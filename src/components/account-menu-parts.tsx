"use client";

import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Loader2, PlaneTakeoff, type LucideIcon } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ACCOUNT_REFRESH_KINDS, REFRESH_DONE_MS, type AccountRefreshKind } from "@/lib/account-refresh";
import { useT } from "@/lib/i18n";
import { CheckinIcon, CreditsIcon, GrowthTaskIcon } from "@/lib/semantic-icons";
import { cn } from "@/lib/utils";

/**
 * 卡片「更多」菜单里三平台共用的积木：**头部 / 分组小标题 / 刷新项 / 不可用状态行 / 结尾提示**。
 *
 * ## 为什么要抽出来
 *
 * WorkBuddy / Trae / Qoder 三张卡片的菜单结构一样、图标与文案也一样。各写一份的下场
 * 在本仓已经出现过多次（`gateway-snippets`、抽屉壳）：三处会立刻在文案、禁用逻辑、
 * 进行中态上漂移。所以「刷新项」只在这里定义一次，卡片与批量条只负责把它们摆进菜单。
 *
 * ## 菜单为什么**不自动关闭**（与原型 `acctMenuInner` 同一决定）
 *
 * 刷完一项还想刷下一项很常见（先看凭据，再决定要不要刷积分）。Radix 默认选中即关：
 * 一次刷新要重新点开菜单，而且「刷新中 / 已更新」这两个状态只在菜单里看得见。
 * 所以刷新项 `preventDefault()` 保持菜单打开；其余动作（签到 / 导出 / 删除）仍按默认关闭。
 *
 * ## ★ 刷新菜单只放**只读项**（2026-10-26 用户要求，覆盖原型）
 *
 * | 项 | 数据来源 | 特点 |
 * |:--|:--|:--|
 * | 积分 `credits` | 上游接口 | 最慢，可能被限流 |
 * | 旅行 `travel` | 上游接口（旅行 / 加速器状态） | 逐账号重读；**仅 WorkBuddy** |
 * | 签到状态 `checkin` | 本机签到记录 / 上游状态端点 | 快 |
 * | 凭证状态 `credential` | 本机账号库（JWT 有效期 / 需重登） | 最快；**实际重取整个账号库**（无单账号接口），tooltip 已如实标注 |
 * | 任务 `RefreshTasksItem` | 上游任务摘要（仅 WB·CN） | 重扫「可领 / 可自动」，**不执行任务** |
 *
 * 三条硬约束：
 *
 * 1. **「刷新今日 Token」不再进任何菜单**。卡片已不展示今日 Token，菜单里留入口会让人
 *    以为有东西会变。`AccountRefreshKind` 仍保留 `tokens`（类型契约），但它不在
 *    {@link REFRESH_ITEMS} 里 ⇒ 菜单渲染不出来；★ 2026-10-29 起账号页也没有任何
 *    「今日 Token」读数需要重读。
 * 2. **写操作不出现在刷新组**。「续期凭据」（写 `refresh_token`）与「签到」「完成任务」
 *    一样是账号级动作，一律摆在刷新菜单**外部**（单账号在「账号」组，批量在批量条按钮行）。
 * 3. 刷新组与「任务」项**同一分组、无分隔线** —— 任务摘要也是「重读上游现成数据」，
 *    语义与其余刷新项同类，不是另一个动作族。
 *
 * 为什么不合成一个「刷新全部」：四类数据来自不同层，快慢与失败原因都不同；合并后
 * 慢的拖住快的，而且失败时分不清卡在哪一层（见 `lib/account-refresh.ts` 文件头）。
 */

/** 菜单头部：账号名（原型 `.am-head`）。点它没有动作，只说明「这些操作作用于谁」。 */
export function MenuHead({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-1.5 text-[11.5px] font-medium text-muted-foreground">{children}</div>;
}

/** 分组小标题（原型 `.am-grp`）。 */
export function MenuGroupLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  /* 不用 `DropdownMenuLabel`：本仓的 `ui/dropdown-menu` 没有导出它（只有 Menu / Item /
     Separator / Trigger / Content），为了一个 `<div>` 去改原语不划算。 */
  return (
    <div
      role="presentation"
      className={cn("px-2 pt-1 pb-0.5 text-[10.5px] font-normal tracking-wide text-muted-foreground", className)}
    >
      {children}
    </div>
  );
}

/** 菜单结尾提示（原型 `.am-note`）：告诉用户备注与登录态在哪，省得再找。 */
export function MenuNote({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1.5 text-[10.5px] leading-snug text-muted-foreground/80">{children}</div>;
}

/** 不可用的状态行（原型里「今日已签到」「需先登录」两态共用这个形状）。 */
export function MenuStateItem({
  icon,
  children,
  hint,
  state,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  /** 悬停解释（禁用项的 `title`，Radix 不会吞掉）。 */
  hint?: string;
  /** 右对齐的状态词（如「需先登录」）。 */
  state?: string;
}) {
  return (
    <div
      role="menuitem"
      aria-disabled
      title={hint}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground"
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {state ? <span className="ml-2 shrink-0 text-[10.5px] opacity-80">{state}</span> : null}
    </div>
  );
}

const REFRESH_ITEMS = [
  /* ★ 2026-10-26（用户反馈）：积分项改用积分概念的那一枚（`CreditsIcon`），不再用通用
     `RefreshCw` —— 每一项各自回答「刷的是哪层数据」，而通用刷新箭头让它看起来像「整组刷新」。 */
  { kind: "credits", icon: CreditsIcon, labelKey: "shared.cardMenu.refresh.credits", hintKey: "shared.cardMenu.refresh.creditsHint" },
  /* ★ 2026-10-26（用户要求）：旅行状态补进菜单 —— 此前它**只有「一键刷新」会写**，
     卡片上却挂着一枚可见的 travel chip，单账号 / 批量都无从更新。仅 WorkBuddy 有该概念，
     Trae / Qoder 的 `refreshKinds` 不含 `travel` ⇒ 过滤后不渲染。 */
  { kind: "travel", icon: PlaneTakeoff, labelKey: "shared.cardMenu.refresh.travel", hintKey: "shared.cardMenu.refresh.travelHint" },
  /* ★ 「签到」在刷新组里也用签到概念的那一枚（`CheckinIcon`）：每一项刷新图标各自回答
     「这一项刷的是哪层数据」，签到项此前用 `Sparkles`（与成长任务的自动完成同形）⇒
     读者会以为它是「智能/自动」类动作，而不是「重读签到状态」。 */
  { kind: "checkin", icon: CheckinIcon, labelKey: "shared.cardMenu.refresh.checkin", hintKey: "shared.cardMenu.refresh.checkinHint" },
  { kind: "credential", icon: KeyRound, labelKey: "shared.cardMenu.refresh.credential", hintKey: "shared.cardMenu.refresh.credentialHint" },
] as const satisfies ReadonlyArray<{
  kind: AccountRefreshKind;
  icon: LucideIcon;
  labelKey: string;
  hintKey: string;
}>;

export function RefreshMenuGroup({
  refreshingKinds,
  doneKinds,
  kinds = ACCOUNT_REFRESH_KINDS,
  disabled = false,
  onPick,
}: {
  /** 本账号正在进行中的刷新项。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刚刷新成功（会自行淡出）的项。 */
  doneKinds?: readonly AccountRefreshKind[];
  /**
   * 本平台**真的能刷**的项（默认 {@link ACCOUNT_REFRESH_KINDS}）。`tokens` 传进来也不会渲染
   * —— {@link REFRESH_ITEMS} 里没有它（2026-10-26 起「刷新今日 Token」不再进菜单）。
   *
   * ⚠️ 这是「不许假装」的闸门：没有该项的只读重取接口时，宁可少给一项，
   * 也不要摆一个点了只会重读缓存的菜单项。
   */
  kinds?: readonly AccountRefreshKind[];
  /** 外部动作进行中时整体禁用（批量条复用本组时使用）。 */
  disabled?: boolean;
  onPick: (kind: AccountRefreshKind) => void;
}) {
  const t = useT();
  const items = REFRESH_ITEMS.filter((item) => kinds.includes(item.kind));
  if (items.length === 0) return null;
  return (
    <>
      <MenuGroupLabel>{t("shared.cardMenu.refreshGroup")}</MenuGroupLabel>
      {items.map(({ kind, icon: Icon, labelKey, hintKey }) => {
        const busy = refreshingKinds?.includes(kind) ?? false;
        const done = doneKinds?.includes(kind) ?? false;
        return (
          <DropdownMenuItem
            key={kind}
            disabled={disabled || busy}
            title={t(hintKey)}
            /* ⚠️ 保菜单开着：刷完一项常常接着刷下一项，且「刷新中 / 已更新」只有菜单里看得见。 */
            onSelect={(event) => {
              event.preventDefault();
              onPick(kind);
            }}
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {busy ? <Loader2 className="size-4 animate-spin" /> : done ? <Check className="size-4 text-primary" /> : <Icon />}
            </span>
            <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
            {busy ? (
              <span className="ml-2 shrink-0 text-[10.5px] text-muted-foreground">{t("shared.cardMenu.busy")}</span>
            ) : done ? (
              <span className="ml-2 shrink-0 text-[10.5px] text-primary">{t("shared.cardMenu.done")}</span>
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * 刷新组里的「任务」项（**仅 WorkBuddy 国内版注入**）。
 *
 * 它不是 `AccountRefreshKind`：那几项重读的是「某一层现成数据」，而这项是
 * `growth_tasks_scan(force)` —— 让上游**重扫**该账号的任务摘要（更新卡片上的
 * 「可领 / 可自动」），**不执行任何任务**（执行走外部的「完成任务」）。
 *
 * 抽成组件是因为**批量条与单账号菜单必须是同一项**（2026-10-26 用户要求两者同步）：
 * 此前批量条叫「刷新成长任务状态」、单账号叫「刷新任务」，还分处不同分隔线两侧。
 *
 * ⚠️ 「已更新」在本组件内部自管：`onPick` 返回 `false` 视为失败，不亮对勾（由调用方 toast）。
 */
export function RefreshTasksItem({
  busy = false,
  disabled = false,
  onPick,
}: {
  /** 外部另有进行中动作（批量条的 `busy`）——转圈与禁用都算上。 */
  busy?: boolean;
  /** 外部禁用（演示模式 / 批量忙态）。 */
  disabled?: boolean;
  onPick: () => void | Promise<boolean | void>;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const doneTimer = useRef<number | null>(null);
  const active = running || busy;

  useEffect(
    () => () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    },
    [],
  );

  async function run() {
    if (disabled || active) return;
    setRunning(true);
    try {
      const ok = await onPick();
      if (ok === false) return;
      setDone(true);
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
      doneTimer.current = window.setTimeout(() => setDone(false), REFRESH_DONE_MS);
    } finally {
      setRunning(false);
    }
  }

  return (
    <DropdownMenuItem
      disabled={disabled || active}
      title={t("shared.cardMenu.refresh.tasksHint")}
      /* ⚠️ 保菜单开着：转圈 / 已更新只有菜单里看得见（与其余刷新项一致）。 */
      onSelect={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {active ? (
          <Loader2 className="size-4 animate-spin" />
        ) : done ? (
          <Check className="size-4 text-primary" />
        ) : (
          <GrowthTaskIcon className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{t("shared.cardMenu.refresh.tasks")}</span>
      {active ? (
        <span className="ml-2 shrink-0 text-[10.5px] text-muted-foreground">{t("shared.cardMenu.busy")}</span>
      ) : done ? (
        <span className="ml-2 shrink-0 text-[10.5px] text-primary">{t("shared.cardMenu.done")}</span>
      ) : null}
    </DropdownMenuItem>
  );
}

/** 顺序对外暴露一份，供调用方做类型收窄（不必再 import 数组常量）。 */
export { ACCOUNT_REFRESH_KINDS };
