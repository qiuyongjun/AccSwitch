"use client";

import { useState, type ReactNode } from "react";
import { ArrowLeftRight, Download, Ellipsis, KeyRound, Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MenuGroupLabel,
  MenuHead,
  MenuNote,
  MenuStateItem,
  RefreshMenuGroup,
  RefreshTasksItem,
} from "@/components/account-menu-parts";
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
 * ## 结构
 *
 * 头部（账号名）· 刷新组（`refreshKinds` 给出的只读项 + 任务项）· 账号组（签到三态 /
 * 完成任务 / 续期凭据 / 切换账号 / 导出账号）· 删除 · 结尾提示。
 * **两边不一致时以原型为准** —— 原型是设计评审通过的那一版。
 *
 * ★ 2026-10-26（用户要求，**覆盖原型**）：刷新组只剩**只读项** ——
 * 积分 / 旅行 / 签到状态 / 凭证状态 / 任务（`RefreshTasksItem`，仅 WB·CN）。
 * 「刷新今日 Token」从所有菜单移除（卡片已不展示今日 Token）；写操作（续期凭据）
 * 与签到、完成任务一起留在刷新菜单**外部**的「账号」组里。
 * 批量条与本组件**同构**：同一批项、同一顺序、同一条分隔线位置。
 *
 * ★ 2026-10-23：「账号」组里**多**一项「完成任务」（成长任务，仅 WB·CN 注入）——
 * 用户要求的快捷入口，原型尚未收录；不是漂移，别照着原型把它删掉。
 *
 * ★ 2026-10-26 用户要求把详情动作搬进菜单：
 * - 「刷新任务」只重扫该账号的任务摘要（更新卡片上的可领 / 可自动），仅 WB·CN 提供；
 * - 「切换账号」与详情抽屉的向导入口**同一个动作**（`setSwitchAccount`），一步打开切换向导。
 *
 * ## ★ 「续期凭据」为什么不在刷新组、而放在「账号」组里
 *
 * 「续期凭据」与只读刷新是**两类动作**：只读刷新（积分 / 旅行 / 签到 / 凭据）只
 * 重读本地或上游的现成数据；「续期凭据」是**写**操作（用 `refresh_token` 续期登录凭据）。
 * 混成一项会让用户以为点「刷新积分」就会顺带续期。此前它以「分隔线 + 单独一块」挂在刷新组后；
 * ★ 2026-10-26（用户要求）挪进「账号」组、紧贴「切换账号」之前 —— 单独立块反而割裂了
 * 「这些都是对一个账号做的事」的分组感。
 *
 * 2026-10-23 用户要求**卡片与表格的菜单也要能续期**（此前只有详情抽屉有）——
 * 因此抽屉与菜单**并存**该动作。判据是「同一个动作不在**同一作用域**内重复」：
 * 全量（页头一键）/ 勾选（批量条）/ 单账号（卡片菜单 + 抽屉）是三个作用域，
 * 单账号这一层里，菜单是「一步做完」的入口，抽屉给的是「看清楚再决定」的入口。
 *
 * ⚠️ 菜单里**没有**「查看详情」：原型把「打开详情」放在卡片/行的整体点击上，
 * 再摆一枚同义按钮就是两个入口做同一件事。
 */
/**
 * 签到状态的**显式取值**（替代互相矛盾的布尔组合）。
 *
 * 五态各自对应一种不同的用户动作：
 * - `checked`：今天已签，无可点项；
 * - `unchecked`：可签；
 * - `unknown`：还没查到 —— **不伪装成未签**（隐藏该项，等刷新后再说）；
 * - `unreadable`：查询失败 —— 给出原因，引导去「刷新签到状态」；
 * - `unavailable`：通道未开放 —— 重试永远无效，不摆可点项。
 */
export type AccountCheckinState =
  | { kind: "checked" }
  | { kind: "unchecked" }
  | { kind: "unknown" }
  | { kind: "unreadable"; reason?: string }
  | { kind: "unavailable"; reason?: string };

/**
 * 平台扩展动作（Trae 的「保存登录态」「解除冷却」这类平台专有能力）。
 *
 * 公共菜单只描述 `id / 文案 / 图标 / 可用性 / 忙态 / 回调`，**业务判定留在页面适配函数**
 * （菜单不接收三种原始账号类型，否则又会回到「每个平台一套菜单」）。
 */
export interface AccountMenuExtraAction {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  busy?: boolean;
  onSelect: () => void | Promise<void>;
}

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
   * 独立于只读刷新项（见文件头），位于「账号」组内「切换账号」之前；
   * `onRefreshPart` 缺省时菜单退回旧形态，但该项仍在「账号」组里（不再单独立块）。
   * ★ 返回 Promise：页面的忙态与实际耗时对齐（R06）。
   */
  onRefresh?: () => void | Promise<void>;
  /** 续期进行中（该项转圈并禁用重复点击）。 */
  refreshingToken?: boolean;
  /**
   * 「刷新任务」：强制重扫该账号的成长任务摘要（只更新卡片标签，不执行任务）。
   *
   * 返回 `false` ⇒ 失败（由调用方 toast），菜单不亮「已更新」。不传 ⇒ 不渲染该项
   * —— 成长任务只有 WorkBuddy 国内版有。
   */
  onRefreshTasks?: () => void | Promise<boolean | void>;
  /** 任务摘要重扫进行中。 */
  refreshingTasks?: boolean;
  /** 「切换账号」：与详情抽屉的向导入口同一个动作（打开切换向导）。 */
  onSwitch?: () => void;
  /** 今日签到状态：`true` 已签 / `false` 未签 / `undefined` 未知（未知 ⇒ 不显示签到行）。 */
  todayCheckedIn?: boolean;
  /**
   * 签到状态的**显式取值**（推荐）。传了即以它为准 —— 五态见 {@link AccountCheckinState}。
   * 旧的 `todayCheckedIn` 保留给 WorkBuddy（它只有「已签 / 未签 / 未知」三态）。
   */
  checkinState?: AccountCheckinState;
  /** 平台扩展动作（Trae：保存登录态 / 解除冷却）。 */
  extraActions?: readonly AccountMenuExtraAction[];
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
  onRefreshTasks,
  refreshingTasks = false,
  onSwitch,
  todayCheckedIn,
  checkinState,
  extraActions,
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
   * 签到状态的**唯一判据**：显式 `checkinState` 优先，旧的 `todayCheckedIn` 只映射三态。
   * 未知（`unknown` / 未传）⇒ 不渲染签到项 —— 不把「不知道」画成「未签到」。
   */
  const checkinKind: AccountCheckinState["kind"] =
    checkinState?.kind ??
    (todayCheckedIn === true ? "checked" : todayCheckedIn === false ? "unchecked" : "unknown");
  const checkinReason =
    checkinState && (checkinState.kind === "unreadable" || checkinState.kind === "unavailable")
      ? checkinState.reason
      : undefined;

  /**
   * 「完成任务」的可用性。
   *
   * 三态口径与卡片上的任务标签**同源**（`growthHint`）：`idle` / 计数为 0 ⇒ 没有可做的；
   * 摘要还没回来（`undefined`）⇒ **禁用并说明「稍后再试」** —— 不把「不知道」当成「没有」。
   * `ok:false`（凭据失效 / 无成长体系）同样不可点，原因由 `title` 交代。
   *
   * ★ 2026-10-26：所有任务 100% 完成时，图标用 success 绿色，与「今日已签到」同语义，
   * 状态直观统一（已签到=今日动作全做完，任务已完成=任务动作全做完）。
   */
  const tasksClaimable = growthHint?.ok && !growthHint.idle ? growthHint.claimable : 0;
  const tasksAutoable = growthHint?.ok && !growthHint.idle ? growthHint.autoable : 0;
  const tasksKnown = growthHint !== undefined && growthHint !== null && growthHint.ok;
  const tasksActionable = tasksClaimable > 0 || tasksAutoable > 0;
  /* 「100% 完成」按 `claimed >= total` 判定 —— 不能拿 `!tasksActionable` 代替：
     只剩手工任务时也不可自动，但那不是「全部完成」。 */
  const tasksAllDone =
    tasksKnown && (growthHint?.total ?? 0) > 0 && (growthHint?.claimed ?? 0) >= (growthHint?.total ?? 0);

  async function runCompleteTasks() {
    if (!onCompleteTasks || tasksBusy) return;
    setTasksBusy(true);
    try {
      await onCompleteTasks();
    } finally {
      setTasksBusy(false);
    }
  }

  /* 「刷新任务」的「已更新」反馈由 `RefreshTasksItem` 内部自管（菜单与批量条同一组件），
     这里不再保留本地定时器 —— 否则同一件事有两份 state。 */

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
            {/* ★ 任务项（仅 WB·CN 注入）：与刷新项**同一分组、无分隔线** —— 它同样是
                「重读上游现成数据」，只是重扫的是任务摘要而不是积分 / 旅行 / 签到 / 凭据。
                ⚠️ 别把它挪到分隔线以下：那会读成「另一个动作族」，与批量条的形状也不再同步。 */}
            {onRefreshTasks && (
              <RefreshTasksItem busy={refreshingTasks} disabled={featuresDisabled} onPick={onRefreshTasks} />
            )}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <MenuGroupLabel>{t("shared.cardMenu.accountGroup")}</MenuGroupLabel>
        {/* ★ 签到是**三态**：已签到 / 需先登录 / 可点。
            缺了前两态就是「卡片给入口、批量却算结构性失败」的自相矛盾（F5）。
            ⚠️ 三态的图标**同一枚**（`CheckinIcon`）：状态由文案与右侧状态词区分，
            不是靠换图标 —— 此前「已签到」是裸 `Check`、「需先登录」是 `Sparkles`，
            同一件事三种画法（详见 `lib/semantic-icons.ts`）。 */}
        {checkinKind === "checked" ? (
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
        ) : checkinKind === "unchecked" ? (
          <DropdownMenuItem disabled={featuresDisabled || !onCheckin} onSelect={onCheckin}>
            <CheckinIcon />
            {t("wbAccounts.card.manualCheckin")}
          </DropdownMenuItem>
        ) : checkinKind === "unavailable" ? (
          <MenuStateItem
            icon={<CheckinIcon className="size-4" />}
            hint={checkinReason ?? t("shared.cardMenu.checkinUnavailableHint")}
            state={t("shared.cardMenu.checkinUnavailable")}
          >
            {t("wbAccounts.card.manualCheckin")}
          </MenuStateItem>
        ) : checkinKind === "unreadable" ? (
          <MenuStateItem
            icon={<CheckinIcon className="size-4" />}
            hint={checkinReason ?? t("shared.cardMenu.checkinUnreadableHint")}
            state={t("shared.cardMenu.checkinUnreadable")}
          >
            {t("wbAccounts.card.manualCheckin")}
          </MenuStateItem>
        ) : null}
        {/* ★ 「完成任务」：没有可做的就**禁用**（而不是隐藏）—— 用户找得到它在哪，
            只是此刻不可点；`title` 说明原因。进行中保持菜单打开（同刷新组），
            否则几秒的等待期里看得见的反馈只剩一条 toast。
            ★ 2026-10-26（用户要求）：全部任务完成时与「今日已签到」同形状 ——
            绿色图标 + 中性文案，而不是一枚被 `opacity-50` 灰掉的禁用项。 */}
        {onCompleteTasks &&
          (tasksAllDone ? (
            <MenuStateItem
              icon={<GrowthTaskIcon className="size-4 text-success" />}
              hint={t("wbAccounts.card.growthDone")}
            >
              {t("shared.cardMenu.completeTasks")}
            </MenuStateItem>
          ) : (
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
          ))}
        {/* ★ 续期凭据：写操作（用 `refresh_token` 续期登录凭据），与只读刷新是两类动作。
            ★ 2026-10-26（用户要求）：从「刷新组」后的单独一块挪进「账号」组、
            紧贴「切换账号」之前 —— 与签到 / 完成任务同为账号级动作，不再单独立块。
            保持菜单打开（`preventDefault`）—— 续期要在菜单里看到转圈与结果。 */}
        {onRefresh && (
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
        )}
        {/* ★ 切换账号：与详情抽屉底部的向导入口同一个动作（打开切换向导），
            因此这里不再区分程序位 —— 向导里会给出目标程序位与可迁移内容。 */}
        {onSwitch && (
          <DropdownMenuItem
            disabled={featuresDisabled}
            title={t("shared.cardMenu.switchAccountHint")}
            onSelect={onSwitch}
          >
            <ArrowLeftRight />
            {t("shared.cardMenu.switchAccount")}
          </DropdownMenuItem>
        )}
        {onExport && (
          <DropdownMenuItem onSelect={onExport}>
            <Download />
            {t("shared.cardMenu.export")}
          </DropdownMenuItem>
        )}
        {/* ★ 平台扩展动作（Trae：保存登录态 / 解除冷却）：只描述形状，业务判定在页面。
            放在账号动作组的末尾 —— 它们是「这一条账号」的补充动作，不是刷新项。 */}
        {extraActions?.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={featuresDisabled || action.disabled || action.busy}
            title={action.title}
            onSelect={(event) => {
              event.preventDefault();
              void action.onSelect();
            }}
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {action.busy ? <Loader2 className="size-4 animate-spin" /> : action.icon}
            </span>
            {action.label}
          </DropdownMenuItem>
        ))}
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
