//! Qoder **额度 / 套餐**视图：逐账号 quota + plan，附区域汇总。
//!
//! ## 诚实性约束（与 `api::parse_quota` 的守卫串成一条线）
//!
//! - 单账号取数失败**不吞**：该行 `ok=false + error`，其余账号照常展示
//!   （一个 401 的账号不能把整页额度变成空）。
//! - 退化响应（解析不了）在 [`api::parse_quota`] 已拒绝 ⇒ 这里永远不会把
//!   「看不懂」写成 `remaining: 0` 再谎报给用户。
//! - 汇总只累加 `ok` 的行，并**报出成功/失败账号数**——部分失败绝不被伪装成全额。

use std::future::Future;
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use super::account;
use super::api;
use super::region::QoderRegion;

/// 单批最多同时推进的账号流水线数。
const MAX_ACCOUNTS_IN_FLIGHT: usize = 4;

/// 单个账号查询的最终结果：成功 =（额度视图, 套餐名），失败 = 行内错误文案。
type AccountOutcome = Result<(api::QuotaView, Option<String>), String>;

/// 从账号库筛选后的一条只读查询目标。
struct AccountTarget {
    uid: String,
    name: String,
    token: Option<String>,
}

/// 进程级并发闸门：国内 / 国际版及重叠批次的账号流水线**共享**同一上限。
///
/// 单账号内部仍按「额度 → 套餐」串行，因此额度模块同时打到上游的请求最多 4 路；
/// 这不代表 Qoder 其他 API（签到、模型清单等）也受此限制。
fn shared_query_gate() -> Arc<Semaphore> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(Semaphore::new(MAX_ACCOUNTS_IN_FLIGHT)))
        .clone()
}

/// 区域额度视图：`{ region, summary:{ okAccounts, failedAccounts, remaining, total }, accounts: [...] }`。
///
/// `uids` 是**可选的账号筛选**：`None` = 全区域（旧行为），`Some([...])` = 只查这些账号。
/// 过滤在**发出上游请求之前**完成 —— 单账号刷新不能因为「顺手」把整个区域打一遍
/// （N 个账号 = N 次上游 + N 次套餐查询）。
///
/// ⚠️ **显式空集合不退化为全量**：`Some([])` 表示「没有目标账号」⇒ 一个上游请求都不发，
/// 返回空 `accounts` 与零汇总。否则前端「只选了 0 个」会被静默放大成全区域刷新。
/// 未知 uid 同样不产生请求（也不会出现在 `accounts` 里），调用方按「缺条目」处理。
pub async fn region_view(region: QoderRegion, uids: Option<&[String]>) -> Value {
    let file = account::load_accounts_for(region);
    let wanted: Option<std::collections::HashSet<&str>> = uids.map(|list| {
        list.iter()
            .map(|uid| uid.trim())
            .filter(|uid| !uid.is_empty())
            .collect()
    });
    let targets: Vec<AccountTarget> = file
        .accounts
        .iter()
        .filter(|account| {
            wanted
                .as_ref()
                .map(|wanted| wanted.contains(account.uid.as_str()))
                .unwrap_or(true)
        })
        .map(|account| AccountTarget {
            uid: account.uid.clone(),
            name: account::display_name(account),
            token: account
                .access_token
                .clone()
                .filter(|token| !token.is_empty()),
        })
        .collect();

    region_view_for_targets(region, targets, shared_query_gate(), move |uid, token| async move {
        fetch_account(
            || api::quota_usage(region, &uid, &token),
            || api::user_plan(region, &uid, &token),
        )
        .await
    })
    .await
}

/// 单账号流水线：**先额度，成功才查套餐**。
///
/// - 额度失败直接返回错误 ⇒ 不产生套餐请求（也绝不重试）；
/// - 套餐失败只丢套餐名，保留已成功的额度（套餐只是展示信息）。
///
/// 两路保持顺序，因此一个账号任务同时在途的上游请求最多 1 个。
async fn fetch_account<Q, QFut, P, PFut>(quota: Q, plan: P) -> AccountOutcome
where
    Q: FnOnce() -> QFut,
    QFut: Future<Output = Result<api::QuotaView, String>>,
    P: FnOnce() -> PFut,
    PFut: Future<Output = Result<Value, String>>,
{
    let quota = quota().await?;
    let plan = plan().await.ok().and_then(|payload| {
        payload
            .get("planName")
            .or_else(|| payload.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    Ok((quota, plan))
}

/// 对有界窗口内的账号任务执行查询，并按**原始顺序**汇总。
///
/// - 窗口：单批最多 [`MAX_ACCOUNTS_IN_FLIGHT`] 个任务在跑，完成一个补一个；
/// - 闸门：`gate` 由调用方注入（生产为进程级共享闸门，测试可注入独立闸门）；
/// - 结果：按目标索引回填，绝不按完成顺序输出；任务异常（panic / 取消）对应
///   UID 仍保留失败行，不编造零积分。
async fn region_view_for_targets<F, Fut>(
    region: QoderRegion,
    targets: Vec<AccountTarget>,
    gate: Arc<Semaphore>,
    query: F,
) -> Value
where
    F: Fn(String, String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = AccountOutcome> + Send + 'static,
{
    let mut outcomes: Vec<Option<AccountOutcome>> = vec![None; targets.len()];
    let mut queue = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        match target.token.as_deref() {
            Some(token) if !token.is_empty() => {
                queue.push((index, target.uid.clone(), token.to_string()));
            }
            _ => outcomes[index] = Some(Err("没有可调用的 access token".to_string())),
        }
    }

    let query = Arc::new(query);
    let mut tasks = JoinSet::new();
    let mut queue = queue.into_iter();
    loop {
        while tasks.len() < MAX_ACCOUNTS_IN_FLIGHT {
            let Some((index, uid, token)) = queue.next() else {
                break;
            };
            let query = query.clone();
            let gate = gate.clone();
            tasks.spawn(async move {
                // 许可覆盖「额度 + 套餐」两路，保证活跃账号流水线 ≤ 上限。
                let _permit = gate.acquire_owned().await.ok();
                (index, (*query)(uid, token).await)
            });
        }
        if tasks.is_empty() {
            break;
        }
        match tasks.join_next().await {
            Some(Ok((index, outcome))) => outcomes[index] = Some(outcome),
            // 任务异常：不记录索引，收集阶段按缺失项补失败行（见下）。
            Some(Err(_)) => {}
            None => break,
        }
    }

    let mut rows = Vec::with_capacity(targets.len());
    let mut ok_accounts = 0u32;
    let mut failed_accounts = 0u32;
    let mut remaining_sum = 0i64;
    let mut total_sum = 0i64;
    for (index, target) in targets.iter().enumerate() {
        let outcome = outcomes[index]
            .take()
            .unwrap_or_else(|| Err("额度查询任务异常终止".to_string()));
        match outcome {
            Ok((quota, plan)) => {
                ok_accounts += 1;
                remaining_sum += quota.remaining;
                total_sum += quota.total;
                rows.push(json!({
                    "uid": target.uid,
                    "name": target.name,
                    "ok": true,
                    "remaining": quota.remaining,
                    "used": quota.used,
                    "total": quota.total,
                    "isExceeded": quota.is_exceeded,
                    /* 当前套餐/额度的到期时刻（Unix **毫秒**；缺值 ⇒ null，前端据此不渲染到期）。
                       聚合后的 remaining 与这一个时刻一起到期（userQuota / addOnQuota 无各自到期时间）。
                       `expiresForever`：上游哨兵「9999-12-31」= **不过期**（`expiresAt` 此时为 null）
                       ⇒ 前端写「长期有效」，不把哨兵渲染成日期（2026-10-29 用户报障）。 */
                    "expiresAt": quota.expires_at,
                    "expiresForever": quota.expires_forever,
                    "plan": plan,
                    "raw": quota.raw,
                }));
            }
            Err(error) => {
                failed_accounts += 1;
                rows.push(json!({
                    "uid": target.uid,
                    "name": target.name,
                    "ok": false,
                    "error": error,
                }));
            }
        }
    }

    json!({
        "region": region.as_str(),
        "summary": {
            "okAccounts": ok_accounts,
            "failedAccounts": failed_accounts,
            "remaining": remaining_sum,
            "total": total_sum,
        },
        "accounts": rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn target(uid: &str, token: Option<&str>) -> AccountTarget {
        AccountTarget {
            uid: uid.to_string(),
            name: format!("name-{uid}"),
            token: token.map(str::to_string),
        }
    }

    fn quota(remaining: i64) -> api::QuotaView {
        api::QuotaView {
            remaining,
            used: 0,
            total: remaining,
            is_exceeded: false,
            expires_at: None,
            expires_forever: false,
            raw: json!({}),
        }
    }

    fn test_gate() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(MAX_ACCOUNTS_IN_FLIGHT))
    }

    /// 完成顺序与输入顺序相反时，结果仍按原序输出（不能按完成顺序返回）。
    #[tokio::test]
    async fn completed_out_of_order_but_reported_in_input_order() {
        let targets: Vec<_> = (0..6)
            .map(|index| target(&format!("u{index}"), Some("t")))
            .collect();
        let view =
            region_view_for_targets(QoderRegion::Cn, targets, test_gate(), |uid, _| async move {
                let index: u64 = uid.trim_start_matches('u').parse().unwrap();
                // 越靠前的账号越慢 ⇒ 任务按相反顺序完成。
                tokio::time::sleep(Duration::from_millis((6 - index) * 10)).await;
                Ok((quota(index as i64), Some(format!("plan-{index}"))))
            })
            .await;

        let accounts = view["accounts"].as_array().unwrap();
        let uids: Vec<&str> = accounts
            .iter()
            .map(|row| row["uid"].as_str().unwrap())
            .collect();
        assert_eq!(uids, ["u0", "u1", "u2", "u3", "u4", "u5"]);
        assert_eq!(accounts[3]["plan"], "plan-3");
        assert_eq!(view["summary"]["okAccounts"], 6);
        assert_eq!(view["summary"]["remaining"], 0 + 1 + 2 + 3 + 4 + 5);
    }

    /// 10 个账号、每个 20ms：确认确实并发，且活跃流水线不超过 4。
    #[tokio::test]
    async fn account_pipeline_concurrency_is_bounded() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let targets: Vec<_> = (0..10)
            .map(|index| target(&format!("u{index}"), Some("t")))
            .collect();
        let (active_query, peak_query) = (active.clone(), peak.clone());
        let view = region_view_for_targets(
            QoderRegion::Cn,
            targets,
            test_gate(),
            move |_uid, _token| {
                let active = active_query.clone();
                let peak = peak_query.clone();
                async move {
                    let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(running, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok((quota(1), None))
                }
            },
        )
        .await;

        assert_eq!(view["accounts"].as_array().unwrap().len(), 10);
        let peak = peak.load(Ordering::SeqCst);
        assert!(
            peak <= MAX_ACCOUNTS_IN_FLIGHT,
            "活跃账号流水线不得超过上限：peak={peak}"
        );
        assert!(peak >= 2, "应当确实并发执行：peak={peak}");
    }

    /// 国内 / 国际两个批次重叠时共享**同一个**闸门（总活跃数仍 ≤ 4）。
    #[tokio::test]
    async fn overlapping_batches_share_one_process_gate() {
        let gate = test_gate();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let batch = || -> Vec<AccountTarget> {
            (0..8)
                .map(|index| target(&format!("u{index}"), Some("t")))
                .collect()
        };

        let (active_cn, peak_cn) = (active.clone(), peak.clone());
        let cn = region_view_for_targets(QoderRegion::Cn, batch(), gate.clone(), move |_u, _t| {
            let active = active_cn.clone();
            let peak = peak_cn.clone();
            async move {
                let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(running, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok((quota(1), None))
            }
        });
        let (active_global, peak_global) = (active.clone(), peak.clone());
        let global =
            region_view_for_targets(QoderRegion::Global, batch(), gate.clone(), move |_u, _t| {
                let active = active_global.clone();
                let peak = peak_global.clone();
                async move {
                    let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(running, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok((quota(1), None))
                }
            });

        let (cn, global) = tokio::join!(cn, global);
        assert_eq!(cn["summary"]["okAccounts"], 8);
        assert_eq!(global["summary"]["okAccounts"], 8);
        let peak = peak.load(Ordering::SeqCst);
        assert!(
            peak <= MAX_ACCOUNTS_IN_FLIGHT,
            "重叠批次必须共享闸门：peak={peak}"
        );
    }

    /// 部分失败：失败行保留原文错误、汇总只累加成功行；无 token 的账号不产生请求。
    #[tokio::test]
    async fn partial_failure_keeps_failed_row_and_honest_summary() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let targets = vec![
            target("u0", Some("t")),
            target("u1", Some("t")),
            target("u2", None),
        ];
        let view = region_view_for_targets(
            QoderRegion::Cn,
            targets,
            test_gate(),
            move |uid, _token| {
                counted.fetch_add(1, Ordering::SeqCst);
                async move {
                    if uid == "u1" {
                        Err("额度查询失败: HTTP 500".to_string())
                    } else {
                        Ok((quota(7), Some("Pro".to_string())))
                    }
                }
            },
        )
        .await;

        let accounts = view["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), 3);
        assert_eq!(accounts[0]["ok"], true);
        assert_eq!(accounts[1]["ok"], false);
        assert_eq!(accounts[1]["error"], "额度查询失败: HTTP 500");
        assert_eq!(accounts[2]["ok"], false);
        assert_eq!(accounts[2]["error"], "没有可调用的 access token");
        assert_eq!(view["summary"]["okAccounts"], 1);
        assert_eq!(view["summary"]["failedAccounts"], 2);
        assert_eq!(view["summary"]["remaining"], 7);
        assert_eq!(view["summary"]["total"], 7);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "无 token 的账号不得发起上游请求"
        );
    }

    /// 任务 panic：不得丢掉该 UID，也不得编造零积分。
    #[tokio::test]
    async fn panicking_task_still_reports_its_account() {
        let targets: Vec<_> = (0..2)
            .map(|index| target(&format!("u{index}"), Some("t")))
            .collect();
        let view = region_view_for_targets(
            QoderRegion::Cn,
            targets,
            test_gate(),
            |uid, _token| async move {
                if uid == "u0" {
                    panic!("模拟任务异常");
                }
                Ok((quota(3), None))
            },
        )
        .await;

        let accounts = view["accounts"].as_array().unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0]["uid"], "u0");
        assert_eq!(accounts[0]["ok"], false);
        assert_eq!(accounts[0]["error"], "额度查询任务异常终止");
        assert_eq!(accounts[1]["ok"], true);
        assert_eq!(view["summary"]["okAccounts"], 1);
        assert_eq!(view["summary"]["failedAccounts"], 1);
    }

    /// 空目标集合 ⇒ 一个请求都不发，零汇总（`Some([])` 不得退化为全量）。
    #[tokio::test]
    async fn empty_target_set_sends_no_requests() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let view = region_view_for_targets(QoderRegion::Cn, vec![], test_gate(), move |_, _| {
            counted.fetch_add(1, Ordering::SeqCst);
            async move { Ok((quota(1), None)) }
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(view["accounts"].as_array().unwrap().is_empty());
        assert_eq!(view["summary"]["okAccounts"], 0);
        assert_eq!(view["summary"]["remaining"], 0);
    }

    /// 额度失败 ⇒ **不查套餐**（避免额外请求），错误原样返回。
    #[tokio::test]
    async fn quota_failure_skips_plan_query() {
        let plan_calls = Arc::new(AtomicUsize::new(0));
        let counted = plan_calls.clone();
        let outcome = fetch_account(
            || async { Err("额度查询失败: HTTP 401 凭据无效".to_string()) },
            move || {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "planName": "Pro" }))
                }
            },
        )
        .await;

        assert_eq!(outcome.unwrap_err(), "额度查询失败: HTTP 401 凭据无效");
        assert_eq!(
            plan_calls.load(Ordering::SeqCst),
            0,
            "额度失败后不得再查套餐"
        );
    }

    /// 套餐失败 ⇒ 保留成功的额度，只把套餐名置空（不重试、不报错）。
    #[tokio::test]
    async fn plan_failure_keeps_successful_quota() {
        let outcome = fetch_account(
            || async { Ok(quota(42)) },
            || async { Err::<Value, String>("套餐查询失败: HTTP 500".to_string()) },
        )
        .await
        .expect("套餐失败不得拖垮额度行");

        assert_eq!(outcome.0.remaining, 42);
        assert_eq!(outcome.1, None);
    }

    /// 套餐名取 `planName`，缺失时回落 `name`。
    #[tokio::test]
    async fn plan_name_prefers_plan_name_then_name() {
        let preferred = fetch_account(
            || async { Ok(quota(1)) },
            || async { Ok(json!({ "name": "Fallback", "planName": "Pro" })) },
        )
        .await
        .unwrap();
        assert_eq!(preferred.1.as_deref(), Some("Pro"));

        let fallback = fetch_account(
            || async { Ok(quota(1)) },
            || async { Ok(json!({ "name": "Fallback" })) },
        )
        .await
        .unwrap();
        assert_eq!(fallback.1.as_deref(), Some("Fallback"));
    }
}
