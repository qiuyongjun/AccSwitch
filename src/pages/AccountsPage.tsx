import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, Download, Loader2, KeyRound, QrCode, RefreshCw, Terminal } from "lucide-react";

import { AccountMoreMenu } from "@/components/account-more-menu";
import {
  AccountCard,
  AccountStatusBadge,
  ACCOUNT_CHIP_CLASS,
  CredentialExpiryMeta,
  GrowthHintBadge,
  TravelStatusBadge,
  accountIdentity,
  accountDisplayName,
  creditMetricValues,
  creditMetricTip,
  expiryTooltipLines,
  formatCredits,
  formatCreditExpiry,
  formatTodayTokens,
  nextExpiryLabel,
  type GuideTarget,
} from "@/components/account-card";
import { REFRESH_DONE_LABEL, REFRESH_DONE_MS, useAccountRefreshBusy, type AccountRefreshKind } from "@/lib/account-refresh";

import { AccountsTableAvatar } from "@/components/account-list-parts";
import { AccountWorkbench } from "@/components/account-workbench";
import {
  QuickActionButton,
  QuickRefreshAction,
  quickRefreshCoolingDown,
  startQuickRefreshCooldown,
} from "@/components/account-quick-actions";
import { type AccountColumn } from "@/components/account-table";
import { type ToolbarOption } from "@/components/account-toolbar";
import { AddAccountDrawer, type AddAccountWay } from "@/components/add-account-drawer";
import { AccountDetailDrawer, type DetailActions, type DetailCheckinHistoryRow, type DetailCredential, type DetailPack, type DetailProgramBadge, type DetailSection, type DetailStat, type DetailSwitchTarget } from "@/components/account-detail-drawer";
import { ClientLimitsCard } from "@/components/client-limits-card";
import { DemoAction } from "@/components/demo-action";
import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportAccountsDialog } from "@/components/export-accounts-dialog";
import { ImportAccountsDialog } from "@/components/import-accounts-dialog";
import { ClientlessEmptyCard, ClientlessStrip } from "@/components/clientless-notice";
import { PasteCredentialDialog } from "@/components/paste-credential-dialog";
import { OAuthLoginDialog } from "@/components/oauth-login-dialog";
import { RecycleBinSheet } from "@/components/recycle-bin-sheet";
import { RestartConfirmDialog } from "@/components/restart-confirm-dialog";
import { SwitchAccountDialog } from "@/components/switch-account-dialog";
import { ExtSessionDrawer } from "@/components/sessions/ext-session-drawer";
import * as api from "@/lib/api";
// ★ B5：`checkinCreditsOf` 是**值**（从条目/raw 里取积分字段），`CheckinStatusEntry` 是**类型**。
import { checkinCreditsOf } from "@/lib/api";
import type { CheckinStatusEntry, GrowthTaskSummary } from "@/lib/api";
import { attentionOf, needsManualAttention } from "@/lib/account-attention";
import { accountSearchText } from "@/lib/account-search";
/** 批量动作的并发口径（与积分刷新同一档削峰）：串行会让 20 个账号的批处理变成 20 次 RTT。 */
import { mapWithConcurrency } from "@/lib/concurrency";
import type { DrawerTab } from "@/lib/drawer-tab-preference";
import { lastSevenDays, localDateKey } from "@/lib/checkin-history";
import {
  filterAccounts,
  groupAccounts,
  hasActiveFilter,
  sortAccounts,
  type AccountComparator,
  type AccountGroupKey,
  type AccountListConfig,
  type AccountSortKey,
  type AccountViewMode,
} from "@/lib/account-list-view";
import { copyText } from "@/lib/clipboard";
import { displayText } from "@/lib/display-text";
import { isExpiryUrgent, summarizeExpiry, type ExpiringBatch } from "@/lib/credit-expiry";
import { formatDate } from "@/lib/format";
import { regionDescriptor } from "@/lib/region";
import { scopeOf } from "@/lib/scope";
import { useRefreshAction } from "@/lib/use-refresh-action";
import type {
  AccountMeta,
  AccountTokenTodayEntry,
  AppStatus,
  CheckinConfig,
  CheckinLog,
  CodeBuddyCliStatus,
  CodeBuddyCnIdeStatus,
  CreditStatsEvent,
  JetbrainsCodebuddyPluginStatus,
  ExtClientId,
  Region,
  SwitchConfig,
  TravelConfig,
  TravelStatus,
  VscodeCodebuddyPluginStatus,
} from "@/lib/types";

import { useDocumentVisible } from "@/lib/use-document-visible";
import { useMediaQuery } from "@/lib/use-media-query";
import { useScope } from "@/lib/use-scope";
import { useAccountsStore } from "@/stores/accounts";
import { useT, type Translate } from "@/lib/i18n";
import { CheckinIcon } from "@/lib/semantic-icons";
import { showUndoToast } from "@/lib/undo-toast";

/* 日期口径（`localDateKey` / `lastSevenDays`）已上提到 `@/lib/checkin-history` ——
   Trae 侧也要装配「近 7 天」抽屉区块，两处必须同口径（差一天就会把「昨天签的」显示成「未签到」）。 */

/**
 * WorkBuddy 卡片 / 表格菜单的刷新项。
 *
 * 2026-10-26 用户要求：刷新菜单 = 积分 / 旅行 / 签到状态 / 凭证状态（+ 任务项，
 * 由 `onRefreshTasks` 注入）。「刷新今日 Token」已从所有刷新菜单移除 ——
 * 卡片与表格都不再展示今日 Token，菜单里留入口会让人以为有东西会变；
 * Token 的重读仍留在指标块（用量页 / 抽屉）与续期后的自动补齐里。
 *
 * ★ 2026-10-26 补 `travel`：旅行 chip 在卡片上可见，但此前只有「一键刷新」能更新它。
 */
const WB_MENU_REFRESH_KINDS = ["credits", "travel", "checkin", "credential"] as const satisfies readonly AccountRefreshKind[];

/**
 * 需要走「统一重启确认」的客户端（PLAN §3.15.3）。
 *
 * - `cli`：**例外** —— 不重开客户端，但当前 CLI 会话会中断（确认框不渲染「自动重开」）；
 * - `ide` / `vscode` / `jetbrains`：都是「先关 → 写凭证 → 再开」⇒ 默认勾选自动重开，
 *   并显式提示未保存文件风险。
 */
type SwitchClient = "cli" | "ide" | "vscode" | "jetbrains";

function isWorkbuddyCurrent(account: AccountMeta, current: AppStatus["current"] | undefined): boolean {
  if (!current) return false;
  return Boolean(
    (current.uid && (account.uid === current.uid || account.id === current.uid)) ||
      (current.email && account.email === current.email),
  );
}

/**
 * 「凭据」的状态补充文案：有效 ⇒ **具体到期时刻**（`MM-DD HH:mm`）；
 * 没有到期时间 ⇒ 长期有效；过期 / 需重登 ⇒ 先重新登录。
 *
 * 指标块与「凭据」页签共用这一处，口径不漂移（2026-10-26 用户要求：
 * 「可正常使用」不携带信息，换成到期时间）。
 *
 * ⚠️ `expiresAt` 只认**正数毫秒**：`0` 过 `formatDate` 会变成「—」，
 * 拼出来是「有效至 —」，比不写更糟。
 */
function credentialHintOf(
  account: Pick<AccountMeta, "expiresAt" | "needsRelogin">,
  t: Translate,
  now: number,
): string {
  if (account.needsRelogin || (typeof account.expiresAt === "number" && account.expiresAt < now)) {
    return t("shared.stat.credentialBadSub");
  }
  return typeof account.expiresAt === "number" && account.expiresAt > 0
    ? t("shared.stat.credentialValidUntil", { date: formatDate(account.expiresAt) })
    : t("wbAccounts.card.forever");
}

/**
 * 并行查询今日签到；失败的账号不写入，由调用方保留原值。
 *
 * ★ 必须走 `api.getCheckinStatusMap`（**批量**），不要在这里对每个账号调
 * `api.getCheckinStatus` —— webui 端那个端点是**整端点**，逐个调用会变成
 * N × N 次上游签到查询（详见 `api.ts` 里该函数的文档）。
 */
async function fetchTodayCheckinMap(
  accountIds: string[],
  region: Region,
  isStale?: () => boolean,
): Promise<Record<string, boolean>> {
  const entries = await api.getCheckinStatusMap(accountIds, region);
  // 整批回来后统一判一次陈旧：过期的结果一条都不用。
  if (isStale?.()) return {};
  const next: Record<string, boolean> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.ok) next[id] = entry.todayCheckedIn;
  }
  return next;
}

/**
 * 并行查询各账号今日旅行状态；失败账号进 `failedIds`，由调用方保留原值。
 *
 * ★ 同上：必须走批量的 `api.queryTravelStatuses`。
 */
async function fetchTravelMap(
  accountIds: string[],
  region: Region,
  isStale?: () => boolean,
): Promise<api.TravelStatusQuery> {
  const result = await api.queryTravelStatuses(accountIds, region);
  if (isStale?.()) return { statuses: {}, failedIds: [] };
  return result;
}

// ---------------------------------------------------------------------------
// 版本状态（Tab 徽标 / 空态判定）
// ---------------------------------------------------------------------------

type RegionPresence = "logged-in" | "installed" | "absent";

/**
 * 判定某版本的展示状态：
 * - logged-in：该 region 有当前登录账号（status.current 非空）。
 * - installed：客户端已安装（后端 status.installed === true）或账号库非空但未登录。
 * - absent：未检测到该版本（后端 status.installed === false，或状态与账号库均为空）。
 */
function regionPresence(status: AppStatus | null, accounts: AccountMeta[]): RegionPresence {
  if (status?.current) return "logged-in";
  if (status?.installed === false) return "absent";
  if (status?.installed === true || accounts.length > 0) return "installed";
  return "absent";
}

export default function AccountsPage() {
  /* P1：区域统一走 `useScope`（URL 优先 + localStorage 记忆），不再用组件 state。
     原实现是 `useState<Region>("cn")` —— 刷新即丢，且与统计页互不通信（§1.2 诊断）。 */
  const [activeRegion] = useScope("workbuddy");
  const fetchAllRegions = useAccountsStore((s) => s.fetchAllRegions);

  useEffect(() => {
    void fetchAllRegions();
  }, [fetchAllRegions]);

  return (
    <div className="mx-auto w-full max-w-[1240px] px-7 pt-[26px] pb-[60px]">
      {/* 页头下沉到 `RegionPanel`：一键操作是页面级动作，需要它的账号/签到/任务状态；
          放在父层就得把整套 state 再上提一层，反而把「一个区块」拆散。 */}
      {/* ★★ `key={activeRegion}` 是**状态隔离的唯一保证**，不要删。
          两个版本渲染的是**同一个组件类型**，React 会复用实例、只换 `region` prop ⇒
          所有按账号 id 键控的缓存（签到 / 旅行 / 签到详情 / 成长摘要）与已打开的抽屉、
          结果条都会跨版本残留。而账号 id **不带 region 命名空间**（同一邮箱在国内版与
          国际版是同一个 id），残留值会直接显示在另一版本的卡片上。
          用 `key` 强制重挂载比「逐个 clear 十几个 state」更难漏：新增 state 自动被覆盖。
          代价是搜索 / 排序 / 分组 / 视图四项偏好随切换重置 —— 这是可接受的：
          它们描述的是「我正在看哪一版账号库」，换了库就该回到默认视角。 */}
      <RegionPanel key={activeRegion} region={activeRegion} />
    </div>
  );
}

/** 页头一键动作的进行中标识（同一时刻只跑一个）。 */
type QuickActionKind = "refresh" | "checkin";

/**
 * 批量条上「刷新」相关动作的进行中标识。
 *
 * - `AccountRefreshKind`：下拉里的只读刷新项（积分 / 签到 / 凭据）；
 * - `"token"`：**下拉外**的「续期凭据」按钮（写 `refresh_token`）；
 * - `"growth"`：下拉里的「刷新任务」（`growth_tasks_scan`，仅 WB·CN）。
 *
 * ⚠️ 后两者**不是** `AccountRefreshKind`：那个类型描述的是「重读某一层现成数据」的
 * 通用语义，而它们是「写凭据」与「重扫上游任务摘要」。区别只在类型层面 ——
 * 2026-10-26 起它们在**展示上**都归「刷新」这一族（续期凭据除外，它挪到了下拉外部）。
 */
type BatchRefreshTarget = AccountRefreshKind | "token" | "growth";

/**
 * 单个账号的签到结局。
 *
 * `already` 与 `success` 分开是为了文案（「N 个签到成功」vs「N 个已签到」），
 * 两者都算**成功**、都不进失败清单。
 */
type CheckinOutcome = "success" | "already" | "failed";

/**
 * 单个账号「一键完成任务」的结局。
 *
 * 四态必须分开，且三条入口（卡片菜单 / 批量 / 抽屉）对同一结果只能有一种说法：
 * - `done`：真的领到了奖励（`claimed` = 领取项数，`credit` = 到账积分）；
 * - `progressed`：行为事件已上报、奖励尚未达标 —— 不是「无事可做」，
 *   更不是「已完成」（此前菜单只看 `claimed`，把它误报成「没有可完成的任务」）；
 * - `skipped`：后端回读后确实无可领任务（正常收尾）；
 * - `failed`：请求失败 / 上游拒绝，带可展示的原因。
 */
type CompleteTasksOutcome =
  | { kind: "done"; claimed: number; credit: number }
  | { kind: "progressed" }
  | { kind: "skipped" }
  | { kind: "failed"; message?: string };

/**
 * 批量**写操作**（签到 / 续期 / 成长任务 / 完成任务）的并发档位。
 *
 * ⚠️ 比只读的积分刷新更保守（同为 3 但加了 150ms 间隔）：这些请求会写上游状态或消耗
 * refresh_token，打太快换来的是 429 与「一半成功一半失败」，比慢更糟。
 * 串行（原来的做法）在 20 个账号时是 20 次 RTT 起步，期间只有一个转圈 —— 用户既不知道
 * 进度也不能停，这才是要修的问题；把并发压到 3 已经能砍掉 2/3 的等待。
 */
const BATCH_WRITE_CONCURRENCY = 3;
const BATCH_WRITE_GAP_MS = 150;

/**
 * 页头一键动作控件（`QuickActionButton` / `QuickRefreshAction`）已上提到
 * `@/components/account-quick-actions` —— 三个账号页共用一份（含 30 秒冷却与禁用原因的表达）。
 */

/** 单个版本的完整账号管理区块（账号卡片、签到开关、积分、刷新等）。 */
function RegionPanel({ region }: { region: Region }) {
  const accounts = useAccountsStore((s) => (region === "cn" ? s.accounts : s.global.accounts));
  const status = useAccountsStore((s) => (region === "cn" ? s.status : s.global.status));
  const loading = useAccountsStore((s) => (region === "cn" ? s.loading : s.global.loading));
  const error = useAccountsStore((s) => (region === "cn" ? s.error : s.global.error));
  const creditMap = useAccountsStore((s) => (region === "cn" ? s.creditMap : s.global.creditMap));
  const creditLoadingMap = useAccountsStore((s) => (region === "cn" ? s.creditLoadingMap : s.global.creditLoadingMap));
  const reconcileAccounts = useAccountsStore((s) => s.reconcileAccounts);
  const refreshRegionStatus = useAccountsStore((s) => s.refreshRegionStatus);
  const deleteAccountStore = useAccountsStore((s) => s.deleteAccount);
  const ensureCredits = useAccountsStore((s) => s.ensureCredits);
  const refreshCredits = useAccountsStore((s) => s.refreshCredits);
  const importLocalStore = useAccountsStore((s) => s.importLocal);

  const descriptor = regionDescriptor(region);

  /* 「重新检测」两处入口（错误 Alert / 详情抽屉空态）各自的进行中态。 */
  const { busy: recheckAlertBusy, run: runRecheckAlert } = useRefreshAction();
  const { busy: recheckDrawerBusy, run: runRecheckDrawer } = useRefreshAction();

  const [oauthOpen, setOauthOpen] = useState(false);
  /** 粘贴授权凭据（issue #62）：无客户端部署的第二条入库路径。 */
  const [pasteCredentialOpen, setPasteCredentialOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /* ★「添加账号」三选抽屉（原型 `drawerAdd()`）。选完方式后**关闭抽屉**再开对应流程
     （原型 `case "add-way"` 也是 `closeDrawer()` 之后才继续）。 */
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  /**
   * 导出目标：`null` = 导出**全部**账号（工具栏入口）；非 `null` = 导出**所选**账号（批量条入口）。
   *
   * 与 `exportOpen` 分开是因为它们回答两个问题：「导哪些」与「弹窗开着没」——
   * 合成一个状态会让「关闭时清空选择」和「打开时带选择」互相踩。
   */
  const [exportTargets, setExportTargets] = useState<AccountMeta[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [switchAccount, setSwitchAccount] = useState<AccountMeta | null>(null);
  /**
   * ★ P14 S4a · 插件会话抽屉的目标（`null` = 关闭）。
   *
   * 与 `switchAccount` **分开两个状态**：两者是**不同的抽屉、不同的流程**
   * （切换向导是桌面版迁移；插件会话是一次性单向复制），共用一个状态会让
   * 「关掉一个却打开了另一个」这种缺陷无法表达。
   */
  const [extDrawer, setExtDrawer] = useState<{ client: ExtClientId; account: AccountMeta } | null>(
    null,
  );
  /**
   * 待确认的客户端切换目标（P8 T03 / §3.15.3）。
   *
   * **所有**客户端切换都走**同一条**确认流程：`client` 决定走「CLI 例外」文案（不重开、当前
   * CLI 会话会中断）还是「需重启」文案（默认勾选自动重开 + 未保存文件风险）。
   *
   * ⚠️ **同一功能在不同客户端行为不一致是缺陷** —— 用户会发现「为什么切 CLI 会提醒、切 IDE
   * 不提醒」，然后**不再相信这个提醒**。故 IDE 与 CLI 共用本状态、共用同一个确认框。
   *
   * ★ 2026-10-09：确认对象从 `isCli` 布尔扩成 `client` 四值 —— 新增的编辑器内 CodeBuddy
   * 插件（VS Code / JetBrains）同样是「需先关再开」，必须走**同一条**确认（否则又出现
   * 「有的客户端提醒、有的不提醒」）。
   */
  const [restartConfirm, setRestartConfirm] = useState<{
    account: AccountMeta;
    client: SwitchClient;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  /**
   * 自动签到 / 自动旅行的**配置读取**（开关本身只在设置页操作，见 `SettingsPage`）。
   *
   * ⚠️ 这里只读不写：列表页需要 `enabled` 来决定「要不要发被动请求」（首查与 60 秒轮询）。
   * 2026-10-23 删除了本页的写入路径 —— 添加抽屉的「更多操作」整块移除后，
   * 页面里已没有开关入口，留着 `onAutoCheckinChange` / `onAutoTravelChange` 就是死代码。
   */
  const [autoCheckinConfig, setAutoCheckinConfig] = useState<CheckinConfig | null>(null);
  /** 账号 id -> 今日是否已签到（undefined=查询中/未知） */
  const [checkinMap, setCheckinMap] = useState<Record<string, boolean>>({});
  const [autoTravelConfig, setAutoTravelConfig] = useState<TravelConfig | null>(null);
  /**
   * 账号切换 / 账号列表展示配置（全局单份，不随 region 分家）。
   *
   * 未加载完时保持 `null`：两处消费方都按「拿不到就不用这项偏好」处理 ——
   * `pin_current_account` 视为关（不改排序）、`copy_sessions_by_default` 视为关
   * （不改变切换语义）。宁可退化成改造前的行为，也不要凭猜测展示。
   */
  const [switchConfig, setSwitchConfig] = useState<SwitchConfig | null>(null);
  /** 账号 id -> 今日旅行状态（undefined=查询中/未知） */
  const [travelMap, setTravelMap] = useState<Record<string, TravelStatus>>({});
  /**
   * 账号 id -> 成长任务摘要（卡片上的「可领 N」/「可自动 N」提示标签）。
   *
   * 缺席 = 还没扫到 / 该号取不到任务 ⇒ **不挂标签**（绝不写「可领 0」）。
   * 数据来自**一次批量扫描**（后端 10 分钟落盘缓存），不是每张卡各查一次。
   */
  const [growthHints, setGrowthHints] = useState<Record<string, GrowthTaskSummary>>({});
  /**
   * 卡片菜单「刷新任务」中正在重扫的账号 id。
   *
   * 与抽屉的 `growthRefreshBusyId` 分开：卡片可能同时刷多张，抽屉只需要单实例。
   */
  const [growthHintRefreshingIds, setGrowthHintRefreshingIds] = useState<Set<string>>(() => new Set());
  /**
   * 抽屉里正在刷成长任务的账号 id（`null` = 没有）。
   *
   * 指标卡 ⟳ 与任务页签 ⟳ 是**同一个动作**（见 `refreshGrowthAccount`）：
   * 强制重扫摘要（`growth_tasks_scan`，可能要几秒）+ 重拉任务列表。
   * 「点了看得见」由这唯一的忙态承担，两个入口同时转圈 / 同时禁点。
   */
  const [growthRefreshBusyId, setGrowthRefreshBusyId] = useState<string | null>(null);
  /**
   * 「今日 Token」按账号聚合（`get_account_token_today`）：`uid -> 明细`。
   *
   * ⚠️ 用 **Map** 而非缺省对象是刻意的：`accounts` 里**缺席**某 uid = 「今日无记录 / 未知」，
   * 与「有一行值全 0（真实 0）」是两件事（诚实边界）。`map.get(uid)` 为 `undefined` 即缺席。
   */
  const [tokenTodayMap, setTokenTodayMap] = useState<Map<string, AccountTokenTodayEntry>>(new Map());
  /** 网关日志已到保留上限 ⇒ 网关部分为下界（「今日 Token」渲染 `≥N`）。 */
  const [tokenTodayTruncated, setTokenTodayTruncated] = useState(false);
  const [codebuddyCli, setCodebuddyCli] = useState<CodeBuddyCliStatus | null>(null);
  const [codebuddyCliSwitchingId, setCodebuddyCliSwitchingId] = useState<string | null>(null);
  const [codebuddyCnIde, setCodebuddyCnIde] = useState<CodeBuddyCnIdeStatus | null>(null);
  const [codebuddyCnIdeSwitchingId, setCodebuddyCnIdeSwitchingId] = useState<string | null>(null);
  /* ★ 2026-10-09：编辑器内 CodeBuddy 插件两个程序位（VS Code / JetBrains）的安装状态与切换态。 */
  const [vscodePlugin, setVscodePlugin] = useState<VscodeCodebuddyPluginStatus | null>(null);
  const [vscodePluginSwitchingId, setVscodePluginSwitchingId] = useState<string | null>(null);
  const [jetbrainsPlugin, setJetbrainsPlugin] = useState<JetbrainsCodebuddyPluginStatus | null>(null);
  const [jetbrainsPluginSwitchingId, setJetbrainsPluginSwitchingId] = useState<string | null>(null);
  const [installingCodebuddyCli, setInstallingCodebuddyCli] = useState(false);
  /**
   * 「续期凭据」正在跑的账号 id（`null` = 没有）。
   *
   * ⚠️ 续期是**写操作**（会消费 refresh_token），重复点击等于连打两次上游 ——
   * 因此既要在菜单项上转圈，也要**拦住第二个点击**（只转圈不禁用不够：Radix 菜单项
   * 关掉再打开仍可点）。
   */
  const [tokenRenewBusyId, setTokenRenewBusyId] = useState<string | null>(null);
  /** 接入/升级 CLI helper 确认框 */
  const [installConfirmOpen, setInstallConfirmOpen] = useState(false);
  /** 删除账号确认目标（null=关闭） */
  const [deleteTarget, setDeleteTarget] = useState<AccountMeta | null>(null);
  /** 回收站抽屉开关（P5 §2.7.1：按**当前作用域**过滤，入口在工具栏）。 */
  const [recycleOpen, setRecycleOpen] = useState(false);
  /** 区域不匹配详情展开 */
  const [mismatchDetailOpen, setMismatchDetailOpen] = useState(false);
  /**
   * P4 工具栏：搜索 / 排序 / 分组 / 视图。
   *
   * 四项都是**页面私有 `useState`**（`PLAN §2.1 L3` / `DECISIONS.md` D1）：不进 URL、
   * 不进 store、不碰作用域，且**不持久化**（决策 #2 —— 视图参数是临时的，持久化会让
   * 「为什么我的排序怪怪的」变成谜题）。唯一预留的 `?q=` 种子属 P6，本轮**不接线**（决策 #1）。
   */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AccountSortKey>("priority");
  const [group, setGroup] = useState<AccountGroupKey>("none");
  const [view, setView] = useState<AccountViewMode>("card");
  /** < 900px 强制卡片视图（`§3.12`）；断点只在 `useMediaQuery` 一处判断，不散落常量。 */
  const tableEnabled = useMediaQuery("(min-width: 900px)");
  const searchRef = useRef<HTMLInputElement>(null);
  const t = useT();

  /** `/` 键聚焦搜索框（`§3.4`）；在输入框 / 文本域 / 可编辑区里打字时不劫持。 */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * P6：命令面板跳过来的 **`?q=` 一次性种子**（§1.8）。
   *
   * 面板搜到**别的作用域**的账号时，回车会跳到本页并带上 `q`。这里**读一次**播种页内
   * 搜索 state，随后 `replace` 清掉参数 —— 此后 URL 不再承载 `q`，视图参数留在页内
   * （§2.1 L3）。用 `seededRef` 保证只读一次（StrictMode 双调用 / 后续 URL 变化都不会重播）。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const seedAppliedRef = useRef(false);
  useEffect(() => {
    if (seedAppliedRef.current) return;
    seedAppliedRef.current = true;
    const seed = searchParams.get("q");
    if (!seed) return;
    setQuery(seed);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("q");
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  /**
   * P4：详情抽屉 + 最小批量选择。
   *
   * 抽屉状态由**页面**持有（卡片只发 `onOpenDetail`）—— 抽屉需要「这个账号的全部明细」，
   * 而那些数据（积分包、签到态、程序位）只有页面手里齐全。
   *
   * `detailAutoEditRemark` 区分两个入口：点「查看详情」只打开抽屉；点「更多 → 编辑备注」
   * 打开抽屉并**直接进入编辑态**（`autoEditRemark`）。
   */
  const [detailAccount, setDetailAccount] = useState<AccountMeta | null>(null);
  /**
   * 打开抽屉时**指定**落点页签（卡片 / 表格的成长任务标签 → `tasks`）。
   * 普通入口（行点击 / 查看详情 / 编辑备注）为 `null` ⇒ 按记忆页签回落。
   */
  const [detailInitialTab, setDetailInitialTab] = useState<DrawerTab | null>(null);
  /**
   * ★ B5：抽屉里的**签到积分详情**（按账号 id 缓存）。
   *
   * ⚠️ 与 `checkinMap`（只记「是否已签到」）**不是一回事**：这里要的是
   * `daily_credit` / `streak_days` / `checkin_dates` 等**上游实测字段**。
   */
  const [checkinDetailMap, setCheckinDetailMap] = useState<Record<string, CheckinStatusEntry>>({});
  const [detailAutoEditRemark, setDetailAutoEditRemark] = useState(false);
  /** 由「更多 → 设置分组」打开抽屉时，直接进入**分组**编辑态（与备注同一交互）。 */
  const [detailAutoEditGroup, setDetailAutoEditGroup] = useState(false);
  /**
   * ★ 抽屉「签到历史（近 7 天）」的数据源（打开抽屉时拉取）：
   * - `checkinLogs` = `getCheckinLogs()`：**真实**的日期 + 结果；
   * - `creditEvents` = `getCreditStatistics()` 的事件流：按**账号 + 日期**匹配签到事件的 `amount`
   *   ⇒ 拿到「获得积分」。取不到时为 `null`，表格渲染「—」（**绝不**臆造固定奖励）。
   */
  const [detailCheckinLogs, setDetailCheckinLogs] = useState<CheckinLog[] | null>(null);
  const [detailCreditEvents, setDetailCreditEvents] = useState<CreditStatsEvent[] | null>(null);
  /**
   * ★ 跨作用域选择集按 **(scope, id)** 键控（P5 §2.5 第 (4) 条）。
   *
   * 键里带上 scope：切作用域后旧键自然失配 ⇒ `targets` 恒为 0，**不会**用 A 作用域的 id
   * 去打 B 作用域的库（或静默空转）。区域切换已由 `key={activeRegion}` 整体重挂载兜住，
   * 这里是**键控层面**的加固 —— 即便哪天重挂载被误删，键控本身仍能挡住跨作用域误操作。
   */
  const scope = scopeOf("workbuddy", region);
  const selectionKey = (id: string) => `${scope}:${id}`;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  /** 批量刷新进行中 / 刚成功的项（与单账号菜单的「刷新中 / 已更新」同一反馈）。 */
  const [batchRefreshKind, setBatchRefreshKind] = useState<BatchRefreshTarget | null>(null);
  const [batchRefreshDoneKind, setBatchRefreshDoneKind] = useState<BatchRefreshTarget | null>(null);
  /* 「已更新」只停留 REFRESH_DONE_MS（与单账号菜单同一时长），不做常驻状态。 */
  useEffect(() => {
    if (!batchRefreshDoneKind) return;
    const timer = window.setTimeout(() => setBatchRefreshDoneKind(null), REFRESH_DONE_MS);
    return () => window.clearTimeout(timer);
  }, [batchRefreshDoneKind]);
  /** 工具栏一键动作的进行中标识（同一时刻只跑一个；非 null 时三枚按钮全禁用）。 */
  const [quickActionBusy, setQuickActionBusy] = useState<QuickActionKind | null>(null);
  /**
   * 逐账号批处理的**进度**（`{done,total}`；`null` = 没有在跑）。
   *
   * 只有「按账号循环」的动作会写它（签到 / 续期 / 成长摘要 / 完成任务）——
   * 一键刷新是几个整批请求的 `Promise.all`，没有可计数的单位，故不写。
   * 批量条与页头共用同一份：同一时刻只允许一个批量动作（`batchBusy || quickActionBusy`）。
   */
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * 当前批量动作的**中止开关**。
   *
   * 协作式中止：只拦**尚未开始**的账号，已在途的请求会跑完 —— 所以中止之后
   * 结果文案必须写「N 个未处理」，不能报成全部完成（见 `batchCheckin` / `quickCheckinAll`）。
   */
  const bulkAbortRef = useRef<AbortController | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  /**
   * 批量签到**结果**（原型 `state.checkinResult`，`buddy-switch-prototype.html:2339-2354`）。
   *
   * ⚠️ 不能只靠 toast：toast 一闪而过，用户来不及看失败的是谁，且「一键签到」看起来
   * 永远 100% 成功。结果条**留在页面上**（工具栏与列表之间），带「只重试失败项」出口。
   */
  const [checkinResult, setCheckinResult] = useState<{ ok: number; failedIds: string[] } | null>(null);

  function toggleSelect(account: AccountMeta) {
    const key = selectionKey(account.id);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearSelection() {
    setSelectedKeys(new Set());
  }

  /**
   * ★ 区域变化**不需要**在这里清任何 state —— `AccountsPage` 用 `key={activeRegion}`
   * 强制重挂载本组件，选择集与全部按账号 id 键控的缓存都随实例一起销毁。
   *
   * 历史：2026-10-23 之前这里有一条 `useEffect(() => setSelectedKeys(new Set()), [region])`，
   * 只清了勾选 —— 因为当时 `<RegionPanel>` 在区域切换时**不 remount**，勾选集跨区域残留会让
   * 批量条显示「已选 N」但 `filter` 后恒为 0，点动作静默无操作。那条 effect 只堵了这一个洞，
   * 签到 / 旅行 / 抽屉 / 结果条仍在跨版本串数据。改成 `key` 之后整类问题一次性消失，
   * 这条 effect 也就成了死代码（清的是每次都已空的集合），故删除。
   * ⇒ **新增 state 不需要再写「切区域时清空」**，重挂载已覆盖。
   */

  /**
   * @param tab 指定落点页签（卡片 / 表格上的可点标签都会传：积分与到期 → `credits`，
   *            签到 / 凭据状态 → `checkin` / `credential`，成长任务 → `tasks`）；
   *            不传 ⇒ 沿用「上次停留页签」的记忆（issue #49）。
   */
  function openDetail(account: AccountMeta, tab?: DrawerTab) {
    setDetailAutoEditRemark(false);
    setDetailAutoEditGroup(false);
    setDetailInitialTab(tab ?? null);
    setDetailAccount(account);
    // ★ B5：顺带查一次**签到详情**（抽屉要显示「+100」+ 连签天数 + 日期列表）。
    //   此前只在批量接口里取了「是否已签到」，**详情从没查过** ⇒ 抽屉无从展示。
    void api
      .getCheckinStatus(account.id, region)
      .then((entry) => setCheckinDetailMap((prev) => ({ ...prev, [account.id]: entry })))
      .catch(() => {
        /* 查询失败不阻断抽屉：签到区**不渲染**即可（不摆空数据）。 */
      });
    // ★ 签到历史（近 7 天）：日期 + 结果来自签到日志；「获得积分」来自积分统计的签到事件。
    //   两者都**真实**取数；任一失败则该列回落「—」，不臆造。
    void api
      .getCheckinLogs()
      .then((res) => setDetailCheckinLogs(res.logs))
      .catch(() => setDetailCheckinLogs(null));
    void api
      .getCreditStatistics(false, region)
      .then((stats) => setDetailCreditEvents(stats.events))
      .catch(() => setDetailCreditEvents(null));
  }

  /**
   * 卡片上「未检测到的程序位」（IDE / CLI）点击 → **页面内闭环**（2026-10-23 更改）。
   *
   * ## 为什么不跳设置页
   *
   * 旧实现无论 `ide` 还是 `cli` 都 `navigate(...settings?section=diagnostics)` —— 但那个分区是
   * **文件系统权限检测**（`PermissionCheckCard`）：既没有 IDE 路径配置，也没有 CLI 接入项。
   * 跳过去解决不了问题，只是把用户从「不知道点哪里」换成「不知道在设置页找哪一条」。
   * 同页的「编辑器插件未检测」（`onGuidePlugin`）早就是「只 toast 说明动作」的正确模式，这里对齐。
   *
   * - `cli` → 打开接入确认弹窗（**与页面顶部 CLI 横幅同一个入口** `onInstallCodebuddyCli`）；
   * - `ide` → toast 说明「先安装并登录 CodeBuddy IDE」，装好后程序位会自动变为可切换。
   */
  function onGuideToSetting(target: GuideTarget) {
    if (target === "cli") {
      void onInstallCodebuddyCli();
      return;
    }
    toast.info(t("wbAccounts.toast.guideIdeSetting"));
  }

  /**
   * 开一轮逐账号批处理：建中止开关、清零进度。
   *
   * 返回的 `controller` 交给 `mapWithConcurrency`；批量条 / 页头的「取消」调 `cancelBulk()`。
   * ⚠️ 必须在 `try/finally` 里配对 `endBulkProgress()`，否则出错后进度条会永远停在半路。
   */
  function beginBulkProgress(total: number): AbortController {
    const controller = new AbortController();
    bulkAbortRef.current = controller;
    setBulkProgress({ done: 0, total });
    return controller;
  }

  function reportBulkProgress(done: number, total: number) {
    setBulkProgress({ done, total });
  }

  function endBulkProgress() {
    bulkAbortRef.current = null;
    setBulkProgress(null);
  }

  /** 「取消」= 协作式中止：尚未开始的账号不再发请求，在途的会跑完。 */
  function cancelBulk() {
    bulkAbortRef.current?.abort();
  }

  /**
   * 对一组账号跑签到（**全量批签与「只重试失败项」共用这一条路径**）。
   *
   * 返回：`ok` / `already`（两者都算成功）、`failedIds`（真的失败了）、
   * `notAttemptedIds`（被取消而**没发过请求**）。后两项必须分开 ——
   * 前者供 toast 的「只重试失败项」复用，后者只是没轮到；混在一起会让失败数虚高。
   *
   * ★ 并发档位见 `BATCH_WRITE_CONCURRENCY`：此前是 `for...of await` 串行，
   *   20 个账号就是 20 次串行 RTT，期间界面只有一个转圈。
   */
  async function runCheckinFor(ids: string[]) {
    const controller = beginBulkProgress(ids.length);
    let outcomes: (CheckinOutcome | undefined)[] = [];
    try {
      outcomes = await mapWithConcurrency(
        ids,
        async (id): Promise<CheckinOutcome> => {
          try {
            const res = await api.checkin(id, region);
            if (res.result === "success") return "success";
            if (res.result === "already") return "already";
            return "failed";
          } catch {
            return "failed";
          }
        },
        {
          concurrency: BATCH_WRITE_CONCURRENCY,
          gapMs: BATCH_WRITE_GAP_MS,
          signal: controller.signal,
          onProgress: reportBulkProgress,
        },
      );
    } finally {
      endBulkProgress();
    }

    const ok = outcomes.filter((outcome) => outcome === "success").length;
    const already = outcomes.filter((outcome) => outcome === "already").length;
    const failedIds = ids.filter((_, index) => outcomes[index] === "failed");
    const notAttemptedIds = ids.filter((_, index) => outcomes[index] === undefined);
    const attemptedIds = ids.filter((_, index) => outcomes[index] !== undefined);

    if (attemptedIds.length > 0) {
      const next = await fetchTodayCheckinMap(attemptedIds, region);
      if (Object.keys(next).length > 0) setCheckinMap((prev) => ({ ...prev, ...next }));
      await refreshCredits(attemptedIds, { region });
    }
    void reconcileAccounts(region);
    return { ok, already, failedIds, notAttemptedIds };
  }

  /* =====================================================================
   * ★ 三个作用域的职责边界（2026-10-26 修订，加任何新动作前先读这段）
   * =====================================================================
   *
   * | 作用域 | 入口 | 允许做什么 |
   * |:--|:--|:--|
   * | **一键**（页头，全部账号） | `quickRefreshAll` / `quickCheckinAll` | 只做**安全、幂等、可重复执行**的批处理：只读刷新，或自动跳过已完成项。**不做**删除 / 导出 / 凭据续期 / 完成任务 —— 在「全部账号」范围上误触发代价太大，且「完成任务」本身低频（2026-10-26 用户要求删除「一键完成」）。 |
   * | **批量**（勾选条，所选账号） | `batchRefreshPart` / `batchRefreshGrowth` / `batchRefreshToken` / `batchCheckin` / `batchCompleteTasks` / 导出 / 删除 | 用户**显式勾选**后才执行 ⇒ 允许写操作与破坏性操作（续期、删除）。只读刷新**不替用户跳过**账号，失败 / 跳过都写进结果文案。 |
   * | **单账号**（卡片 / 表格菜单、详情抽屉） | `onRefresh` / `onRefreshPart` / `onCheckin` / `onCompleteTasks` / 导出 / 删除 | 单实例、需要上下文才能判断的动作。菜单负责「一步做完」，抽屉负责「看清楚再决定」。 |
   *
   * ⚠️ 同一个动作**允许**在三个作用域各有一个入口（作用域不同、误触代价不同），
   * 但**同一作用域内不重复** —— 2026-10-23 删掉的「签到并刷新全部账号积分」
   * （`onRefreshCredits`）就是反例：它在页头之外又造了第三套刷新语义。
   * 2026-10-26 把「今日 Token」从一键刷新移出（卡片已不展示它）；
   * 「凭据状态」**保留**在一键里（用户拍板）：卡片上的凭据到期只有 `getAccounts` 能更新。
   *
   * ⚠️ 刷新语义只有三条，别再拼第四条：
   * ① 单账号：刷新组四项只读（积分 / 旅行 / 签到 / 凭据）+ 任务摘要 + 组外续期；
   * ② 批量：同一组四项只读 + 成长摘要 + 下拉外续期（2026-10-26 两边统一）；
   * ③ 一键复合只读（积分 / 旅行 / 签到状态 / 凭据状态 / 任务摘要；**不含**今日 Token）。
   * 成长摘要统一走 `refreshGrowthHint`（单账号 `force` 扫描），一键走全量扫描
   * （它本来就覆盖全部账号）。
   */

  /**
   * 批量签到：逐个走**单账号**接口（与单卡菜单同一路径）。
   * ★ 页面已知今日已签到的账号**直接跳过**（与「一键签到」同一口径）：
   *   批量签到只补没签的，重复提交换回的只是一串 `already`。状态未知的照常请求 ——
   *   后端会先查状态，已签到直接返回 `already`。
   * ★ 部分失败时**把失败项留在 toast 的 action 里** ⇒ 用户可「只重试失败项」，
   *   不必把已成功的再跑一遍（原型 P1-2：部分失败态不能只给一句 toast 就完事）。
   * @param ids 省略 = 对当前勾选项跑；传入 = 只对这批（重试路径）。
   */
  async function batchCheckin(ids?: string[]) {
    if (batchBusy || quickActionBusy) return;
    const targetIds =
      ids ?? accounts.filter((a) => selectedKeys.has(selectionKey(a.id))).map((a) => a.id);
    if (targetIds.length === 0) return;
    const pendingIds = targetIds.filter((id) => checkinMap[id] !== true);
    const skipped = targetIds.length - pendingIds.length;
    if (pendingIds.length === 0) {
      toast.info(t("wbAccounts.toast.checkinNone"));
      return;
    }
    setBatchBusy(true);
    try {
      /* 结果条与 toast 的说法由 `reportCheckinOutcome` 统一产出（与「一键签到」同一份）。 */
      reportCheckinOutcome(await runCheckinFor(pendingIds), skipped);
    } finally {
      setBatchBusy(false);
    }
  }

  /**
   * 签到结果的**统一说法**（批量条与页头「一键签到」共用）。
   *
   * ⚠️ 这两条入口此前各写一遍「拼 parts + 判断全失败 + 造重试 action」，20 行同构代码
   * 早晚漂移（已经出现过一边带「跳过 N 个」另一边不带的差异）。收成一处。
   *
   * 三种收尾：
   * - 全部尝试都失败 ⇒ error（不能把「一个都没签上」说成「签到完成」）；
   * - 一个都没轮到（用户立刻点了取消）⇒ info，**不报成功**，否则等于把取消谎报成完成；
   * - 其余（含部分失败 / 部分取消）⇒ success，但描述里逐项写清失败与未处理。
   *
   * 重试 action 覆盖「失败 + 未处理」两项：取消掉的账号同样需要补跑，
   * 只重试失败项会让它们永远停在未签到。
   */
  function reportCheckinOutcome(
    outcome: { ok: number; already: number; failedIds: string[]; notAttemptedIds: string[] },
    skipped: number,
  ) {
    const { ok, already, failedIds, notAttemptedIds } = outcome;
    const attempted = ok + already + failedIds.length;
    setCheckinResult({ ok: ok + already, failedIds });

    const parts: string[] = [];
    if (ok > 0) parts.push(t("wbAccounts.toast.checkinBatchSuccess", { n: ok }));
    if (already > 0) parts.push(t("wbAccounts.toast.checkinBatchAlready", { n: already }));
    if (skipped > 0) parts.push(t("wbAccounts.toast.checkinSkipped", { n: skipped }));
    if (failedIds.length > 0) {
      parts.push(t("wbAccounts.toast.checkinBatchFailed", { n: failedIds.length }));
    }
    if (notAttemptedIds.length > 0) {
      parts.push(t("wbAccounts.toast.batchCancelled", { n: notAttemptedIds.length }));
    }
    const summary =
      parts.length > 0 ? parts.join(t("shared.punct.comma")) : t("wbAccounts.toast.checkinNone");

    const retryIds = [...failedIds, ...notAttemptedIds];
    const retryAction =
      retryIds.length > 0
        ? {
            label: t("wbAccounts.toast.checkinRetryFailed"),
            onClick: () => void batchCheckin(retryIds),
          }
        : undefined;

    if (attempted === 0) {
      toast.info(t("wbAccounts.toast.batchCancelledToast"), { description: summary });
      return;
    }
    if (failedIds.length === attempted) {
      toast.error(t("wbAccounts.toast.checkinFailBatch"), { description: summary, action: retryAction });
      return;
    }
    toast.success(t("wbAccounts.toast.checkinDone"), { description: summary, action: retryAction });
  }

  /**
   * 批量条「刷新」下拉的单项入口（积分 / 签到状态 / 凭证状态各自独立）。
   *
   * 与单账号菜单 `onRefreshPart` 同一口径：**只重读**某一层，不续期凭据（写 refresh_token）、
   * 不提交签到。拆成多项而不是合成一个「刷新」：各类数据来源不同（上游 / 本机签到 /
   * 本机凭据），合成后失败原因分不清，慢的还会拖住快的。
   *
   * ⚠️ `tokens` 分支**已无入口**（2026-10-26 起「刷新今日 Token」不在任何菜单里），
   * 保留它只为让 `AccountRefreshKind` 的四值语义完整（Trae 抽屉 / 用量页仍在用它）。
   */
  async function batchRefreshPart(kind: AccountRefreshKind) {
    if (batchBusy || quickActionBusy) return;
    const targets = accounts.filter((a) => selectedKeys.has(selectionKey(a.id)));
    if (targets.length === 0) return;
    const ids = targets.map((a) => a.id);
    setBatchBusy(true);
    setBatchRefreshKind(kind);
    try {
      if (kind === "credits") {
        await refreshCredits(ids, { region });
      } else if (kind === "tokens") {
        /* 显式点刷新 ⇒ 强制重算「今日 Token」（绕过后端 TTL 闸门）。
           ⚠️ `get_account_token_today` 是**按整版本聚合**的接口，没有「只算这几个账号」
           的入参 ⇒ 选了 3 个也会重算全部。此前用同一句「已对 {n} 个所选账号执行」把这件
           事说成按所选执行，与批量「成长摘要」自己写下的边界（越界更新未勾选账号是越权）
           自相矛盾。这里如实换一句文案：范围是整版本，不能让用户以为只动了勾选的。 */
        await loadTokenToday(true);
        toast.success(t(REFRESH_DONE_LABEL[kind]), {
          description: t("wbAccounts.toast.batchRefreshTokensRegion"),
        });
        setBatchRefreshDoneKind(kind);
        return;
      } else if (kind === "checkin") {
        const next = await fetchTodayCheckinMap(ids, region);
        if (Object.keys(next).length > 0) setCheckinMap((prev) => ({ ...prev, ...next }));
      } else if (kind === "travel") {
        /* 与单账号同一路径（`queryTravelStatuses` 批量版）。失败项保留旧值，
           并且**不能**在没读到任何账号时亮「已更新」。 */
        const result = await loadTravelMap(ids);
        const okCount = ids.filter((id) => result.statuses[id] !== undefined).length;
        if (okCount === 0) {
          toast.error(t("wbAccounts.toast.travelFailed"));
          return;
        }
        if (result.failedIds.length > 0) {
          toast.warning(t("wbAccounts.toast.travelPartial", { ok: okCount, failed: result.failedIds.length }));
        } else {
          toast.success(t(REFRESH_DONE_LABEL[kind]), {
            description: t("wbAccounts.toast.batchRefreshDesc", { n: ids.length }),
          });
        }
        setBatchRefreshDoneKind(kind);
        return;
      } else {
        await reconcileAccounts(region);
      }
      toast.success(t(REFRESH_DONE_LABEL[kind]), {
        description: t("wbAccounts.toast.batchRefreshDesc", { n: ids.length }),
      });
      setBatchRefreshDoneKind(kind);
    } catch (e) {
      toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
    } finally {
      setBatchRefreshKind(null);
      setBatchBusy(false);
    }
  }

  /**
   * 批量条「续期凭据」：对所选账号**续期凭据**（写 refresh_token）。
   *
   * 这是四项只读刷新之外唯一的写操作，与单账号抽屉的「续期凭据」同一路径；
   * 没有 refresh_token 的账号回 `needsRelogin`，计入「需重新登录」而不是失败。
   * 续期成功后按单账号口径补齐卡片读数（积分 / 旅行 / 签到状态 / 今日 Token），
   * 否则用户只看到「已续期」而卡片数字一个没变。
   */
  async function batchRefreshToken() {
    if (batchBusy || quickActionBusy) return;
    const targets = accounts.filter((a) => selectedKeys.has(selectionKey(a.id)));
    if (targets.length === 0) return;
    setBatchBusy(true);
    setBatchRefreshKind("token");
    const controller = beginBulkProgress(targets.length);
    try {
      let outcomes: ("renewed" | "relogin" | "failed" | undefined)[] = [];
      try {
        outcomes = await mapWithConcurrency(
          targets,
          async (account) => {
            try {
              const res = await api.refreshAccountToken(account.id, region);
              return res.needsRelogin ? "relogin" : "renewed";
            } catch {
              return "failed";
            }
          },
          {
            concurrency: BATCH_WRITE_CONCURRENCY,
            gapMs: BATCH_WRITE_GAP_MS,
            signal: controller.signal,
            onProgress: reportBulkProgress,
          },
        );
      } finally {
        endBulkProgress();
      }
      const renewed = outcomes.filter((outcome) => outcome === "renewed").length;
      const needRelogin = outcomes.filter((outcome) => outcome === "relogin").length;
      const failed = outcomes.filter((outcome) => outcome === "failed").length;
      const notAttempted = outcomes.filter((outcome) => outcome === undefined).length;
      /* 只补读**真的发出过请求**的账号：取消掉的账号没被写过，重读它们是白打上游。 */
      const attemptedIds = targets.filter((_, index) => outcomes[index] !== undefined).map((a) => a.id);
      void reconcileAccounts(region);
      if (attemptedIds.length > 0) {
        void refreshCredits(attemptedIds, { region });
        void loadTravelMap(attemptedIds);
        try {
          const next = await fetchTodayCheckinMap(attemptedIds, region);
          if (Object.keys(next).length > 0) setCheckinMap((prev) => ({ ...prev, ...next }));
        } catch {
          /* 签到状态属辅助信息：失败不影响续期结论。 */
        }
        void loadTokenToday(true);
      }

      const parts: string[] = [];
      if (renewed > 0) parts.push(t("wbAccounts.toast.batchTokenRenewed", { n: renewed }));
      if (needRelogin > 0) parts.push(t("wbAccounts.toast.batchTokenRelogin", { n: needRelogin }));
      if (failed > 0) parts.push(t("wbAccounts.toast.batchTokenFailed", { n: failed }));
      if (notAttempted > 0) parts.push(t("wbAccounts.toast.batchCancelled", { n: notAttempted }));
      const summary = parts.join(t("shared.punct.comma"));
      if (renewed === 0) {
        toast.error(t("wbAccounts.toast.batchTokenFail"), { description: summary });
      } else {
        toast.success(t("wbAccounts.toast.batchTokenDone"), { description: summary });
      }
      setBatchRefreshDoneKind("token");
    } finally {
      setBatchRefreshKind(null);
      setBatchBusy(false);
    }
  }

  /**
   * 刷新下拉的「刷新任务」：对**所选账号逐个**强制重扫任务摘要（仅 WB·CN 注入）。
   *
   * ## 为什么逐个扫，而不是一次全量 `growthTasksScan(scope, { force: true })`
   *
   * 全量扫描会把它扫到的**全部账号**的摘要一起写回来 —— 包括没勾选的那些。
   * 批量条的动作边界是「**所选**账号」：越界更新未勾选账号的卡片标签，是行为上的越权
   * （用户会看到自己没动的卡片突然从「可领 1」变成「已领 2/2」）。
   *
   * ## 与「一键刷新」的分工
   *
   * 一键刷新覆盖**全部**账号 ⇒ 用全量强制扫描是对的；批量只覆盖勾选 ⇒ 逐个扫。
   * 两条路径共用 `refreshGrowthHint`（单账号 `force` 扫描 + 合并摘要），只有作用域不同。
   *
   * 失败口径：某个账号拿不到摘要就计入 `failed`；**全部失败**才报 error，
   * 部分成功仍算成功但把失败数写进描述 —— 不把「一半没刷到」报成「已完成」。
   *
   * ★ 返回值 `boolean` = 是否至少有一个账号刷到了摘要。刷新下拉里的「刷新任务」
   * 用它决定要不要亮「已更新」（`RefreshTasksItem` 把 `false` 当失败，不亮对勾）。
   */
  async function batchRefreshGrowth(): Promise<boolean> {
    if (region !== "cn") return false;
    if (batchBusy || quickActionBusy) return false;
    const targets = accounts.filter((a) => selectedKeys.has(selectionKey(a.id)));
    if (targets.length === 0) return false;
    setBatchBusy(true);
    setBatchRefreshKind("growth");
    const controller = beginBulkProgress(targets.length);
    try {
      let outcomes: (boolean | undefined)[] = [];
      try {
        outcomes = await mapWithConcurrency(
          targets,
          async (account) => refreshGrowthHint(account.id),
          {
            concurrency: BATCH_WRITE_CONCURRENCY,
            gapMs: BATCH_WRITE_GAP_MS,
            signal: controller.signal,
            onProgress: reportBulkProgress,
          },
        );
      } finally {
        endBulkProgress();
      }
      const failed = outcomes.filter((ok) => ok === false).length;
      const notAttempted = outcomes.filter((ok) => ok === undefined).length;
      const n = outcomes.filter((ok) => ok === true).length;
      if (n === 0) {
        toast.error(t("wbAccounts.toast.batchGrowthFail"), {
          description: t("wbAccounts.toast.batchGrowthDesc", { n: 0, failed: failed + notAttempted }),
        });
      } else {
        toast.success(t("wbAccounts.toast.batchGrowthDone"), {
          description: t("wbAccounts.toast.batchGrowthDesc", { n, failed: failed + notAttempted }),
        });
      }
      /* 「已更新」由 `RefreshTasksItem` 自己亮（它拿这个返回值判定），不再走批量的 done 状态。 */
      return n > 0;
    } finally {
      setBatchRefreshKind(null);
      setBatchBusy(false);
    }
  }

  /**
   * 页头「一键刷新」：把**卡片上能看到的读数**全部刷新到最新 ——
   * 积分 / 旅行 / 签到状态 / 凭据状态 / 任务摘要。
   *
   * ## 范围（2026-10-26 修订）
   *
   * | 项 | 刷新 | 说明 |
   * |:--|:--|:--|
   * | 积分 `credits` | ✅ | 上游，N 账号 × 3 路（3 并发 + 120ms） |
   * | 旅行 `travel` | ✅ | 上游，webui 下 1 次批量 |
   * | 签到状态 `checkin` | ✅ | 本机签到记录，1 次批量 |
   * | 凭据状态 `credential` | ✅ | `reconcileAccounts`（重取账号库：昵称 / 到期 / 需重登） |
   * | 任务摘要 `growth` | ✅ 仅国区 | 全量强制重扫（本来就覆盖全部账号） |
   * | 今日 Token | ❌ **不在范围内** | 归批量条 / 抽屉的单项刷新；卡片已不展示它 |
   *
   * ## ★ 「凭据状态」为什么留在这里（2026-10-26 用户拍板）
   *
   * 卡片上的「凭据到期 / 刷新令牌到期」来自 `account.expiresAt` / `refreshExpiresAt`，
   * **只能**由 `getAccounts`（即 `reconcileAccounts`）更新。把它移出会留下
   * 「积分 / 旅行 / 签到都新了、凭据还是旧日期」的半新半旧卡片 —— 用户报过这类障。
   * 因此一键刷新覆盖
   * **卡片上所有可见读数**，不做取舍。
   *
   * ⚠️ 顶栏 ⟳ 与这里共用同一条命令（`reconcileAccounts`），这是**刻意**的：
   * - 顶栏 ⟳ = 「重新发现账号库」：账号增减、安装 / 运行状态；
   * - 页头一键刷新 = 「刷新这张卡上的数字」，含凭据到期。
   * 两者数据层重叠，但用户心智不同；不要再试图把某一个拆成"只做一半"。
   *
   * 与「一键签到」明确分开：这里只重读数据，**不提交签到** ——
   * 否则点一次刷新就会把所有账号各打一次签到接口，正是用户要求避免的重复请求。
   *
   * 任务摘要走 `force`（绕过后端 10 分钟缓存），保证「一键刷新」之后
   * 卡片上的任务标签一定是最新值；扫描失败只影响这一项辅助信息，不阻断其余刷新。
   */
  async function quickRefreshAll(): Promise<boolean> {
    if (batchBusy || quickActionBusy || accounts.length === 0) return false;
    /* 兜底：即使按钮因切页恢复而暂时可点，模块级冷却仍能挡住重复请求。 */
    if (quickRefreshCoolingDown(scope)) return false;
    /* 先落一个截止时间：请求进行中切页再回来，按钮也不会立刻可点。 */
    startQuickRefreshCooldown(scope);
    setQuickActionBusy("refresh");
    try {
      const ids = accounts.map((account) => account.id);
      let growthFailed = false;
      let travelFailed = 0;
      const growthScan =
        region === "cn"
          ? api
              .growthTasksScan(scope, { force: true })
              .then((res) => {
                if (res.ok) setGrowthHints((prev) => ({ ...prev, ...res.accounts }));
                else growthFailed = true;
              })
              .catch(() => {
                /* 任务摘要属辅助信息：失败不打断整次刷新，但要在 toast 里说明。 */
                growthFailed = true;
              })
          : Promise.resolve();
      /* 旅行层单独留一份失败计数：全部读不到时**不能**报「一键刷新完成」。 */
      const travelScan = loadTravelMap(ids).then((result) => {
        travelFailed = result.failedIds.length;
      });
      await Promise.all([
        refreshCredits(ids, { region }),
        travelScan,
        growthScan,
        /* ★ 凭据状态（昵称 / 到期 / 需重登）与顶栏 ⟳ 同一条命令。留在这是**必须**的：
           卡片的「凭据到期 / 刷新令牌到期」只有 `getAccounts` 能更新，移出会留下
           「其他数字都新了、凭据还是旧日期」的半新半旧卡片。失败不阻断其余数据。 */
        reconcileAccounts(region).catch(() => undefined),
      ]);
      const next = await fetchTodayCheckinMap(ids, region);
      if (Object.keys(next).length > 0) setCheckinMap((prev) => ({ ...prev, ...next }));
      /* toast 必须把范围说全，否则用户会以为「账号信息 / Token 也刷了」。 */
      const description = growthFailed
        ? t("wbAccounts.toast.quickRefreshTasksFailed", { n: ids.length })
        : region === "cn"
          ? t("wbAccounts.toast.quickRefreshScope", { n: ids.length })
          : t("wbAccounts.toast.quickRefreshScopeNoTasks", { n: ids.length });
      if (travelFailed > 0) {
        /* 有账号没读到旅行状态 ⇒ **不报全成功**；已成功的项仍在界面上更新了。 */
        toast.warning(t("wbAccounts.toast.quickRefreshTravelPartial", { n: ids.length, failed: travelFailed }), {
          description,
        });
      } else {
        toast.success(t("wbAccounts.toast.quickRefreshDone"), { description });
      }
      return true;
    } finally {
      setQuickActionBusy(null);
    }
  }

  /**
   * 工具栏「一键签到」：只对**尚未签到**的账号发请求。
   *
   * 跳过依据是页面缓存的 `checkinMap`（`true` = 今日已签到）。
   * 状态未知的账号照常请求：后端 `checkin_account_for` 会先查状态，
   * 已签到直接返回 `already`，不会二次提交。
   */
  async function quickCheckinAll() {
    if (batchBusy || quickActionBusy || accounts.length === 0) return;
    const pendingIds = accounts
      .filter((account) => checkinMap[account.id] !== true)
      .map((account) => account.id);
    const skipped = accounts.length - pendingIds.length;
    if (pendingIds.length === 0) {
      toast.info(t("wbAccounts.toast.checkinNone"));
      return;
    }
    setQuickActionBusy("checkin");
    try {
      reportCheckinOutcome(await runCheckinFor(pendingIds), skipped);
    } finally {
      setQuickActionBusy(null);
    }
  }

  /**
   * 单账号「一键完成」的唯一实现 —— 卡片菜单与批处理都调它。
   *
   * 结局按 {@link CompleteTasksOutcome} 归一化，调用方只负责措辞；**不要**再在调用方
   * 按 `claimed` 自己判一次，那正是「上报了进度却被说成没有可完成任务」的来源。
   *
   * 无论成败都强制重扫该账号摘要（失败也可能已被后端部分推进）；串在函数内部，
   * 保证批处理并发时也不漏。
   */
  async function completeTasksOnce(account: AccountMeta): Promise<CompleteTasksOutcome> {
    let outcome: CompleteTasksOutcome;
    try {
      const report = await api.growthTasksAuto(scope, account.id);
      const claimed = report.claimed ?? 0;
      if (!report.ok) {
        outcome = { kind: "failed", message: report.message };
      } else if (claimed > 0) {
        outcome = { kind: "done", claimed, credit: report.credit ?? 0 };
      } else if ((report.results ?? []).some((item) => item.status === "progressed")) {
        outcome = { kind: "progressed" };
      } else {
        outcome = { kind: "skipped" };
      }
    } catch (error) {
      outcome = { kind: "failed", message: String((error as Error)?.message ?? error) };
    }
    await refreshGrowthHint(account.id);
    return outcome;
  }

  /**
   * 跑一组账号的成长任务（「一键完成」与批量条「完成任务」共用）。
   *
   * 调用方负责先扫描摘要、筛出可行动账号并算出跳过数；这里只负责逐账号执行、
   * 回写摘要与积分，以及部分失败汇总 —— 两条入口对同一动作必须给同一套说法。
   *
   * ★ 「跳过」不只来自调用方的摘要筛选：摘要可能落后（缓存 10 分钟），真正执行时
   *   后端回读后可能发现任务已全部领完 / 无需处理 —— 这类账号同样计入跳过，
   *   不把「本来就已完成」算成一次完成。
   */
  async function completeTasksFor(targets: AccountMeta[], skipped: number, noneMessage: string) {
    const controller = beginBulkProgress(targets.length);
    let outcomes: (CompleteTasksOutcome | undefined)[] = [];
    try {
      outcomes = await mapWithConcurrency(
        targets,
        completeTasksOnce,
        {
          concurrency: BATCH_WRITE_CONCURRENCY,
          gapMs: BATCH_WRITE_GAP_MS,
          signal: controller.signal,
          onProgress: reportBulkProgress,
        },
      );
    } finally {
      endBulkProgress();
    }

    let skippedCount = skipped;
    let progressedCount = 0;
    let claimedCredit = 0;
    let done = 0;
    const failedIds: string[] = [];
    const creditedIds: string[] = [];
    let notAttempted = 0;
    outcomes.forEach((outcome, index) => {
      if (!outcome) {
        notAttempted += 1;
        return;
      }
      if (outcome.kind === "failed") failedIds.push(targets[index].id);
      else if (outcome.kind === "skipped") skippedCount += 1;
      else if (outcome.kind === "progressed") progressedCount += 1;
      else {
        done += 1;
        claimedCredit += outcome.credit;
        if (outcome.credit > 0) creditedIds.push(targets[index].id);
      }
    });
    if (creditedIds.length > 0) await refreshCredits(creditedIds, { region });

    const parts: string[] = [];
    if (done > 0) {
      parts.push(t("wbAccounts.toast.completeSummary", { n: done, credit: claimedCredit }));
    }
    if (progressedCount > 0) {
      parts.push(t("wbAccounts.toast.completeProgressed", { n: progressedCount }));
    }
    if (skippedCount > 0) parts.push(t("wbAccounts.toast.completeSkipped", { n: skippedCount }));
    if (failedIds.length > 0) {
      parts.push(t("wbAccounts.toast.completeFailed", { n: failedIds.length }));
    }
    if (notAttempted > 0) parts.push(t("wbAccounts.toast.batchCancelled", { n: notAttempted }));
    const summary = parts.join(t("shared.punct.comma"));
    if (failedIds.length === targets.length) {
      toast.error(t("wbAccounts.toast.completeDoneFail"), { description: summary });
    } else if (done === 0 && failedIds.length === 0) {
      /* 没有领到任何奖励 ⇒ 不摆「任务完成」的成功语气。但「已上报进度」仍然是一次
         真实的动作（抽屉也是这么说的），不能并进「无事可做」。 */
      toast.info(
        progressedCount > 0 ? t("shared.growthTasks.progressedOnly") : noneMessage,
        { description: summary },
      );
    } else {
      toast.success(t("wbAccounts.toast.completeDone"), { description: summary });
    }
  }

  /** 先补一次非强制摘要扫描，避免拿页面旧摘要判断「哪些账号有可做任务」。 */
  async function scanGrowthHintsNow() {
    let hints = growthHints;
    try {
      const res = await api.growthTasksScan(scope);
      if (res.ok) {
        hints = { ...hints, ...res.accounts };
        setGrowthHints((prev) => ({ ...prev, ...res.accounts }));
      }
    } catch {
      /* 摘要扫描失败不阻断：继续用页面已有缓存判断是否值得请求。 */
    }
    return hints;
  }

  /**
   * 批量条「完成任务」：只对**勾选账号**跑成长任务（仅国内版）。
   *
   * 与「一键完成」共用扫描 / 筛选 / 执行 / 文案，差别只在作用域：
   * 没有可做任务的勾选账号计入「跳过」，而不是照样打上游换回一串失败。
   *
   * ⚠️ 2026-10-26（用户要求）：页头「一键完成」已删除 —— 成长任务是低频动作，
   * 不值得占一枚页头按钮。批量条与单账号菜单仍保留该动作（用户显式勾选 / 指定账号时）。
   */
  async function batchCompleteTasks() {
    if (region !== "cn") return;
    if (batchBusy || quickActionBusy) return;
    const selected = accounts.filter((a) => selectedKeys.has(selectionKey(a.id)));
    if (selected.length === 0) return;
    setBatchBusy(true);
    try {
      const hints = await scanGrowthHintsNow();
      const targets = selected.filter((account) => {
        const hint = hints[account.id];
        return Boolean(hint?.ok && (hint.autoable > 0 || hint.claimable > 0));
      });
      const skipped = selected.length - targets.length;
      if (targets.length === 0) {
        toast.info(t("wbAccounts.toast.completeSelectedNone"));
        return;
      }
      await completeTasksFor(targets, skipped, t("wbAccounts.toast.completeSelectedNone"));
    } finally {
      setBatchBusy(false);
    }
  }

  /** 账号的撤销 toast 副标题（过 `displayText` 白屏防线；全空则不显示副标题）。 */
  function accountUndoLabel(account: AccountMeta): string | undefined {
    return displayText(account.nickname) || displayText(account.email) || displayText(account.id) || undefined;
  }

  /**
   * 删除成功后弹「已删除 · 撤销」（P6 T04 §1.4）。
   *
   * ★ 撤销必须**真的能撤销**：删除是软删除（账号进回收站，P5 §2.7），撤销就是把账号从
   * 回收站移回 live —— 走 `api.accountRestore`（**与回收站同一命令**，不另写恢复逻辑）。
   * 恢复后 `reconcileAccounts` 重取列表，否则用户「撤销了却看不到账号回来」。
   *
   * 连续删多个时每条 toast 各自独立（`showUndoToast` 内部**不传固定 id**）。
   */
  function offerUndo(keys: readonly string[], description?: string) {
    showUndoToast({
      title: keys.length === 1 ? t("undo.deletedTitle") : t("undo.batchTitle", { n: keys.length }),
      description,
      undoLabel: t("undo.action"),
      undoneTitle: t("undo.undone"),
      undo: async () => {
        // 逐个恢复：一个失败不阻断其余；全部尝试后再刷新，最后把首个错误抛出（不静默）。
        let firstError: unknown = null;
        for (const key of keys) {
          try {
            await api.accountRestore(scope, key);
          } catch (e) {
            if (!firstError) firstError = e;
          }
        }
        await reconcileAccounts(region);
        if (firstError) throw firstError;
      },
    });
  }

  /** 批量删除（先确认）。逐个删除，任一个失败不阻断其余。 */
  async function batchDelete() {
    if (batchBusy || quickActionBusy) return;
    const targets = accounts.filter((a) => selectedKeys.has(selectionKey(a.id)));
    setBatchDeleteOpen(false);
    if (targets.length === 0) return;
    setBatchBusy(true);
    try {
      const deleted: AccountMeta[] = [];
      let failed = 0;
      for (const a of targets) {
        try {
          await deleteAccountStore(a.id, region);
          deleted.push(a);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) toast.error(t("wbAccounts.toast.deleteFail"), { description: `${failed}` });
      clearSelection();
      if (deleted.length > 0) {
        offerUndo(
          deleted.map((a) => a.id),
          deleted.length === 1 ? accountUndoLabel(deleted[0]) : undefined,
        );
      }
    } finally {
      setBatchBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void api
      .getAutoCheckinConfig()
      .then((config) => {
        if (!cancelled) setAutoCheckinConfig(config);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(t("wbAccounts.toast.autoCheckinLoadFail"), { description: api.asError(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .getAutoTravelConfig()
      .then((config) => {
        if (!cancelled) setAutoTravelConfig(config);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(t("wbAccounts.toast.autoTravelLoadFail"), { description: api.asError(e) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSwitchConfig()
      .then((config) => {
        if (!cancelled) setSwitchConfig(config);
      })
      .catch(() => {
        // 静默按默认值走：这两项只是偏好（排序 / 默认勾选），读不到不影响核心功能，
        // 而每次挂载都弹一次错误提示的代价远大于收益。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshCodebuddyCliStatus() {
    try {
      setCodebuddyCli(await api.getCodebuddyCliStatus());
    } catch {
      setCodebuddyCli(null);
    }
  }

  async function refreshCodebuddyCnIdeStatus() {
    try {
      setCodebuddyCnIde(await api.getCodebuddyCnIdeStatus());
    } catch {
      setCodebuddyCnIde(null);
    }
  }

  /**
   * 编辑器内 CodeBuddy 插件（VS Code / JetBrains）的**安装 / 运行 / 登录态**。
   *
   * ⚠️ 只拉 `status`，**不**在挂载时调 `detect`：`detect` 要**解密** secret（macOS 会弹
   * 钥匙串授权）⇒ 放进每次挂载的轮询路径会骚扰用户；「当前账号」改由本地状态文件给出，
   * 用户主动点「从本机导入」时才解密（与 `vscode_ext::status` 的注释同一口径）。
   */
  async function refreshVscodePluginStatus() {
    try {
      setVscodePlugin(await api.getVscodeCodebuddyPluginStatus());
    } catch {
      setVscodePlugin(null);
    }
  }

  async function refreshJetbrainsPluginStatus() {
    try {
      setJetbrainsPlugin(await api.getJetbrainsCodebuddyPluginStatus());
    } catch {
      setJetbrainsPlugin(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void refreshCodebuddyCliStatus();
    /* 两个编辑器插件的状态：与 CLI / IDE 同批拉取（都是**本机只读探测**，无网络）。 */
    void refreshVscodePluginStatus();
    void refreshJetbrainsPluginStatus();
    void (async () => {
      if (!api.isDemoMode()) {
        try {
          await api.detectCodebuddyCnIdeAccount();
        } catch {
          /* 未登录或钥匙串拒绝时静默，下面仍拉安装/运行状态 */
        }
      }
      if (!cancelled) await refreshCodebuddyCnIdeStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts.length]);

  /**
   * 自动导入「已登录、但还不在账号库里」的本机账号。
   *
   * ⚠️ 旧实现是一个「每版本只尝试一次」的布尔闸（`autoImportTried`），且要求
   * `accounts.length === 0`。于是**登录发生在页面加载之后**时必然错过：
   * 用户在客户端登录（或重新登录）后回到本页，闸门已经合上 ⇒ 不再导入 ⇒
   * 账号列表一直空着，只剩一张「当前登录」提示卡（2026-09-24 用户报障：
   * 「下面怎么是空的了」）。
   *
   * 改为**按 uid 记账**：只要「当前登录的 uid」还没为它试过一次，就试一次；
   * 也不再因 `accounts.length > 0` 提前返回 —— 库非空时当前账号仍可能不在库里。
   * 导入成功后 `accounts` 里就有该 uid，`accounts.some(...)` 自然成立，不会重复调用；
   * 导入失败则 uid 已入账，同样不会变成重试循环。
   */
  const autoImportTriedUids = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (loading) return;
    const current = status?.current;
    if (!current) return;
    const uid = current.uid;
    if (!uid) return;
    if (accounts.some((a) => isWorkbuddyCurrent(a, current))) return;
    if (autoImportTriedUids.current.has(uid)) return;
    autoImportTriedUids.current.add(uid);
    void importLocalStore(region)
      .then(() => void reconcileAccounts(region))
      .catch(() => {
        /* 本机无可用登录态时静默，不打扰用户 */
      });
  }, [accounts, status, loading, importLocalStore, reconcileAccounts, region]);

  // 切到该版本时立刻重查一次状态：`status.current` 决定卡片上的「当前账号」标记，
  // 若沿用上一次的快照，切换账号（尤其是国际版）后标记会停在旧账号上。
  useEffect(() => {
    void refreshRegionStatus(region);
  }, [refreshRegionStatus, region]);

  // 账号列表变化后并行查询各账号今日签到状态。
  //
  // 这是一次「被动请求」：用户没点任何东西，是我们自己发起的批量查询，所以必须受自动签到开关约束 ——
  // 开关关掉后还继续查，只会白白消耗上游额度、制造噪声。
  // `autoCheckinConfig` 为 `null` 表示配置还没读回来，此时同样不发：拿一个「尚未读到」的状态当默认值，
  // 会在开关实际为关的机器上先误发一轮，等配置回来才停 —— 已经产生的请求收不回来，违背开关本意。
  // 依赖里带上 `enabled`，开关切换后 effect 才会重跑：开→关立即停，关→开立即补一次。
  useEffect(() => {
    if (!autoCheckinConfig?.enabled) return;
    if (!accounts.length) return;
    let cancelled = false;
    void fetchTodayCheckinMap(
      accounts.map((account) => account.id),
      region,
      () => cancelled,
    ).then((next) => {
      if (!cancelled && Object.keys(next).length > 0) {
        setCheckinMap((prev) => ({ ...prev, ...next }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, region, autoCheckinConfig?.enabled]);

  /**
   * 批量扫一次成长任务摘要（卡片提示标签）。
   *
   * 为什么放在「账号列表就绪后」而不是每张卡各自请求：每卡一次 = 打开账号页就打
   * N 次上游；批量 + 后端缓存后，绝大多数打开是**零**上游请求。
   * 只服务 CN（国际版没有成长任务体系，打了也只会拿到错误）。
   */
  useEffect(() => {
    if (region !== "cn") return;
    if (!accounts.length) return;
    let cancelled = false;
    void api
      .growthTasksScan(scope)
      .then((res) => {
        if (!cancelled && res.ok) setGrowthHints((prev) => ({ ...prev, ...res.accounts }));
      })
      .catch(() => {
        // 提示标签是**辅助信息**：扫不到就不挂标签，绝不为它弹错误打断用户。
      });
    return () => {
      cancelled = true;
    };
  }, [accounts, region, scope]);

  /**
   * 刷**单个**账号的任务摘要（抽屉里跑完「一键完成 / 领取」后调用）。
   *
   * 必须有这条：否则用户领完奖励关掉抽屉，卡片上还挂着「可领 1」——
   * 而重扫全表只为了纠正一张卡，代价又太大。
   *
   * @returns 是否**真的拿到了新摘要**。批量刷新用它统计失败数（见 `batchRefreshGrowth`）：
   *          非 CN、上游报错、异常都算失败，不把「什么都没发生」报成成功。
   */
  async function refreshGrowthHint(accountId: string): Promise<boolean> {
    if (region !== "cn") return false;
    try {
      const res = await api.growthTasksScan(scope, { force: true, accountId });
      if (!res.ok) return false;
      setGrowthHints((prev) => ({ ...prev, ...res.accounts }));
      return true;
    } catch {
      // 辅助信息，失败不打扰；下次整页扫描会自己纠正。
      return false;
    }
  }

  /**
   * 卡片菜单「刷新任务」：重扫**单个**账号的任务摘要并给回执。
   *
   * 只更新卡片上的「可领 / 可自动」，不执行任务（执行是「完成任务」）。
   * 返回 `false` 时调用方菜单不亮「已更新」。
   */
  async function onRefreshGrowthHintForCard(a: AccountMeta): Promise<boolean> {
    if (growthHintRefreshingIds.has(a.id)) return false;
    setGrowthHintRefreshingIds((prev) => new Set(prev).add(a.id));
    try {
      const ok = await refreshGrowthHint(a.id);
      const label = accountDisplayName(a);
      if (ok) {
        toast.success(`${label}${t("shared.punct.colon")}${t("shared.growthTasks.refreshDone")}`);
      } else {
        toast.error(t("shared.refreshPart.fail"), { description: label });
      }
      return ok;
    } finally {
      setGrowthHintRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    }
  }

  /**
   * 抽屉「任务」的**统一刷新**：指标卡 ⟳ 与任务页签 ⟳ 走同一条。
   *
   * ★ 2026-10-26 用户报障：两个 ⟳ 此前各刷一半 —— 指标卡只强制重扫摘要
   * （`growth_tasks_scan`，页签里的列表不动），页签只重拉列表
   * （`growth_tasks_list`，指标块与卡片标签的「可领 N」不动）。同一个「刷新」在两个
   * 入口给出两种结果，等于没有一致的语义。页签入口把列表 `reload` 传进来，
   * 页面先等摘要重扫、再等列表重拉，避免列表先完成而读回旧摘要；两路都成功才报成功。
   * 指标卡入口没有已挂载列表，只重扫摘要。
   */
  async function refreshGrowthAccount(a: AccountMeta, reloadTasks?: () => Promise<boolean>) {
    if (growthRefreshBusyId !== null) return;
    setGrowthRefreshBusyId(a.id);
    try {
      const summaryOk = await refreshGrowthHint(a.id);
      const listOk = reloadTasks ? await reloadTasks() : true;
      const label = accountDisplayName(a);
      if (summaryOk && listOk) {
        toast.success(
          `${label}${t("shared.punct.colon")}${t("shared.growthTasks.refreshDone")}`,
        );
      } else {
        toast.error(t("shared.refreshPart.fail"), { description: label });
      }
    } finally {
      setGrowthRefreshBusyId(null);
    }
  }

  /**
   * 卡片菜单的「完成任务」（单账号一键完成）。
   *
   * 与抽屉里的「一键完成」走**同一个后端命令**（`growth_tasks_auto`），toast 也复用同一批词条 ——
   * 两个入口对同一个动作给两套说法会让人怀疑哪个是真的。结局判定与摘要回写都收在
   * {@link completeTasksOnce}（批处理也走它），这里只按四态选措辞。
   *
   * 完成后刷新**这一张卡**的任务摘要与积分：领到的奖励直接落在积分上，
   * 不重拉积分的话卡片会停在「刚领完却还是旧数」。
   */
  async function onCompleteTasks(a: AccountMeta) {
    const label = accountDisplayName(a);
    const outcome = await completeTasksOnce(a);
    switch (outcome.kind) {
      case "failed":
        toast.error(outcome.message ?? t("wbAccounts.toast.completeDoneFail"), { description: label });
        return;
      case "progressed":
        /* 与抽屉「一键完成」同一句话：进度已上报、奖励未达标 ≠ 无事可做。 */
        toast.info(t("shared.growthTasks.progressedOnly"), { description: label });
        return;
      case "skipped":
        toast.info(t("shared.growthTasks.autoNone"), { description: label });
        return;
      default:
        toast.success(t("shared.growthTasks.autoDone", { n: outcome.claimed, credit: outcome.credit }), {
          description: label,
        });
        void refreshCredits([a.id], { region });
    }
  }

  /**
   * 重读旅行状态：**只写成功项**，失败项保留旧值。
   *
   * 返回值显式带 `failedIds`，供「单账号刷新」「批量刷新」「一键刷新」如实提示；
   * 后台轮询忽略返回值即可（它本来就是容错优先）。
   */
  async function loadTravelMap(
    accountIds: string[],
    isStale?: () => boolean,
  ): Promise<api.TravelStatusQuery> {
    const result = await fetchTravelMap(accountIds, region, isStale);
    if (!isStale?.() && Object.keys(result.statuses).length > 0) {
      setTravelMap((prev) => ({ ...prev, ...result.statuses }));
    }
    return result;
  }

  // 账号列表变化后并行查询旅行状态；后台领取后每 60 秒再拉一次，避免卡片停在「旅行中」。
  //
  // 同样是「被动请求」，必须受自动旅行开关约束：关掉后不仅首查不发，连这个 60 秒轮询定时器都不该建立，
  // 否则会以每分钟一次的频率持续空打上游 —— 定时器的代价比单次请求更高，更要拦在建立之前。
  // `autoTravelConfig` 为 `null`（配置尚未读回）时同样不发，理由同上：不能把「未知」当作默认开启先打一轮。
  // 依赖里带上 `enabled`，开关切换后 effect 才会重跑：关掉时清理函数会顺手 clearInterval，开关打开时重新建表。
  //
  // ★ 拆成两个 effect：**首查**与**轮询**对可见性的要求不同（见下）。
  const documentVisible = useDocumentVisible();

  // 首查：不受可见性门控 —— 否则「切到后台再切回来」会因为 effect 重跑被跳过而看到空态。
  useEffect(() => {
    if (!autoTravelConfig?.enabled) return;
    if (!accounts.length) return;
    let cancelled = false;
    const ids = accounts.map((account) => account.id);
    void loadTravelMap(ids, () => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, region, autoTravelConfig?.enabled]);

  // 轮询：**加可见性门控** —— 应用在后台时每分钟空打一次上游毫无意义（用户看不见）。
  // 只门控「要不要建这个定时器」，间隔 60 秒本身不动。
  useEffect(() => {
    if (!autoTravelConfig?.enabled) return;
    if (!accounts.length) return;
    if (!documentVisible) return;
    let cancelled = false;
    const ids = accounts.map((account) => account.id);
    const timer = window.setInterval(() => {
      void loadTravelMap(ids, () => cancelled);
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, region, autoTravelConfig?.enabled, documentVisible]);

  // 只给尚未缓存的账号拉积分；切回首页不重复请求。点「刷新积分」才强制更新。
  useEffect(() => {
    if (!accounts.length) return;
    void ensureCredits(accounts.map((account) => account.id), region);
  }, [accounts, ensureCredits, region]);

  /**
   * 「今日 Token」按账号聚合（只读）—— 卡片指标行 / 表格列的数据源。
   *
   * ⚠️ 读不到时**清空为「今日无记录」**（卡片 / 表格渲染「—」），**绝不**沿用上一次的数字：
   * 换 region 后旧数字会张冠李戴（本仓踩过字段张冠李戴的坑）。取数失败不弹错、不打扰用户。
   *
   * ## ★ `force` 的边界（2026-10-12）
   *
   * 后端 `force` 会**绕过**「距上次扫描不足 TTL」的闸门、立刻重扫客户端会话日志；
   * 默认路径**不给** —— 由后端按 TTL 自己决定（否则每次进页面都全量重扫）。
   * 只有**用户显式点刷新**才给 `true`。
   *
   * 重扫本身不贵：后端带 mtime 预筛，只读「当天动过的文件」（实测 40GB → 当天那几 MB）。
   */
  const tokenTodayGenRef = useRef(0);
  const loadTokenToday = useCallback(
    async (force: boolean) => {
      /* 代次：region 变化后晚到的旧响应**不得**覆盖新结果（否则又变成张冠李戴）。 */
      const gen = (tokenTodayGenRef.current += 1);
      const current = () => gen === tokenTodayGenRef.current;
      try {
        const res = await api.getAccountTokenToday(region, force);
        if (!current()) return;
        const map = new Map<string, AccountTokenTodayEntry>();
        for (const entry of res.accounts ?? []) map.set(entry.uid, entry);
        setTokenTodayMap(map);
        setTokenTodayTruncated(Boolean(res.gatewayTruncated));
      } catch {
        if (!current()) return;
        setTokenTodayMap(new Map());
        setTokenTodayTruncated(false);
      }
    },
    [region],
  );

  useEffect(() => {
    void loadTokenToday(false);
  }, [loadTokenToday, accounts.length]);

  async function onRecheck() {
    await Promise.all([refreshRegionStatus(region), reconcileAccounts(region)]);
  }

  async function onImport() {
    setImporting(true);
    try {
      const acc = await importLocalStore(region);
      toast.success(t("wbAccounts.toast.imported"), { description: accountDisplayName(acc) });
    } catch (e) {
      toast.error(t("wbAccounts.toast.importFail"), { description: api.asError(e) });
    } finally {
      setImporting(false);
    }
  }

  /** 导出完成提示（含安全提醒）。 */
  function onExported(count: number) {
    const text = t("wbAccounts.toast.exportDetail", { count });
    toast.success(t("wbAccounts.toast.exportSuccess"), { description: text });
  }

  /** 导入完成提示：计数 + token 可能过期提醒，并刷新列表。 */
  function onImported(result: { imported: number; skipped: number; overwritten: number }) {
    void reconcileAccounts(region);
    const overwriteText = result.overwritten > 0 ? t("wbAccounts.toast.importOverwrite", { n: result.overwritten }) : "";
    const text = t("wbAccounts.toast.importDetail", { imported: result.imported, overwrite: overwriteText, skipped: result.skipped });
    toast.success(t("wbAccounts.toast.importSuccess"), { description: text });
  }

  function onDelete(a: AccountMeta) {
    // 桌面 App（Tauri WebView）不支持 window.confirm，改用 Dialog 确认
    setDeleteTarget(a);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const a = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAccountStore(a.id, region);
      // 软删除成功 ⇒ 弹「已删除 · 撤销」（撤销走 account_restore，与回收站同一命令）。
      offerUndo([a.id], accountUndoLabel(a));
    } catch (e) {
      toast.error(t("wbAccounts.toast.deleteFail"), { description: api.asError(e) });
    }
  }

  async function onCheckin(a: AccountMeta) {
    try {
      const res = await api.checkin(a.id, region);
      const label =
        res.result === "success"
          ? t("wbAccounts.toast.checkinSuccess")
          : res.result === "already"
            ? t("wbAccounts.toast.checkedInToday")
            : t("wbAccounts.toast.checkinFail");
      const description = `${accountDisplayName(a)}${res.error ? `${t("shared.punct.colon")}${res.error}` : ""}`;
      if (res.result === "error") toast.error(label, { description });
      else toast.success(label, { description });
      // 刷新该账号的今日签到状态
      try {
        const st = await api.getCheckinStatus(a.id, region);
        if (st.ok) {
          setCheckinMap((prev) => ({ ...prev, [a.id]: st.todayCheckedIn }));
          /* ★ 2026-10-23：抽屉「签到」页签现在**自带签到按钮**，所以详情缓存也必须跟着更新 ——
             只写 `checkinMap` 的话，刚签完的账号在抽屉里仍显示「未签到」，
             按钮还留在原地（点了会得到「今天已签到」）。 */
          setCheckinDetailMap((prev) => ({ ...prev, [a.id]: st }));
        }
      } catch {
        /* ignore */
      }
      void reconcileAccounts(region);
      // 签到成功/已签到会带来积分变动，force 刷新该账号积分
      if (res.result !== "error") void refreshCredits([a.id], { region });
    } catch (e) {
      toast.error(t("wbAccounts.toast.checkinFail"), { description: api.asError(e) });
    }
  }

  /**
   * 卡片菜单 /详情抽屉的「续期凭据」（**单账号**）。
   *
   * ★ 2026-10-16 修复：原先只刷 token + `reconcileAccounts`，卡片上的**其余数据源一个都没动**
   * —— 积分（`creditMap`）、今日 Token（`tokenTodayMap`）、旅行（`travelMap`）、
   * 今日签到（`checkinMap`）全都停在旧值。用户点完只看到一句「凭据已续期」，
   * 而卡片上真正会变的数字一个都没变 ⇒ 「点了刷新没反应」（本条报障）。
   *
   * `reconcileAccounts` 只换`accounts` 数组（账号元信息：昵称/到期/需重登），
   * **上面四张 map 是页面本地的 state，与它无关** —— 这是「刷新了却看不到变化」的结构性原因。
   *
   * 现在按「用户在点这个账号的刷新 ⇒ 想看这个账号此刻的真实数据」的口径，
   * 成功后把这四路一并重拉（失败各自吞掉，不影响已成功的 token 刷新提示）。
   */
  const refreshBusy = useAccountRefreshBusy();

  /**
   * 单项刷新（四项各自独立）。
   *
   * 与 {@link onRefresh} 的区别：那个是**续期**凭据（写 `refresh_token`），
   * 这里是**重读**某一层数据 —— 积分打上游、Token 重扫本机会话日志、签到读签到状态、
   * 凭据只是重取账号元数据。合成一个动作会让「刷新失败」分不清是哪一层的问题。
   */
  const onRefreshPart = useCallback(
    async (a: AccountMeta, kind: AccountRefreshKind) => {
      const label = accountDisplayName(a);
      /* ⚠️ 错误 toast 放在 `run` **外面**：任务抛错 ⇒ `run` 不亮「已更新」。
         此前 catch 在任务内部吞掉错误，失败项（尤其是「读不到旅行状态」）
         仍会亮绿勾 —— 错误提示旁挂着「已更新」。 */
      try {
        await refreshBusy.run(a.id, kind, async () => {
          if (kind === "credits") {
            await refreshCredits([a.id], { region });
          } else if (kind === "tokens") {
            /* `force=true`：用户显式点了刷新，就绕过后端「距上次扫描不足 TTL」的闸门。 */
            await loadTokenToday(true);
          } else if (kind === "checkin") {
            const next = await fetchTodayCheckinMap([a.id], region);
            if (Object.keys(next).length > 0) setCheckinMap((prev) => ({ ...prev, ...next }));
          } else if (kind === "travel") {
            /* 只重读这个账号的旅行 / 加速器状态（卡片 chip 与表格列共用 `travelMap`）。
               ★ 没拿到条目 ⇒ 抛错：任务抛错时 `refreshBusy` 不会亮「已更新」，
               用户看到的是「刷新失败」而不是绿勾。「无 Buddy」等正常业务态有 `label`，
               仍然算读取成功。 */
            const result = await loadTravelMap([a.id]);
            if (result.statuses[a.id] === undefined) {
              throw new Error(t("wbAccounts.toast.travelFailed"));
            }
          } else {
            await reconcileAccounts(region);
          }
          /* ★ 2026-10-23（用户反馈）：单账号回执合成**一行** —— description 只放一个
             账号名会孤零零占一行，标题+短描述的上下排版反而失衡。
             批量刷新的 description 是完整句子，维持上下两行不动。 */
          toast.success(`${label}${t("shared.punct.colon")}${t(REFRESH_DONE_LABEL[kind])}`);
        });
      } catch (e) {
        toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
      }
    },
    [refreshBusy, refreshCredits, region, loadTokenToday, reconcileAccounts, t],
  );

  async function onRefresh(a: AccountMeta) {
    /* 续期是写操作（消费 refresh_token）：同一时刻只允许一个，连点等于连打两次上游。
       菜单项上的转圈只解决「看得见」，这里才是真正的闸。 */
    if (tokenRenewBusyId !== null) return;
    setTokenRenewBusyId(a.id);
    try {
      const res = await api.refreshAccountToken(a.id, region);
      const label = accountDisplayName(a);
      if (res.needsRelogin) {
        // `needsReloginReason` 是后端给出的**自足**原因（自带「需重新登录…」这一步），
        // 旧实现把它塞进「需重新登录（…）」的括号里 ⇒ 同一句话在一条 toast 里出现两遍
        //（2026-09-24 用户截图：「Andev：需重新登录（缺少 refresh token，无法刷新，需重新登录）」）。
        // 有原因就**只用原因**；只有原因缺失时才退回本地化的「需重新登录」。
        toast.error(t("wbAccounts.toast.tokenRefreshFail"), {
          description: res.needsReloginReason
            ? `${label}${t("shared.punct.colon")}${res.needsReloginReason}`
            : `${label}${t("shared.punct.colon")}${t("wbAccounts.toast.needRelogin")}`,
        });
      } else {
        toast.success(t("wbAccounts.toast.tokenRefreshed"), { description: label });
      }
      void reconcileAccounts(region);
      /* ★ 刷新成功后补齐卡片上的其余读数（token 已换新 ⇒ 重新打一次上游才拿得到新值）。 */
      void refreshCredits([a.id], { region });
      void loadTravelMap([a.id]);
      try {
        const next = await fetchTodayCheckinMap([a.id], region);
        if (Object.keys(next).length > 0) {
          setCheckinMap((prev) => ({ ...prev, ...next }));
        }
      } catch {
        /* ignore */
      }
      /* 显式刷新 ⇒ 强制重算「今日 Token」（绕过后端 TTL 闸门）。 */
      void loadTokenToday(true);
    } catch (e) {
      toast.error(t("wbAccounts.toast.tokenRefreshFail"), { description: api.asError(e) });
    } finally {
      setTokenRenewBusyId(null);
    }
  }

  /** 点「切换 CLI」：先走**统一重启确认**（CLI 例外 —— 不重开，但当前 CLI 会话会中断）。 */
  function onSwitchCodebuddyCli(account: AccountMeta) {
    if (codebuddyCliSwitchingId !== null) return;
    setRestartConfirm({ account, client: "cli" });
  }

  /** 用户在确认框里点了「仍要切换」后，真正执行 CLI 切换。 */
  async function doSwitchCodebuddyCli(account: AccountMeta) {
    if (codebuddyCliSwitchingId !== null) return;
    setCodebuddyCliSwitchingId(account.id);
    const toastId = toast.loading(t("wbAccounts.toast.switchCliLoading"), {
      description: t("wbAccounts.toast.switchCliLoadingDesc", { name: accountDisplayName(account) }),
    });
    try {
      const result = await api.switchCodebuddyCliAccount(account.id);
      await refreshCodebuddyCliStatus();
      toast.success(t("wbAccounts.toast.switchCliUpdated"), {
        id: toastId,
        description: `${accountDisplayName(account)}${t("shared.punct.colon")}${result.message || t("wbAccounts.toast.configUpdated")}`,
      });
    } catch (error) {
      toast.error(t("wbAccounts.toast.switchCliFail"), {
        id: toastId,
        description: api.asError(error),
      });
    } finally {
      setCodebuddyCliSwitchingId(null);
    }
  }

  /** 点「切换到 CodeBuddy IDE」：先走**统一重启确认**（IDE 需重启，默认勾选自动重开）。 */
  function onSwitchCodebuddyCnIde(account: AccountMeta) {
    if (codebuddyCnIdeSwitchingId !== null) return;
    setRestartConfirm({ account, client: "ide" });
  }

  /** 用户在确认框里点了确认后，真正执行 IDE 切换（`restart` 由确认框决定）。 */
  async function doSwitchCodebuddyCnIde(account: AccountMeta, restart: boolean) {
    if (codebuddyCnIdeSwitchingId !== null) return;
    setCodebuddyCnIdeSwitchingId(account.id);
    const toastId = toast.loading(t("wbAccounts.toast.switchIdeLoading"), {
      // 取消勾选「自动重开」时**不得**说「并重启」—— 那是假承诺（§3.5）。
      description: restart
        ? t("wbAccounts.toast.switchIdeLoadingDesc")
        : t("sessions.restart.switchingNoRestart", {
            client: t("wbAccounts.program.codebuddyCnIde"),
          }),
    });
    try {
      const result = await api.switchCodebuddyCnIdeAccount(account.id, restart);
      await refreshCodebuddyCnIdeStatus();
      toast.success(t("wbAccounts.toast.switchIdeUpdated"), {
        id: toastId,
        description: result.message || result.account,
      });
    } catch (error) {
      toast.error(t("wbAccounts.toast.switchIdeFail"), {
        id: toastId,
        description: api.asError(error),
      });
    } finally {
      setCodebuddyCnIdeSwitchingId(null);
    }
  }

  /**
   * 编辑器内 CodeBuddy 插件（VS Code / JetBrains）两个程序位：**一条**切换实现，参数化客户端。
   *
   * ## 为什么合成一条
   *
   * 两者只在「切哪个程序位 / 显示什么名字」上不同，时序完全一致（确认 → 关编辑器 →
   * 写凭证 → 重开）。各写一份必然漂移（一处改了 toast 文案、另一处没改）—— 那正是
   * §3.15.3「不要各写一套」要防的。
   *
   * ## 诚实边界
   *
   * `restart=false`（用户取消「自动重开」）时**不得**说「并重启」：文案改用
   * `sessions.restart.switchingNoRestart`，如实写「稍后手动打开」。
   */
  async function runPluginSwitch(
    account: AccountMeta,
    restart: boolean,
    busyId: string | null,
    setBusy: (id: string | null) => void,
    label: string,
    doSwitch: (accountId: string, restart: boolean) => Promise<{ message?: string; account?: string }>,
    refresh: () => Promise<void>,
  ) {
    if (busyId !== null) return;
    setBusy(account.id);
    const toastId = toast.loading(t("wbAccounts.toast.switchPluginLoading", { client: label }), {
      description: restart
        ? t("wbAccounts.toast.switchPluginLoadingDesc", { client: label })
        : t("sessions.restart.switchingNoRestart", { client: label }),
    });
    try {
      const result = await doSwitch(account.id, restart);
      await refresh();
      toast.success(t("wbAccounts.toast.switchPluginUpdated", { client: label }), {
        id: toastId,
        description: result.message || result.account,
      });
    } catch (error) {
      toast.error(t("wbAccounts.toast.switchPluginFail", { client: label }), {
        id: toastId,
        description: api.asError(error),
      });
    } finally {
      setBusy(null);
    }
  }

  /** 点「切换 VS Code 扩展」：先走**统一重启确认**（写 `state.vscdb` 前 VS Code 必须退出）。 */
  function onSwitchVscodePlugin(account: AccountMeta) {
    if (vscodePluginSwitchingId !== null) return;
    setRestartConfirm({ account, client: "vscode" });
  }

  function doSwitchVscodePlugin(account: AccountMeta, restart: boolean) {
    void runPluginSwitch(
      account,
      restart,
      vscodePluginSwitchingId,
      setVscodePluginSwitchingId,
      t("wbAccounts.program.vscodeCodebuddyPlugin"),
      api.switchVscodeCodebuddyPluginAccount,
      refreshVscodePluginStatus,
    );
  }

  /** 点「切换 JetBrains 插件」：同上（IDE 运行中写入会被内存态覆盖 ⇒ 必须先关）。 */
  function onSwitchJetbrainsPlugin(account: AccountMeta) {
    if (jetbrainsPluginSwitchingId !== null) return;
    setRestartConfirm({ account, client: "jetbrains" });
  }

  function doSwitchJetbrainsPlugin(account: AccountMeta, restart: boolean) {
    void runPluginSwitch(
      account,
      restart,
      jetbrainsPluginSwitchingId,
      setJetbrainsPluginSwitchingId,
      t("wbAccounts.program.jetbrainsCodebuddyPlugin"),
      api.switchJetbrainsCodebuddyPluginAccount,
      refreshJetbrainsPluginStatus,
    );
  }

  /**
   * 未检测到编辑器扩展时的出口（§3.3 规则 1：**不摆点不动的灰按钮**）。
   *
   * ⚠️ 与「去设置」分开：设置页里**没有**「安装 VS Code / JetBrains 扩展」这类子项 ⇒
   * 把用户送到设置页帮不上忙。真正指向正确动作的是**说明**：先去编辑器里装扩展。
   */
  function onGuidePlugin(programId: string) {
    const client =
      programId === "vscode_codebuddy_plugin"
        ? t("wbAccounts.program.vscodeCodebuddyPlugin")
        : t("wbAccounts.program.jetbrainsCodebuddyPlugin");
    toast.info(t("wbAccounts.card.guidePlugin", { client }));
  }

  /**
   * 统一重启确认框里的客户端显示名 —— 与注册表 `labelKey` **同一份文案**（不另抄一份）。
   */
  function switchClientLabel(client: SwitchClient): string {
    switch (client) {
      case "cli":
        return t("wbAccounts.program.codebuddyCli");
      case "ide":
        return t("wbAccounts.program.codebuddyCnIde");
      case "vscode":
        return t("wbAccounts.program.vscodeCodebuddyPlugin");
      default:
        return t("wbAccounts.program.jetbrainsCodebuddyPlugin");
    }
  }

  async function onInstallCodebuddyCli() {
    // 桌面 App（Tauri WebView）不支持 window.confirm，改用 Dialog 确认
    setInstallConfirmOpen(true);
  }

  async function confirmInstallCodebuddyCli() {
    setInstallConfirmOpen(false);
    setInstallingCodebuddyCli(true);
    try {
      const result = await api.installCodebuddyCliHelper();
      toast.success(t("wbAccounts.toast.cliIntegrationUpdated"), { description: result.message });
      await refreshCodebuddyCliStatus();
    } catch (error) {
      toast.error(t("wbAccounts.toast.cliIntegrationFail"), { description: api.asError(error) });
    } finally {
      setInstallingCodebuddyCli(false);
    }
  }

  const current = status?.current;

  /**
   * 保存账号备注。
   *
   * 成功后**重新拉取账号列表**而不是就地改 state：备注是唯一由用户手改的字段，
   * 让后端回传的脱敏 meta 成为唯一真相源，可以避免两边说法不一致
   * （后端会把全空白备注归一成「没有备注」，前端就地改就会留下一个空串）。
   *
   * 返回布尔值而不是抛异常：失败时卡片要保持编辑态，让用户改完重试，
   * 而不是把已输入的文字丢掉。
   */
  async function onSaveRemark(account: AccountMeta, remark: string): Promise<boolean> {
    try {
      await api.setAccountRemark(account.id, remark, region);
      await reconcileAccounts(region);
      toast.success(remark.trim() ? t("wbAccounts.toast.remarkSaved") : t("wbAccounts.toast.remarkCleared"));
      return true;
    } catch (e) {
      toast.error(t("wbAccounts.toast.remarkSaveFail"), { description: api.asError(e) });
      return false;
    }
  }

  /**
   * 保存账号自定义分组（**字段级更新**，与 {@link onSaveRemark} 同一交互 / 同一口径）。
   *
   * 成功后重取账号库（后端把空串归一成「未分组」⇒ 让后端返回的 meta 成为唯一真相源）。
   * 返回布尔值而非抛异常：失败时抽屉保持编辑态，让用户改完重试。
   */
  async function onSaveGroup(account: AccountMeta, group: string): Promise<boolean> {
    try {
      await api.setAccountGroup(account.id, group, region);
      await reconcileAccounts(region);
      toast.success(
        group.trim() ? t("wbAccounts.toast.groupSaved") : t("wbAccounts.toast.groupCleared"),
      );
      return true;
    } catch (e) {
      toast.error(t("wbAccounts.toast.groupSaveFail"), { description: api.asError(e) });
      return false;
    }
  }

  /**
   * 抽屉里的**分组候选**：本版本账号已经用过的分组名（去重 + 排序）。
   *
   * 为什么由页面算：分组是账号数据的派生物，抽屉只是「壳」（它不该去读账号库）。
   * 用户在这里看得见「我已经有哪些组」，选一下就能归入，而不是每次手打一遍
   * ——手打必然出现「客户A / 客户 A / 客户a」三份。
   */
  const detailGroups = useMemo(() => {
    const names = new Set<string>();
    for (const account of accounts) {
      const name = displayText(account.groupName)?.trim();
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [accounts]);

  const creditOrderingReady =
    accounts.length > 0 &&
    accounts.every((account) => Boolean(creditMap[account.id]) && !creditLoadingMap[account.id]);

  const cliCurrentAccountId = codebuddyCli?.activeAccountId;
  // 归一是必须的：`t()` 的插值走 `String(params[name])`，脏值会原样变成
  // 「已登录: [object Object]」（issue #2 用户截图里的那一行）。
  const workbuddyCurrentName = current
    ? displayText(current.nickname) ||
      displayText(current.email) ||
      displayText(current.uid) ||
      t("wbAccounts.common.unknownAccount")
    : t("wbAccounts.common.notLoggedIn");
  const cnIdeCurrentAccountId = codebuddyCnIde?.activeAccountId;
  /* ★ 2026-10-09：编辑器内两个插件的「当前账号」——同样来自**本地状态文件**
     （`status.activeAccountId`），不为了这一行去解密 secret（那会弹钥匙串授权）。 */
  const vscodePluginCurrentAccountId = vscodePlugin?.activeAccountId;
  const jetbrainsPluginCurrentAccountId = jetbrainsPlugin?.activeAccountId;

  /**
   * 程序位激活态 —— **与卡片 `programSlots` 同一组 5 个信号**（WB / IDE / CLI /
   * VS Code 扩展 / JetBrains 插件），顺序也照卡片的程序位行。
   *
   * ⚠️ 表格此前只看前 3 个：一个只绑了编辑器扩展的账号，卡片上亮着「当前登录」，
   * 列表里却既不高亮、也算不上「当前」、程序位列显示「—」—— 同一账号两个视图互相矛盾。
   * 当前行高亮、「当前 / 使用中 N」徽标、程序位列、「按程序位」分组全部读这一份。
   */
  const accountProgramSlots = (account: AccountMeta) => {
    const slots = [
      isWorkbuddyCurrent(account, current),
      account.id === cnIdeCurrentAccountId,
      account.id === cliCurrentAccountId,
      account.id === vscodePluginCurrentAccountId,
      account.id === jetbrainsPluginCurrentAccountId,
    ];
    return { slots, activeCount: slots.filter(Boolean).length };
  };

  /** 程序位显示名（程序位列与「按程序位」分组共用；顺序同卡片程序位行）。 */
  const accountProgramLabels = (account: AccountMeta): string[] => {
    const { slots } = accountProgramSlots(account);
    return [
      slots[0] ? "WorkBuddy" : null,
      slots[1] ? t("wbAccounts.program.codebuddyCnIde") : null,
      slots[2] ? t("wbAccounts.program.codebuddyCli") : null,
      slots[3] ? t("wbAccounts.program.vscodeCodebuddyPlugin") : null,
      slots[4] ? t("wbAccounts.program.jetbrainsCodebuddyPlugin") : null,
    ].filter((label): label is string => Boolean(label));
  };
  const codebuddyUsesSettingsEnv = codebuddyCli?.authMode === "settings-env";

  /** 账号展示名（表格 / 无障碍标签共用；过 `displayText` 归一，防脏值白屏）。 */
  const wbAccountName = (account: AccountMeta): string =>
    displayText(account.nickname) ||
    displayText(account.email) ||
    displayText(account.uid) ||
    displayText(account.id) ||
    t("wbAccounts.card.unnamed");

  /**
   * 每个账号的**最急一批**积分（`summarizeExpiry().batches[0]`）。
   *
   * 排序与「优先」徽章共用同一份 —— 列表顺序、卡面文案、「优先」标记必须指向同一批积分，
   * 否则会出现「排第一的号卡上写着 10-27，而标着『优先』的是另一个」。
   */
  const nextBatchById = useMemo(() => {
    const map = new Map<string, ExpiringBatch>();
    for (const [id, credit] of Object.entries(creditMap)) {
      const batch = credit?.ok ? summarizeExpiry(credit.resources)?.batches[0] : undefined;
      if (batch) map.set(id, batch);
    }
    return map;
  }, [creditMap]);

  /**
   * 列表视图配置 —— 平台差异**全部以数据表达**（`P4-TOOLBAR-ARCH §3.1`）。
   *
   * 共享组件不写平台判断，只按本配置渲染。排序比较器与置顶的语义与改造前逐条对齐：
   * - `priority` = 「该先用谁」：最急一批的到期时刻升序 → 该批金额降序；`creditOrderingReady`
   *   为假时返回 0 ⇒ 稳定排序保持原序（与旧实现的 `: accounts` 分支等价）；
   * - `name` / `expiry` 是新增键；
   * - `recent` = 按 `AccountMeta.lastUsedAt`（epoch 毫秒）**倒序**；从未使用的账号（缺该字段）
   *   排到最后。⚠️ 2026-10-10 起后端为 `AccountMeta` 记录 `lastUsedAt`，故「最近使用」不再是
   *   假选项（决策 #3 的原判据「无字段」已不成立 —— 见 `check-scope-registry.cjs` 对应断言）。
   */
  const listConfig = useMemo<AccountListConfig<AccountMeta>>(() => {
    /* 没有任何未来到期批次（凭据失败 / 积分已用完 / 全部过期）的账号一律沉底 ——
       已过期的积分不能再被消耗，排在能用的账号前面只会挡住视线。 */
    const priorityComparator: AccountComparator<AccountMeta> = (left, right) => {
      const leftBatch = nextBatchById.get(left.id);
      const rightBatch = nextBatchById.get(right.id);
      if (!leftBatch || !rightBatch) return leftBatch ? -1 : rightBatch ? 1 : 0;
      if (leftBatch.expireAt !== rightBatch.expireAt) return leftBatch.expireAt - rightBatch.expireAt;
      return rightBatch.amount - leftBatch.amount;
    };
    const nameComparator: AccountComparator<AccountMeta> = (left, right) =>
      wbAccountName(left).localeCompare(wbAccountName(right), undefined, { numeric: true, sensitivity: "base" });
    const expiryComparator: AccountComparator<AccountMeta> = (left, right) =>
      (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY);
    /* 「最近使用」：按 `lastUsedAt` **倒序**（新的在前）；缺席（从未使用）用 `-Infinity`
       兜底 ⇒ 一律排到最后，而不是被当成「很久以前」（0 会混进中间去）。 */
    const recentComparator: AccountComparator<AccountMeta> = (left, right) =>
      (right.lastUsedAt ?? Number.NEGATIVE_INFINITY) - (left.lastUsedAt ?? Number.NEGATIVE_INFINITY);
    return {
      searchText: (account) =>
        accountSearchText({
          name: displayText(account.nickname),
          email: displayText(account.email),
          uid: displayText(account.uid),
          remark: displayText(account.remark),
        }),
      comparators: {
        priority: creditOrderingReady ? priorityComparator : () => 0,
        name: nameComparator,
        expiry: expiryComparator,
        recent: recentComparator,
      },
      /**
       * `pin_current_account` 打开时把当前登录账号整体提到第一位。
       *
       * 这是**显式覆盖**而不是往比较函数里插一条分支：置顶与积分排序是同一根轴的两端
       * （「该切到谁」vs「正在用谁」），插进比较函数会让两者互相打架，结果取决于哪条规则
       * 先命中 —— 那种「有时候置顶、有时候不置顶」最难排查。覆盖之后其余账号的相对顺序
       * 完全不动，⭐「建议优先」徽章也照旧渲染。
       */
      pinFirst: switchConfig?.pin_current_account
        ? (rows) => {
            const pinned = rows.find((account) => isWorkbuddyCurrent(account, current));
            if (!pinned || rows[0]?.id === pinned.id) return rows;
            return [pinned, ...rows.filter((account) => account.id !== pinned.id)];
          }
        : undefined,
      bucketKey: (account, key) => {
        if (key === "program") {
          const labels = accountProgramLabels(account);
          return labels.length > 0 ? labels.join(" + ") : t("wbAccounts.toolbar.programBucket.unbound");
        }
        if (key === "status") {
          /* ★ 与页头「{m} 个需处理」同源（`lib/account-attention.ts`）：两处各写一份判定
             就会漂移成「页头说 0 个要处理、分组里躺着 3 个过期账号」。 */
          const kind = attentionOf(account, checkinMap[account.id], Date.now());
          if (kind === "needsRelogin") return t("wbAccounts.toolbar.statusBucket.needsRelogin");
          if (kind === "expired") return t("wbAccounts.toolbar.statusBucket.expired");
          if (kind === "notCheckedIn") return t("wbAccounts.toolbar.statusBucket.notCheckedIn");
          return t("wbAccounts.toolbar.statusBucket.normal");
        }
        if (key === "group") {
          /* 按用户自定义分组名分桶；**空 / 缺省 = 未分组**落到显式「未分组」桶
             （不给它一个空桶名 ⇒ 必须有一个可读的桶标题）。 */
          const name = displayText(account.groupName)?.trim();
          return name ? name : t("wbAccounts.toolbar.groupBucket.ungrouped");
        }
        return null;
      },
      availableSorts: ["priority", "name", "expiry", "recent"],
      availableGroups: ["none", "program", "status", "group"],
    };
  }, [creditOrderingReady, creditMap, nextBatchById, switchConfig, current, cnIdeCurrentAccountId, cliCurrentAccountId, vscodePluginCurrentAccountId, jetbrainsPluginCurrentAccountId, checkinMap, t]);

  /** 过滤 → 排序 → 分桶（视图参数全部留在页内，纯函数不改后端）。 */
  const filtered = filterAccounts(accounts, listConfig, query);
  const sorted = sortAccounts(filtered, sort, listConfig);
  const buckets = groupAccounts(sorted, group, listConfig);
  /** 只服务「建议优先」徽章：按积分优先级排一遍（与当前 `sort` 无关）。 */
  const priorityOrdered = sortAccounts(accounts, "priority", listConfig);
  /** 取第一个**有未来到期批次**的账号 —— 与卡片「最近到期」和排序键同源。 */
  const priorityAccountId = creditOrderingReady
    ? priorityOrdered.find((account) => nextBatchById.has(account.id))?.id
    : undefined;

  /** 排序 / 分组下拉选项 —— 由 `availableSorts` / `availableGroups`（数据）驱动，无假选项。 */
  const sortLabels: Partial<Record<AccountSortKey, string>> = {
    priority: t("wbAccounts.toolbar.sort.priority"),
    name: t("wbAccounts.toolbar.sort.name"),
    expiry: t("wbAccounts.toolbar.sort.expiry"),
    recent: t("wbAccounts.toolbar.sort.recent"),
  };
  const groupLabels: Partial<Record<AccountGroupKey, string>> = {
    none: t("wbAccounts.toolbar.group.none"),
    program: t("wbAccounts.toolbar.group.program"),
    status: t("wbAccounts.toolbar.group.status"),
    group: t("wbAccounts.toolbar.group.custom"),
  };
  const sortOptions: ToolbarOption[] = listConfig.availableSorts.flatMap((key) => {
    const label = sortLabels[key];
    return label ? [{ value: key, label }] : [];
  });
  const groupOptions: ToolbarOption[] = listConfig.availableGroups.flatMap((key) => {
    const label = groupLabels[key];
    return label ? [{ value: key, label }] : [];
  });

  /** 全选：只作用于**当前可见**（过滤后）的行；与表头全选读写同一份 `selectedKeys`。 */
  const allVisibleSelected =
    sorted.length > 0 && sorted.every((account) => selectedKeys.has(selectionKey(account.id)));
  const someVisibleSelected =
    !allVisibleSelected && sorted.some((account) => selectedKeys.has(selectionKey(account.id)));
  function toggleVisibleSelection() {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const account of sorted) {
        if (allVisibleSelected) next.delete(selectionKey(account.id));
        else next.add(selectionKey(account.id));
      }
      return next;
    });
  }
  function bucketAllSelected(items: AccountMeta[]): boolean {
    return items.length > 0 && items.every((account) => selectedKeys.has(selectionKey(account.id)));
  }
  function bucketSomeSelected(items: AccountMeta[]): boolean {
    return !bucketAllSelected(items) && items.some((account) => selectedKeys.has(selectionKey(account.id)));
  }
  function toggleBucketSelection(items: AccountMeta[], checked: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const account of items) {
        if (checked) next.add(selectionKey(account.id));
        else next.delete(selectionKey(account.id));
      }
      return next;
    });
  }

  /** 「清除筛选」出口：复位搜索与分组（`§1.9` 两种空态绝不混用）。 */
  function clearListFilters() {
    if (!hasActiveFilter({ query, group })) return;
    setQuery("");
    setGroup("none");
  }

  /**
   * 单账号「更多」菜单 —— **卡片页脚与表格行尾消费同一份**（T05）。
   *
   * 装配只留在这里：卡片与表格各写一份必然漂移（上一版就出现过「卡片有刷新、表格没有」）。
   * `compact` 只影响触发按钮尺寸。
   */
  function renderAccountMenu(a: AccountMeta, compact = false) {
    return (
      <AccountMoreMenu
        accountName={accountDisplayName(a)}
        compact={compact}
        onRefreshPart={(kind) => void onRefreshPart(a, kind)}
        refreshKinds={WB_MENU_REFRESH_KINDS}
        refreshingKinds={refreshBusy.kindsOf(a.id)}
        doneKinds={refreshBusy.doneKindsOf(a.id)}
        onRefresh={() => void onRefresh(a)}
        refreshingToken={tokenRenewBusyId === a.id}
        todayCheckedIn={checkinMap[a.id]}
        expired={typeof a.expiresAt === "number" && a.expiresAt < Date.now()}
        needsRelogin={a.needsRelogin}
        onCheckin={() => void onCheckin(a)}
        /* 成长任务只有国内版有 ⇒ 国际版不传，菜单里也就不出现该项。 */
        onCompleteTasks={region === "cn" ? () => onCompleteTasks(a) : undefined}
        onRefreshTasks={region === "cn" ? () => onRefreshGrowthHintForCard(a) : undefined}
        refreshingTasks={growthHintRefreshingIds.has(a.id)}
        onSwitch={() => setSwitchAccount(a)}
        growthHint={growthHints[a.id]}
        onExport={() => {
          setExportTargets([a]);
          setExportOpen(true);
        }}
        onDelete={() => onDelete(a)}
      />
    );
  }

  /**
   * 表格「状态」列：**直接复用卡片的徽章组件**（状态 / 成长任务 / 旅行）。
   *
   * ⚠️ 此前这里另写了一套：状态可以并列（「已签到」+「需重新登录」同时出现）、
   * 未签到是灰徽章、旅行只有「旅行中」、成长任务没有 tooltip —— 同一账号在卡片和
   * 列表里说法不同。现在判定与渲染都收在 `account-card.tsx`，两处不可能再分叉。
   */

  /**
   * 表格列定义（`§1.8`）。列头文案已 i18n；单元格全部返回**已归一**节点
   * （字符串 / 元素），**绝不返回对象** —— 对象当 React 子节点会卸载整棵树 ⇒ 白屏。
   *
   * ⚠️「程序位」列是**只读徽标**（无 `onClick`、无按钮）：表格行只有 2 个可点区
   * （勾选 + 行本身），门禁对此有静态断言。
   */
  const columns: AccountColumn<AccountMeta>[] = [
    {
      key: "account",
      header: t("wbAccounts.table.account"),
      render: (account) => {
        const { activeCount } = accountProgramSlots(account);
        return (
          <div className="flex min-w-0 items-center gap-2.5">
            {/* 表格头像走共享件（原型 `.avatar`：26px / 圆角 8px / 2 字）——
                此前这里写的是 `rounded-full` + 1 字，与原型不符，也与卡片头像规格混用。 */}
            <AccountsTableAvatar name={wbAccountName(account)} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium" title={wbAccountName(account)}>
                  {wbAccountName(account)}
                </span>
                {/* ★「当前登录」读程序位信号（见 `accountProgramSlots`）；2026-10-26 起
                    表格也不再显示「使用中 N 个工具」—— 右侧程序位列已经列出激活项，计数重复。 */}
                {activeCount > 0 && (
                  <Badge variant="info" className={ACCOUNT_CHIP_CLASS}>
                    {t("wbAccounts.card.currentLogin")}
                  </Badge>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground" title={accountIdentity(account)}>
                {accountIdentity(account)}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "status",
      header: t("wbAccounts.table.status"),
      render: (account) => (
        <div className="flex flex-wrap items-center gap-1">
          {/* ★ 状态标签可点 → 抽屉的「凭据」/「签到」页签（判定同卡片，见 `AccountStatusBadge`）。 */}
          <AccountStatusBadge
            account={account}
            todayCheckedIn={checkinMap[account.id]}
            onOpen={(tab) => openDetail(account, tab)}
          />
          <GrowthHintBadge
            summary={growthHints[account.id]}
            onOpen={() => openDetail(account, "tasks")}
          />
          <TravelStatusBadge status={travelMap[account.id]} />
        </div>
      ),
    },
    {
      /* ★ 2026-10-23：与卡片指标行**同一份**取数与形态（`creditMetricValues`）——
         第一行「当前/总额」，第二行「最近到期 · 优先」（纯文字，只用字色分级）。
         卡片上已经删掉的「今日 Token」不再单独成列（其正式界面是用量统计页与抽屉）。 */
      key: "credits",
      header: t("wbAccounts.table.credits"),
      align: "right",
      render: (account) => {
        const creditMetric = creditMetricValues(creditMap[account.id]);
        const { current: currentCredit, total: totalCredit, expiry } = creditMetric;
        const creditTip = creditMetricTip(creditMetric, t);
        const priority = account.id === priorityAccountId;
        const next = expiry?.batches[0] ?? null;
        const expiryLabel = nextExpiryLabel(expiry, t);
        const expiryTip = expiry ? expiryTooltipLines(expiry, t) : null;
        return (
          /* ★ 2026-10-23：整格可点 → 抽屉「积分」。`data-no-account-open` 让行点击让位
             （行的 onClick 只排除 `[data-row-actions]` / `[data-no-account-open]`），
             否则「点积分跳积分页签」会被行点击覆盖成「打开概览」。 */
          <button
            type="button"
            data-no-account-open
            onClick={() => openDetail(account, "credits")}
            aria-label={t("wbAccounts.card.openCredits", { name: wbAccountName(account) })}
            className="flex w-full cursor-pointer flex-col items-end gap-0.5 text-right tabular-nums transition-opacity hover:opacity-85"
          >
            <span className="whitespace-nowrap" title={creditTip ?? undefined}>
              {currentCredit === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <>
                  <b className="font-semibold text-foreground">{formatCredits(currentCredit)}</b>
                  {totalCredit === null ? null : (
                    <span className="text-muted-foreground">/{formatCredits(totalCredit)}</span>
                  )}
                </>
              )}
            </span>
            {(next || priority) && (
              <span className="flex flex-wrap items-center justify-end gap-x-1.5 whitespace-nowrap text-[11px]">
                {next && expiryTip ? (
                  <span
                    className={
                      isExpiryUrgent(next.expireAt) ? "text-warning" : "text-muted-foreground"
                    }
                    title={[expiryTip.title, ...expiryTip.lines, expiryTip.more ?? ""].filter(Boolean).join("\n")}
                  >
                    {expiryLabel}
                  </span>
                ) : null}
                {priority && (
                  <span className="text-primary" title={t("wbAccounts.card.priorityTip")}>
                    {t("wbAccounts.card.priority")}
                  </span>
                )}
              </span>
            )}
          </button>
        );
      },
    },
    /* ★ 2026-10-26：卡片指标行下方新增「凭证到期 · 刷新令牌到期」，表格同批补「凭据」列。
       2026-10-23 删掉旧「到期」列的理由是「卡片从不显示凭证到期」—— 该前提已不成立，
       现在两边必须说法一致。单元格走卡片导出的 `CredentialExpiryMeta`（同一份日期格式与
       缺值三分支），**不在这里另拼字符串**；纵向两行是因为单元格比卡片整行窄得多。
       纯文本、无 `onClick`：表格行的可点区预算不变（勾选 + 行本身）。 */
    {
      key: "credential",
      header: t("wbAccounts.table.credential"),
      render: (account) => <CredentialExpiryMeta account={account} layout="column" />,
    },
    {
      key: "programs",
      header: t("wbAccounts.table.programs"),
      render: (account) => {
        const labels = accountProgramLabels(account);
        return labels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <Badge key={label} variant="info" className={ACCOUNT_CHIP_CLASS}>
                {label}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
  ];

  const presence = regionPresence(status, accounts);
  /**
   * 账号库为空 **且** 当前没有任何登录态，才显示「未检测到 / 未登录」空态。
   *
   * ⚠️ 只看 `accounts.length` 会漏掉「客户端已登录、但账号还没保存进账号库」的用户
   * （从未点过「从本机导入」，或账号库刚丢）—— 那时页签写着「已登录: …」，
   * 下面却是一张「未检测到 WorkBuddy …」的卡片，同一屏自相矛盾
   * （2026-09-24 用户报障）。已登录时改走正常面板 + 下方的「当前登录」提示卡片。
   *
   * ⚠️⚠️ `!error` 这一项同样不可省：**「这次没取到」与「确实没有账号」是两件事**。
   * 少了它，账号库读取失败时会渲染出「未检测到 WorkBuddy / 未登录」外加一串
   * 「可能原因：未安装客户端…」—— 那是在**诊断一个不存在的问题**；而真正的错误
   * 反而一句都不显示（下方 `error &&` 那条 Alert 位于**非空态**分支内，
   * 空态分支根本走不到它）。用户会去重装客户端，而问题只是取数失败。
   * 加了门控后，失败时会落到正常分支并显示错误 Alert + 「重新检测」。
   */
  const showEmpty = accounts.length === 0 && !current && !error;
  const mismatch = status?.regionMismatch ?? null;
  const expectedAuthFile = status?.authFile || descriptor.authFilename;

  // ---- 详情抽屉的数据装配（字段全部过 `displayText` 出口，见 display-text.ts）----
  /* 抽屉的**身份**仍是打开时的快照（`detailAccount`），但展示数据必须跟随 store：
     续期凭据 / 单项刷新只经 `reconcileAccounts` 替换 `accounts`，**不会回写** `detailAccount`。
     直接用快照会让凭据页签的「刷新令牌到期 / 最近续期」永远停在打开抽屉那一刻 ——
     用户点完只看到 toast，下方数字不动。 */
  const detail = detailAccount
    ? accounts.find((account) => account.id === detailAccount.id) ?? detailAccount
    : null;
  const detailName = detail
    ? displayText(detail.nickname) || displayText(detail.uid) || t("wbAccounts.card.unnamed")
    : "";
  const detailCredit = detail ? creditMap[detail.id] : undefined;
  const detailLoading = detail ? Boolean(creditLoadingMap[detail.id]) : false;
  const detailSections: DetailSection[] = detail
    ? [
        {
          key: "account",
          title: t("wbAccounts.detail.section.account"),
          rows: [
            { label: t("wbAccounts.detail.email"), value: displayText(detail.email) ?? "—", mono: true },
            { label: t("wbAccounts.detail.uid"), value: displayText(detail.uid) ?? "—", mono: true },
            { label: t("wbAccounts.detail.id"), value: displayText(detail.id) ?? "—", mono: true },
            {
              label: t("wbAccounts.detail.tokenExpiry"),
              value:
                typeof detail.expiresAt === "number"
                  ? detail.expiresAt < Date.now()
                    ? t("wbAccounts.detail.expired")
                    : formatDate(detail.expiresAt)
                  : t("wbAccounts.card.forever"),
            },
            {
              label: t("wbAccounts.detail.checkedIn"),
              value:
                checkinMap[detail.id] === true
                  ? t("wbAccounts.card.checkedIn")
                  : checkinMap[detail.id] === false
                    ? t("wbAccounts.card.notCheckedIn")
                    : "—",
            },
            /* ★ 2026-10-23：指标块换掉「今日 Token」后，这个数字**不能就此消失** ——
               它下沉到「概览」：用量页虽然也有，但「这个号今天用了多少」属于账号身份的一部分。
               诚实边界与卡片同源（`formatTodayTokens`：缺失 ⇒ 「—」，网关截断 ⇒ `≥N`）。 */
            {
              label: t("shared.stat.tokens"),
              value: formatTodayTokens(
                detail.uid ? tokenTodayMap.get(detail.uid) : undefined,
                tokenTodayTruncated,
                t,
              ),
            },
          ],
        },
      ]
    : [];
  /**
   * 判定「临期」的**同一时刻**。
   *
   * 后端口径是 `expire_at > now && expire_at - now <= 7 天`（core `credits.rs`），
   * 下界与上界必须取**同一个** `now` —— 各写一次 `Date.now()` 会跨毫秒各算一次。
   */
  const now = Date.now();
  /**
   * 抽屉顶部的四个指标块：**积分 / 签到 / 任务 / 凭证**。
   *
   * ⚠️ 全部**在这里格式化**（抽屉只排版，见 `account-detail-drawer.tsx` 文件头约束 1）：
   * 单位、日期、千分位都在页面侧决定，避免同一句话在两个组件里各写一遍。
   * `refreshKind` 让每块带上就地 ⟳ —— 与卡片「更多」的四项**同一个回调**。
   *
   * ★ 2026-10-23（用户要求）：四块改成与下面页签**一一对应**（概览 / 积分 / 签到 / 任务 / 凭证）。
   * 「今日 Token」块被「任务」块替换 —— Token 是「回顾用量」，读它的地方是用量统计页与
   * `用量` 页签，摆在最上面反而挤掉了「有没有奖励可领」这个**决策**项。
   * Token 数字没有丢：下沉到「概览」的信息行。
   *
   * ★ 同一轮修掉**积分临期表述不一致**：旧文案是「314.86 积分 1 天内到期」（后端 7 天窗口的
   * 合计 + 最晚一批天数），卡片上是 `120 积分今天 14:30 到期`（最急一批的金额 + 时分）。
   * 同一个账号在两个地方给两句不同的话，用户没法判断到底哪个是真的 ⇒ 现在抽屉
   * 直接复用卡片的 `nextExpiryLabel` / `isExpiryUrgent`，同源同口径。
   */
  const detailStats = useMemo<DetailStat[]>(() => {
    if (!detail) return [];
    const credit = creditMap[detail.id];
    const checkedIn = checkinMap[detail.id];
    const expired = detail.expiresAt != null && detail.expiresAt < Date.now();
    const credBad = expired || Boolean(detail.needsRelogin);
    const expiry = credit?.ok ? summarizeExpiry(credit.resources ?? [], { now }) : null;
    const nextBatch = expiry?.batches[0] ?? null;
    const growthHint = growthHints[detail.id];

    const stats: DetailStat[] = [
      {
        key: "credits",
        label: t("shared.stat.credits"),
        valueText:
          credit && credit.totalCapacity != null
            ? `${formatCredits(credit.totalRemaining ?? 0)}/${formatCredits(credit.totalCapacity)}`
            : "—",
        subText: nextBatch ? nextExpiryLabel(expiry, t, now) : t("shared.stat.noExpiring"),
        /* 与卡片同一阈值：3 天内到期才用警示色（`isExpiryUrgent`）。 */
        tone: nextBatch && isExpiryUrgent(nextBatch.expireAt, now) ? "warn" : undefined,
        refreshKind: "credits",
      },
      {
        key: "checkin",
        label: t("shared.stat.checkin"),
        valueText: checkedIn ? t("shared.stat.checkedIn") : t("shared.stat.notCheckedIn"),
        refreshKind: "checkin",
      },
      /* 「任务」块只在有成长体系的作用域出现（与「任务」页签同一个门控）。 */
      ...(scope === "wb-cn"
        ? [
            {
              key: "tasks",
              label: t("shared.stat.tasks"),
              /* 摘要没扫到（未扫 / 上游失败 / 企业号）⇒ 「—」，**不写 0**：
                 0 会被读成「确实没有可领的」，那是另一个结论。 */
              valueText: growthHint?.ok
                ? t("shared.stat.taskClaimable", { n: growthHint.claimable })
                : "—",
              /* ★ 2026-10-26（用户要求）：副行从「已领 {n}」改为「已领 x/共 y」——
                 只写「已领 13」读不出总数，与卡片徽章「已领 x/y」同一口径。 */
              subText: growthHint?.ok
                ? t("shared.stat.taskClaimedTotal", {
                    claimed: growthHint.claimed,
                    total: growthHint.total,
                  })
                : undefined,
              /* 有可领 ⇒ 用与积分临期同一档警示色（都是「该动手了」）。 */
              tone: growthHint?.ok && growthHint.claimable > 0 ? ("warn" as const) : undefined,
              /* ★ 2026-10-23（用户要求）：任务卡也带 ⟳ —— 强制重扫这一个账号的任务摘要。
                 它不是 `AccountRefreshKind` 四项之一（那是「重读现成数据」的语义），
                 走 `onRefresh` 自定义通道。
                 ★ 2026-10-26：与任务页签的 ⟳ 合并为同一条刷新（摘要 + 列表），
                 两边共用一个忙态，见 `refreshGrowthAccount`。 */
              onRefresh: () => {
                void refreshGrowthAccount(detail);
              },
              refreshBusy: growthRefreshBusyId === detail.id,
            },
          ]
        : []),
      {
        key: "credential",
        label: t("shared.stat.credential"),
        valueText: credBad
          ? detail.needsRelogin
            ? t("shared.stat.credentialRelogin")
            : t("shared.stat.credentialExpired")
          : t("shared.stat.credentialOk"),
        subText: credentialHintOf(detail, t, now),
        tone: credBad ? "bad" : undefined,
        refreshKind: "credential",
      },
    ];
    return stats;
  }, [detail, creditMap, checkinMap, growthHints, growthRefreshBusyId, scope, t, now]);

  /**
   * 「凭据」页签的凭据信息 —— 状态徽标 + 三行明细（凭据到期 / 刷新令牌到期 / 最近续期）。
   *
   * ★ 2026-10-23（用户要求）：这一页此前只有两枚按钮，点下去才知道凭据什么状态。
   * 三个时间字段全部来自账号元数据（`reconcileAccounts` 刷新后即更新），
   * **没有**一个是推算的：缺值渲染「—」，凭据永久有效才写「长期有效」。
   */
  const detailCredential: DetailCredential | null = detail
    ? (() => {
        const credExpired = typeof detail.expiresAt === "number" && detail.expiresAt < Date.now();
        const credBad = credExpired || Boolean(detail.needsRelogin);
        return {
          statusText: credBad
            ? detail.needsRelogin
              ? t("shared.stat.credentialRelogin")
              : t("shared.stat.credentialExpired")
            : t("shared.stat.credentialOk"),
          tone: credBad ? ("bad" as const) : ("ok" as const),
          hint: credentialHintOf(detail, t, now),
          rows: [
            {
              label: t("wbAccounts.detail.tokenExpiry"),
              value:
                typeof detail.expiresAt === "number"
                  ? credExpired
                    ? t("wbAccounts.detail.expired")
                    : formatDate(detail.expiresAt)
                  : t("wbAccounts.card.forever"),
              mono: true,
            },
            {
              label: t("wbAccounts.detail.refreshTokenExpiry"),
              value:
                typeof detail.refreshExpiresAt === "number"
                  ? formatDate(detail.refreshExpiresAt)
                  : "—",
              mono: true,
            },
            {
              label: t("wbAccounts.detail.refreshedAt"),
              value:
                typeof detail.refreshedAt === "number" && detail.refreshedAt > 0
                  ? formatDate(detail.refreshedAt)
                  : "—",
              mono: true,
            },
          ],
        };
      })()
    : null;

  const detailPacks: DetailPack[] =
    detail && detailCredit?.ok
      ? (detailCredit.resources ?? [])
          .filter((resource) => resource.remaining > 0)
          .map((resource, index) => ({ resource, index }))
          .sort((left, right) => {
            const leftExpiry = left.resource.expireAt ?? Number.POSITIVE_INFINITY;
            const rightExpiry = right.resource.expireAt ?? Number.POSITIVE_INFINITY;
            return leftExpiry === rightExpiry ? left.index - right.index : leftExpiry - rightExpiry;
          })
          .map(({ resource }) => ({
            key: `${resource.packageCode ?? resource.packageName ?? "pack"}-${resource.expireAt ?? "none"}`,
            // `packageName` / `packageCode` 声明为 `string | null`，但后端可能吐对象
            // （`api.ts` 只归一了账号字段，没归一 credit 的这两个）⇒ 直接当 React 子节点会
            // 卸载整棵树（issue #2 白屏）。过 `displayText` 出口归一，取不到再回落。
            name: displayText(resource.packageName) || displayText(resource.packageCode) || t("wbAccounts.card.creditPackFallback"),
            remainingText: formatCredits(resource.remaining),
            totalText: formatCredits(resource.total),
            usedText: t("wbAccounts.card.used", { n: formatCredits(resource.used) }),
            expiryText: resource.expired
              ? t("wbAccounts.card.expired")
              : resource.expireAt
                ? t("wbAccounts.card.expiresOn", { date: formatCreditExpiry(resource.expireAt, t) })
                : t("wbAccounts.card.forever"),
            expired: resource.expired,
            /* ⚠️ 与后端**逐条同口径**：`expired` 只覆盖「`expire_at <= now`」，
               所以**下界 `> now` 不能省**。此前只判上界，靠的是「`expired` 恒等于
               `expire_at <= now`」这条后端不变量 —— 隐式耦合，后端口径一改就会把
               「已过期」的包标成「临期」。
               `resource.expireAt` 是**毫秒**（`CreditResource.expireAt`，WB 侧口径）。 */
            expiringSoon:
              !resource.expired &&
              resource.expireAt != null &&
              resource.expireAt > now &&
              resource.expireAt - now <= 7 * 86_400_000,
            ratio: resource.total > 0 ? Math.min(100, Math.max(0, (resource.remaining / resource.total) * 100)) : 0,
          }))
      : [];
  const detailPrograms: DetailProgramBadge[] = detail
    ? [
        {
          key: "workbuddy",
          label: "WorkBuddy",
          current: isWorkbuddyCurrent(detail, current),
          installed: true,
          hasDataDir: true,
        },
        {
          key: "ide",
          label: "CodeBuddy IDE",
          current: detail.id === cnIdeCurrentAccountId,
          installed: Boolean(codebuddyCnIde?.installed),
          hasDataDir: Boolean(codebuddyCnIde?.installed),
        },
        {
          key: "cli",
          label: "CodeBuddy CLI",
          current: detail.id === cliCurrentAccountId,
          installed: Boolean(codebuddyCli?.configured),
          hasDataDir: Boolean(codebuddyCli?.configured),
        },
      ]
    : [];

  /**
   * ★ 抽屉：账号是否「当前登录」= 绑定了**任一**程序位（与卡片 / 原型 :3467 同口径）。
   */
  const detailIsCurrent = detail
    ? isWorkbuddyCurrent(detail, current) ||
      detail.id === cnIdeCurrentAccountId ||
      detail.id === cliCurrentAccountId ||
      detail.id === vscodePluginCurrentAccountId ||
      detail.id === jetbrainsPluginCurrentAccountId
    : false;

  /**
   * ★ 抽屉「切换到此账号」程序位（可点）。
   *
   * 每个程序的 `onSwitch` 只在**可用**时提供 —— 不可用的渲染成「未检测到」的禁用项，
   * 不把用户引向一个必然失败的切换（与卡片 `.prog.off` 的措辞同一纪律）。
   * 回调全部复用页面**既有**的切换处理函数（各程序位自己的确认流程）。
   */
  const detailSwitchTargets: DetailSwitchTarget[] = detail    ? [
        {
          key: "workbuddy",
          label: "WorkBuddy",
          current: isWorkbuddyCurrent(detail, current),
          available: true,
          onSwitch: () => setSwitchAccount(detail),
        },
        {
          key: "ide",
          label: "CodeBuddy IDE",
          current: detail.id === cnIdeCurrentAccountId,
          available: Boolean(codebuddyCnIde?.installed),
          busy: codebuddyCnIdeSwitchingId !== null,
          loading: codebuddyCnIdeSwitchingId === detail.id,
          onSwitch: codebuddyCnIde?.installed ? () => onSwitchCodebuddyCnIde(detail) : undefined,
        },
        {
          key: "cli",
          label: "CodeBuddy CLI",
          current: detail.id === cliCurrentAccountId,
          available: Boolean(codebuddyCli?.configured && !codebuddyCli.migrationRequired && !codebuddyCli.syncPending),
          busy: codebuddyCliSwitchingId !== null,
          loading: codebuddyCliSwitchingId === detail.id,
          onSwitch:
            codebuddyCli?.configured && !codebuddyCli.migrationRequired && !codebuddyCli.syncPending
              ? () => onSwitchCodebuddyCli(detail)
              : undefined,
        },
        {
          key: "vscode",
          label: t("wbAccounts.program.vscodeCodebuddyPlugin"),
          current: detail.id === vscodePluginCurrentAccountId,
          available: Boolean(vscodePlugin?.extensionInstalled),
          busy: vscodePluginSwitchingId !== null,
          loading: vscodePluginSwitchingId === detail.id,
          onSwitch: vscodePlugin?.extensionInstalled ? () => onSwitchVscodePlugin(detail) : undefined,
        },
        {
          key: "jetbrains",
          label: t("wbAccounts.program.jetbrainsCodebuddyPlugin"),
          current: detail.id === jetbrainsPluginCurrentAccountId,
          available: Boolean(jetbrainsPlugin?.pluginInstalled),
          busy: jetbrainsPluginSwitchingId !== null,
          loading: jetbrainsPluginSwitchingId === detail.id,
          onSwitch: jetbrainsPlugin?.pluginInstalled ? () => onSwitchJetbrainsPlugin(detail) : undefined,
        },
      ]
    : [];

  /**
   * ★ P14 S4a · 插件会话复制的来源客户端（`null` ⇒ 入口不渲染）。
   *
   * ⚠️ **`jetbrains` 刻意不在映射里**：会话仓的客户端段只有 `VSCode` / `CodeBuddyIDE`
   * 两个值（见 `lib/ext-sessions.ts`）⇒ JetBrains 插件**没有**对应的会话树。
   * 给它入口等于去读一棵不属于它的树 —— 比没有这个功能坏得多。
   *
   * ⚠️ **与原型的一处已知差异（未消除）**：原型用「该账号**绑定了**插件程序位」作条件；
   * 真实页面的 `switchTargets` 没有「本账号是否绑定」这个位，只有「该程序位是否已接入」
   * ⇒ 这里退化为「**该程序位已接入**」。记在 `P14-TASKS.md` 的待办里。
   */
  const detailExtClient: ExtClientId | null = (() => {
    const map: Record<string, ExtClientId> = { ide: "codebuddy-ide", vscode: "vscode" };
    for (const target of detailSwitchTargets) {
      const client = map[target.key];
      if (client && target.available) return client;
    }
    return null;
  })();

  const detailExpired =
    detail != null && typeof detail.expiresAt === "number" && detail.expiresAt < Date.now();

  /**
   * ★ 抽屉「操作」区：回调全部复用页面**既有**处理函数（刷新 / 签到 / 导出 / 权限诊断 / 删除）。
   * 「手动签到」按 F5 口径门控（过期 / 需重登不给入口）—— 与卡片菜单、批量签到同一条规则。
   */
  /**
   * ★ 抽屉「操作」区：只注入凭据相关的两枚（续期凭据 / 签到由「签到」页签自己用）。
   *
   * ★ 2026-10-23（用户要求）：移除 `导出` 与 `切换权限诊断` ——
   * 导出在卡片「更多」与批量条已有（不必三个入口），权限诊断与本页职责无关。
   * 「签到」按钮按 F5 口径门控（过期 / 需重登不给入口）—— 与卡片菜单、批量签到同一条规则。
   */
  const detailActions: DetailActions | null = detail
    ? {
        onRefresh: () => onRefresh(detail),
        onCheckin: () => onCheckin(detail),
        /* 门控读**与页签同一个数据源**：详情已加载时以 `checkinDetailMap` 为准，
           否则两个陈旧度不同的 map 会让「页签写着已签到、按钮却还在」。 */
        showCheckin:
          (checkinDetailMap[detail.id]?.todayCheckedIn ?? checkinMap[detail.id]) === false &&
          !detailExpired &&
          !detail.needsRelogin,
        onDelete: () => onDelete(detail),
        credentialUnavailable: Boolean(detail.needsRelogin || detailExpired),
      }
    : null;

  /**
   * ★ 抽屉「签到历史（近 7 天）」。
   *
   * 「签没签到」以上游 `checkin_dates` 为准（本地台账只记本工具发起的签到），
   * 本地日志只用来区分 `success` / `already` / `fail` 以及补足上游未覆盖的日期；
   * 「获得积分」按**账号 + 日期**取积分统计的签到事件 `amount`，取不到时为 `null`
   * ⇒ 渲染「—」（**绝不**臆造固定奖励）。
   */
  const detailCheckinHistory: DetailCheckinHistoryRow[] | null =
    detail && detailCheckinLogs
      ? (() => {
          /* 上游 `checkin_dates` 才是「签没签到」的权威来源：本地台账只记录**本工具发起**
             的签到，用户在 IDE 里手动签的日子台账里没有 ⇒ 只按台账会把那些天错误地标成
             「未签到」，与同页签上方展示的日期标签自相矛盾。金额仍只取积分统计（取不到「—」）。 */
          const upstreamDates = new Set(
            checkinCreditsOf(checkinDetailMap[detail.id] ?? {}).checkinDates ?? [],
          );
          return lastSevenDays().map((day) => {
            const log = detailCheckinLogs
              .filter(
                (entry) =>
                  localDateKey(entry.ts) === day &&
                  (entry.accountId === detail.id ||
                    (entry.accountId == null && Boolean(detail.email) && entry.email === detail.email)),
              )
              .sort((left, right) => right.ts - left.ts)[0];
            const event = (detailCreditEvents ?? []).find(
              (item) => item.kind === "checkin" && item.date === day && item.accountId === detail.id,
            );
            const amount = event && event.kind === "checkin" ? event.amount ?? null : null;
            if (upstreamDates.has(day)) {
              return { date: day, resultLabel: t("shared.drawer.checkin.result.success"), tone: "ok", amount };
            }
            if (!log) {
              return { date: day, resultLabel: t("shared.drawer.checkin.result.none"), tone: "none", amount };
            }
            if (log.result === "success") {
              return { date: day, resultLabel: t("shared.drawer.checkin.result.success"), tone: "ok", amount };
            }
            if (log.result === "already") {
              return { date: day, resultLabel: t("shared.drawer.checkin.result.already"), tone: "warn", amount };
            }
            return { date: day, resultLabel: t("shared.drawer.checkin.result.fail"), tone: "fail", amount };
          });
        })()
      : null;

  /**
   * 已勾选的账号（按当前列表顺序）—— 批量条上的动作共用这一份，避免各处再 filter 一遍。
   */
  const selectedAccounts = useMemo(
    () => accounts.filter((a) => selectedKeys.has(selectionKey(a.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, selectedKeys, scope],
  );

  /**
   * 页头「{m} 个需处理」。
   *
   * ★ 2026-10-23：改为 `needsManualAttention`（凭据需重登 / 已过期），与「按状态」分桶
   * **同源**（`lib/account-attention.ts`）。此前只数 `needsRelogin` ⇒ 会出现
   * 「0 个需处理」而列表里躺着「凭据已过期」分组的自相矛盾画面。
   * 签到与成长任务**不进这个数**：它们有一键按钮，机器能做完的事不该变成页头上永不归零的数字。
   */
  const pendingCount = accounts.filter((account) => needsManualAttention(account, now)).length;

  /**
   * 页头一键动作的可用性：**做不了就禁用**，别让按钮点下去只弹一句“没活可干”。
   *
   * - 无账号 ⇒ 两枚全禁用（动作函数里的 early-return 用户看不见）。
   * - 「一键签到」：所有账号的今日签到都**已知为已签**才禁用；
   *   任一账号状态未知（`checkinMap` 还没回来）就保持可点 —— 不把「不知道」当成「已签」。
   *
   * ⚠️ 2026-10-26（用户要求）：页头「一键完成」已删除 ⇒ 原来的
   * `growthKnownAll` / `growthActionable` 两个判据一并移除。成长任务仍可用
   * 「批量条 → 完成任务」或单账号菜单执行。
   */
  const noAccounts = accounts.length === 0;
  const checkinHasPending = accounts.some((account) => checkinMap[account.id] !== true);
  const quickBlocked = batchBusy || quickActionBusy !== null;

  return (
    <>
      {/* 页头：标题 + 作用域副标题 + 页面级一键操作 + 只读 scope-chip。
          一键操作放在这里而不是列表工具栏：它是**页面级动作**（作用于全部账号），
          与搜索/筛选/全选/添加账号这些列表级控件分开，右侧不再挤成一排。 */}
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          {/* 原型 `.page-head h1`（`buddy-switch-prototype.html:179`）：28px / 字重 640 / `-.02em`。 */}
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">{t("wbAccounts.page.title")}</h1>
          {/* 作用域用 Chip 取代副标题里的纯文字：同一信息不再出现两遍，右侧也腾出来给一键操作。 */}
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <ScopeChip scope={scopeOf("workbuddy", region)} />
            {/* 「需处理」的判据挂在 `title` 上：这枚数字不点也不跳，用户唯一会问的就是
                「凭什么算需处理」。判据见 `lib/account-attention.ts`（与「按状态」分桶同源）。 */}
            <span
              title={
                pendingCount > 0 ? t("wbAccounts.page.accountsCountPendingHint") : undefined
              }
            >
              ·{" "}
              {pendingCount > 0
                ? t("wbAccounts.page.accountsCountPending", { n: accounts.length, m: pendingCount })
                : t("wbAccounts.page.accountsCount", { n: accounts.length })}
            </span>
          </p>
        </div>
        <div className="grow" />
        <div className="flex flex-wrap items-center gap-2">
          {/* ★ 批处理进度 + 取消：此前一轮 20 个账号的签到/续期只有一个转圈，
              用户既不知道到哪了、也没法停。进度只在「按账号循环」的动作里出现
              （一键刷新是几个整批请求，没有可计数单位）。 */}
          {bulkProgress ? (
            <>
              <span className="text-[12px] tabular-nums text-muted-foreground">
                {t("shared.batch.progress", {
                  done: bulkProgress.done,
                  total: bulkProgress.total,
                })}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={cancelBulk}>
                {t("shared.batch.cancel")}
              </Button>
            </>
          ) : null}
          <QuickRefreshAction
            scope={scope}
            busy={quickActionBusy === "refresh"}
            disabled={quickBlocked || noAccounts}
            disabledReason={noAccounts ? t("shared.toolbar.quickNoAccounts") : undefined}
            onRefresh={quickRefreshAll}
          />
          <QuickActionButton
            icon={<CheckinIcon />}
            label={t("shared.toolbar.quickCheckin")}
            busy={quickActionBusy === "checkin"}
            disabled={quickBlocked || noAccounts || !checkinHasPending}
            disabledReason={
              noAccounts
                ? t("shared.toolbar.quickNoAccounts")
                : !checkinHasPending
                  ? t("shared.toolbar.quickCheckinNone")
                  : undefined
            }
            onClick={() => void quickCheckinAll()}
          />
        </div>
      </header>

      {/* 区域不匹配（安全红线） */}
      {mismatch && (
        <Alert variant="warning" className="mb-4">
          <AlertTriangle />
          <AlertTitle>{t("wbAccounts.page.mismatchTitle")}</AlertTitle>
          <AlertDescription>
            <p>
              {t("wbAccounts.page.mismatchBody1", { region: regionDescriptor(mismatch.actualRegion ?? "global").displayName, version: descriptor.versionLabel, domain: mismatch.actualDomain })}
            </p>
            <p className="mt-1">
              {t("wbAccounts.page.mismatchBody2", { env: mismatch.envVar || descriptor.authEnv, version: descriptor.versionLabel })}
            </p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => setMismatchDetailOpen(true)}>
              {t("wbAccounts.page.mismatchDetail")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ★ 账号工作台（**两平台共用容器**）：布局与交互全部下沉到 `AccountWorkbench`，
          本页只负责取数 + 装配 props + 注入平台插槽。

          ⚠️ 改造前这里是 450 行手写 JSX，`TraeAccountsPage` 里有一份「差不多但不一样」的副本
          —— 骨架形状、空态出口、批量条位置、分组标题样式逐项漂移。原型的账号页是
          **平台无关**的（只有 `viewAccounts()` + `curPlatform().programs`），本容器就是那个
          「一段代码」。 */}
      <AccountWorkbench
        query={query}
        /* ★ 表格视图的「更多」：与卡片**同一个装配函数**（R07）。 */
        renderActions={(row) => renderAccountMenu(row, true)}
        onQueryChange={setQuery}
        searchInputRef={searchRef}
        sort={sort}
        sortOptions={sortOptions}
        onSortChange={(next) => setSort(next as AccountSortKey)}
        group={group}
        groupOptions={groupOptions}
        onGroupChange={(next) => setGroup(next as AccountGroupKey)}
        view={view}
        onViewChange={setView}
        tableViewEnabled={tableEnabled}
        selection={{
          allSelected: allVisibleSelected,
          someSelected: someVisibleSelected,
          onToggleAll: toggleVisibleSelection,
          label: allVisibleSelected ? t("shared.toolbar.deselectAll") : t("shared.toolbar.selectAll"),
        }}
        addAction={{
          label: t("wbAccounts.toolbar.addAccount"),
          onClick: () => setAddDrawerOpen(true),
        }}
        /* ★ 一枚**常驻**控件（用户要求「回收站放出来」）——
           走结构化 prop 注入，几何与文案都留在工具栏壳里。 */
        onOpenRecycleBin={() => setRecycleOpen(true)}
        /* ★ 工具栏**只有** 搜索 / 排序 / 分组 / 视图 / 回收站 / 全选 / 主操作。
           原先的「⋯」溢出菜单、以及后来顶替它的「添加账号 → 更多操作」分区**均已删除**
           （2026-10-23）：开关归设置页、批量动作归批量条、刷新归页头 / 批量条。
           下方 `<AddAccountDrawer>` 只负责「添加方式 + 粘贴凭据」。 */
        loading={loading}
        /* 首屏空态（未安装 / 未登录）：整块替换工具栏与列表（原型 `emptyBlock` 也不带工具栏）。 */
        emptyState={
          showEmpty ? (
            /* ★ 无客户端形态（issue #62）：服务器 / 容器里「没装客户端」是正常形态。
               旧卡片只给「重新检测 / 从本机导入」两条死路，等于告诉服务器用户「你用不了」。
               现在换成「浏览器授权 + 导入备份」两条真能走的路 + 能力矩阵。 */
            presence === "absent" ? (
              <ClientlessEmptyCard
                scopeLabel={scopeLabel(t, scopeOf("workbuddy", region))}
                platformLabel={descriptor.versionLabel}
                expectedAuthFile={expectedAuthFile}
                onOauth={() => setOauthOpen(true)}
                onBackup={() => setImportOpen(true)}
                onPaste={() => setPasteCredentialOpen(true)}
                onRecheck={onRecheck}
              />
            ) : (
              <EmptyRegionCard
                region={region}
                installed
                expectedAuthFile={expectedAuthFile}
                onRecheck={onRecheck}
                onImport={() => void onImport()}
                importing={importing}
              />
            )
          ) : null
        }
        notices={
          <>
          {/* 有账号、但本机没有客户端：一行说清影响面（网关不受影响），别让用户以为整页降级。 */}
          {presence === "absent" && accounts.length > 0 ? (
            <ClientlessStrip scopeLabel={scopeLabel(t, scopeOf("workbuddy", region))} />
          ) : null}
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>{t("wbAccounts.page.loadFailed")}</AlertTitle>
              <AlertDescription>
                <p>{error}</p>
                {/* 失败态必须给一条出路：没有它，用户唯一能做的就是重启应用。 */}
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  disabled={recheckAlertBusy}
                  onClick={() => void runRecheckAlert(() => onRecheck())}
                >
                  {recheckAlertBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {t("wbAccounts.empty.recheck")}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* ★ CodeBuddy CLI 接入提示：**压成一行细条**，不再占一整张卡。
            原型没有这个场景（`viewAccounts` 里没有 CLI 接入提示），但本仓账号页确实会撞上
            「装了 CodeBuddy 却没接入 CLI」—— 这是**真实待办**，不能删。
            ⇒ 保留信息与出口，但按原型 `.note-warn`（`demo.css:833-836`）那种
            「一行说明 + 一个按钮」的密度：11.5px 文字、圆角 9px、无标题层级。*/}
          {codebuddyCli &&
            (!codebuddyCli.configured ||
              (!codebuddyUsesSettingsEnv && !codebuddyCli.helperSupportsAccountIds) ||
              codebuddyCli.migrationRequired ||
              codebuddyCli.syncPending) && (
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[9px] border border-border bg-card-2 px-3 py-2">
                <Terminal className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">{t("wbAccounts.page.cliTitle")}</span>
                  {" · "}
                  {codebuddyUsesSettingsEnv
                    ? codebuddyCli.environmentOverride
                      ? t("wbAccounts.page.cliDescEnvOverride")
                      : codebuddyCli.syncPending
                        ? t("wbAccounts.page.cliDescEnvSyncPending")
                        : codebuddyCli.migrationRequired
                          ? t("wbAccounts.page.cliDescEnvMigration")
                          : t("wbAccounts.page.cliDescEnvDefault")
                    : codebuddyCli.migrationRequired
                      ? t("wbAccounts.page.cliDescHelperMigration")
                      : codebuddyCli.configured
                        ? t("wbAccounts.page.cliDescHelperConfigured")
                        : t("wbAccounts.page.cliDescDefault")}
                </span>
                <DemoAction>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-[28px] shrink-0 rounded-[8px] px-[10px] text-[12px]"
                    onClick={() => void onInstallCodebuddyCli()}
                    disabled={installingCodebuddyCli}
                  >
                    {installingCodebuddyCli && <Loader2 className="animate-spin" />}
                    {codebuddyUsesSettingsEnv
                      ? codebuddyCli.configured ? t("wbAccounts.page.cliBtnUpdateAuth") : t("wbAccounts.page.cliBtnConnect")
                      : codebuddyCli.configured || codebuddyCli.migrationRequired ? t("wbAccounts.page.cliBtnUpgradeHelper") : t("wbAccounts.page.cliBtnConnect")}
                  </Button>
                </DemoAction>
              </div>
            )}

          {/*
            「当前登录账号，但还不在账号库里」的提示卡片。
            账号库为空 ≠ 没有登录态：客户端可能已登录，只是用户还没点过「从本机导入」。
            这时必须把「当前登录的是谁」明确显示出来，而不是给一张「未检测到」空态卡片。
          */}
          {current && !accounts.some((a) => isWorkbuddyCurrent(a, current)) && (
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-4 rounded-2xl border border-border bg-muted/30 px-5 py-4">
              <div className="min-w-[200px] flex-1">
                <h2 className="text-sm font-semibold text-foreground">
                  {t("wbAccounts.currentLogin.title", { name: workbuddyCurrentName })}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t("wbAccounts.currentLogin.unsaved")}
                </p>
              </div>
              <DemoAction>
                <Button className="h-9 px-3" variant="outline" onClick={onImport} disabled={importing}>
                  {importing ? <Loader2 className="animate-spin" /> : <Download />}
                  {t("wbAccounts.currentLogin.save")}
                </Button>
              </DemoAction>
            </div>
          )}

          </>
        }
        checkinResult={
          checkinResult
            ? {
                okCount: checkinResult.ok,
                failedNames: accounts
                  .filter((account) => checkinResult.failedIds.includes(account.id))
                  .map((account) => wbAccountName(account)),
                onRetry:
                  checkinResult.failedIds.length > 0
                    ? () => batchCheckin(checkinResult.failedIds)
                    : undefined,
              }
            : null
        }
        onDismissCheckinResult={() => setCheckinResult(null)}
        batch={{
          selectedCount: selectedKeys.size,
          busy: batchBusy || quickActionBusy !== null,
          /* 进度与取消：只有按账号循环的动作会填，其余为 `null`（不渲染进度与取消）。 */
          progress: bulkProgress,
          onCancel: cancelBulk,
          onRefreshPart: (kind) => void batchRefreshPart(kind),
          /* ⚠️ 只把四项 `AccountRefreshKind` 传给刷新组：`"token"` / `"growth"` 不是只读刷新项，
             混进 `kinds` 会让 `RefreshMenuGroup` 渲染出两个空槽（它按 kind 过滤图标与文案）。 */
          refreshingKinds:
            batchRefreshKind && batchRefreshKind !== "token" && batchRefreshKind !== "growth"
              ? [batchRefreshKind]
              : [],
          doneKinds:
            batchRefreshDoneKind && batchRefreshDoneKind !== "token" && batchRefreshDoneKind !== "growth"
              ? [batchRefreshDoneKind]
              : [],
          onRefreshToken: () => void batchRefreshToken(),
          refreshingToken: batchRefreshKind === "token",
          doneToken: batchRefreshDoneKind === "token",
          /* ★ 任务重扫（仅国内版）：下拉里的「刷新任务」，与单账号菜单**同一项**、
              同一条分隔线位置（都在刷新组内、无分隔线）。国际版没有成长体系 ⇒ 不注入。
              ⚠️ 直接返回 Promise<boolean>：`RefreshTasksItem` 靠它决定亮不亮「已更新」。 */
          onRefreshTasks: region === "cn" ? () => batchRefreshGrowth() : undefined,
          onCheckin: () => void batchCheckin(),
          /* 成长任务只有国内版有 ⇒ 国际版不渲染该项（与卡片菜单同一门控）。 */
          onCompleteTasks: region === "cn" ? () => void batchCompleteTasks() : undefined,
          onExport:
            selectedAccounts.length > 0
              ? () => {
                  setExportTargets(selectedAccounts);
                  setExportOpen(true);
                }
              : undefined,
          onDelete: () => setBatchDeleteOpen(true),
          onClear: clearSelection,
        }}
        listAriaLabel={t("wbAccounts.page.accountsAria", { count: accounts.length })}
        totalCount={accounts.length}
        visibleCount={sorted.length}
        emptyNone={{
          title: t("shared.list.empty.none"),
          description: t("shared.list.empty.noneDesc"),
          action: (
            <Button onClick={() => setOauthOpen(true)}>
              <QrCode />
              {t("wbAccounts.page.oauthAdd")}
            </Button>
          ),
        }}
        emptyFiltered={{
          title: t("shared.list.empty.filtered"),
          description: t("shared.list.empty.filteredDesc"),
          action: (
            <Button variant="outline" onClick={clearListFilters}>
              {t("shared.list.empty.clearFilters")}
            </Button>
          ),
        }}
        buckets={buckets}
        columns={columns}
        rowKey={(account) => selectionKey(account.id)}
        selectedIds={selectedKeys}
        onToggleSelect={toggleSelect}
        onToggleBucketAll={toggleBucketSelection}
        bucketAllSelected={bucketAllSelected}
        bucketSomeSelected={bucketSomeSelected}
        onOpenRow={openDetail}
        isRowCurrent={(account) => accountProgramSlots(account).activeCount > 0}
        rowSelectLabel={(account) => t("shared.table.selectRowAria", { name: wbAccountName(account) })}
        rowOpenLabel={(account) => t("shared.table.openRowAria", { name: wbAccountName(account) })}
        renderCard={(a) => (
                            <AccountCard
                              key={a.id}
                              account={a}
                              /* ★ 菜单由页面装配，卡片只负责摆到页脚（与表格 renderActions 同源）。 */
                              menu={renderAccountMenu(a)}
                              todayCheckedIn={checkinMap[a.id]}
                              travelStatus={travelMap[a.id]}
                              growthHint={growthHints[a.id]}
                              credit={creditMap[a.id]}
                              creditLoading={creditLoadingMap[a.id]}
                              creditPriority={a.id === priorityAccountId}
                              workbuddyActive={isWorkbuddyCurrent(a, current)}
                              codebuddyCliConfigured={codebuddyCli?.configured && !codebuddyCli.migrationRequired && !codebuddyCli.syncPending}
                              codebuddyCliActive={a.id === cliCurrentAccountId}
                              codebuddyCliBusy={codebuddyCliSwitchingId !== null}
                              onSwitchCodebuddyCli={onSwitchCodebuddyCli}
                              codebuddyCliLoading={codebuddyCliSwitchingId === a.id}
                              codebuddyCnIdeAvailable={Boolean(codebuddyCnIde?.installed)}
                              codebuddyCnIdeActive={a.id === cnIdeCurrentAccountId}
                              codebuddyCnIdeBusy={codebuddyCnIdeSwitchingId !== null}
                              codebuddyCnIdeLoading={codebuddyCnIdeSwitchingId === a.id}
                              onSwitchCodebuddyCnIde={onSwitchCodebuddyCnIde}
                              vscodePluginAvailable={Boolean(vscodePlugin?.extensionInstalled)}
                              vscodePluginActive={a.id === vscodePluginCurrentAccountId}
                              vscodePluginBusy={vscodePluginSwitchingId !== null}
                              vscodePluginLoading={vscodePluginSwitchingId === a.id}
                              onSwitchVscodePlugin={onSwitchVscodePlugin}
                              jetbrainsPluginAvailable={Boolean(jetbrainsPlugin?.pluginInstalled)}
                              jetbrainsPluginActive={a.id === jetbrainsPluginCurrentAccountId}
                              jetbrainsPluginBusy={jetbrainsPluginSwitchingId !== null}
                              jetbrainsPluginLoading={jetbrainsPluginSwitchingId === a.id}
                              onSwitchJetbrainsPlugin={onSwitchJetbrainsPlugin}
                              onGuidePlugin={onGuidePlugin}
                              onAddPlaintextAccount={() => setOauthOpen(true)}
                              onGuideToSetting={onGuideToSetting}
                              selected={selectedKeys.has(selectionKey(a.id))}
                              onToggleSelect={toggleSelect}
                              onOpenDetail={openDetail}
                              /* 标签点击 → 直接落在抽屉的对应页签（积分 / 到期 → 积分；
                                 签到 / 凭据状态 → 签到 / 凭据；成长任务 → 任务，仅 CN 有该页签）。
                                 页签不可用时由抽屉的 `resolveDrawerTab` 回退。 */
                              onOpenTab={(target, tab) => openDetail(target, tab)}
                              /* ★ 两平台**同一取值**（Trae 侧同为 `false`）。
                                 ⚠️ 此前 WB 传 `false`、Trae 传 `api.isDemoMode()` ⇒ 同一个演示构建里
                                 「WB 的按钮能点、Trae 的按钮点不动」，用户看到两个平台行为不一致。
                                 统一取 `false`：演示构建里写操作由 `api.ts` 统一拦截并给可读原因
                                 （`demoUnavailableMessage`），比一枚**点不动又不说明**的按钮好；
                                 这也是截图演示一直依赖的行为。 */
                              featuresDisabled={false}
                            />
        )}
        /* 列表下方的平台专属插槽：客户端限流台账（**只读**观测，账号 × 模型 × 恢复时刻）。
           与账号强相关、无需切页；与网关无关，故不放「API 服务」页（PRD S4「挂载位置已定」）。 */
        footer={
          <section className="mt-7 min-w-0">
            <ClientLimitsCard region={region} />
          </section>
        }
      />

      <AddAccountDrawer
        open={addDrawerOpen}
        onOpenChange={setAddDrawerOpen}
        scopeLabel={scopeLabel(t, scopeOf("workbuddy", region))}
        installed={presence !== "absent"}
        /* 无客户端时的第三条路（issue #62）：把另一台机器上的 auth 文件内容整段粘进来。 */
        extraOptions={
          presence === "absent"
            ? [
                {
                  key: "paste-credential",
                  icon: KeyRound,
                  title: t("shared.srv.paste.title"),
                  desc: t("shared.srv.paste.hint.wb"),
                  onClick: () => setPasteCredentialOpen(true),
                },
              ]
            : undefined
        }
        onPick={(way: AddAccountWay) => {
          /* 与原型 `case "add-way"`（`:4236`）同构：先关抽屉，再进入对应流程。 */
          /* 「从本机导入」在无客户端时**不静默失败**：给出两条能走的路（issue #62）。 */
          if (way === "local" && presence === "absent") {
            toast.error(t("shared.srv.localUnavailable"), {
              description: t("shared.srv.localUnavailableDesc"),
            });
            return;
          }
          if (way === "oauth") setOauthOpen(true);
          else if (way === "backup") setImportOpen(true);
          else void onImport();
        }}
        labels={{
          title: t("shared.addDrawer.title"),
          scopeHintPrefix: t("shared.addDrawer.scopePrefix"),
          scopeHintSuffix: t("shared.addDrawer.scopeSuffix"),
          oauthTitle: t("shared.addDrawer.oauthTitle"),
          oauthDesc: t("shared.addDrawer.oauthDesc"),
          localTitle: t("shared.addDrawer.localTitle"),
          localDesc: t("shared.addDrawer.localDesc"),
          backupTitle: t("shared.addDrawer.backupTitle"),
          backupDesc: t("shared.addDrawer.backupDesc"),
          notInstalled: t("shared.addDrawer.notInstalled"),
        }}
      />

      <OAuthLoginDialog open={oauthOpen} onOpenChange={setOauthOpen} region={region} />
      <PasteCredentialDialog
        open={pasteCredentialOpen}
        onOpenChange={setPasteCredentialOpen}
        scope={scopeOf("workbuddy", region)}
        onAdded={(name) => {
          void reconcileAccounts(region);
          toast.success(t("shared.srv.paste.ok", { name: name || "—" }), {
            description: t("shared.srv.paste.okDesc"),
          });
        }}
      />
      <ExportAccountsDialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open);
          // 关闭即清掉「导出所选」的目标：下次从工具栏进来仍是「全部」，不残留上一次的范围。
          if (!open) setExportTargets(null);
        }}
        accounts={(exportTargets ?? accounts).map((item) => ({
          id: item.id,
          label: accountDisplayName(item),
        }))}
        onExported={onExported}
        scope={scope}
      />
      <ImportAccountsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
        scope={scope}
      />
      {/* ★ P14 S4a · 插件会话抽屉（VS Code 插件 / CodeBuddy IDE）。
          与切换向导**并列而不是嵌套**：两者是不同流程，嵌套会让「关一个开一个」无法表达。 */}
      {extDrawer ? (
        <ExtSessionDrawer
          open
          onOpenChange={(open) => {
            if (!open) setExtDrawer(null);
          }}
          client={extDrawer.client}
          account={extDrawer.account}
          /* 目标候选 = 本区域**除源账号以外**的全部账号（不写死列表）。 */
          targets={accounts.filter((item) => item.id !== extDrawer.account.id)}
        />
      ) : null}

      <SwitchAccountDialog
        open={switchAccount !== null}
        onOpenChange={(o) => {
          if (!o) setSwitchAccount(null);
        }}
        account={switchAccount}
        region={region}
        copySessionsByDefault={Boolean(switchConfig?.copy_sessions_by_default)}
        onDone={() => {
          // 切换完成后必须同时刷新账号库与状态：账号库决定卡片内容，
          // `status.current` 决定「当前账号」标记；只刷账号库会让标记留在旧账号上。
          void reconcileAccounts(region);
          void refreshRegionStatus(region);
          void refreshCodebuddyCliStatus();
          void refreshCodebuddyCnIdeStatus();
        }}
      />

      {/* 回收站（P5 §2.7.1）：恢复 = 移回 live ⇒ 成功后重取账号库，让恢复的账号立刻回到列表。 */}
      <RecycleBinSheet
        open={recycleOpen}
        onOpenChange={setRecycleOpen}
        scope={scope}
        onRestored={() => void reconcileAccounts(region)}
      />

      {/* 统一重启确认（P8 T03 / §3.15.3）：**所有**客户端切换走同一条流程。
          CLI 例外（`client === "cli"`）⇒ 不渲染「自动重开」，文案如实写「当前 CLI 会话会中断」；
          「先关再开」的三个客户端（IDE / VS Code 扩展 / JetBrains 插件）⇒ 「需重启」文案 +
          默认勾选自动重开 + 未保存文件风险。 */}
      <RestartConfirmDialog
        open={restartConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setRestartConfirm(null);
        }}
        clientLabel={switchClientLabel(restartConfirm?.client ?? "ide")}
        isCli={(restartConfirm?.client ?? "ide") === "cli"}
        onConfirm={(restart) => {
          const target = restartConfirm;
          setRestartConfirm(null);
          if (!target) return;
          switch (target.client) {
            case "cli":
              void doSwitchCodebuddyCli(target.account);
              return;
            case "ide":
              void doSwitchCodebuddyCnIde(target.account, restart);
              return;
            case "vscode":
              doSwitchVscodePlugin(target.account, restart);
              return;
            default:
              doSwitchJetbrainsPlugin(target.account, restart);
          }
        }}
      />

      {/* 接入/升级 CLI 认证确认（桌面 App 不支持 window.confirm） */}
      <Dialog open={installConfirmOpen} onOpenChange={setInstallConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {codebuddyUsesSettingsEnv
                ? t("wbAccounts.dialog.installTitleUpdate")
                : codebuddyCli?.configured || codebuddyCli?.migrationRequired
                  ? t("wbAccounts.dialog.installTitleUpgrade")
                  : t("wbAccounts.dialog.installTitleConnect")}
            </DialogTitle>
            <DialogDescription>
              {codebuddyUsesSettingsEnv ? (
                <>
                  {t("wbAccounts.dialog.installDescSettingsA")}
                  <code className="mx-1 rounded bg-muted px-1">~/.codebuddy/settings.json</code>
                  {t("wbAccounts.dialog.installDescSettingsB")}
                </>
              ) : (
                <>
                  {t("wbAccounts.dialog.installDescOtherA", { verb: codebuddyCli?.configured || codebuddyCli?.migrationRequired ? t("wbAccounts.dialog.installVerbUpgrade") : t("wbAccounts.dialog.installVerbConnect") })}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstallConfirmOpen(false)}>
              {t("wbAccounts.dialog.cancel")}
            </Button>
            <Button onClick={() => void confirmInstallCodebuddyCli()}>{t("wbAccounts.dialog.continue")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除账号确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("wbAccounts.dialog.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("wbAccounts.dialog.deleteDesc", {
                name:
                  displayText(deleteTarget?.nickname) ||
                  displayText(deleteTarget?.email) ||
                  displayText(deleteTarget?.id) ||
                  t("wbAccounts.common.unknownAccount"),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("wbAccounts.dialog.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              {t("wbAccounts.dialog.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 区域不匹配详情 */}
      <Dialog open={mismatchDetailOpen} onOpenChange={setMismatchDetailOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("wbAccounts.page.mismatchDetailTitle")}</DialogTitle>
            <DialogDescription>
              {t("wbAccounts.page.mismatchDetailDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t("wbAccounts.page.mismatchActualDomain")}</span>
              <code className="font-mono">{mismatch?.actualDomain || "—"}</code>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t("wbAccounts.page.mismatchExpectedFile")}</span>
              <code className="font-mono">{mismatch?.expectedFile || descriptor.authFilename}</code>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">{t("wbAccounts.page.mismatchEnvVar")}</span>
              <code className="font-mono">{mismatch?.envVar || descriptor.authEnv}</code>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setMismatchDetailOpen(false)}>{t("wbAccounts.dialog.oauthClose")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 账号详情抽屉（P4）：共享壳 + 本页装配的 sections / packs / programs。 */}
      <AccountDetailDrawer
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailAccount(null);
            // 入口页签只对「这一次打开」有效，关闭即清，避免下一次普通打开先闪一下任务页签。
            setDetailInitialTab(null);
          }
        }}
        // 页签记忆的身份键：`scope:id`（同一 id 在国内版 / 国际版是两个账号）。
        accountKey={detail ? `${scope}:${detail.id}` : ""}
        name={detailName}
        subtitle={detail ? accountIdentity(detail) : ""}
        avatarSeed={detailName}
        loading={detailLoading}
        packs={detailPacks}
        stats={detailStats}
        refreshingKinds={detail ? refreshBusy.kindsOf(detail.id) : []}
        onRefreshPart={detail ? (kind) => void onRefreshPart(detail, kind) : undefined}
        sections={detailSections}
        programs={detailPrograms}
        /* ★ 头部「当前登录」徽章 + 可点「切换到此账号」程序位 + 向导入口（原型 :3475 / :3480-3486）。 */
        current={detailIsCurrent}
        switchTargets={detailSwitchTargets}
        onWizardSwitch={detail ? () => setSwitchAccount(detail) : undefined}
        /* ★ P14 S4a · 插件会话复制入口：只在**有会话仓的程序位已接入**时注入
           （`jetbrains` 刻意不映射 —— 它没有对应的会话树）。 */
        onExtSessions={
          detail && detailExtClient
            ? () => setExtDrawer({ client: detailExtClient, account: detail })
            : undefined
        }
        extClientLabel={
          detailExtClient
            ? t(
                detailExtClient === "vscode"
                  ? "sessions.ext.client.vscode"
                  : "sessions.ext.client.codebuddyIde",
              )
            : undefined
        }
        /* ★ 「操作」区：只剩凭据续期（导出 / 权限诊断已于 2026-10-23 移除）。 */
        actions={detailActions}
        /* ★ 「凭据」页签的凭证信息（状态 + 到期 / 续期时间）。 */
        credential={detailCredential}
        /* ★ 「签到历史（近 7 天）」（原型 :3428）：日期 / 结果来自签到日志，金额来自积分统计（缺失「—」）。 */
        checkinHistory={detailCheckinHistory}
        /* ★ 成长任务中心：**只在 WorkBuddy 国内版**注入 —— 国际版没有这套成长体系
           （后端 `growth_tasks` 对 Global 直接返回「暂无」），Trae / Qoder 更没有。
           注入的是「账号定位」而非数据：任务列表由面板在切到页签时自取。
           ★ 2026-10-26：`onRefresh` / `refreshing` 把页签 ⟳ 与指标卡 ⟳
           接到同一条统一刷新上（摘要重扫 + 列表重拉，共用一个忙态）。 */
        growthTasks={
          detail && scope === "wb-cn"
            ? {
                scope,
                accountId: detail.id,
                refreshing: growthRefreshBusyId === detail.id,
                onRefresh: (reload) => void refreshGrowthAccount(detail, reload),
              }
            : null
        }
        /* 跑完任务后刷**这一张卡**的提示标签（不重扫全表）。 */
        onGrowthTasksChanged={detail ? () => void refreshGrowthHint(detail.id) : undefined}
        // ★ B5：签到积分（**有数据才渲染**；查询未回来 / 失败时为 `null`）。
        checkin={
          detail && checkinDetailMap[detail.id]
            ? {
                todayCheckedIn: checkinDetailMap[detail.id].todayCheckedIn,
                ...checkinCreditsOf(checkinDetailMap[detail.id]),
              }
            : null
        }
        remark={detail ? displayText(detail.remark)?.trim() || "" : ""}
        onSaveRemark={detail ? (remark) => onSaveRemark(detail, remark) : undefined}
        autoEditRemark={detailAutoEditRemark}
        /* ★ 自定义分组（与备注**同一交互**）：注入 `onSaveGroup` ⇒ 抽屉渲染「分组」区块。 */
        group={detail ? displayText(detail.groupName)?.trim() || "" : ""}
        onSaveGroup={detail ? (group) => onSaveGroup(detail, group) : undefined}
        groups={detailGroups}
        autoEditGroup={detailAutoEditGroup}
        /* 成长任务标签打开的抽屉直接落在「任务」页签；普通入口按记忆页签回落。 */
        initialTab={detailInitialTab}
        empty={{
          title: t("shared.drawer.empty.title"),
          description: t("shared.drawer.empty.description"),
          action: (
            <Button
              size="sm"
              variant="outline"
              disabled={recheckDrawerBusy}
              onClick={() => void runRecheckDrawer(() => onRecheck())}
            >
              {recheckDrawerBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbAccounts.empty.recheck")}
            </Button>
          ),
        }}
      />

      {/* 批量删除确认（桌面 App 不支持 window.confirm）。 */}
      <Dialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shared.batch.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("shared.batch.deleteDesc", { n: selectedKeys.size })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDeleteOpen(false)}>
              {t("shared.batch.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void batchDelete()}>
              {t("shared.batch.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 该版本未安装 / 未登录时的空态卡片（PRD §3.3.1）。 */
function EmptyRegionCard({
  region,
  installed,
  expectedAuthFile,
  onRecheck,
  onImport,
  importing,
}: {
  region: Region;
  installed: boolean;
  expectedAuthFile: string;
  onRecheck: () => void | Promise<void>;
  onImport: () => void;
  importing: boolean;
}) {
  const descriptor = regionDescriptor(region);
  const t = useT();
  const { busy, run } = useRefreshAction();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 px-5 py-5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {/*
            ⚠️ 标题必须按 `installed` 分叉：客户端已安装、只是没有登录态时说「未检测到」，
            用户会读成「应用认为我没装」（2026-09-24 报障），而且与页签上那句
            「未登录」自相矛盾。原因列表同理 —— 已安装时不该再列「未安装客户端」。
          */}
          <h2 className="text-sm font-medium">
            {installed
              ? t("wbAccounts.empty.notLoggedInTitle", { version: descriptor.versionLabel })
              : t("wbAccounts.empty.notDetected", { version: descriptor.versionLabel })}
          </h2>

          <div className="mt-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground/80">{t("wbAccounts.empty.possibleReasons")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {!installed && (
                <li>{t("wbAccounts.empty.reasonNotInstalled", { version: descriptor.versionLabel })}</li>
              )}
              <li>{t("wbAccounts.empty.reasonNoLogin")}</li>
              {installed && <li>{t("wbAccounts.empty.reasonNoSession")}</li>}
            </ul>
          </div>

          <div className="mt-4">
            <p className="text-sm font-medium text-foreground/80">{t("wbAccounts.empty.expectedAuthFile")}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {expectedAuthFile}
              </code>
              <Button variant="ghost" size="sm" onClick={() => void copyText(expectedAuthFile, t("wbAccounts.empty.copyPathToast"))}>
                {t("wbAccounts.empty.copyPath")}
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => onRecheck())}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("wbAccounts.empty.recheck")}
            </Button>
            <Button size="sm" onClick={onImport} disabled={importing}>
              {importing ? <Loader2 className="animate-spin" /> : <Download />}
              {t("wbAccounts.empty.importLocal")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
