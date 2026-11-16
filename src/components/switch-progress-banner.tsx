/**
 * 账号切换的**页面级状态条**（三个账号页共用）。
 *
 * ## 放在页头下方、滚动时吸顶
 *
 * 切换通常从卡片 / 抽屉里的程序位按钮触发，用户的视线就在列表附近。右下角的 toast
 * 很容易被忽略（尤其是切到客户端窗口再回来时）。这条状态条挂在列表上方，切换期间
 * 通过 `sticky` 固定在滚动容器顶部 —— 列表再长也不会把「正在切换」滚出视野。
 *
 * ## 为什么是不确定进度条
 *
 * 后端的步骤时长差异极大（关客户端 0–20s、快照复制取决于文件数、客户端启动 5–30s），
 * 没有可靠的总步数可换算成百分比。画一条**来回滑动**的不确定条表示「还在动」，
 * 比编一个假的 37% 诚实（§3.5「不写假承诺」）。
 *
 * 完成 / 超时 / 失败三态不显示进度条，只留图标 + 文案：
 * 此时已没有「进度」可言，继续转圈反而让人以为还在进行。
 */

import { Check, Loader2, TriangleAlert } from "lucide-react";

import type { SwitchProgressState } from "@/lib/switch-progress";
import { cn } from "@/lib/utils";

export function SwitchProgressBanner({
  state,
  className,
}: {
  /** `null` = 没有进行中的切换。 */
  state: SwitchProgressState | null;
  className?: string;
}) {
  if (!state) return null;

  const active = state.phase === "switching" || state.phase === "launching";
  const warning = state.phase === "warning";
  const failed = state.phase === "failed";

  return (
    <div
      role="status"
      aria-live="polite"
      data-switch-phase={state.phase}
      className={cn(
        "sticky top-0 z-30 flex items-start gap-3 rounded-[12px] border px-3.5 py-3 shadow-card",
        active
          ? "border-border bg-card"
          : failed
            ? "border-destructive/40 bg-destructive/[0.06]"
            : warning
              ? "border-warning/40 bg-warning/[0.07]"
              : "border-success/40 bg-success/[0.06]",
        className,
      )}
    >
      {active ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      ) : warning ? (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      ) : failed ? (
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      )}

      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{state.title}</div>
        {state.detail ? (
          <div className="mt-0.5 break-words text-[11.5px] leading-relaxed text-muted-foreground">
            {state.detail}
          </div>
        ) : null}
        {active ? (
          <div
            role="progressbar"
            /* 不确定进度：没有 aria-valuenow，读屏只播报「正在进行」。 */
            aria-label={state.title}
            aria-valuetext={state.detail ?? state.title}
            className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full w-2/5 rounded-full bg-primary animate-progress-indeterminate motion-reduce:animate-none" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
