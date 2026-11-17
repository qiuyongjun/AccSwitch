//! 按账号串行的异步刷新闸门。
//!
//! refresh token 是**轮换凭证**：同一账号并发刷新时，后到的请求会拿到
//! `invalid_grant` / `12153`，被误判成「凭据失效」。卡片 / 批量 / 后台保活
//! 都可能同时打同一条账号，故需要进程级串行。
//!
//! 闸门表是静态量：每次调用新建锁等于没串行化。条目在无人持有时摘掉，
//! 否则会随「历史上出现过的每个账号」永久增长。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::Mutex as AsyncMutex;

/// 表里那一份 + 当前调用方手上这一份。
const EXPECTED_HOLDERS: usize = 2;

fn locks() -> &'static Mutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(key: &str) -> Arc<AsyncMutex<()>> {
    let mut guard = locks()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    guard
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// 调用方用完闸门后，若除表本身已无人持有，就摘掉该条目。
fn release(key: &str, gate: &Arc<AsyncMutex<()>>) {
    if Arc::strong_count(gate) > EXPECTED_HOLDERS {
        return;
    }
    let mut guard = locks()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // 拿到表锁之前可能又有线程 clone 走了这一份，对表里那一份再确认一次，
    // 否则会摘掉别人正在持有的闸门（那人释放时用的还是旧 Arc，串行化就漏了）。
    if guard
        .get(key)
        .is_some_and(|entry| Arc::strong_count(entry) <= EXPECTED_HOLDERS)
    {
        guard.remove(key);
    }
}

/// 同一 `key` 的操作串行执行；不同 `key` 之间互不阻塞。
pub async fn with_refresh_lock<T, F, Fut>(key: &str, action: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = T>,
{
    let gate = lock_for(key);
    let outcome = {
        let _permit = gate.lock().await;
        action().await
    };
    release(key, &gate);
    outcome
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::with_refresh_lock;

    /// 同键并发 → 临界区峰值并发必须为 1。
    #[tokio::test]
    async fn same_key_serializes() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let (active, peak) = (active.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                with_refresh_lock("same", move || async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                })
                .await;
            }));
        }
        for task in tasks {
            task.await.expect("task 不应 panic");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "同键临界区不得重叠");
    }

    /// 异键并发 → 两个任务必须能同时进入各自临界区（串行化不得变成全局锁）。
    #[tokio::test]
    async fn different_keys_do_not_block() {
        use tokio::sync::Barrier;

        let barrier = Arc::new(Barrier::new(2));
        let mut tasks = Vec::new();
        for key in ["a", "b"] {
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                with_refresh_lock(key, move || async move {
                    let joined = tokio::time::timeout(
                        Duration::from_secs(1),
                        barrier.wait(),
                    )
                    .await;
                    assert!(joined.is_ok(), "异键不应互相阻塞：{key}");
                })
                .await;
            }));
        }
        for task in tasks {
            task.await.expect("task 不应 panic");
        }
    }

    /// 表项必须被回收：连续使用不同键后不能永久累积。
    #[tokio::test]
    async fn entries_are_released() {
        for index in 0..20 {
            let key = format!("release-{index}");
            with_refresh_lock(&key, || async {}).await;
        }
        assert!(
            super::locks()
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_empty(),
            "无人持有的闸门条目应被摘除"
        );
    }
}
