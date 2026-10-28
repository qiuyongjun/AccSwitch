//! 账号库「读 → 改 → 写」的事务边界。
//!
//! ## 为什么需要它
//!
//! 账号库的每个写函数都是同一个形态：`load 整份 → 改一条 → save 整份`。
//! 没有互斥时，两个并发调用（批量续期、后台保活、备注编辑、回收站）会各自读到**同一份
//! 旧快照**，后写者的整份覆盖会把先写者刚落盘的新令牌 / 备注 / 签到记录**静默回滚**，
//! 而两个请求都返回成功 —— 用户看到的是「续期成功但过一阵子又掉线」。
//!
//! ## 三层保护
//!
//! 1. **进程内互斥**：按**账号库文件路径**分键的 `std::sync::Mutex`，把整段读改写包住。
//!    键用路径而不是 `region` / `variant` 枚举：两条产品线、跨区域迁移、回收站各自指向
//!    不同文件时天然分开，指向同一文件时天然共用一把锁 —— 不需要在调用方维护映射表。
//! 2. **同线程可重入**：`Mutex` 不可重入，而 `add_manual_for` 这类写函数内部还会调用
//!    另一个写函数（分组关系）。用 thread-local 深度计数识别「已在本线程事务内」，
//!    嵌套调用直接执行，不抢锁（抢就是自己把自己锁死）。
//! 3. **跨进程乐观校验**：桌面端与 WebUI 是两个进程，进程内锁管不到。读账号库时记下
//!    原文，写之前重读比对；不一致说明有别的进程插进来改过 ⇒ 返回 [`CONFLICT`]，
//!    由 [`with_txn`] 重新执行整段（重新读到最新内容再改）。
//!
//! 第 3 层是**乐观**的：检查与 `rename` 之间仍有微秒级窗口，严格互斥需要 OS 文件锁。
//! 这里刻意不引入文件锁依赖 —— 账号库写入频率极低、单次写几百字节，乐观重试已能把
//! 「毫秒级读改写窗口」压缩到「微秒级比对窗口」，收益与复杂度之比远好于平台相关代码。
//!
//! ## 使用纪律
//!
//! - `with_txn` 的闭包里**不要 `.await`**（持锁跨 await 会把整个进程的账号库写操作拖住，
//!   且 `std::sync::Mutex` 跨 await 会触发 `Send` 约束报错）。网络请求一律留在事务外。
//! - 闭包里**只改这一份账号库**；关联文件（回收站 / 分组）的写入顺序由调用方决定，
//!   现有实现都是「先写新增侧、后写删除侧」，重试安全。

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// 冲突哨兵：写前发现别的进程改过账号库。
///
/// 用字符串而不是错误枚举，是因为整条调用链的签名都是 `Result<T, String>`
/// （命令面要把它原样变成前端可见的文案）。这个值**不会**漏给用户：只有
/// [`with_txn`] 认它并重试，重试耗尽才转成一条普通错误。
pub const CONFLICT: &str = "__accounts_txn_conflict__";

/// 一轮事务最多重跑几次。5 次足够覆盖「两个进程交替写」的极端情形；
/// 再多说明有进程在死循环写同一个文件，那是别处的 bug，继续重试只会放大。
const MAX_ATTEMPTS: usize = 5;

fn lock_table() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取某账号库的进程内写闸门。
///
/// 条目**永不摘除**：账号库文件的路径是个闭集（每个平台 × 区域各一条），
/// 数量有上界（个位数），摘除只会引入「两个线程各拿一把新锁」的漏串行风险。
fn gate_for(path: &Path) -> Arc<Mutex<()>> {
    let mut table = lock_table()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    table
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

thread_local! {
    /// 本线程已持有的写事务深度（按账号库路径）。
    ///
    /// 只用于**重入识别**，不是锁本身：深度 > 0 说明外层已经拿着闸门了。
    static DEPTH: RefCell<HashMap<PathBuf, usize>> = RefCell::new(HashMap::new());
    /// 本线程在事务内读到的账号库原文（写前比对用）。
    static SNAPSHOT: RefCell<HashMap<PathBuf, String>> = RefCell::new(HashMap::new());
}

fn depth_of(path: &Path) -> usize {
    DEPTH.with(|depth| depth.borrow().get(path).copied().unwrap_or(0))
}

fn enter(path: &Path) {
    DEPTH.with(|depth| {
        *depth.borrow_mut().entry(path.to_path_buf()).or_insert(0) += 1;
    });
}

fn leave(path: &Path) {
    DEPTH.with(|depth| {
        let mut depth = depth.borrow_mut();
        if let Some(current) = depth.get_mut(path) {
            *current = current.saturating_sub(1);
            if *current == 0 {
                depth.remove(path);
            }
        }
    });
}

/// 在一条账号库的写事务内执行 `f`。
///
/// 返回 `f` 的结果；`f` 若报 [`CONFLICT`]（写前发现别的进程改过），整段重新执行。
/// 重试时 `f` 会重新 `load`，因此「在最新内容上再做一次同样的修改」——
/// 这也是各 `set_*` / `record_*` 函数都只做**字段级赋值**的原因（可重放）。
pub fn with_txn<T>(path: &Path, mut f: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    // 嵌套调用：外层已持锁、已在自己的事务里，直接执行（抢锁会自锁）。
    if depth_of(path) > 0 {
        enter(path);
        let outcome = f();
        leave(path);
        return outcome;
    }

    let gate = gate_for(path);
    let _guard = gate.lock().unwrap_or_else(|poison| poison.into_inner());

    enter(path);
    let mut result: Result<T, String> = Err("账号库写事务未执行".to_string());
    for attempt in 0..MAX_ATTEMPTS {
        match f() {
            Err(error) if error == CONFLICT => {
                // 丢掉这一轮的读取快照，下一轮必须重新读到最新内容。
                SNAPSHOT.with(|snapshot| snapshot.borrow_mut().remove(path));
                result = Err(error);
                if attempt + 1 == MAX_ATTEMPTS {
                    result = Err(format!(
                        "账号库正被其他进程反复修改，已重试 {MAX_ATTEMPTS} 次仍未写入，请稍后重试"
                    ));
                }
            }
            other => {
                result = other;
                break;
            }
        }
    }
    SNAPSHOT.with(|snapshot| snapshot.borrow_mut().remove(path));
    leave(path);
    result
}

/// 记录「本线程刚读到这份原文」。由 `load_accounts_checked_for` 在**事务内**调用。
///
/// 事务外读到的不记：只读路径（列表 / 导出）不该影响别人的写判定。
pub fn record_read(path: &Path, text: &str) {
    if depth_of(path) == 0 {
        return;
    }
    SNAPSHOT.with(|snapshot| {
        snapshot
            .borrow_mut()
            .insert(path.to_path_buf(), text.to_string());
    });
}

/// 写之前确认账号库没有被**别的进程**改过。由 `save_accounts_for` 调用。
///
/// - 不在事务内（测试直接造数据、导入流程偶发直写）⇒ 直接放行：没有可比对的基准，
///   强行失败会把既有调用点全打断。
/// - 事务内但本线程没读过（例如只写不读的补丁）⇒ 放行。
/// - 读到过且当前内容已变 ⇒ [`CONFLICT`]，事务重跑。
pub fn ensure_unchanged(path: &Path) -> Result<(), String> {
    if depth_of(path) == 0 {
        return Ok(());
    }
    let expected = SNAPSHOT.with(|snapshot| snapshot.borrow().get(path).cloned());
    let Some(expected) = expected else {
        return Ok(());
    };
    let current = std::fs::read_to_string(path).unwrap_or_default();
    if current == expected {
        Ok(())
    } else {
        Err(CONFLICT.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 隔离的账号库路径。`TempDir` 必须由调用方持有到用例结束（Drop 时删目录）。
    fn isolated(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("buddy-switch-txn-{name}-"))
            .tempdir()
            .expect("建临时目录");
        let path = dir.path().join("accounts.json");
        (dir, path)
    }

    #[test]
    fn nested_txn_does_not_deadlock() {
        let (_dir, path) = isolated("nested");
        let outcome = with_txn(&path, || {
            with_txn(&path, || Ok::<_, String>("inner".to_string()))
        });
        assert_eq!(outcome.unwrap(), "inner");
    }

    #[test]
    fn conflict_is_retried_with_fresh_read() {
        let (_dir, path) = isolated("retry");
        std::fs::write(&path, "v1").unwrap();
        let attempts = AtomicUsize::new(0);
        let outcome = with_txn(&path, || {
            let round = attempts.fetch_add(1, Ordering::SeqCst);
            let text = std::fs::read_to_string(&path).unwrap();
            record_read(&path, &text);
            // 第一次模拟「读完之后别的进程写进来了」。
            if round == 0 {
                std::fs::write(&path, "v2").unwrap();
            }
            ensure_unchanged(&path)?;
            Ok::<_, String>(text)
        });
        assert_eq!(outcome.unwrap(), "v2", "重试必须读到新内容，而不是复用旧快照");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn save_outside_txn_skips_verification() {
        let (_dir, path) = isolated("outside");
        std::fs::write(&path, "before").unwrap();
        assert!(ensure_unchanged(&path).is_ok());
    }

    #[test]
    fn clean_exit_drops_snapshot() {
        let (_dir, path) = isolated("clean");
        std::fs::write(&path, "v1").unwrap();
        with_txn(&path, || {
            let text = std::fs::read_to_string(&path).unwrap();
            record_read(&path, &text);
            Ok::<_, String>(())
        })
        .unwrap();
        // 事务结束后快照必须清干净，否则同线程的下一个写操作会拿旧文本误判冲突。
        SNAPSHOT.with(|snapshot| assert!(!snapshot.borrow().contains_key(&path)));
    }

    /// 不同账号库文件必须各用各的闸门（否则 Qoder 的续期会拖住 Trae 的写）。
    #[test]
    fn different_files_use_different_gates() {
        let (dir_a, path_a) = isolated("gate-a");
        let (_dir_b, path_b) = isolated("gate-b");
        assert!(!std::sync::Arc::ptr_eq(&gate_for(&path_a), &gate_for(&path_b)));
        assert!(std::sync::Arc::ptr_eq(&gate_for(&path_a), &gate_for(&path_a)));
        drop(dir_a);
    }

    /// ★ 核心回归：多线程并发做「读整份 → 追加一条 → 写整份」，一条都不能丢。
    ///
    /// 这条用例就是修复前会红的形态：没有事务时，后写者用自己那份旧快照整份覆盖，
    /// 先写者的条目消失，而每个线程都返回成功。
    #[test]
    fn concurrent_writers_keep_every_update() {
        const WRITERS: usize = 8;
        let (_dir, path) = isolated("concurrent");
        std::fs::write(&path, r#"{"items":[]}"#).unwrap();

        let handles: Vec<_> = (0..WRITERS)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    with_txn(&path, || {
                        let text = std::fs::read_to_string(&path).unwrap();
                        record_read(&path, &text);
                        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
                        value["items"]
                            .as_array_mut()
                            .unwrap()
                            .push(serde_json::json!(index));
                        ensure_unchanged(&path)?;
                        std::fs::write(&path, serde_json::to_string(&value).unwrap()).unwrap();
                        Ok::<_, String>(())
                    })
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut items: Vec<i64> = value["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_i64().unwrap())
            .collect();
        items.sort_unstable();
        assert_eq!(
            items,
            (0..WRITERS as i64).collect::<Vec<_>>(),
            "并发写必须一条不丢（修复前的症状是后写者整份覆盖）"
        );
    }
}
