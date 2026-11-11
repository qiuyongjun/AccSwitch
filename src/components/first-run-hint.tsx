/**
 * 首次引导条 —— P6 / `P6-ARCH.md` §1.5。
 *
 * ## 内容：讲「怎么开始用」而不是「快捷键怎么按」
 *
 * 快捷键在命令面板入口 / 设置里都能查到，首次进入的用户更需要的是**基本流程**：
 * 选作用域 → 添加账号 → 切换程序位 → 一键刷新 / 签到。四步与页面上真实存在的
 * 控件逐字对应，不写「引导里有、界面找不到」的假承诺（§3.4 规则 1）。
 *
 * ⚠️ 早期版本列的是 `⌘K` / `⌘1..N` / `/`。实测首次用户看完仍不知道账号从哪来、
 * 程序位怎么切 —— 快捷键是**熟练后的加速器**，不是上手路径。
 *
 * 四步里的按钮名**不写死**：`添加账号` / `一键刷新` / `一键签到` 取自真实词条
 * （`shared.addDrawer.title` / `shared.toolbar.quickRefresh` / `quickCheckin`），
 * 界面改名时引导自动跟随，不会出现「引导里写着旧按钮名」。
 *
 * ## 形态与退场
 *
 * **底部居中浮层**（原型 `.hint`，`demo.css:538-547`：`fixed` + `bottom:20px` +
 * `left:50%` + `translateX(-50%)`、`rounded-[12px]`、底 `--popover`、`shadow-overlay`、
 * 字号 12px、`max-width: min(760px,94vw)`）。
 *
 * ⚠️ 原先是**顶部通栏**（`border-b` + 通栏底色）：它会把内容整体下推一截，且与页头
 * 争夺注意力。原型做成浮层正是为了「不挤压内容、不抢视觉重心」。
 *
 * ⚠️ 浮层会盖住底部内容 ⇒ 外层 `pointer-events-none` + 本体 `pointer-events-auto`，
 * 使浮层**空隙处**的点击能穿透到下面的卡片，不挡住操作。
 *
 * 关闭即**持久化**（`lib/first-run.ts`），下次冷启动不再出现。
 * 刻意不做「自动退场」—— 那会让每次冷启动都重来一遍。
 */

import { useState } from "react";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dismissFirstRunHint, shouldShowFirstRunHint } from "@/lib/first-run";
import { useT } from "@/lib/i18n";

/** 取可用的 `localStorage`（不可用返回 `undefined`）。 */
function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** 单步卡片：序号 + 动作名 + 一句说明（说明与标题左对齐，避免「密文感」）。 */
function StepItem({ index, title, description }: { index: number; title: string; description: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
          {index}
        </span>
        <span className="text-[11.5px] font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-1.5 pl-7 text-[11.5px] leading-[1.55] text-muted-foreground">{description}</p>
    </div>
  );
}

export function FirstRunHint() {
  const t = useT();
  const [dismissed, setDismissed] = useState(() => !shouldShowFirstRunHint(safeStorage()));

  if (dismissed) return null;

  const steps = [
    { title: t("firstRun.step.scope.title"), description: t("firstRun.step.scope.desc") },
    {
      title: t("firstRun.step.account.title"),
      description: t("firstRun.step.account.desc", { add: t("shared.addDrawer.title") }),
    },
    { title: t("firstRun.step.switch.title"), description: t("firstRun.step.switch.desc") },
    {
      title: t("firstRun.step.daily.title"),
      description: t("firstRun.step.daily.desc", {
        refresh: t("shared.toolbar.quickRefresh"),
        checkin: t("shared.toolbar.quickCheckin"),
      }),
    },
  ];

  function dismiss() {
    dismissFirstRunHint(safeStorage());
    setDismissed(true);
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <section
        aria-label={t("firstRun.title")}
        className="pointer-events-auto w-full max-w-[720px] animate-in rounded-2xl border border-border/80 bg-popover/95 p-4 shadow-overlay backdrop-blur-sm fade-in-0 slide-in-from-bottom-2 duration-300 motion-reduce:animate-none"
      >
        <header className="flex items-start gap-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold">{t("firstRun.title")}</h2>
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {t("firstRun.subtitle")}
            </p>
          </div>
          <div className="grow" />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={dismiss}
          >
            <X className="size-3.5" aria-hidden="true" />
            {t("firstRun.dismiss")}
          </Button>
        </header>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {steps.map((step, i) => (
            <StepItem key={step.title} index={i + 1} title={step.title} description={step.description} />
          ))}
        </div>
      </section>
    </div>
  );
}
