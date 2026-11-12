import { useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { useLocation } from "react-router-dom";

import * as api from "@/lib/api";
import { platformOfPath } from "@/lib/platforms/registry";
import { readLastScope } from "@/lib/scope";
import type { Region } from "@/lib/types";
import { resolveRegion } from "@/lib/use-scope";
import { selectRegionSlice, useAccountsStore } from "@/stores/accounts";

/**
 * 界面积分的**新鲜度窗口**。
 *
 * 用户明确表示「通常自己点一键刷新」，因此这里不再保留 30 分钟静默定时器
 * （那会在任何页面、任何时间对全部账号打一轮上游，且用户完全看不见）。
 * 只在**进入 WorkBuddy 账号页**或窗口重新可见时检查一次：
 * - 距上次**覆盖全区的强制刷新**超过本窗口 ⇒ 强制刷新该区域；
 * - 否则只补「从未取到 / 上次失败」的条目，成功过的值不重复请求。
 *
 * ⚠️ 判据读 `creditFullRefreshedAt`，**不是** `creditRefreshedAt`：后者的写入方包含
 * `ensureCredits`（只补失败账号），存在长期失败账号时会 60 秒一次地把它推后，
 * 让这个窗口永远判定为「还新鲜」—— TTL 形同虚设。
 *
 * 路由数据（网关选号权重、Trae 自动解冻）仍由后端后台循环刷新，与本钩子无关。
 */
export const CREDIT_REFRESH_TTL_MS = 15 * 60 * 1000;

/** 只认「WorkBuddy 账号页」：新作用域路由 `/s/wb-<region>/accounts` 与旧扁平路由。 */
function isWorkbuddyAccountsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (platformOfPath(path) !== "workbuddy") return false;
  const scoped = /^\/s\/[^/]+\/([^/]+)/.exec(path);
  if (scoped) return scoped[1] === "accounts";
  /* `/overview` 是已移除概览页的旧书签，落到账号页（见 `destinationOfLegacyPath`）。 */
  return path === "/" || path === "/accounts" || path === "/overview";
}

/** 当前页面对应的区域 —— 与 `useScope` 同一套优先级（路径 scope > `?region=` > 记忆）。 */
function activeRegionOf(pathname: string, search: string): Region {
  const pathScope = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  return resolveRegion({
    pathScope,
    urlValue: new URLSearchParams(search).get("region"),
    rememberedScope: readLastScope(window.localStorage),
    product: "workbuddy",
  });
}

/** 只刷新**当前可见区域**：切到国际版时不该顺带给国内版打一轮上游。 */
function refreshIfStale(region: Region) {
  const state = useAccountsStore.getState();
  const { accounts } = selectRegionSlice(state, region);
  const ids = accounts.map((account) => account.id);
  if (ids.length === 0) return;
  const last = state.creditFullRefreshedAt[region] ?? 0;
  if (last === 0 || Date.now() - last >= CREDIT_REFRESH_TTL_MS) {
    /* 不静默：进入页面就是可见上下文，静默刷新让用户看不出在刷新，
       只好再点一次「一键刷新」（白打一轮上游）。卡片对 loading 的处理是
       「有读数不顶掉内容、下方补一行小字」，不会闪烁。 */
    void state.refreshCredits(ids, { region });
  } else {
    void state.ensureCredits(ids, region);
  }
}

export function useCreditAutoRefresh() {
  const location = useLocation();
  /* 用 pathname 做依赖：切换区域（`/s/wb-cn/accounts` → `/s/wb-global/accounts`）
     也应重新检查一次新鲜度，而不是只在「进入 / 离开账号页」时检查。 */
  const activePath = isWorkbuddyAccountsPath(location.pathname) ? location.pathname : null;
  const region = useMemo(
    () => (activePath ? activeRegionOf(location.pathname, location.search) : null),
    [activePath, location.pathname, location.search],
  );

  useEffect(() => {
    if (!activePath || !region) return;
    const targetRegion: Region = region;
    let disposed = false;
    let visible = document.visibilityState !== "hidden";

    function refresh() {
      if (disposed || !visible) return;
      refreshIfStale(targetRegion);
    }

    refresh();

    const onVisibility = () => {
      visible = document.visibilityState !== "hidden";
      if (visible) refresh();
    };
    /* 切回本窗口也算「回来了」：WebView 的 visibilitychange 不一定在切焦点时触发。 */
    const onFocus = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    let unlisten: (() => void) | undefined;
    if (!api.isWebui()) {
      void listen<boolean>("main-window-visible", (event) => {
        visible = event.payload;
        if (visible) refresh();
      }).then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      });
    }

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      unlisten?.();
    };
  }, [activePath, region]);
}
