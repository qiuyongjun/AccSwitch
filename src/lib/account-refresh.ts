"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 账号「单项刷新」的共用契约（三平台卡片 + 详情抽屉都按这一套来）。
 *
 * ## 为什么是**多项**而不是一个「刷新全部」
 *
 * 各类数据来自**不同层**，耗时与失败原因都不一样：
 *
 * | 项 | 数据来源 | 特点 |
 * |:--|:--|:--|
 * | `credits` | 上游接口（查剩余积分 / 到期） | 最慢，可能被限流 |
 * | `travel` | 上游接口（旅行 / 加速器状态） | 逐账号，webui 下一次批量；**仅 WorkBuddy** |
 * | `tokens` | 本机客户端日志 + 网关日志 | 快，离线可读。**⚠️ 已无界面入口，仅保留类型与文案** |
 * | `checkin` | 本机签到记录 | 快 |
 * | `credential` | 本机账号库（JWT 有效期 / 需重登） | 最快；**实际重取整个账号库**（`getAccounts` 无单账号变体），菜单 tooltip 已标注「刷新所有账号」 |
 *
 * 合成一个动作时，慢的拖住快的，而且失败原因分不清 —— 凭据过期的账号其实只有
 * 「凭据状态」能刷出真值，另外三项必然失败。拆开之后用户能只刷要用的那项，
 * 也能从失败项里看出卡在哪一层（判据见 `docs/specs/PLAN.md` §3.3）。
 *
 * ★ 2026-10-26（用户要求）：**「刷新今日 Token」不再出现在任何刷新菜单**——
 * 卡片已不展示今日 Token，菜单里留入口会让人以为有东西会变。`tokens` 这个 kind
 * 因而**不在** {@link ACCOUNT_REFRESH_KINDS} 里 —— 那个常量是**菜单可见项**的顺序来源。
 * ★ 2026-10-29（用户要求）：抽屉概览的「今日 Token」行也已移除 ⇒ `tokens` 连
 * 「指标块上的刷新按钮」这最后一处入口都没有了（三平台账号页均不再调用它）。
 * 类型与 {@link REFRESH_DONE_LABEL} 里的字面量暂留：`AccountRefreshKind` 是公开契约、
 * 删一项会牵动卡片与菜单的图标/文案表；等真有第二处 UI 需要「今日 Token」时再按现状接回。
 *
 * ★ 2026-10-26 新增 `travel`（用户要求）：旅行状态此前**只有「一键刷新」会写**
 * （另一条路径是「续期凭据」顺带刷一次），单账号与批量都没有入口 —— 于是一枚
 * 可见的卡片 chip（`TravelStatusBadge`）只能靠「刷新全部账号」更新。补成菜单项后，
 * 三个作用域对旅行状态的口径一致；Trae / Qoder 没有旅行概念，不传即不渲染。
 *
 * ## 为什么按「账号 + 项」记进行中，而不是一个全局布尔
 *
 * 列表里可能同时有多个账号在刷，同一个账号也可能同时刷两项（比如先刷凭据再刷积分）。
 * 用一个布尔会让后开始的把先开始的转圈吞掉；用一个 `Set<accountId>` 又会让
 * 「点了积分，全部项一起转」。所以键是 `id:kind`。
 */
export type AccountRefreshKind = "credits" | "tokens" | "travel" | "checkin" | "credential";

/**
 * **菜单里能出现**的刷新项，固定顺序（图标 / 文案的过滤依据）。
 *
 * ⚠️ 不含 `tokens`：它已从所有刷新菜单移除（见文件头）。若要恢复，需先在
 * `components/account-menu-parts.tsx` 的 `REFRESH_ITEMS` 里补回一行，否则过滤后仍不渲染。
 * ⚠️ 含 `travel`，但 Trae / Qoder 的 `refreshKinds` 显式不含它 ⇒ 那两侧不渲染。
 */
export const ACCOUNT_REFRESH_KINDS: readonly AccountRefreshKind[] = [
  "credits",
  "travel",
  "checkin",
  "credential",
] as const;

const keyOf = (accountId: string, kind: AccountRefreshKind) => `${accountId}:${kind}`;

/**
 * 各项的成功文案键。
 *
 * 写死成字面量是为了让 `t()` 的**编译期键校验**生效（拼错 key 会直接报错，而不是静默回退成 key 本身）；
 * 也避免三个页面各自写一份「已刷新」的措辞 —— 用户需要知道刷的是哪一层。
 */
export const REFRESH_DONE_LABEL = {
  credits: "shared.refreshPart.credits",
  tokens: "shared.refreshPart.tokens",
  travel: "shared.refreshPart.travel",
  checkin: "shared.refreshPart.checkin",
  credential: "shared.refreshPart.credential",
} as const;

/**
 * 进行中态的小 hook。
 *
 * 用法：
 * ```tsx
 * const refresh = useAccountRefreshBusy();
 * const onRefreshPart = (a, kind) => refresh.run(a.id, kind, () => api.xxx(...));
 * <AccountCard refreshingKinds={refresh.kindsOf(a.id)} onRefreshPart={onRefreshPart} />
 * ```
 *
 * ⚠️ `kindsOf` 每次返回**新数组**：调用方不要把它放进 `useMemo`/`useEffect` 依赖里
 * （会每次重算）。卡片只需要读它来决定哪一项显示转圈。
 */
/**
 * 「已更新」的停留时长（ms）。
 *
 * ⚠️ 它是**刚刚发生了什么**的反馈，不是常驻状态（原型同样只留 900ms）：
 * 常驻会让用户以为「这个值只在我点的那一刻是对的」。
 */
export const REFRESH_DONE_MS = 900;

export function useAccountRefreshBusy() {
  const [busy, setBusy] = useState<Map<string, Set<AccountRefreshKind>>>(() => new Map());
  const [done, setDone] = useState<Map<string, Set<AccountRefreshKind>>>(() => new Map());
  /** 定时器句柄：同一项重复刷新时先撤掉旧的，避免「早就撤了却被旧定时器清了新状态」。 */
  const doneTimers = useRef(new Map<string, number>());
  /**
   * 在途去重（**同步**判据）。
   *
   * `busy` 是 React state，第二次点击可能发生在它生效之前（同一帧内的连点 / 菜单 + 指标块
   * 两个入口）—— 只靠 `busy` 会并发打两次上游。这里用 ref 做同步闸门，键与 `busy` 同形。
   * 作用域由**组件实例**承担（账号页按 scope 键控重挂载），因此键里不需要再拼 scope。
   */
  const inFlight = useRef(new Set<string>());

  const setOne = useCallback((accountId: string, kind: AccountRefreshKind, on: boolean) => {
    setBusy((prev) => {
      const current = prev.get(accountId);
      if (on) {
        if (current?.has(kind)) return prev;
        const next = new Map(prev);
        const set = new Set(current ?? []);
        set.add(kind);
        next.set(accountId, set);
        return next;
      }
      if (!current?.has(kind)) return prev;
      const next = new Map(prev);
      const set = new Set(current);
      set.delete(kind);
      if (set.size === 0) next.delete(accountId);
      else next.set(accountId, set);
      return next;
    });
  }, []);

  const kindsOf = useCallback(
    (accountId: string): AccountRefreshKind[] => {
      const set = busy.get(accountId);
      return set ? [...set] : [];
    },
    [busy],
  );

  const isBusy = useCallback(
    (accountId: string, kind: AccountRefreshKind): boolean => busy.get(accountId)?.has(kind) ?? false,
    [busy],
  );

  /** 置 / 清「已更新」。 */
  const markDone = useCallback((accountId: string, kind: AccountRefreshKind, on: boolean) => {
    setDone((prev) => {
      const current = prev.get(accountId);
      if (on) {
        const set = new Set(current ?? []);
        set.add(kind);
        const next = new Map(prev);
        next.set(accountId, set);
        return next;
      }
      if (!current?.has(kind)) return prev;
      const next = new Map(prev);
      const set = new Set(current);
      set.delete(kind);
      if (set.size === 0) next.delete(accountId);
      else next.set(accountId, set);
      return next;
    });
  }, []);

  const doneKindsOf = useCallback(
    (accountId: string): AccountRefreshKind[] => {
      const set = done.get(accountId);
      return set ? [...set] : [];
    },
    [done],
  );

  /**
   * 跑一次单项刷新：先标记进行中，**无论成功失败都撤掉**（`finally`）。
   *
   * 成功后才亮 {@link REFRESH_DONE_MS} 毫秒的「已更新」。以下三种结果**都不算成功**：
   * 任务抛错、任务返回 `false`（缺目标条目 / `ok:false` / 快照读取失败）、同一项已在途。
   * 失败的处理（toast / 重试）交给调用方 —— 这个 hook 只管状态。
   *
   * 返回 `true` = 真的刷新成功；`false` = 没跑（已在途）或没拿到可信结果。
   */
  const run = useCallback(
    async (
      accountId: string,
      kind: AccountRefreshKind,
      task: () => Promise<unknown>,
    ): Promise<boolean> => {
      const key = keyOf(accountId, kind);
      /* 同一账号 + 同一动作在途 ⇒ 直接拒绝第二次，避免并发消耗材料 / 打两次上游。 */
      if (inFlight.current.has(key)) return false;
      inFlight.current.add(key);
      setOne(accountId, kind, true);
      try {
        const outcome = await task();
        /* `false` 是调用方的「没拿到可信数据」信号（不是异常）⇒ 不亮「已更新」。 */
        if (outcome === false) return false;
        markDone(accountId, kind, true);
        const previous = doneTimers.current.get(key);
        if (previous !== undefined) window.clearTimeout(previous);
        doneTimers.current.set(
          key,
          window.setTimeout(() => {
            markDone(accountId, kind, false);
            doneTimers.current.delete(key);
          }, REFRESH_DONE_MS),
        );
        return true;
      } finally {
        inFlight.current.delete(key);
        setOne(accountId, kind, false);
      }
    },
    [setOne, markDone],
  );

  /* 卸载时清掉所有「已更新」计时器：页面按作用域重挂载，残留计时器会写已卸载实例的 state。 */
  useEffect(() => {
    const timers = doneTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { kindsOf, doneKindsOf, isBusy, run, keyOf };
}
