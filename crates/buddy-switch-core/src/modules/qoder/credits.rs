//! Qoder **额度 / 套餐**视图：逐账号 quota + plan，附区域汇总。
//!
//! ## 诚实性约束（与 `api::parse_quota` 的守卫串成一条线）
//!
//! - 单账号取数失败**不吞**：该行 `ok=false + error`，其余账号照常展示
//!   （一个 401 的账号不能把整页额度变成空）。
//! - 退化响应（解析不了）在 [`api::parse_quota`] 已拒绝 ⇒ 这里永远不会把
//!   「看不懂」写成 `remaining: 0` 再谎报给用户。
//! - 汇总只累加 `ok` 的行，并**报出成功/失败账号数**——部分失败绝不被伪装成全额。

use serde_json::{json, Value};

use super::account;
use super::api;
use super::region::QoderRegion;

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
    let mut rows = Vec::new();
    let mut ok_accounts = 0u32;
    let mut failed_accounts = 0u32;
    let mut remaining_sum = 0i64;
    let mut total_sum = 0i64;

    for account in &file.accounts {
        if let Some(wanted) = &wanted {
            if !wanted.contains(account.uid.as_str()) {
                continue;
            }
        }
        let name = account::display_name(account);
        let Some(access) = account
            .access_token
            .as_deref()
            .filter(|token| !token.is_empty())
        else {
            failed_accounts += 1;
            rows.push(json!({
                "uid": account.uid,
                "name": name,
                "ok": false,
                "error": "没有可调用的 access token",
            }));
            continue;
        };
        match api::quota_usage(region, &account.uid, access).await {
            Ok(quota) => {
                ok_accounts += 1;
                remaining_sum += quota.remaining;
                total_sum += quota.total;
                // 套餐名单独取（失败不影响额度展示 —— 套餐只是展示信息）。
                let plan = api::user_plan(region, &account.uid, access)
                    .await
                    .ok()
                    .and_then(|payload| {
                        payload
                            .get("planName")
                            .or_else(|| payload.get("name"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                rows.push(json!({
                    "uid": account.uid,
                    "name": name,
                    "ok": true,
                    "remaining": quota.remaining,
                    "used": quota.used,
                    "total": quota.total,
                    "isExceeded": quota.is_exceeded,
                    /* 当前套餐/额度的到期时刻（Unix **毫秒**；缺值 ⇒ null，前端据此不渲染到期）。
                       聚合后的 remaining 与这一个时刻一起到期（userQuota / addOnQuota 无各自到期时间）。 */
                    "expiresAt": quota.expires_at,
                    "plan": plan,
                    "raw": quota.raw,
                }));
            }
            Err(error) => {
                failed_accounts += 1;
                rows.push(json!({
                    "uid": account.uid,
                    "name": name,
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
