import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import * as api from "@/lib/api";
import { useAccountsStore } from "@/stores/accounts";

export const WORKBUDDY_STATUS_REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * 焦点 / 可见性事件触发的最小间隔。
 *
 * 窗口每次获得焦点都会走 `syncActiveState → refreshStatusOnEvent`；alt-tab 来回几次就会
 * 叠出多轮 `get_status`（Windows 上每次包含进程 / 路径探测）。10 秒内只跑第一轮，
 * 既保留「回到窗口立即刷新」的语义，又不至于被焦点抖动放大。
 *
 * ⚠️ 闸门**只**装在事件路径上：60 秒定时器与首次激活走的是无闸门的 `refreshStatus`。
 * 若把闸门塞进 `refreshStatus` 本身，间隔一旦调到 10 秒以下就会连定时轮询一起吞掉。
 */
export const WORKBUDDY_STATUS_FOCUS_MIN_INTERVAL_MS = 10 * 1000;

/**
 * 仅在主窗口可见且聚焦时刷新 WorkBuddy（国内版 + 国际版）运行状态与当前账号。
 *
 * 两个 region 都要轮询：`status.current` 同时决定「国际版/国内版」Tab 上的登录态文案
 * 与账号卡片上的「当前账号」标记，漏掉任何一个都会让标记停留在旧值。
 */
export function useWorkbuddyStatusRefresh() {
  const activeRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let documentVisible = document.visibilityState !== "hidden";
    const webui = api.isWebui();
    // Tauri emits the startup visibility decision before the WebView may have
    // installed this listener. Keep desktop inactive until isVisible() supplies
    // the authoritative initial value; later transitions arrive via the event.
    let mainWindowVisible = webui;
    let windowFocused = document.hasFocus();
    // 单调时钟：`Date.now()` 会被系统校时 / 时区跳变影响，一旦回拨，闸门会把
    // **定时轮询**一起挡在门外（表现为状态一直不刷新）。`performance.now()` 不会。
    // 初值取 `-Infinity`：`performance.now()` 从页面加载起算，若初值为 0，首屏那次
    // 真实刷新会被「加载至今不足 10 秒」这条判据吞掉。
    let lastRefreshAt = Number.NEGATIVE_INFINITY;

    function stopTimer() {
      if (timerRef.current !== undefined) {
        window.clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
    }

    function refreshStatus() {
      if (disposed || !activeRef.current) return;
      lastRefreshAt = performance.now();
      // 必须同时刷新国内版与国际版：`status.current` 是卡片「当前账号」标记的唯一来源，
      // 只轮询国内版会让国际版的状态永远停在首屏快照上——切换国际账号后标记不跟着走。
      void useAccountsStore.getState().refreshAllStatus(abortControllerRef.current?.signal);
    }

    /** 焦点 / 可见性触发的刷新：10 秒闸门，挡住 alt-tab 抖动。 */
    function refreshStatusOnEvent() {
      if (performance.now() - lastRefreshAt < WORKBUDDY_STATUS_FOCUS_MIN_INTERVAL_MS) return;
      refreshStatus();
    }

    function startTimer() {
      stopTimer();
      timerRef.current = window.setInterval(refreshStatus, WORKBUDDY_STATUS_REFRESH_INTERVAL_MS);
    }

    /** `fromEvent` 只决定这一拍要不要过 10 秒闸门；定时器与首次激活一律不过。 */
    function syncActiveState(fromEvent: boolean) {
      const nextActive = documentVisible && mainWindowVisible && windowFocused;
      if (nextActive === activeRef.current) return;

      activeRef.current = nextActive;
      if (nextActive) {
        abortControllerRef.current = new AbortController();
        if (fromEvent) refreshStatusOnEvent();
        else refreshStatus();
        startTimer();
      } else {
        abortControllerRef.current?.abort();
        abortControllerRef.current = undefined;
        stopTimer();
      }
    }

    const onVisibilityChange = () => {
      documentVisible = document.visibilityState !== "hidden";
      syncActiveState(true);
    };
    const onFocus = () => {
      windowFocused = true;
      syncActiveState(true);
    };
    const onBlur = () => {
      windowFocused = false;
      syncActiveState(false);
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    syncActiveState(false);

    let unlisten: (() => void) | undefined;
    if (!webui) {
      void (async () => {
        try {
          const fn = await listen<boolean>("main-window-visible", (event) => {
            mainWindowVisible = event.payload;
            syncActiveState(true);
          });
          if (disposed) {
            fn();
            return;
          }
          unlisten = fn;

          try {
            mainWindowVisible = await getCurrentWindow().isVisible();
          } catch {
            // Preserve the previous DOM-based behavior if the native query is
            // unavailable; focus is still required before polling can start.
            mainWindowVisible = documentVisible;
          }
          if (disposed) return;
          syncActiveState(false);
        } catch {
          if (!disposed) {
            mainWindowVisible = documentVisible;
            syncActiveState(false);
          }
        }
      })();
    }

    return () => {
      disposed = true;
      activeRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = undefined;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      unlisten?.();
    };
  }, []);
}
