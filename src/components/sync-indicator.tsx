import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 页头「后台同步中」的**轻量**指示（三个账号页共用：WorkBuddy / Trae / Qoder）。
 *
 * ## 解决什么问题
 *
 * 三个账号页都是 stale-while-revalidate：有旧值时页面**立刻渲染旧数据**、请求在后台跑。
 * 这个取舍本身是对的（不闪骨架），但它缺了另一半 —— **后台正在刷新这件事不可见**。
 * 用户看到的就是「打开页面什么都不动，几秒钟后数据突然跳一下」。
 *
 * 数据层其实一直有判据（`AccountSlice.loading` / `CachedResource.pending`），
 * 只是它们被当成**骨架屏判据**用（`loading && totalCount === 0`），
 * 有旧值时恒为「看不出在加载」。本组件就是把那个判据接到**一枚小字**上。
 *
 * ## 三条设计约束（改之前先读）
 *
 * 1. **不顶掉内容**：不弹遮罩、不换骨架、不整页转圈 —— 有读数就继续显示读数，
 *    这里只是旁边补一句「正在同步…」。§12.1 的「首屏不转圈」仍然成立。
 * 2. **不闪**：真实请求常在 50–300ms 内返回，若跟着真实耗时走，spinner 会一帧而过
 *    （感官上仍等于没反馈，见 `lib/use-refresh-action.ts` 同一条教训）。因此有
 *    {@link MIN_VISIBLE_MS} 的最短展示窗口。
 * 3. **不平移布局**：挂在页头副标题那一行**行内**（`flex-wrap` 的小字），
 *    出现 / 消失只是这一行自己多几个字，列表不会上下跳。
 *
 * ## 完成态（「已更新」）
 *
 * 同步结束后短暂亮一下「已更新」（{@link DONE_VISIBLE_MS}），回答用户
 * 「刚才那一下跳变是什么」—— 否则「突然更新」永远是个没有解释的事件。
 * **不常驻**：常驻时间戳会让页头多一列永远在变的小字，价值低于噪声。
 *
 * ## 与卡片的分工（2026-11-19，用户拍板）
 *
 * 本组件是**环境态**：只回答「现在在同步吗」，不回答「哪个账号」。
 * 逐账号「我点的这一项刷到哪一步」归**因果态**，留在交互点自己回话：菜单项
 * 「刷新中… → 已更新」、按钮内小转圈、批量进度 / 结果条 / toast。
 * 卡片正文**不**再出现 loading（2026-11-17 撤掉逐卡「积分查询中…」）。
 * ⇒ 判据必须覆盖**全部**加载路径，否则撤掉逐卡指示后那段刷新就彻底静默：
 * WorkBuddy 侧是 `loading || refreshingCredits || creditBusy`，其中 `creditBusy`
 * （任一账号的 `creditLoadingMap`）专门补「非 force」的 TTL / 失败重试 ——
 * `refreshingCredits` 只在强刷时置位。Trae / Qoder 的资源 `pending` 本来就覆盖全部加载。
 */
const MIN_VISIBLE_MS = 500;
const DONE_VISIBLE_MS = 2400;

export interface SyncIndicatorProps {
  /** 是否有后台请求在飞（判据由页面提供，见各页调用点）。 */
  syncing: boolean;
  className?: string;
}

export function SyncIndicator({ syncing, className }: SyncIndicatorProps) {
  const t = useT();

  /**
   * 最短展示窗口：`syncing` 为真的那一刻起至少可见 {@link MIN_VISIBLE_MS}。
   *
   * 与 `useRefreshAction` 的 `minSpinMs` 同一思路，但**不能直接复用那个 hook**：
   * 它的 `busy` 由调用方手动 `run()` 驱动，而这里的状态是**外部数据流**给的
   * （store / resource 的 pending），没有「动作开始」这个可挂钩的时机。
   *
   * ⚠️ 收尾的补足计时器**必须放在 `syncing` 变 false 的那次 effect 里**，
   * 不能在「变 true」时起一个 `setTimeout(setHolding(false))` 再指望它活到点 ——
   * 那个 timer 会随着 `syncing` 翻转被 cleanup 掉，结果快请求结束时
   * `holding` 永远为 true，指示器停不下来（首版实现踩到过）。
   */
  const [active, setActive] = useState(syncing);
  const startedAtRef = useRef(0);
  useEffect(() => {
    if (syncing) {
      startedAtRef.current = Date.now();
      setActive(true);
      return;
    }
    const remaining = MIN_VISIBLE_MS - (Date.now() - startedAtRef.current);
    if (remaining <= 0) {
      setActive(false);
      return;
    }
    const timer = setTimeout(() => setActive(false), remaining);
    return () => clearTimeout(timer);
  }, [syncing]);

  /** 结束瞬间亮一下「已更新」。`wasActive` 初值跟随首帧，挂载/重挂载时不会误报。 */
  const [done, setDone] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) setDone(true);
    wasActive.current = active;
  }, [active]);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  if (active) {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn("inline-flex items-center gap-1.5", className)}
      >
        {/* 与副标题里「· N 个账号」同一分隔记号，行内读起来是一句话而不是一个新控件。 */}
        <span aria-hidden="true">·</span>
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        {t("shared.sync.syncing")}
      </span>
    );
  }

  if (done) {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn("inline-flex items-center gap-1.5", className)}
      >
        <span aria-hidden="true">·</span>
        <Check className="size-3" aria-hidden="true" />
        {t("shared.sync.done")}
      </span>
    );
  }

  return null;
}
