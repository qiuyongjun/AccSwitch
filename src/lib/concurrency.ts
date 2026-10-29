/**
 * 批量任务的**固定并发**执行器（本仓唯一的口径）。
 *
 * ## 为什么要有这个模块
 *
 * 账号页的批量动作此前有两种执行模型：
 * - 只读的积分刷新走「3 worker + 请求间隔」的池（`stores/accounts.ts` 的 `loadCredits`）；
 * - 写操作（签到 / 续期 / 成长任务 / 完成任务）走 `for...of await` **串行**。
 *
 * 同一个页面里两套模型 ⇒ 20 个账号批量续期要等 20 次串行 RTT，界面上只有一个转圈，
 * 用户不知道进行到哪、也不能停。本模块把两种模型的差异收成一个参数
 * （`concurrency` + `gapMs`），调用方只声明自己的削峰档位。
 *
 * ★ 2026-10-23：`loadCredits` 也改走本模块（此前是手写的 cursor + gapMs 循环）。
 * 现在「批量并发」在本仓只有这一份实现；新增批量动作请直接复用，不要再写 worker 池。
 *
 * ## 契约
 *
 * - **固定的 worker 数**，不是「分批 `Promise.all`」：后者会让快慢不均时的并发在
 *   1~N 之间抖动，削峰失去意义。
 * - `worker` **必须自己处理错误**（本仓四处调用都自带 `try/catch`，把失败计入 failed 清单）。
 *   让异常穿透会中断 `Promise.all`，而其余 worker 仍在跑 —— 那种「部分继续」最难排查。
 * - `signal` 为**协作式中止**：只阻止**尚未开始**的项，已在途的请求一定会跑完。
 *   因此中止后的结果是「部分生效」，调用方**必须**把未处理的条数写进结果文案，
 *   不能报成「已完成」。
 * - 返回数组与入参**同序同长**，且**稠密**：被中止而没跑的项是 `undefined`
 *   （缺席 ≠ 失败）。⚠️ 不要用 `new Array(total)` —— 稀疏数组会让 `filter` / `forEach`
 *   **跳过空位**，取消场景下「未处理」会被静默统计成 0。
 */
export interface MapWithConcurrencyOptions {
  /** worker 数上限（默认 3，与积分刷新同一档）。 */
  concurrency?: number;
  /** 每个 worker 两次任务之间的间隔（毫秒），进一步削峰；默认 0。 */
  gapMs?: number;
  /** 协作式中止信号。 */
  signal?: AbortSignal;
  /** 每完成一项回调一次（`done` 从 1 开始，`total` 为入参长度）。 */
  onProgress?: (done: number, total: number) => void;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {},
): Promise<(R | undefined)[]> {
  const { concurrency = 3, gapMs = 0, signal, onProgress } = options;
  const total = items.length;
  const results: (R | undefined)[] = Array.from({ length: total }, () => undefined);
  if (total === 0) return results;

  let cursor = 0;
  let done = 0;

  const runWorker = async () => {
    for (;;) {
      /* 中止检查放在**取号之前**：已取号的项一定跑完（协作式中止的语义）。 */
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= total) return;
      results[index] = await worker(items[index], index);
      done += 1;
      onProgress?.(done, total);
      if (gapMs > 0 && cursor < total) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), total) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}
