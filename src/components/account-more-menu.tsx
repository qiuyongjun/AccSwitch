"use client";

import { useState } from "react";
import { Download, Ellipsis, KeyRound, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuGroupLabel, MenuHead, MenuNote, MenuStateItem, RefreshMenuGroup } from "@/components/account-menu-parts";
import { DemoAction } from "@/components/demo-action";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import type { GrowthTaskSummary } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { CheckinIcon, GrowthTaskIcon } from "@/lib/semantic-icons";

/**
 * 账号的「更多」菜单（**卡片与表格共用同一份**）。
 *
 * ## 为什么抽成组件而不是两处各写一遍
 *
 * 表格视图与卡片视图列的是同一批账号、同一批动作。此前只有卡片有菜单，于是用户在表格里
 * 只能「点行进详情」再找动作 —— 这是「同一能力两种形态」的经典分叉。共用一份组件后：
 * 菜单结构、文案、禁用逻辑、进行中态只有一处定义，加一项动作不会漏掉另一个视图。
 *
 * ## 结构逐项对齐原型 `acctMenuInner`
 *
 * 头部（账号名）· 刷新组（四项只读 + 续期凭据）· 账号组（签到三态 / 导出账号）· 删除 · 结尾提示。
 * **两边不一致时以原型为准** —— 原型是设计评审通过的那一版。
 *
 * ★ 2026-10-23：「账号」组里**多**一项「完成任务」（成长任务，仅 WB·CN 注入）——
 * 用户要求的快捷入口，原型尚未收录；不是漂移，别照着原型把它删掉。
 *
 * ## ★ 刷新组里为什么同时有「四项只读」与「续期凭据」
 *
 * 两者是**两类动作**：四项只读刷新（积分 / 今日 Token / 签到 / 凭据）只重读本地或上游的
 * 现成数据；「续期凭据」是**写**操作（用 `refresh_token` 续期登录凭据）。混成一项会让
 * 用户以为点「刷新积分」就会顺带续期。
 *
 * 2026-10-23 用户要求**卡片与表格的菜单也要能续期**（此前只有详情抽屉有）——
 * 因此抽屉与菜单**并存**该动作。判据是「同一个动作不在**同一作用域**内重复」：
 * 全量（页头一键）/ 勾选（批量条）/ 单账号（卡片菜单 + 抽屉）是三个作用域，
 * 单账号这一层里，菜单是「一步做完」的入口，抽屉给的是「看清楚再决定」的入口。
 *
 * ⚠️ 菜单里**没有**「查看详情」：原型把「打开详情」放在卡片/行的整体点击上，
 * 再摆一枚同义按钮就是两个入口做同一件事。
 */
export interface AccountMoreMenuProps {
  /** 账号展示名（已过 `displayText`）。 */
  accountName: string;
  /** 单项刷新；不传 ⇒ 退回旧的单条「续期凭据」项（向后兼容）。 */
  onRefreshPart?: (kind: AccountRefreshKind) => void;
  refreshingKinds?: readonly AccountRefreshKind[];
  doneKinds?: readonly AccountRefreshKind[];
  refreshKinds?: readonly AccountRefreshKind[];
  /**
   * 续期凭据（写 `refresh_token`）。
   *
   * 与四项只读刷新并列成项（见文件头）；`onRefreshPart` 缺省时退回「只有这一项」的旧形态。
   */
  onRefresh?: () => void;
  /** 续期进行中（该项转圈并禁用重复点击）。 */
  refreshingToken?: boolean;
  /** 今日签到状态：`true` 已签 / `false` 未签 / `undefined` 未知（未知 ⇒ 不显示签到行）。 */
  todayCheckedIn?: boolean;
  /** 凭据已过期（与 `needsRelogin` 一起决定「需先登录」态）。 */
  expired?: boolean;
  needsRelogin?: boolean;
  onCheckin?: () => void;
  /**
   * 「完成任务」：对该账号执行「一键完成」（报名 → 点亮 → 回读 → 领奖）。
   *
   * 不传 ⇒ **不渲染**该项 —— 成长任务只有 WorkBuddy 国内版有，别的平台摆一个
   * 永远禁用的入口比没有更差。
   */
  onCompleteTasks?: () => void | Promise<void>;
  /**
   * 该账号的成长任务摘要：决定「完成任务」是否可用，以及右侧的「可领 N / 可自动 N」。
   * `undefined` = 还没扫到（此时禁用并说明「稍后再试」，不猜）。
   */
  growthHint?: GrowthTaskSummary | null;
  onExport?: () => void;
  onDelete: () => void;
  /** 演示模式下把菜单整体禁用（与卡片一致）。 */
  featuresDisabled?: boolean;
  /** 触发按钮的尺寸（表格里用更紧凑的）。 */
  compact?: boolean;
}

export function AccountMoreMenu({
  accountName,
  onRefreshPart,
  refreshingKinds,
  doneKinds,
  refreshKinds,
  onRefresh,
  refreshingToken = false,
  todayCheckedIn,
  expired,
  needsRelogin,
  onCheckin,
  onCompleteTasks,
  growthHint,
  onExport,
  onDelete,
  featuresDisabled = false,
  compact = false,
}: AccountMoreMenuProps) {
  const t = useT();
  const [tasksBusy, setTasksBusy] = useState(false);
  const credentialDead = Boolean(expired) || Boolean(needsRelogin);

  /**
   * 「完成任务」的可用性。
   *
   * 三态口径与卡片上的任务标签**同源**（`growthHint`）：`idle` / 计数为 0 ⇒ 没有可做的；
   * 摘要还没回来（`undefined`）⇒ **禁用并说明「稍后再试」** —— 不把「不知道」当成「没有」。
   * `ok:false`（凭据失效 / 无成长体系）同样不可点，原因由 `title` 交代。
   */
  const tasksClaimable = growthHint?.ok && !growthHint.idle ? growthHint.claimable : 0;
  const tasksAutoable = growthHint?.ok && !growthHint.idle ? growthHint.autoable : 0;
  const tasksKnown = growthHint !== undefined && growthHint !== null && growthHint.ok;
  const tasksActionable = tasksClaimable > 0 || tasksAutoable > 0;

  async function runCompleteTasks() {
    if (!onCompleteTasks || tasksBusy) return;
    setTasksBusy(true);
    try {
      await onCompleteTasks();
    } finally {
      setTasksBusy(false);
    }
  }

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className={compact ? "!size-7 !px-0" : "!px-[10px]"}
      aria-label={t("wbAccounts.card.manageAria", { name: accountName })}
      title={t("wbAccounts.card.moreActions")}
    >
      <Ellipsis className="size-4" />
    </Button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuHead>{accountName}</MenuHead>
        {onRefreshPart ? (
          <>
            <RefreshMenuGroup
              refreshingKinds={refreshingKinds}
              doneKinds={doneKinds}
              kinds={refreshKinds}
              onPick={onRefreshPart}
            />
            {/* ★ 续期凭据：写操作，与上面四项只读分开（分隔线 + 「续期凭据」）。
                保持菜单打开（`preventDefault`）—— 续期要在菜单里看到转圈与结果。 */}
            {onRefresh && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={featuresDisabled || refreshingToken}
                  title={t("shared.cardMenu.refreshTokenHint")}
                  onSelect={(event) => {
                    event.preventDefault();
                    onRefresh();
                  }}
                >
                  <span className="grid size-4 shrink-0 place-items-center">
                    {refreshingToken ? <Loader2 className="size-4 animate-spin" /> : <KeyRound />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t("shared.cardMenu.refreshToken")}</span>
                  {refreshingToken ? (
                    <span className="ml-2 shrink-0 text-[10.5px] text-muted-foreground">
                      {t("shared.cardMenu.busy")}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : (
          onRefresh && (
            <DropdownMenuItem disabled={featuresDisabled || refreshingToken} onSelect={onRefresh}>
              {refreshingToken ? <Loader2 className="animate-spin" /> : <KeyRound />}
              {t("shared.cardMenu.refreshToken")}
            </DropdownMenuItem>
          )
        )}
        <DropdownMenuSeparator />
        <MenuGroupLabel>{t("shared.cardMenu.accountGroup")}</MenuGroupLabel>
        {/* ★ 签到是**三态**：已签到 / 需先登录 / 可点。
            缺了前两态就是「卡片给入口、批量却算结构性失败」的自相矛盾（F5）。
            ⚠️ 三态的图标**同一枚**（`CheckinIcon`）：状态由文案与右侧状态词区分，
            不是靠换图标 —— 此前「已签到」是裸 `Check`、「需先登录」是 `Sparkles`，
            同一件事三种画法（详见 `lib/semantic-icons.ts`）。 */}
        {todayCheckedIn === true ? (
          <MenuStateItem
            icon={<CheckinIcon className="size-4 text-primary" />}
            hint={t("shared.cardMenu.checkedTodayHint")}
          >
            {t("shared.cardMenu.checkedToday")}
          </MenuStateItem>
        ) : credentialDead ? (
          <MenuStateItem
            icon={<CheckinIcon className="size-4" />}
            hint={t("shared.cardMenu.needLoginHint")}
            state={t("shared.cardMenu.needLogin")}
          >
            {t("wbAccounts.card.manualCheckin")}
          </MenuStateItem>
        ) : todayCheckedIn === false ? (
          <DropdownMenuItem disabled={featuresDisabled || !onCheckin} onSelect={onCheckin}>
            <CheckinIcon />
            {t("wbAccounts.card.manualCheckin")}
          </DropdownMenuItem>
        ) : null}
        {/* ★ 「完成任务」：没有可做的就**禁用**（而不是隐藏）—— 用户找得到它在哪，
            只是此刻不可点；`title` 说明原因。进行中保持菜单打开（同刷新组），
            否则几秒的等待期里看得见的反馈只剩一条 toast。 */}
        {onCompleteTasks && (
          /* ⚠️ `title` 挂在**外层 span**：禁用项的 `data-[disabled]` 带 `pointer-events-none`，
             挂在菜单项上悬停永远不触发。外层没有这个限制，鼠标停在灰项上仍能看到原因。 */
          <span
            className="block"
            title={
              tasksBusy
                ? t("shared.cardMenu.completeTasksRunning")
                : tasksActionable
                  ? t("wbAccounts.card.growthTip", { claimable: tasksClaimable, autoable: tasksAutoable })
                  : tasksKnown
                    ? t("shared.cardMenu.completeTasksNone")
                    : t("shared.cardMenu.completeTasksUnknown")
            }
          >
            <DropdownMenuItem
              disabled={featuresDisabled || tasksBusy || !tasksActionable}
              onSelect={(event) => {
                event.preventDefault();
                void runCompleteTasks();
              }}
            >
              <span className="grid size-4 shrink-0 place-items-center">
                {tasksBusy ? <Loader2 className="size-4 animate-spin" /> : <GrowthTaskIcon className="size-4" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{t("shared.cardMenu.completeTasks")}</span>
              {tasksBusy ? (
                <span className="ml-2 shrink-0 text-[10.5px] text-muted-foreground">
                  {t("shared.cardMenu.completeTasksRunning")}
                </span>
              ) : tasksActionable ? (
                <span className="ml-2 shrink-0 text-[10.5px] text-muted-foreground">
                  {tasksClaimable > 0
                    ? t("shared.cardMenu.completeTasksClaimable", { n: tasksClaimable })
                    : t("shared.cardMenu.completeTasksAutoable", { n: tasksAutoable })}
                </span>
              ) : null}
            </DropdownMenuItem>
          </span>
        )}
        {onExport && (
          <DropdownMenuItem onSelect={onExport}>
            <Download />
            {t("shared.cardMenu.export")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/5 focus:text-destructive"
          onSelect={onDelete}
        >
          <Trash2 />
          {t("wbAccounts.card.deleteAccount")}
        </DropdownMenuItem>
        <MenuNote>{t("shared.cardMenu.note")}</MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 演示模式下的占位（与卡片一致：菜单整体不可用）。 */
export function AccountMoreMenuDemo() {
  return (
    <DemoAction>
      <Button variant="ghost" size="sm" className="!px-[10px]">
        <Ellipsis className="size-4" />
      </Button>
    </DemoAction>
  );
}
