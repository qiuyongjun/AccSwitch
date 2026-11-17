import { useEffect, useRef } from "react";

import { useDocumentVisible } from "@/lib/use-document-visible";

/** 可见期轮询间隔：与 WorkBuddy 的账号状态轮询同一档（60 秒）。 */
export const VISIBLE_REVALIDATE_INTERVAL_MS = 60 * 1000;

/** 焦点 / 可见性触发的重取节流：alt-tab 抖动不该放大成请求风暴。 */
const FOCUS_MIN_INTERVAL_MS = 10 * 1000;

/**
 * 页面可见期间按固定节奏重取，并在重新获得焦点时立刻重取一次。
 *
 * 用于「后台任务直接改磁盘」的数据（账号库）：Trae 的 JWT 自动续期、Qoder 的保活
 * 都在页面之外写入，页面不重读就会一直停在旧快照上 —— 表现为凭据明明已续期，
 * 卡片仍显示「已过期 / 需重新登录」，只能靠用户手动刷新。
 *
 * 只做只读重取：不续期、不签到，也不改任何本地偏好。
 */
export function useVisibleRevalidate(revalidate: () => Promise<unknown>) {
  const visible = useDocumentVisible();
  const actionRef = useRef(revalidate);
  actionRef.current = revalidate;

  useEffect(() => {
    if (!visible) return;
    let lastAt = Number.NEGATIVE_INFINITY;

    function run() {
      lastAt = performance.now();
      void actionRef.current().catch(() => {});
    }

    function runOnEvent() {
      if (document.visibilityState === "hidden") return;
      if (performance.now() - lastAt < FOCUS_MIN_INTERVAL_MS) return;
      run();
    }

    /* 可见即重取一次：既覆盖「窗口从后台回来」，也不额外打后端 —— 本 hook 在
       `useCachedResource` 之后调用，挂载那一次会与首屏在飞请求同键合并。 */
    run();

    const timer = window.setInterval(run, VISIBLE_REVALIDATE_INTERVAL_MS);
    window.addEventListener("focus", runOnEvent);
    document.addEventListener("visibilitychange", runOnEvent);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", runOnEvent);
      document.removeEventListener("visibilitychange", runOnEvent);
    };
  }, [visible]);
}
