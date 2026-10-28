import { Check, ChevronDown, Download, KeyRound, Loader2, RefreshCw, Trash2, XIcon } from "lucide-react";

import { RefreshMenuGroup, RefreshTasksItem } from "@/components/account-menu-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import { useT } from "@/lib/i18n";
import { CheckinIcon, GrowthTaskIcon } from "@/lib/semantic-icons";
import { cn } from "@/lib/utils";

/**
 * 批量操作条（**三平台共用**：WorkBuddy / Trae / Qoder，PLAN §3.4 的「勾选 + 批量」）。
 *
 * ## 位置与形态：**文档流内**横条，位于工具栏与列表之间（照原型）
 *
 * 原型 `.batch-bar`（`buddy-switch-prototype.html:303-307`）是**文档流内**的横条：
 * `padding:10px 14px; margin-bottom:14px; border-radius:var(--radius);
 * border:1px solid color-mix(primary 35%, transparent);
 * background:color-mix(primary 10%, var(--card))`，插在工具栏与列表之间。
 *
 * ⚠️ **不再用底部浮条**：浮条会盖住列表底部（网格视图尤甚），且「选择模式」是
 * **当前列表上下文**的动作，跟着列表走才符合直觉。
 *
 * ## 动作是可选的（`onCheckin?` / `onRefresh?` / `onRefreshPart?` / `onRefreshToken?` / `onRefreshTasks?` / `onCompleteTasks?` / `onExport?` / `onDelete?`）
 *
 * 平台能力不同（WB 有积分刷新与成长任务、Trae 侧动作集不同、Qoder 只有删除），**缺哪个就不渲染哪个**，
 * 而不是渲染一枚点了没反应的按钮 —— 后者比不渲染更差。
 *
 * 批量「刷新」要么给一个粗粒度 `onRefresh`，要么给细粒度 `onRefreshPart`（渲染成下拉，
 * 与单账号菜单的「刷新」组同构）；**不要既给两者**，否则同一动作出现两个入口。
 *
 * ## ★ 刷新菜单里只有只读项，写操作在外（2026-10-26 用户要求）
 *
 * | 位置 | 动作 |
 * |:--|:--|
 * | 下拉（= 单账号菜单的刷新组） | 刷新积分 / 刷新签到状态 / 刷新凭证状态 / 刷新任务 |
 * | 下拉**外部**的按钮行 | 签到 / 完成任务 / **续期凭据** / 导出 / 删除 |
 *
 * 判据是「读 / 写」：下拉里的只读项只重读现成数据；续期凭据会写 `refresh_token`，
 * 与签到、完成任务同属账号级写动作，混进下拉会让人以为点「刷新积分」也会顺带续期。
 * 「刷新今日 Token」已从所有刷新菜单移除（卡片不再展示它）。
 *
 * ## ★ 作用域边界：批量 = **勾选范围**（2026-10-26 修订）
 *
 * | 作用域 | 入口 | 允许做什么 |
 * |:--|:--|:--|
 * | 全量 | 页头「一键刷新 / 一键签到」 | 只做安全、幂等、可重复执行的批处理（只读刷新、自动跳过已完成项）；**不删除、不导出、不续期、不完成任务** |
 * | 勾选 | 本组件 | 用户显式选择后执行，**允许写操作与破坏性操作**（续期、删除） |
 * | 单账号 | 卡片 / 表格菜单、详情抽屉 | 单实例、需要上下文才能判断的动作 |
 *
 * ⚠️ 同一个动作允许在「全量 / 勾选 / 单账号」三个作用域各有一个入口，但**同一作用域内不重复**。
 *
 * ## ★ 进度与取消（`progress` / `onCancel`，2026-10-23）
 *
 * 逐账号循环的动作（签到 / 续期 / 成长摘要 / 完成任务）在账号多时是**分钟级**的等待。
 * 此前只有一个转圈：用户不知道进行到哪、也不能停。现在这两个 prop 都不传就与旧行为逐字一致，
 * 传了就多一段「处理中 3/20 + 取消」。
 *
 * ⚠️ 「取消」是**协作式**中止：只拦尚未开始的账号，已发出的请求会跑完并计入结果。
 * 因此取消后**必须**报「N 个未处理」，不能报成全部完成 —— 文案键
 * `wbAccounts.toast.batchCancelled` 就是为此存在的。
 *
 * ## ★ 任务项（`onRefreshTasks`）只由 WB·CN 注入
 *
 * 它**不是** `AccountRefreshKind`（那几个是「重读某一层现成数据」的接口级语义），
 * 而是「对所选账号逐个强制重扫上游任务摘要」——只有 WorkBuddy 国内版有成长体系。
 * 但它在**展示上**属于刷新组：与积分 / 签到 / 凭据同组、无分隔线，共用
 * `RefreshTasksItem`（单账号菜单用的也是同一个组件 ⇒ 两处不可能再漂移）。
 *
 * ## 为什么是自定义组件（AGENTS.md 要求记录理由）
 *
 * 它不是交互原语，而是「计数 + 若干按钮 + 清除」的纯展示组合，由现有 `Button` / token 拼成，
 * 不涉及焦点管理 / 键盘模式，因此不需要 Radix 层，也不必新增 shadcn 组件。
 */
export interface AccountBatchBarProps {
  /** 已选数量；`<= 0` 时整个条不渲染。 */
  selectedCount: number;
  /** 任一批量动作进行中（禁用所有动作，避免并发）。 */
  busy?: boolean;
  onCheckin?: () => void;
  onRefresh?: () => void;
  /** 单项批量刷新；提供时「刷新」渲染为下拉菜单，与单账号菜单同构。 */
  onRefreshPart?: (kind: AccountRefreshKind) => void;
  /** 批量条真的能刷的刷新项（默认 {@link ACCOUNT_REFRESH_KINDS}，`tokens` 传了也不渲染）。 */
  refreshKinds?: readonly AccountRefreshKind[];
  /** 正在批量刷新的项（显示转圈并禁用）。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刷新成功的项（显示对勾，调用方负责淡出）。 */
  doneKinds?: readonly AccountRefreshKind[];
  /**
   * 批量续期凭据（写 refresh_token）。这是只读刷新之外的**写操作**，
   * 与单账号抽屉里的「续期凭据」同一条路径，渲染为下拉**外部**的独立按钮
   * （2026-10-26 用户要求：续期 / 签到 / 完成任务都在刷新菜单外）。
   */
  onRefreshToken?: () => void;
  refreshingToken?: boolean;
  doneToken?: boolean;
  /**
   * 批量**重扫任务摘要**（仅 WorkBuddy 国内版注入）。
   *
   * 对所选账号**逐个** `growth_tasks_scan(force, accountId)` —— 不能用全量扫描，
   * 那会越界更新未勾选账号的卡片标签。见 `docs/specs/GROWTH-TASKS.md` §6。
   * 与单账号菜单的「刷新任务」是**同一项**（同一个 `RefreshTasksItem`），不执行任务。
   *
   * 转圈 / 「已更新」由 `RefreshTasksItem` 与 {@link busy} 决定 ⇒ 不再单独要一组
   * `refreshing` / `done` prop（此前那组只服务批量条自己那份内联实现）。
   */
  onRefreshTasks?: () => void;
  /** 批量完成成长任务（仅 WorkBuddy 国内版有成长体系）。 */
  onCompleteTasks?: () => void;
  /** 导出所选账号（原型 `batch-export`：批量条上的第四个动作）。 */
  onExport?: () => void;
  onDelete?: () => void;
  /**
   * 逐账号批处理的进度（`{done,total}`）。只有「按账号循环」的动作才有意义：
   * 签到 / 续期 / 成长摘要 / 完成任务。整批请求的动作（如一键刷新）不传。
   *
   * 不传 ⇒ 与加这个 prop 之前逐字一致（三平台都不会突然多出一段文字）。
   */
  progress?: { done: number; total: number } | null;
  /**
   * 中止正在跑的批处理。**协作式**：只拦尚未开始的账号，在途请求会跑完。
   * 传了才渲染「取消」；平台若没有可循环的动作就不传。
   */
  onCancel?: () => void;
  /** 清除选择（必填：这是「退出选择模式」的唯一出口）。 */
  onClear: () => void;
}

export function AccountBatchBar({
  selectedCount,
  busy = false,
  onCheckin,
  onRefresh,
  onRefreshPart,
  refreshKinds,
  refreshingKinds,
  doneKinds,
  onRefreshToken,
  refreshingToken,
  doneToken,
  onRefreshTasks,
  onCompleteTasks,
  onExport,
  onDelete,
  progress,
  onCancel,
  onClear,
}: AccountBatchBarProps) {
  const t = useT();
  if (selectedCount <= 0) return null;

  const refreshing = (refreshingKinds?.length ?? 0) > 0;

  return (
    <div
      /* ★ `flex-wrap`：动作最多时（刷新下拉 + 签到 + 完成任务 + 续期 + 导出 + 删除 + 清除）
         再加「进度 + 取消」在窄窗会挤出一行 —— 换行比横向溢出好，溢出会把最右侧的
         「清除选择」推到可视区外，用户找不到退出选择模式的出口。 */
      className="mb-3 flex min-w-0 w-full flex-wrap items-center gap-2.5 rounded-lg border border-primary/35 px-3.5 py-2.5"
      style={{ background: "color-mix(in oklab, var(--primary) 10%, var(--card))" }}
    >
        <Badge variant="secondary" className="tabular-nums">
          {t("shared.batch.selected", { n: selectedCount })}
        </Badge>
        {/* 进度与取消紧贴「已选 N 项」：它们描述的是**这一批**的执行状态，
            分开摆放会读成两个无关的控件。`progress` 缺席时这一段完全不渲染。 */}
        {progress ? (
          <>
            <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
              {t("shared.batch.progress", { done: progress.done, total: progress.total })}
            </span>
            {onCancel ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                onClick={onCancel}
                title={t("shared.batch.cancelHint")}
              >
                {t("shared.batch.cancel")}
              </Button>
            ) : null}
          </>
        ) : null}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {onRefreshPart ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-full px-3 text-xs"
                disabled={busy}
              >
                {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("shared.batch.refresh")}
                <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {/* ★ 下拉里**只有只读刷新项**（积分 / 签到状态 / 凭证状态 / 任务），与单账号菜单同构：
                  「续期凭据」是写操作，已挪到下拉**外部**的按钮行（2026-10-26 用户要求）；
                  「刷新今日 Token」不再出现在任何刷新菜单。 */}
              <RefreshMenuGroup
                kinds={refreshKinds}
                refreshingKinds={refreshingKinds}
                doneKinds={doneKinds}
                disabled={busy}
                onPick={onRefreshPart}
              />
              {/* 任务项（仅 WB·CN 注入）：与刷新项同组、**无分隔线** —— 单账号菜单里也是这个位置。 */}
              {onRefreshTasks && <RefreshTasksItem busy={busy} onPick={onRefreshTasks} />}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : onRefresh ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onRefresh}
          >
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("shared.batch.refresh")}
          </Button>
        ) : null}
        {onCheckin && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onCheckin}
          >
            <CheckinIcon />
            {t("shared.batch.checkin")}
          </Button>
        )}
        {onCompleteTasks && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onCompleteTasks}
          >
            <GrowthTaskIcon />
            {t("shared.batch.completeTasks")}
          </Button>
        )}
        {/* ★ 续期凭据（写 `refresh_token`）：与签到 / 完成任务同为账号级写动作，
            因此摆在刷新下拉**外部**（2026-10-26 用户要求）—— 混进下拉会让人以为
            「点刷新积分」也会顺带续期。 */}
        {onRefreshToken && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            title={t("shared.cardMenu.refreshTokenHint")}
            onClick={onRefreshToken}
          >
            {refreshingToken ? (
              <Loader2 className="animate-spin" />
            ) : doneToken ? (
              <Check className="text-primary" />
            ) : (
              <KeyRound />
            )}
            {t("shared.batch.refreshToken")}
          </Button>
        )}
        {onExport && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-full px-3 text-xs"
            disabled={busy}
            onClick={onExport}
          >
            <Download />
            {t("shared.batch.export")}
          </Button>
        )}
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-8 rounded-full px-3 text-xs text-destructive hover:bg-destructive/5 hover:text-destructive")}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 />
            {t("shared.batch.delete")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-0.5 size-8 rounded-full text-muted-foreground hover:text-foreground"
          onClick={onClear}
          aria-label={t("shared.batch.clear")}
          title={t("shared.batch.clear")}
        >
          <XIcon />
        </Button>
    </div>
  );
}
