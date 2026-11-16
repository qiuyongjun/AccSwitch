/**
 * 账号切换的**长任务状态**（三个平台共用）。
 *
 * ## 解决什么问题
 *
 * 切换账号不是一次请求就结束：它要关客户端、备份/写入登录态、再启动客户端。
 * 慢的时候几十秒，而界面此前只有两种反馈：
 *
 * - 右下角一条 toast（容易被忽略，切到客户端窗口后根本看不见）；
 * - 卡片上的按钮忙态（接口一返回就清掉 —— 但此时客户端**还在启动**）。
 *
 * 用户看到的就是「点了没反应 / 切换完了但客户端没开 / 不知道还在不在切」。
 * 本模块把这段过程收成一份页面级状态：开始 → 当前步骤 → 启动客户端 → 完成/超时。
 *
 * ## 为什么轮询放在前端、而不是加一个后端「启动完成」事件
 *
 * 后端的启动动作是 `spawn`，返回只代表**进程已拉起**，不代表窗口已就绪；
 * 而「客户端真的在跑」的判据后端已有（进程探测），前端按固定节奏调用即可。
 * 这样不需要新增后台循环，也不需要改三套 switch 命令的返回协议。
 *
 * ## 诚实边界
 *
 * 超时**不代表切换失败**：登录态已经写好，只是客户端没在预期时间内出现。
 * 因此超时落 `warning`（「登录态已切换，可手动打开」），绝不写成失败。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SwitchProgressPhase = "switching" | "launching" | "done" | "warning" | "failed";

export interface SwitchProgressState {
  phase: SwitchProgressPhase;
  /** 主文案（当前动作 / 结果）。 */
  title: string;
  /** 后端当前步骤或补充说明。 */
  detail?: string;
}

export interface SwitchProgressPatch {
  phase?: SwitchProgressPhase;
  title?: string;
  /** `null` 表示清空副标题。 */
  detail?: string | null;
}

/** 一次切换操作的句柄：旧操作的回调不会覆盖新操作。 */
export interface SwitchProgressHandle {
  readonly token: number;
  /** 新操作开始 / 组件卸载时 abort；异步轮询据此提前收手。 */
  readonly signal: AbortSignal;
  update: (patch: SwitchProgressPatch) => void;
  /** 结束本次操作并短暂展示结果，`holdMs` 后自动清空。 */
  settle: (next: SwitchProgressState, holdMs?: number) => void;
}

export interface SwitchProgressController {
  state: SwitchProgressState | null;
  begin: (title: string, detail?: string) => SwitchProgressHandle;
}

/** 完成态停留时长：要让人看见「已经切完了」，又不至于长期占着页头。 */
const DONE_HOLD_MS = 4000;
/** 超时 / 失败态留得更久，因为它需要用户采取动作。 */
const WARNING_HOLD_MS = 8000;

/** 客户端启动的默认等待上限（Electron 客户端冷启动在慢机器上可达数十秒）。 */
export const CLIENT_LAUNCH_TIMEOUT_MS = 60_000;
/** 两次进程探测之间的间隔（探测本身还要数百毫秒到数秒）。 */
const CLIENT_LAUNCH_PROBE_INTERVAL_MS = 1500;

export function useSwitchProgress(): SwitchProgressController {
  const [state, setState] = useState<SwitchProgressState | null>(null);
  /** 操作代次：只有**当前代次**的更新/收尾能落到 state。 */
  const tokenRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const begin = useCallback(
    (title: string, detail?: string): SwitchProgressHandle => {
      clearTimer();
      /* 上一轮还没收尾就开始新一轮（例如授权恢复后自动重试）：
         旧轮询必须停，否则它后续的 settle 会和新一轮抢状态。 */
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      tokenRef.current += 1;
      const token = tokenRef.current;
      /* 本轮是否已被 settle 结束：结束后迟到的 progress 事件不该把结果态改回「进行中」。 */
      let settled = false;
      setState({ phase: "switching", title, detail });

      const isCurrent = () =>
        !settled && !controller.signal.aborted && token === tokenRef.current;

      return {
        token,
        signal: controller.signal,
        update(patch) {
          if (!isCurrent()) return;
          setState((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.detail !== undefined ? { detail: patch.detail ?? undefined } : {}),
            };
          });
        },
        settle(next, holdMs) {
          if (!isCurrent()) return;
          settled = true;
          clearTimer();
          setState(next);
          timerRef.current = window.setTimeout(
            () => {
              if (token === tokenRef.current) setState(null);
            },
            holdMs ?? (next.phase === "done" ? DONE_HOLD_MS : WARNING_HOLD_MS),
          );
        },
      };
    },
    [clearTimer],
  );

  // 卸载即作废当前代次：在途轮询看到 abort 后不再更新 state。
  useEffect(
    () => () => {
      tokenRef.current += 1;
      abortRef.current?.abort();
      clearTimer();
    },
    [clearTimer],
  );

  return { state, begin };
}

/** 可被 abort 打断的 sleep。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: number | undefined;
    const onAbort = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 轮询直到客户端进程在运行。
 *
 * - `probe` 抛错**不视为失败**：下一拍再试（进程探测可能撞上客户端刚退出/刚启动的瞬间）；
 * - 超时返回 `false`（调用方据此落到「已切换、但客户端未在预期时间内启动」）；
 * - `signal` abort 后尽快返回，调用方应再检查一次 `signal.aborted` 再更新界面。
 */
export async function waitForClientRunning(
  probe: () => Promise<boolean>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
): Promise<boolean> {
  const {
    signal,
    timeoutMs = CLIENT_LAUNCH_TIMEOUT_MS,
    intervalMs = CLIENT_LAUNCH_PROBE_INTERVAL_MS,
  } = options;
  // 用单调时钟：系统校时回拨会让 `Date.now()` 的差值变成负数，超时永远不到。
  const startedAt = performance.now();

  while (!signal?.aborted) {
    try {
      if (await probe()) return true;
    } catch {
      /* 探测失败不当作「已启动」，也不当作「启动失败」—— 交给下一拍。 */
    }
    if (signal?.aborted) return false;
    if (performance.now() - startedAt >= timeoutMs) return false;
    await sleep(intervalMs, signal);
  }
  return false;
}
