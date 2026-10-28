import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CircleSlash,
  Download,
  Loader2,
  QrCode,
  RefreshCw,
  Rocket,
  Save,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { AddAccountDrawer, type AddAccountWay } from "@/components/add-account-drawer";
import { AccountsTableAvatar } from "@/components/account-list-parts";
import {
  ACCOUNT_CHIP_CLASS,
  CredentialExpiryMeta,
  expiryTooltipLines,
  formatTodayTokens,
  nextExpiryLabel,
} from "@/components/account-card";
import {
  QuickActionButton,
  QuickRefreshAction,
  quickRefreshCoolingDown,
  startQuickRefreshCooldown,
} from "@/components/account-quick-actions";
import { CheckinIcon } from "@/lib/semantic-icons";
import {
  AccountMoreMenu,
  AccountMoreMenuDemo,
  type AccountCheckinState,
} from "@/components/account-more-menu";
import { AccountWorkbench } from "@/components/account-workbench";
import { type AccountColumn } from "@/components/account-table";
import { type ToolbarOption } from "@/components/account-toolbar";
import {
  AccountDetailDrawer,
  type DetailActions,
  type DetailCheckinHistoryRow,
  type DetailCredential,
  type DetailPack,
  type DetailStat,
  type DetailProgramBadge,
  type DetailSection,
  type DetailSnapshot,
  type DetailSwitchTarget,
} from "@/components/account-detail-drawer";
import type { DrawerTab } from "@/lib/drawer-tab-preference";
import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import {
  TraeAccountCard,
  TraeCurrentProgramChip,
  TraeStatusChips,
  formatCredits,
  jwtBadge,
  shortTime,
  traeCreditPackages,
  traeCreditTotal,
  traeJwtExpiryMs,
  type TraeProgram,
} from "@/components/trae-account-card";
import { isExpiryUrgent, summarizeExpiry } from "@/lib/credit-expiry";
import { REFRESH_DONE_LABEL, useAccountRefreshBusy, type AccountRefreshKind } from "@/lib/account-refresh";
import { mapWithConcurrency } from "@/lib/concurrency";
import { TraeExportAccountsDialog } from "@/components/trae-export-accounts-dialog";
import { TraeImportAccountsDialog } from "@/components/trae-import-accounts-dialog";
import { ClientlessEmptyCard, ClientlessStrip } from "@/components/clientless-notice";
import { TraeOAuthLoginDialog } from "@/components/trae-oauth-login-dialog";
import { RecycleBinSheet } from "@/components/recycle-bin-sheet";
import { RestartConfirmDialog } from "@/components/restart-confirm-dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/api";
import type { CheckinStatusEntry } from "@/lib/api";
import type { AccountTokenTodayEntry } from "@/lib/types";
import { accountSearchText } from "@/lib/account-search";
import { lastSevenDays } from "@/lib/checkin-history";
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
import { displayText } from "@/lib/display-text";
import { useMediaQuery } from "@/lib/use-media-query";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/zh";
import {
  loadScheduleConfig,
  SCHEDULE_CONFIG_KEY,
} from "@/lib/schedule-config";
import { traeVariantLabel, type TraeLogEntry } from "@/lib/trae-types";
import {
  TRAE_VARIANT_FALLBACK,
  loadTraeVariantLogins,
  loadTraeVariantStatuses,
  type TraeVariantLogins,
} from "@/lib/trae-variant-status";
import type { ScheduleConfig } from "@/lib/types";
import type {
  TraeAccount,
  TraeAccountsOverview,
  TraeCheckinEvent,
  TraeCheckinReport,
  TraeCheckinStatus,
  TraeCreditsOverview,
  TraeEnvStatus,
  TraeProfileInfo,
  TraeSnapshotCarryReport,
  TraeVariantId,
  TraeVariantStatus,
  TraeRegionId,
} from "@/lib/trae-types";
import { cn } from "@/lib/utils";
import { scopeOf } from "@/lib/scope";
import { useCachedResource } from "@/lib/use-cached-resource";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { showUndoToast } from "@/lib/undo-toast";
import { useTraeVariant } from "@/lib/use-trae-variant";

/**
 * 一次动作的**结果判定**（由调用方按后端报告如实给出）。
 *
 * ## 为什么要有这个类型（2026-09-29）
 *
 * 本仓不少后端写操作的失败是**正常返回的报告**，不是传输错误：
 * 切换账号回 `success:false` + `steps`、批量签到回 `failed: n`。
 * 而动作外壳原先只认「Promise 有没有 reject」⇒ 这些失败全被弹成「{label}完成」。
 * 报障原文：「切换成功，但是程序没有被打开，标记状态也没有变更」。
 *
 * 把「报成功还是报失败」变成**显式的返回值**，调用方就必须表态；
 * 省略 `message` 时按 `level` 取默认文案（success → 「{label}完成」，
 * 其余 → 「{label}失败」）。
 */
type ActionVerdict = {
  level: "success" | "warning" | "error";
  /** 省略时按 `level` 取默认文案。 */
  message?: string;
  description?: string;
};

/** 一键刷新里**单层**的结果（积分 / 签到 / 快照各判一次，再汇总提示）。 */
type RefreshLayerOutcome = "ok" | "partial" | "fail";

/**
 * 本轮快照读取被**更新的同键请求**取代 —— 既不是成功也不是失败。
 *
 * 为什么要单独一类：并发强制刷新时先发请求的结果会因序号过期被丢弃，
 * 若把它当成功，错误 toast 旁仍会亮「已更新」；当失败又会误报。调用方应当
 * **不弹任何回执**、也不点亮「已更新」。
 */
class SupersededRefreshError extends Error {
  constructor() {
    super("refresh superseded by a newer request");
    this.name = "SupersededRefreshError";
  }
}

/**
 * 账号页的快照。
 *
 * 这些数据**必须一起**缓存：卡片上的程序切换按钮要同时用到账号、程序位与各区域
 * 登录态，分开缓存会让「账号已是新的、按钮还是旧的」这种不一致有缝可钻。
 *
 * 缓存键里带 `variant`（产品线），所以切到另一条线绝不会渲染出上一条线的数据。
 */
interface AccountsSnapshot {
  overview: TraeAccountsOverview;
  env: TraeEnvStatus;
  credits: TraeCreditsOverview;
  checkin: TraeCheckinStatus;
  /** 本机全部产品线的环境状态（并排视角），账号卡片与状态条共用。 */
  variantStatuses: TraeVariantStatus[];
  /** 每条产品线各自的当前登录账号（`profiles.currentAccount` 的 uid + 展示名）。 */
  logins: TraeVariantLogins;
}

/**
 * 「账号管理」页（Trae 分区）。
 *
 * ## 与 WorkBuddy 页面的关系
 *
 * **骨架逐段照抄** WorkBuddy 的 `AccountsPage`：产品状态标记行 → 「添加与迁移账号」
 * 横幅 → 环境说明行 → 空态卡 → 账号工具栏 → 卡片栅格 → 各确认 Dialog。
 * 用户在两个分区之间切换时不需要重新学习界面。
 *
 * **文案与数据源按 Trae 实情落地**，不搬 WorkBuddy 的：
 * - 区域（国内版 / 国际版）与 WorkBuddy **语义完全对应**，且**切换入口统一在顶栏**
 *   （`ScopeSelector`，区域已并入 L1 作用域）：这些页面级切换器（`TraeVariantBar` /
 *   `TraeVariantSwitch` / `WorkbuddyRegionSwitch`）已删除，页头只留一枚**只读** `ScopeChip`。
 *   承载标识见 `useTraeVariant`（返回**区域**；旧值 `trae_work`/`trae_cn` 一律回落国内版，
 *   否则老书签会去读空库）；
 * - 卡片头部的**程序切换按钮**（该区域的每个 Trae 程序各一枚）对应 WorkBuddy 卡片上的
 *   WorkBuddy / CodeBuddy IDE / CodeBuddy CLI 三枚按钮——都是「把这个账号挂到哪个
 *   客户端上」。这个维度 Trae 叫**程序位**（TraeWork / TraeCode，见 `TraeProgram`），
 *   与「区域」是两层：区域决定账号库与端点，程序位决定写进哪个客户端；
 * - **支持 OAuth 网页登录**（`trae-oauth-login-dialog.tsx` + OAuth 三命令），
 *   粘贴 `Cloud-IDE-JWT` 只是「优先用网页登录」的兜底方式；
 * - **有自动签到**（排程任务 `trae_checkin`，默认关闭）：与 WorkBuddy 工具栏的同名开关
 *   同位同义 —— 到点由后台调度器签一轮、应用启动时若当天还没签则补一轮，两个区域各签一遍；
 *   小时点在 Trae 设置页配置。它管**何时签**；
 * - 「跳过今日已签」是**策略**开关（管**怎么签**）：手动与自动两轮都受它约束，
 *   两者是不同层，因此并排出现并不重复；
 * - 没有自动旅行（Trae 侧不存在该客户端）。
 */
/**
 * Trae 账号页 —— 作用域外壳。
 *
 * 按**完整作用域**渲染带 `key` 的内容面板（`docs/specs/P4-TOOLBAR-ARCH.md` §1.11①）。
 * 产品线是账号库的分家维度：Trae Work 与 Trae CN 的 userId 可能同名（同一用户两条线），
 * 只换 prop 不换实例会把 A 线的勾选、抽屉、签到快照与结果条显示到 B 线。
 */
export default function TraeAccountsPage() {
  const [variant] = useTraeVariant();
  const scope = scopeOf("trae", variant);
  return <TraeAccountsPanel key={scope} variant={variant} />;
}

function TraeAccountsPanel({ variant }: { variant: TraeRegionId }) {
  const t = useT();
  /**
   * 一次取齐本页快照。四份分家数据全部按**当前选中的产品线**读取，与侧栏分区同源。
   * `env` 仍然单独取：它是「单一视角」的环境快照，用于展示该线的安装/运行状态。
   *
   * `statuses` 与「各线当前账号」则是**跨产品线**的：卡片上的程序切换按钮条
   * （对应 WorkBuddy 卡片的 WorkBuddy / CodeBuddy IDE / CLI 三枚按钮）必须知道
   * 「本机装了哪几条线、每条线当前挂的是哪个账号」，缺一条就渲染不出那一枚按钮。
   */
  const loadSnapshot = useCallback(async (): Promise<AccountsSnapshot> => {
    const [accountData, envData, creditData, checkinData, statuses] = await Promise.all([
      api.getTraeAccounts(variant),
      api.getTraeEnv(),
      api.getTraeCredits(variant),
      api.getTraeCheckinStatus(variant),
      loadTraeVariantStatuses(),
    ]);
    // 登录态读取依赖刚拿到的产品线清单（要遍历它逐条读），故串在探测之后。
    // 它自己逐条容错：某条线读不到只记 `null`，不会把整页拖成错误态。
    const currentLogins = await loadTraeVariantLogins(statuses);
    return {
      overview: accountData,
      env: envData,
      credits: creditData,
      checkin: checkinData,
      variantStatuses: statuses,
      logins: currentLogins,
    };
  }, [variant]);

  /**
   * 快照缓存（`stores/resources.ts`）。
   *
   * 数据持有权从组件搬到 store，是为了**跨挂载存活**：侧栏切到 WorkBuddy 再切回来时
   * 页面组件会卸载重建，数据留在 store 里 ⇒ 重挂载立刻渲染真数据、不再闪骨架。
   * `loadAll` 是「强制重取并等待」，变更操作（签到 / 切换 / 删除 / 导入）之后必须调它。
   */
  const {
    data: snapshot,
    loading,
    error,
    refresh: loadAll,
    refreshWithResult: loadAllWithResult,
  } = useCachedResource<AccountsSnapshot>(`trae:accounts:${variant}`, loadSnapshot);

  /**
   * 自动签到的**排程**（何时跑），与 Trae 设置页共用同一把键（`SCHEDULE_CONFIG_KEY`）。
   *
   * ⚠️ 2026-10-23：账号页**只读不写**。原先这里还挂着「自动签到 / 跳过已签到」两枚开关
   * （在「添加账号 → 更多操作」里），该分区已整块删除 ⇒ 开关只留在
   * `TraeSettingsPage`；`trae:settings` 那份资源也随之下线（本页不再读它）。
   * 卡片仍需要 `trae_jwt_refresh_enabled` 来判断「JWT 自动续期是否关着」，故 `schedule` 保留。
   */
  const { data: schedule } = useCachedResource<ScheduleConfig>(
    SCHEDULE_CONFIG_KEY,
    loadScheduleConfig,
  );

  /**
   * 本机全部 Trae 产品线的环境状态（并排视角），与状态条、卡片共用同一份。
   *
   * 账号卡片上的「程序切换按钮」要按**每条线**渲染，因此这里必须拿全量，
   * 而不是 `env`（后者只是「自动挑中的那一条」的单一视角）。
   *
   * 初值是**兜底的两条线占位**而不是空数组：状态条与卡片都直接按它渲染，
   * 空数组会让首次加载期间出现「一枚 Tab 都没有」的空条（模板占了位却什么都没画）。
   * 用占位起步、加载完成后替换，形态与 WorkBuddy 的 region Tabs 一致
   * （后者也是先渲染两枚 Tab，再逐区填状态）。
   */
  const overview = snapshot?.overview ?? null;
  const credits = snapshot?.credits ?? null;
  const checkin = snapshot?.checkin ?? null;
  const variantStatuses = snapshot?.variantStatuses ?? TRAE_VARIANT_FALLBACK;
  /**
   * 每条产品线各自的当前登录账号（`profiles.currentAccount` 的 uid + 展示名）。
   *
   * **不能**只读当前这条线：卡片上每条程序按钮的「是否当前账号」是**各判各的**，
   * 同一个 Trae 账号完全可以同时是 Trae Work 的当前账号、却不是 Trae CN 的。
   * 只拿当前线的值会让另一枚按钮永远显示成「未启用」——那是谎报，不是简化。
   *
   * 身份与展示名同源（同一次 `get_trae_profiles`）：卡片用 `userId` 比身份，
   * 状态条用 `name` 显示 —— 两者绑在一个对象里，不会出现半更新。
   */
  const logins = snapshot?.logins ?? {};

  const [busy, setBusy] = useState<string | null>(null);
  /**
   * 收敛迁移的**一次性升级引导**内容（issue #28）。
   *
   * 只在 `snapshots.firstRun` 为真时由遗留迁移链写入；用户关掉后不再写
   * （后端标记已落 ⇒ 整条链再次执行时 `firstRun` 为假）。
   * `null` = 不展示（正常态 / 演示模式）。
   */
  const [mergeGuide, setMergeGuide] = useState<TraeSnapshotCarryReport | null>(null);
  /* 「重新检测」两处入口（错误 Alert / 详情抽屉空态）各自的进行中态 —— 与 WorkBuddy
     账号页同一做法：`void loadAll()` 是 fire-and-forget，点击后按钮必须立刻有转圈反馈。 */
  const { busy: recheckAlertBusy, run: runRecheckAlert } = useRefreshAction();
  const { busy: recheckDrawerBusy, run: runRecheckDrawer } = useRefreshAction();
  const [oauthOpen, setOauthOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** 「添加账号」抽屉（两平台同一入口；原工具栏「⋯」菜单的内容都落在这里）。 */
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * 导出目标：`null` = 导出**全部**账号（工具栏入口）；非 `null` = 导出**所选**账号（批量条入口）。
   *
   * ⚠️ 与 WorkBuddy **同名同义**（`AccountsPage` 的 `exportTargets`）：批量条上的「导出」
   * 与工具栏上的「导出备份」范围不同（所选 vs 全部），必须分成两个状态，
   * 否则「关闭时清空选择」与「打开时带选择」会互相踩。
   */
  const [exportTargets, setExportTargets] = useState<TraeAccount[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<TraeCheckinEvent | null>(null);
  const [report, setReport] = useState<TraeCheckinReport | null>(null);
  /**
   * P4 工具栏：搜索 / 排序 / 分组 / 视图（**页面私有 `useState`**，`PLAN §2.1 L3` / D1）。
   * 不进 URL、不进 store、不碰作用域，且**不持久化**（决策 #2）。
   *
   * ⚠️ 2026-10-10：原先另有一个「分组**筛选**」状态（`groupFilter`，只看某一组），
   * 已随工具栏上那个 Trae 独有的下拉一起删除（用户要求工具栏与 WorkBuddy 一致）。
   * 分组信息仍在：卡片上有分组标签，`group = "group"` 仍能按分组**分桶**。
   */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AccountSortKey>("priority");
  const [group, setGroup] = useState<AccountGroupKey>("none");
  const [view, setView] = useState<AccountViewMode>("card");
  const tableEnabled = useMediaQuery("(min-width: 900px)");
  const searchRef = useRef<HTMLInputElement>(null);

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
   * 与 `AccountsPage` 同构：读一次播种页内搜索 state，随后 `replace` 清参
   * （视图参数留页内，§2.1 L3）。`seededRef` 保证只读一次。
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

  /** 待确认删除的账号。用 shadcn Dialog 承载确认，而非 `window.confirm`——
   *  Tauri WebView 不支持原生 confirm，且原生弹窗无法保持主题与无障碍契约。 */
  const [pendingDelete, setPendingDelete] = useState<TraeAccount | null>(null);
  /** 回收站抽屉开关（P5 §2.7.1：按**当前作用域**过滤，入口在工具栏）。 */
  const [recycleOpen, setRecycleOpen] = useState(false);

  /**
   * 待确认的「切换到某个程序位」目标（P8 T03 / §3.15.3）。
   *
   * 切换 TraeWork / TraeCode 会**先关再开**客户端（`trae::profile::switch_account` 的
   * `launch` 阶段）⇒ 与 WorkBuddy / CodeBuddy IDE 走**同一条**确认流程（默认勾选自动重开 +
   * 未保存文件风险）。`restart` 映射到后端的 `launch`：取消勾选 ⇒ `launch: false`
   * （只换登录态、不拉起客户端）。
   */
  const [switchConfirm, setSwitchConfirm] = useState<{
    userId: string;
    variant: TraeVariantId;
    label: string;
  } | null>(null);

  /**
   * P4：详情抽屉 + 最小批量选择（与 WorkBuddy 账号页 `AccountsPage` 同构）。
   *
   * 抽屉状态由**页面**持有（卡片只发 `onOpenDetail`）：抽屉需要「这个账号的全部明细」，
   * 而那些数据（逐包积分、程序位、凭据）只有页面手里齐全。
   * （★ 2026-10-27：菜单的「编辑备注」入口已删，抽屉不再需要 `autoEditRemark` 直达编辑态；
   * 备注在抽屉「备注」区就地编辑。）
   *
   * 选择集用 `Set<userId>`：Trae 账号的身份就是 `userId`（改名不改身份）。
   */
  const [detailAccount, setDetailAccount] = useState<TraeAccount | null>(null);
  /** 本次打开要直达的页签（`null` = 按账号记忆）。 */
  const [detailTab, setDetailTab] = useState<DrawerTab | null>(null);
  /**
   * ★ 抽屉「签到历史（近 7 天）」的数据源（打开抽屉时拉取）。
   *
   * `get_trae_logs({ kind: "checkin" })` 是本机**真实**的签到日志（`TraeLogEntry` 带 `date`），
   * 与 WorkBuddy 侧的 `getCheckinLogs()` 同一层语义。取不到时 `null` ⇒ 该区块**不渲染**
   * （不摆一张空表，也不臆造「+N」）。
   */
  const [detailCheckinLogs, setDetailCheckinLogs] = useState<TraeLogEntry[] | null>(null);
  const detailCheckinLogsRequest = useRef(0);
  /**
   * 抽屉「快照」页签的数据源（打开抽屉时按需拉取）。
   *
   * 为什么不在账号列表里一起拉：`get_trae_profiles` 是**逐账号槽位**的目录扫描，
   * 列表页一次拉 20 个账号的槽位只为了一个可能不打开的抽屉，属于白花钱。
   * 取不到时给空数组 ⇒ 页签**不渲染**（不摆空表）。
   */
  const [detailProfiles, setDetailProfiles] = useState<TraeProfileInfo[] | null>(null);

  useEffect(() => {
    if (!detailAccount) {
      setDetailProfiles(null);
      return;
    }
    let alive = true;
    void api
      .getTraeProfiles(variant)
      .then((overview) => {
        if (alive) setDetailProfiles(overview.profiles ?? []);
      })
      .catch(() => {
        if (alive) setDetailProfiles([]);
      });
    return () => {
      alive = false;
    };
  }, [detailAccount, variant]);

  /**
   * 该账号的快照行。
   *
   * `TraeProfileInfo.slot` 就是**账号的 userId**（后端 `backup_to_slot_for(variant, user_id)`），
   * 所以按 userId 精确匹配即可 —— 不要按 name 匹配（改名后会失配）。
   */
  const detailSnapshots = useMemo<DetailSnapshot[]>(() => {
    if (!detailAccount || !detailProfiles) return [];
    return detailProfiles
      .filter((profile) => profile.slot === detailAccount.userId)
      .map((profile) => ({
        key: profile.slot,
        timeText: profile.lastModified,
        sizeText: profile.sizeText,
        fileCountText: t("shared.drawer.snapshot.files", { n: profile.fileCount }),
      }));
  }, [detailAccount, detailProfiles, t]);

  /**
   * ★ 跨作用域选择集按 **(scope, userId)** 键控（P5 §2.5 第 (4) 条）。
   *
   * scope 由 `variant`（本页的 `variant` 即**区域**，见 `useTraeVariant` 文档）派生：
   * `trae-cn` / `trae-global`。键里带上 scope：切区域后旧键自然失配 ⇒ `targets` 恒为 0，
   * **不会**用 A 区域的 userId 去打 B 区域的库（或静默空转）。P4 已在 `variant` 变化时清空
   * （见下方 effect），这里是**键控层面**的加固。
   */
  const scope = scopeOf("trae", variant);
  const selectionKey = (userId: string) => `${scope}:${userId}`;
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  /** 批量续期凭据进行中（与 `batchBusy` 分开：批量条要单独给「续期凭据」转圈）。 */
  const [renewBusy, setRenewBusy] = useState(false);
  /** 当前批次的协作式中止句柄与进度（只对逐账号循环的动作有意义）。 */
  const batchAbortRef = useRef<AbortController | null>(null);
  /** 当前签到任务 id（协作式取消用；`null` = 没有在跑的签到）。 */
  const checkinTaskIdRef = useRef<string | null>(null);
  /** 统一取消入口：签到走任务 id（后端逐账号检查），逐账号循环走 AbortController。 */
  function cancelBatch() {
    const taskId = checkinTaskIdRef.current;
    if (taskId) void api.traeCheckinCancel(taskId);
    batchAbortRef.current?.abort();
  }
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * 组件是否仍挂载（切换产品线即卸载）。
   *
   * 卸载时中止**尚未开始**的批处理，并抑制在途批次的收尾 toast ——
   * 否则切区后仍会收到上一条产品线的「已刷新 N 个」，而界面已换成另一条线。
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      /* 卸载（切产品线）：中止尚未开始的逐账号任务，并取消后端批签到任务。 */
      const taskId = checkinTaskIdRef.current;
      if (taskId) void api.traeCheckinCancel(taskId);
      batchAbortRef.current?.abort();
    };
  }, []);
  /**
   * 页头「一键」动作的进行中标识（同一时刻只跑一个）。
   *
   * 与 {@link batchBusy} **分开**：一键作用于**全部账号**、批量作用于**勾选账号**，
   * 两者误触代价不同（PLAN §3.4 三作用域），共享一个布尔会让「一键刷新」把批量条的
   * 按钮也一起转起来，用户分不清是哪一个在跑。
   */
  const [quickActionBusy, setQuickActionBusy] = useState<"refresh" | "checkin" | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  /**
   * 批量签到**结果条**（原型 `state.checkinResult`，`buddy-switch-prototype.html:2339-2354`）。
   *
   * ⚠️ 与 WorkBuddy **同一条**结果条、同一位置（工具栏与列表之间）——
   * 此前 Trae 侧是一张页面底部的大 Card，形状与位置都与 WB 不同。
   */
  const [checkinResult, setCheckinResult] = useState<{
    ok: number;
    failedIds: string[];
    /** 协作式取消后**未处理**的账号 id（没有发出请求，既不是成功也不是失败）。 */
    unprocessedIds: string[];
  } | null>(null);

  /**
   * 状态条第二行（每条产品线各自已登录哪个账号）的数据由**本页持有并注入**，
   * 状态条不再自己读一遍。
   *
   * ## 为什么不再用「修订号」触发状态条重读
   *
   * 状态条原先自己读各线登录态，因此需要一个 `variantBarRevision`：否则用户执行
   * 「切换账号 / 保存登录态 / 删除账号 / OAuth 新增」之后，页面主体已更新、
   * 状态条第二行却仍写着旧账号名。
   *
   * 现在卡片上的程序切换按钮**本来就要**每条线的当前账号（否则画不出「那条线上
   * 有没有挂着这个账号」），本页于是成为唯一数据源，状态条改为接收 `logins`。
   * 一次性取齐、同一次渲染下发，不一致在结构上就不可能出现 —— 修订号随之取消，
   * 它要解决的问题已经不存在了。
   */

  /**
   * 一次性遗留迁移（幂等）：旧「产品线」账号库并入国内版区域账号库 + 客户端合并后
   * 遗留的登录态快照搬进合并版槽位。
   *
   * ## 为什么挂在页面挂载时
   *
   * 后端在没有旧库 / 已经并完 / 没有可搬的快照时立刻返回 `changed: false`（成本只是一次
   * 文件存在性判断），所以不需要前端再维护「跑过没有」的状态 —— 那反而会引入
   * 「换了台机器/清了缓存就不跑了」这类新缺陷。依赖 `loadAll` 会让切换产品线时
   * 再调一次：**这是有意的**，代价是一次廉价请求，换来的是「用户切过去时数据已就绪」。
   *
   * ## ⚠️ 两个 `changed` 必须分开看（issue #20）
   *
   * `report.changed` 只表示**账号库**被改写了，`report.snapshots.changed` 才是快照搬运。
   * 两者互相独立：账号库早就并完、只剩快照没搬的机器上，只看前者会让提示**永不出现**，
   * 用户则继续卡在「切换账号失败：登录态快照不存在」。
   *
   * ## 为什么只在真并了东西时提示
   *
   * 改写用户数据这件事，用户有权知道改了什么、旧数据备份在哪 ——
   * 因此提示里带上账号数、分组数与**备份路径**；备份失败单独警告（凭据仍在旧文件里，
   * 未被删除，所以不必阻断）。快照搬运同理：搬了几个、有没有搬失败都要说。
   *
   * 失败**不阻断页面**：读侧此刻仍按旧库工作，账号一个都没少，用户照常用。
   */
  useEffect(() => {
    if (api.isDemoMode()) return;
    let disposed = false;
    void (async () => {
      try {
        const report = await api.traeMergeLegacyRegions();
        if (disposed) return;
        const snapshots = report.snapshots;
        const snapshotsChanged = snapshots?.changed ?? false;
        // ★ 一次性升级引导（issue #28）：收敛迁移**首次**执行时弹一次。
        //   判据是 `firstRun` 而不是 `changed` —— 全新安装没有存量快照（`changed`
        //   为假），用户同样需要知道「Trae 已合并、老程序位已退役、按钮只剩一个」。
        //   后端落盘的一次性标记保证只弹一次（那个链每次进账号页都会跑）。
        if (snapshots?.firstRun) setMergeGuide(snapshots);
        // 两个 changed 任一为真才提示（见上方说明）。
        if (!report.changed && !snapshotsChanged) return;
        toast.success(
          report.changed
            ? t("trae.page.accounts.mergeDone")
            : t("trae.page.accounts.mergeSnapshotsDone"),
          {
            description: [
              // 账号库那几行只在账号库真被改写时才出现 —— 快照-only 的机器上
              // 报「并入 0 个账号」是噪声，还会让人以为账号出了问题。
              report.changed
                ? t("trae.page.accounts.mergeSummary", {
                    added: report.accountsAdded,
                    kept: report.accountsKept,
                  })
                : null,
              report.changed && report.groupsAdded > 0
                ? t("trae.page.accounts.mergeGroups", { count: report.groupsAdded })
                : null,
              report.changed && report.backup
                ? t("trae.page.accounts.mergeBackup", { path: report.backup })
                : null,
              report.changed && report.backupFailed
                ? t("trae.page.accounts.mergeBackupFailed")
                : null,
              snapshotsChanged
                ? t("trae.page.accounts.mergeSnapshots", { count: snapshots.slotsCopied })
                : null,
              snapshots?.errors?.length
                ? t("trae.page.accounts.mergeSnapshotsFailed", {
                    count: snapshots.errors.length,
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
          },
        );
        await loadAll();
      } catch (e) {
        toast.error(t("trae.page.accounts.mergeFailed"), { description: api.asError(e) });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [loadAll]);

  // 签到进度：仅桌面端有事件通道；webui 只在结束时拿到完整报告。
  useEffect(() => {
    if (!api.isDesktop()) return;
    let dispose: (() => void) | undefined;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<TraeCheckinEvent>("trae-checkin-progress", (event) => {
          const payload = event.payload;
          /* ★ 只消费**本产品线**的事件；带 taskId 时还必须是**当前任务** ——
             切区后旧任务收尾 / 新旧任务重叠都不能污染新批次进度（如 2 个账号显示 4/2）。 */
          /* 后端直传 `region`（`TraeVariant::region()` 是唯一的变体→区域映射）；
             老版本后端没有该字段时，才回落到按 `variant` 前缀反推。 */
          const eventRegion = payload.region
            ? payload.region
            : payload.variant
              ? payload.variant.startsWith("global")
                ? "global"
                : "cn"
              : undefined;
          if (eventRegion && eventRegion !== variant) return;
          const currentTask = checkinTaskIdRef.current;
          if (payload.taskId && payload.taskId !== currentTask) return;
          setProgress(payload);
          /* 批量条进度只跟**当前任务**的事件走；单账号签到（无 taskId）只更新结果面板。 */
          if (!payload.taskId || payload.taskId !== currentTask) return;
          if (payload.type === "start") setBatchProgress({ done: 0, total: payload.total });
          else if (payload.type === "account") {
            setBatchProgress((prev) => (prev ? { done: payload.index, total: prev.total } : prev));
          }
        });
      } catch {
        // 事件通道不可用不影响主流程（仍可用返回的完整报告渲染结果）。
      }
    })();
    return () => dispose?.();
  }, [variant]);

  /**
   * 统一的动作执行：加忙标记、**判定结果**、提示、随后刷新聚合数据。
   *
   * ## ★ 为什么第 6 个参数是「判定」而不是「自定义成功文案」（2026-09-29 改）
   *
   * 旧签名只给了一个 `successMessage`（返回 `null` 就用默认的「{label}完成」）。
   * 它的语义**预设了成功** —— 于是「后端正常返回一份带失败的报告」这类动作
   * （切换的 `success:false`、签到的 `failed: n`）在界面上**永远报「完成」**，
   * 而调用方连改口的机会都没有。报障原文：「切换成功，但是程序没有被打开」。
   *
   * 现在改成返回一份**判定**（`ActionVerdict`），由调用方按后端报告如实表态；
   * 不传时保持旧行为（成功 → 「{label}完成」）。这样「失败也报完成」这类缺陷
   * 在**签名层面**就写不出来了，而不是靠每个调用点各自记得。
   */
  async function run<T>(
    key: string,
    /** 动作的文案键；渲染时才取词，切换语言后同一枚按钮读到的就是新语言。 */
    labelKey: TranslationKey,
    action: () => Promise<T>,
    labelParams?: Record<string, string | number>,
    after?: (result: T) => void,
    verdictOf?: (result: T) => ActionVerdict,
  ) {
    setBusy(key);
    const label = t(labelKey, labelParams);
    try {
      const result = await action();
      after?.(result);
      const verdict = verdictOf?.(result) ?? { level: "success" as const };
      const message =
        verdict.message ??
        t(
          verdict.level === "success"
            ? "trae.page.accounts.actionDone"
            : "trae.page.accounts.actionFailed",
          { label },
        );
      const emit =
        verdict.level === "error" ? toast.error : verdict.level === "warning" ? toast.warning : toast.success;
      emit(message, { description: verdict.description });
      await loadAll();
    } catch (e) {
      toast.error(t("trae.page.accounts.actionFailed", { label }), { description: api.asError(e) });
    } finally {
      setBusy(null);
    }
  }

  /**
   * 用户在统一重启确认框里确认后，真正把账号挂到指定程序位。
   *
   * `restart`（确认框的「自动重开」）映射到后端 `launch`：`true` ⇒ 切换后拉起客户端；
   * `false` ⇒ 只换登录态、不拉起（与 WorkBuddy 的 `restart` 同一语义）。
   *
   * ⚠️ `programLabel` 由调用方从**程序位自己的展示名**传进来（卡片/抽屉读的是后端
   * `TraeProgramStatus.label`），**不得**在这里用 `traeVariantLabel(programVariant)` 反推：
   * 变体 `trae_cn` 同时属于遗留 `trae_code` 与合并版 `trae`（issue #20，两者共用变体），
   * 反推会把合并版说成 `TraeCode` —— 用户报障原文就是「我点的是 trae 不是 TraeCode」。
   */
  async function doSwitchTo(
    userId: string,
    programVariant: TraeVariantId,
    programLabel: string,
    restart: boolean,
  ) {
    await run(
      `switch-${userId}@${programVariant}`,
      "trae.page.accounts.actionSwitch",
      () => api.traeSwitchAccount({ userId, launch: restart, variant: programVariant }),
      { line: programLabel },
    );
  }

  /**
   * 保存账号备注（与 WorkBuddy 账号页的同名函数同形）。
   *
   * 成功后**重新拉取账号列表**而不是就地改 state：备注是唯一由用户手改的字段，
   * 后端会把全空白备注归一成「没有备注」（删键）—— 前端就地改就会留下一个空串，
   * 卡片上表现为「备注还在，只是看不见」。
   *
   * 返回布尔值而不是抛异常：卡片据此决定要不要收起编辑器。失败时保持编辑态，
   * 用户能改完重试，不会把半截输入丢掉。
   */
  async function saveRemark(account: TraeAccount, remark: string): Promise<boolean> {
    try {
      await api.traeSetAccountRemark(account.userId, remark, variant);
      await loadAll();
      toast.success(
        remark.trim()
          ? t("trae.page.accounts.remarkSaved")
          : t("trae.page.accounts.remarkCleared"),
      );
      return true;
    } catch (e) {
      toast.error(t("trae.page.accounts.remarkSaveFailed"), { description: api.asError(e) });
      return false;
    }
  }

  /**
   * 单账号签到（卡片菜单里的「手动签到」，与 WorkBuddy 卡片的同名菜单项对齐）。
   *
   * 与 `batchCheckin` 的差别只有范围：走 `scope: "selected"` + 当个 `userId`，
   * 与「全部签到」共用同一条后端路径、同一套跳过与冷却规则 ——
   * **不为单账号另开旁路**，否则「整批签到会跳过它、单独点却签了」这类不一致
   * 迟早出现，且两个入口的说辞会互相矛盾。
   *
   * 不走 `run()`：批量动作统一报「××完成」够用，但单账号签到的结果有三种真实形态
   * （签到成功 / 今天已签 / 失败），用户点一下就该直接看到是哪一种，
   * 而不是先收到一句通用的「签到完成」、再自己到底下那张结果卡里找答案。
   */
  async function checkinOne(account: TraeAccount) {
    const label = account.name || account.userId;
    setBusy(`checkin-${account.userId}`);
    try {
      const result = await api.traeCheckin({
        scope: "selected",
        userIds: [account.userId],
        variant,
      });
      setReport(result);
      const outcome = result.results[0];
      if (!outcome) {
        // 一条结果都没有 = 该账号在计划阶段就被跳过（今日已签 / 冷却中 / 凭据过期）。
        // 如实说「没有执行」，不要为了好看谎报成功。
        toast.info(t("trae.page.accounts.checkinNotRun"), {
          description:
            result.warnings[0] ??
            t("trae.page.accounts.checkinSkippedDesc", { name: label }),
        });
      } else if (outcome.action === "skip_already") {
        toast.success(t("trae.page.accounts.alreadyCheckedToday"), { description: label });
      } else if (!outcome.ok) {
        toast.error(t("trae.page.accounts.checkinFailed"), {
          description: t("trae.page.accounts.checkinFailedDesc", {
            name: label,
            reason: outcome.message || outcome.action,
          }),
        });
      } else {
        toast.success(t("trae.page.accounts.checkinSuccess"), {
          description:
            outcome.delta > 0
              ? t("trae.page.accounts.checkinSuccessDesc", { name: label, delta: outcome.delta })
              : label,
        });
      }
      /* 签到成功是「今日已签到」的**确定性事实**：就地更新签到状态快照，
         别让用户点完「签到」还看着刷新时刻留下的「未签到」。 */
      markCheckinMapChecked(
        (result.results ?? []).filter((row) => row.ok && row.userId).map((row) => row.userId),
      );
      await loadAll();
      /* 抽屉开着时同步重取签到流水：签到历史读的是**结构化流水 + 积分明细**，
         不重取的话刚签完的那一行还停在旧结论（要关掉抽屉重开才更新）。 */
      if (detailAccount) loadDetailCheckinLogs(detailAccount);
    } catch (e) {
      toast.error(t("trae.page.accounts.checkinFailed"), { description: api.asError(e) });
    } finally {
      setBusy(null);
    }
  }

  /** 导入本机账号：读客户端登录态里的 `Cloud-IDE-JWT`，已存在的账号就地覆盖刷新。 */
  async function importLocal() {
    if (importing) return;
    setImporting(true);
    try {
      // 把当前产品线传下去：Trae 多条产品线可同机并存，不传会让后端按「最近活跃」
      // 全局挑一条 —— 用户在 Trae Work 分区导入却可能读到 Trae CN 的目录，
      // 连报错文案都会说错产品线。
      //
      // 用已解析好的 `variant` 状态而不是 `env?.variant`：后者在 env 还没加载完时
      // 是 `null`，会让「用户抢在加载完成前点导入」落到默认变体上；
      // `variant` 初值就是默认变体、加载完成后被修正，语义更稳。
      const result = await api.traeImportLocalAccount(variant);
      const who = result.name || result.userId;
      toast.success(t("trae.page.accounts.importLocalDone"), {
        description: result.userId
          ? t("trae.page.accounts.importLocalUid", { name: who, uid: result.userId.slice(-6) })
          : who,
      });
      await loadAll();
    } catch (e) {
      toast.error(t("trae.page.accounts.importLocalFailed"), { description: api.asError(e) });
    } finally {
      setImporting(false);
    }
  }

  /**
   * P4：勾选 / 详情入口 / 最小批量动作（与 WorkBuddy 账号页同构）。
   *
   * 选择集按 `userId`（身份）记账：Trae 账号改名不改身份，按 `name` 记账会在改名后失配。
   */
  function toggleSelect(account: TraeAccount) {
    const key = selectionKey(account.userId);
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
   * P4：区域变化时清空勾选（同 WorkBuddy 账号页）。
   *
   * `selectedKeys` 是组件 state，切区域只改 URL `?line=`、**不 remount** ⇒ 选择集跨区域残留：
   * 批量条显示「已选 N」，而 `targets = accounts.filter(selectedKeys)` 恒为 0（动作静默无操作）。
   *
   * 用 effect 监听 `variant` 变化来清，而不是去接管区域 setter —— 后者是「页面内切区域」的能力，
   * P3 已明确不该有。
   */
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [variant]);

  /**
   * 请求把账号切到指定 Trae 产品线：**先走统一重启确认**（TraeWork / TraeCode 需先关再开），
   * 真正的切换在确认框的 `onConfirm` 里调 `doSwitchTo`。
   *
   * ★ 抽成具名函数：卡片与抽屉（「切换到此账号」）必须是**同一条**流程 ——
   * 两处各写一遍内联箭头，迟早出现「卡片会确认、抽屉直接切」的分叉。
   *
   * ⚠️ `label` 必须由调用方传入（取自后端 `TraeProgramStatus.label`），**不要**用
   * `traeVariantLabel(programVariant)` 反推：合并版 `trae` 与遗留 `trae_code`
   * **共用变体** `trae_cn`，反推会把合并版说成 `TraeCode`（issue #20 报障）。
   */
  function requestSwitchTo(account: TraeAccount, programVariant: TraeVariantId, label: string) {
    setSwitchConfirm({
      userId: account.userId,
      variant: programVariant,
      label,
    });
  }

  /**
   * ★ 以下四个「单账号动作」抽成具名函数：卡片菜单与抽屉「操作」区必须是**同一段代码**。
   *
   * ⚠️ 它们原先全是卡片上的内联箭头。抽屉要复用就只能再抄一遍 ——
   * 而「同一动作两处实现」正是本仓反复出现的分叉来源（确认流程、保存登录态都栽过）。
   */
  async function refreshJwt(account: TraeAccount) {
    await run(`jwt-${account.userId}`, "trae.page.accounts.actionRefreshJwt", () =>
      api.traeRefreshJwt(account.userId, variant),
    );
  }

  /**
   * 单账号刷新积分（issue #44）。
   *
   * 此前卡片上的提示让用户「点右上角菜单『刷新积分』」，而菜单里没有该项；唯一能刷的路径是
   * 「全选 → 批量刷新 → 取消全选」。后端 `trae_refresh_credits` 本来就支持只传一个 `userId`
   * （批量刷新也是逐账号调它），因此这里直接复用同一接口，成本为零。
   *
   * ⚠️ 忙标记必须与卡片约定的 key 一致（`credits-<uid>`），否则按钮点了没转圈，
   * 用户会以为没生效而反复点。
   */
  /**
   * 本平台**真的能刷**的项 → 刷新菜单里能出现的项。
   *
   * ★ 2026-10-26（用户要求）：**`tokens` 不再进菜单**（与 WB 同步 —— 刷新菜单只放
   * 积分 / 签到状态 / 凭证状态 / 任务）。Trae 卡片上的「今日 Token」指标块仍带自己的
   * 刷新按钮，走的是同一个 `onRefreshPart(account, "tokens")`，所以 `tokens` 这个
   * kind 与其数据来源（`get_trae_account_token_today`，**只读**网关日志）都保留 ——
   * 只是不再作为菜单项出现。
   *
   * 其余两项的诚实边界：
   * - `checkin` → `get_trae_checkin_status_map`（**只读**上游状态端点）。本地台账只记
   *   「本工具签过谁」，用户在 IDE 里手动签时台账里没有 ⇒ 必须真去问上游。
   *   **绝不**借刷新之名触发 claim（那是写操作，走独立的「签到」入口）。
   */
  const TRAE_REFRESH_KINDS = ["credits", "checkin", "credential"] as const;
  const refreshBusy = useAccountRefreshBusy();

  /**
   * 「今日 Token」按账号（`get_trae_account_token_today`）—— 抽屉概览信息行的数据源
   * （打开抽屉时静默补一次，见 `loadDetailTokens`）。
   *
   * **缺席即「—」**：只存后端真的返回的账号，不给缺席的账号补 0。
   */
  const [todayTokens, setTodayTokens] = useState<Record<string, AccountTokenTodayEntry>>({});
  const [todayTokensTruncated, setTodayTokensTruncated] = useState(false);
  /**
   * 逐账号签到状态（`get_trae_checkin_status_map`）——**只覆盖被刷新过的账号**。
   *
   * 刻意不在进页面时全量拉：这要逐账号打上游（N 个账号 = N 次请求），
   * 而账号视图自带的 `checkedToday`（本地台账）足够画初值。用户点「刷新签到状态」
   * 才去问上游 —— 那一次是真值。
   */
  const [checkinMap, setCheckinMap] = useState<Record<string, CheckinStatusEntry>>({});

  /**
   * 把「本轮签到**确实成功**」的账号在 `checkinMap` 里就地置为已签到。
   *
   * ## 为什么必须就地改，而不是等下一次「刷新签到状态」
   *
   * `checkinMap` 是用户点过「刷新签到状态」后留下的上游快照，**优先级高于本地台账**
   * （`detailCheckinToday` / 卡片徽章都先读它）。签到成功只会写台账与积分明细，
   * 不会动这份快照 ⇒ 用户点完「签到」，同一屏上历史表已显示「成功 +100」，
   * 「今日签到」却还挂着刷新时刻的「未签到」—— 2026-10-27 用户报的正是这个组合。
   *
   * 只改**已有**的条目：没有条目时台账兜底本来就正确，不臆造一个半空的
   * 上游条目（`streakDays` 等字段编不出来）；`source` 改标 `"ledger"`，
   * 如实说明这个「已签到」是本工具刚写入的事实、不是上游回答。
   *
   * ★ 2026-10-27（用户复现）：旧条目 **`ok:false`**（上一次查询失败）也必须被替换 ——
   * 成功签到是**更新的事实**，优先级高于一条过期失败。此前只改 `ok` 条目 ⇒
   * 失败条目原样留着，抽屉优先读它 ⇒ 历史已显示「签到成功」，今日签到仍是「读不到」。
   * 失败条目没有可信统计字段，整体替换为「已签到 + ledger」，未知统计保持为空。
   */
  function markCheckinMapChecked(userIds: string[]) {
    if (userIds.length === 0) return;
    setCheckinMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const userId of userIds) {
        const entry = prev[userId];
        /* 没有上游条目 ⇒ **不写**：这里只修正已有快照，不凭空造一条上游条目。
           （「台账里已签到」由读侧 `detailCheckinToday` 自己优先取，不靠这里补。） */
        if (!entry) continue;
        /* 已经是「确认已签到」⇒ 不用重复改。 */
        if (entry.ok && entry.todayCheckedIn) continue;
        next[userId] = entry.ok
          ? /* 成功的上游条目只改签到事实，保留它已有的统计字段。 */
            { ...entry, todayCheckedIn: true, source: "ledger" }
          : /* 旧的失败条目整体替换：错误字段不能留，失败条目也没有可信统计。 */
            { ok: true, todayCheckedIn: true, source: "ledger" };
        changed = true;
      }
      return changed ? next : prev;
    });
  }

  /** 单项刷新（与卡片「更多」里的四项同源）。 */
  const onRefreshPart = useCallback(
    async (account: TraeAccount, kind: AccountRefreshKind) => {
      const label = displayText(account.name) || account.userId;
      /* ⚠️ 错误 toast 放在 `run` **外面**：任务抛错 ⇒ `run` 不亮「已更新」。
         此前 catch 在任务内部吞掉错误，失败项也会亮绿勾（错误提示旁挂着「已更新」）。 */
      try {
        await refreshBusy.run(account.userId, kind, async () => {
          if (kind === "credits") {
            await api.traeRefreshCredits(account.userId, variant);
            /* ★ 落盘后必须同步页面快照：卡片 / 表格读的是 `accounts` 与积分总览，
               不重取的话「刷新成功」只体现在 toast 上，数字还是旧的。
               快照读取失败也要让本轮算失败 —— 否则失败提示旁仍会亮「已更新」。 */
            const synced = await loadAllWithResult();
            if (synced.superseded) throw new SupersededRefreshError();
            if (!synced.ok) throw synced.error;
          } else if (kind === "tokens") {
            /* 一次调用取全部账号（网关日志是区域共用的），按 uid 落到 state。 */
            const today = await api.getTraeAccountTokenToday(variant, true);
            setTodayTokens(
              Object.fromEntries(today.accounts.map((entry) => [entry.uid, entry])),
            );
            setTodayTokensTruncated(today.gatewayTruncated);
          } else if (kind === "checkin") {
            /* 只问这一个账号（批量接口传 1 个 id 即可，不新增「单账号」变体）。 */
            const map = await api.getTraeCheckinStatusMap(variant, [account.userId]);
            setCheckinMap((prev) => ({ ...prev, ...map }));
            const current = map[account.userId];
            /* ★ 缺条目 = 没取得数据（账号已删 / 后端未回）⇒ 读取失败，不亮「已更新」。 */
            if (!current || !current.ok) throw new Error(current?.error ?? t("shared.refreshPart.fail"));
          } else {
            /* 凭据状态 = 重取账号元数据（JWT 有效期 / 需重登标记都在列表载荷里）。
               同样把快照读取失败抛给刷新状态管理层。 */
            const synced = await loadAllWithResult();
            if (synced.superseded) throw new SupersededRefreshError();
            if (!synced.ok) throw synced.error;
          }
          /* 单账号回执合成一行（同 AccountsPage 2026-10-23 调整）。 */
          toast.success(`${label}${t("shared.punct.colon")}${t(REFRESH_DONE_LABEL[kind])}`);
        });
      } catch (e) {
        /* 被后续刷新取代 ⇒ 不弹任何回执（`run` 也不会亮「已更新」）。 */
        if (e instanceof SupersededRefreshError) return;
        toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
      }
    },
    [refreshBusy, variant, loadAllWithResult, t],
  );

  function refreshCreditsOne(account: TraeAccount) {
    const name = displayText(account.name) || account.userId;
    void run(
      `credits-${account.userId}`,
      "trae.page.accounts.actionRefreshCredits",
      () => api.traeRefreshCredits(account.userId, variant),
      undefined,
      undefined,
      () => ({ level: "success" as const, description: name }),
    );
  }

  function clearCooldown(account: TraeAccount) {
    void run(`thaw-${account.userId}`, "trae.page.accounts.actionThaw", () =>
      api.traeClearCooldown(account.userId, variant),
    );
  }

  function requestDelete(account: TraeAccount) {
    setPendingDelete(account);
  }

  /** 「保存登录态」：目标是「该账号此刻登录着的那个程序位」（可能多条线同时登录）。 */
  function saveLogin(account: TraeAccount) {
    const targets = programsFor(account).filter((program) => program.current);
    if (targets.length === 0) {
      toast.error(t("trae.page.accounts.saveLoginNoProgram"), {
        description: account.name || account.userId,
      });
      return;
    }
    void run(`save-${account.userId}`, "trae.page.accounts.actionSaveLogin", async () => {
      let fileCount = 0;
      for (const program of targets) {
        const result = await api.traeSaveLogin(account.userId, program.variant);
        fileCount += result.fileCount;
      }
      return fileCount;
    });
  }

  /** 按账号与日期各取最新一条，避免全局日志上限截断近 7 天历史。 */
  function loadDetailCheckinLogs(account: TraeAccount) {
    const request = ++detailCheckinLogsRequest.current;
    setDetailCheckinLogs(null);
    void Promise.all(
      lastSevenDays().map((date) =>
        api.getTraeLogs({ kind: "checkin", variant, date, checkinUserId: account.userId, limit: 1 }),
      ),
    )
      .then((responses) => {
        if (request === detailCheckinLogsRequest.current) {
          setDetailCheckinLogs(responses.flatMap((response) => response.entries));
        }
      })
      .catch(() => {
        if (request === detailCheckinLogsRequest.current) setDetailCheckinLogs(null);
      });
  }

  /**
   * 概览「今日 Token」行：打开抽屉时静默补一次（`force=false`，后端按 TTL 决定是否重扫）。
   *
   * 每个区域每轮会话最多拉一次（卡片不展示 Token，页面快照里也没有这份数据）；
   * 失败不打扰，下次打开抽屉再试 —— 读不到就保持「—」，绝不补 0。
   */
  const detailTokensLoadedFor = useRef<string | null>(null);
  function loadDetailTokens() {
    if (detailTokensLoadedFor.current === variant) return;
    detailTokensLoadedFor.current = variant;
    void api
      .getTraeAccountTokenToday(variant, false)
      .then((res) => {
        setTodayTokens(Object.fromEntries((res.accounts ?? []).map((entry) => [entry.uid, entry])));
        setTodayTokensTruncated(Boolean(res.gatewayTruncated));
      })
      .catch(() => {
        detailTokensLoadedFor.current = null;
      });
  }

  /** 点卡片 / 表格行：打开抽屉。`tab` 非空 ⇒ 直达该页签（R10）。 */
  function openDetail(account: TraeAccount, tab: DrawerTab | null = null) {
    setDetailTab(tab);
    setDetailAccount(account);
    loadDetailCheckinLogs(account);
    loadDetailTokens();
  }

  /**
   * 批量签到：走 `scope: "selected"`（与单账号同一后端路径），跑完重取快照并展开结果卡。
   *
   * 判定口径与 `checkinOne` 一致：全失败 ⇒ `error`；一轮没轮到任何账号 ⇒ 明说
   * 「没有需要签到的账号」；其余按后端报告拼「成功 / 已签 / 失败」三段。
   *
   * ★ B4：部分失败时**把失败项留在 toast 的 action 里** ⇒ 可「只重试失败项」。
   *   原实现只汇总 `result.failed` 计数、**不保留失败 id**，Trae 用户只能把成功的一起重跑。
   *   （WB 侧 `AccountsPage::batchCheckin` 早已对齐，`runCheckinFor` 返回 `failedIds`。）
   * @param userIds 省略 = 对当前勾选项跑；传入 = 只对这批（重试路径）。
   */
  async function batchCheckin(userIds?: string[]) {
    if (batchBusy) return;
    const targets = userIds
      ? accounts.filter((account) => userIds.includes(account.userId))
      : accounts.filter((account) => selectedKeys.has(selectionKey(account.userId)));
    if (targets.length === 0) return;
    setBatchBusy(true);
    const label = t("trae.page.accounts.actionBatchCheckin");
    /* ★ 任务 id + 进度：签到是后端一次批处理，取消走 traeCheckinCancel(taskId)（只拦未开始项）。 */
    const taskId = `trae-checkin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    checkinTaskIdRef.current = taskId;
    setBatchProgress({ done: 0, total: targets.length });
    try {
      const result = await api.traeCheckin({
        scope: "selected",
        userIds: targets.map((account) => account.userId),
        taskId,
        variant,
      });
      setReport(result);
      /* 与单账号签到同一条规则：成功的账号就地置为已签到，
         不让签到状态快照继续说上一轮刷新时刻的「未签到」。 */
      markCheckinMapChecked(
        (result.results ?? []).filter((row) => row.ok && row.userId).map((row) => row.userId),
      );
      /* ★ 结果**留在页面上**（原型 `checkinResult`），与 WorkBuddy 同一形状同一位置。 */
      /* ★ 「未处理」由**后端**给出：只含计划内未执行的账号（取消）；
         被策略跳过（已签到 / 过期 / 冷却）的账号不在其中 —— 正常完成的一批不该出现未处理项。 */
      const unprocessedIds = result.unprocessedIds ?? [];
      const failedIds = (result.results ?? [])
        .filter((row) => !row.ok && row.userId)
        .map((row) => row.userId);
      setCheckinResult({
        ok: result.totalOk + result.already,
        failedIds,
        unprocessedIds,
      });
      const parts: string[] = [];
      if (result.totalOk > 0) parts.push(t("trae.page.accounts.checkinBatchSuccess", { n: result.totalOk }));
      if (result.already > 0) parts.push(t("trae.page.accounts.checkinBatchAlready", { n: result.already }));
      if (result.failed > 0) parts.push(t("trae.page.accounts.checkinBatchFailed", { n: result.failed }));
      const description = parts.join(t("shared.punct.comma"));
      /* 重试名单 = 失败 + 未处理（取消后没开始的）；已成功 / 被策略跳过的不重试。 */
      const retryIds = [...failedIds, ...unprocessedIds];
      const retryAction =
        result.total > 0 && retryIds.length > 0
          ? {
              label: t("trae.page.accounts.checkinRetryFailed"),
              onClick: () => void batchCheckin(retryIds),
            }
          : undefined;
      /* ★ 判定顺序：取消（仍有未处理）⇒ 全失败 ⇒ 成功。取消绝不能报「完成」。 */
      if (result.total === 0) {
        if (aliveRef.current) toast.success(t("trae.page.accounts.noNeedCheckin"));
      } else if (unprocessedIds.length > 0) {
        if (aliveRef.current) {
          toast.warning(t("shared.batch.cancelled", { n: unprocessedIds.length }), {
            description,
            action: retryAction,
          });
        }
      } else if (result.failed === result.total) {
        if (aliveRef.current) toast.error(t("trae.page.accounts.actionFailed", { label }), { description, action: retryAction });
      } else {
        if (aliveRef.current) toast.success(t("trae.page.accounts.actionDone", { label }), { description, action: retryAction });
      }
      await loadAll();
      if (detailAccount) loadDetailCheckinLogs(detailAccount);
    } catch (e) {
      if (aliveRef.current) toast.error(t("trae.page.accounts.actionFailed", { label }), { description: api.asError(e) });
    } finally {
      checkinTaskIdRef.current = null;
      setBatchProgress(null);
      setBatchBusy(false);
    }
  }

  /**
   * 批量执行器（与 WorkBuddy / Qoder **同一档位**：并发 3 + 间隔 150ms）。
   * 返回与入参同序同长；被取消而没跑的项是 `undefined`（缺席 ≠ 失败）。
   */
  async function runBatch<T, R>(targets: T[], worker: (item: T) => Promise<R>): Promise<(R | undefined)[]> {
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setBatchProgress({ done: 0, total: targets.length });
    try {
      return await mapWithConcurrency(targets, worker, {
        concurrency: 3,
        gapMs: 150,
        signal: controller.signal,
        onProgress: (done, total) => setBatchProgress({ done, total }),
      });
    } finally {
      batchAbortRef.current = null;
      setBatchProgress(null);
    }
  }

  /**
   * 批量**只读刷新**积分：逐账号走**单账号**接口（无批量端点），跑完重取快照。
   *
   * ★ 走并发池而非串行：20 个账号的串行刷新是分钟级等待，且界面上只有一个转圈。
   * 结果区分成功 / 失败 / 未处理（取消）；全部失败才报 error。
   */
  async function batchRefresh() {
    if (batchBusy) return;
    const targets = accounts.filter((account) => selectedKeys.has(selectionKey(account.userId)));
    if (targets.length === 0) return;
    setBatchBusy(true);
    const label = t("trae.page.accounts.actionRefreshCredits");
    try {
      const outcomes = await runBatch(targets, async (account) => {
        try {
          await api.traeRefreshCredits(account.userId, variant);
          return true;
        } catch {
          return false;
        }
      });
      const ok = outcomes.filter((outcome) => outcome === true).length;
      const failed = outcomes.filter((outcome) => outcome === false).length;
      const unprocessed = outcomes.filter((outcome) => outcome === undefined).length;
      /* 无论成败都回读：成功的那批已经落盘。 */
      await loadAll();
      if (!aliveRef.current) return;
      if (failed === 0 && unprocessed === 0) {
        if (aliveRef.current) toast.success(t("trae.page.accounts.actionDone", { label }));
      } else if (ok === 0) {
        if (aliveRef.current) toast.error(t("trae.page.accounts.actionFailed", { label }), {
          description: unprocessed > 0 ? t("shared.batch.cancelled", { n: unprocessed }) : undefined,
        });
      } else {
        if (aliveRef.current) toast.warning(t("trae.page.accounts.quickRefreshPartial", { n: targets.length }), {
          description: t("trae.page.accounts.batchRefreshPartial", { ok, failed }),
        });
      }
    } finally {
      setBatchBusy(false);
    }
  }

  /** 批量「刷新签到状态」：一次调用问全部勾选账号（只读端点，不触发领取）。 */
  async function batchRefreshCheckin() {
    if (batchBusy) return;
    const targets = accounts.filter((account) => selectedKeys.has(selectionKey(account.userId)));
    if (targets.length === 0) return;
    setBatchBusy(true);
    try {
      const map = await api.getTraeCheckinStatusMap(variant, targets.map((account) => account.userId));
      setCheckinMap((prev) => ({ ...prev, ...map }));
      const failed = targets.filter((account) => !map[account.userId]?.ok).length;
      if (!aliveRef.current) return;
      if (failed === 0) toast.success(t("trae.page.accounts.quickRefreshDone", { n: targets.length }));
      else toast.warning(t("trae.page.accounts.quickRefreshPartial", { n: failed }));
    } catch (e) {
      if (aliveRef.current) toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
    } finally {
      setBatchBusy(false);
    }
  }

  /** 批量「刷新凭据状态」：只重取账号元数据（JWT 有效期 / 需重登标记都在列表载荷里）。 */
  async function batchRefreshCredential() {
    if (batchBusy) return;
    setBatchBusy(true);
    try {
      const result = await loadAllWithResult();
      if (!result.ok || result.superseded) throw result.error ?? new Error(t("shared.refreshPart.fail"));
      if (aliveRef.current) toast.success(t("trae.page.accounts.actionDone", { label: t("shared.cardMenu.refresh.credential") }));
    } catch (e) {
      if (aliveRef.current) toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
    } finally {
      setBatchBusy(false);
    }
  }

  /**
   * 批量**续期凭据**（写 `refresh_token`）：逐账号走 `trae_refresh_jwt`。
   *
   * 与只读刷新分开：这是写操作，重试名单**不含**已成功项（重复续期会白耗材料）。
   */
  async function batchRenewTokens() {
    if (batchBusy) return;
    const targets = accounts.filter((account) => selectedKeys.has(selectionKey(account.userId)));
    if (targets.length === 0) return;
    setBatchBusy(true);
    setRenewBusy(true);
    const label = t("trae.page.accounts.actionRefreshJwt");
    try {
      const outcomes = await runBatch(targets, async (account) => {
        try {
          await api.traeRefreshJwt(account.userId, variant);
          return true;
        } catch {
          return false;
        }
      });
      const ok = outcomes.filter((outcome) => outcome === true).length;
      const failed = outcomes.filter((outcome) => outcome === false).length;
      const unprocessed = outcomes.filter((outcome) => outcome === undefined).length;
      await loadAll();
      if (failed === 0 && unprocessed === 0) {
        if (aliveRef.current) toast.success(t("trae.page.accounts.actionDone", { label }));
      } else {
        if (aliveRef.current) toast.error(t("trae.page.accounts.actionFailed", { label }), {
          description: t("trae.page.accounts.batchRefreshPartial", { ok, failed }),
        });
      }
    } finally {
      setBatchBusy(false);
      setRenewBusy(false);
    }
  }

  /** 批量条「刷新」下拉的分派：只走读接口（续期凭据在独立按钮）。 */
  function batchRefreshPart(kind: AccountRefreshKind) {
    if (kind === "credits") void batchRefresh();
    else if (kind === "checkin") void batchRefreshCheckin();
    else void batchRefreshCredential();
  }

  /** 签到状态的显式取值（与卡片标签同源：上游读数优先，回落列表快照）。 */
  function checkinStateOf(account: TraeAccount): AccountCheckinState {
    const entry = checkinMap[account.userId];
    if (entry) {
      if (!entry.ok) return { kind: "unreadable", reason: entry.error };
      return entry.todayCheckedIn ? { kind: "checked" } : { kind: "unchecked" };
    }
    return account.checkedToday ? { kind: "checked" } : { kind: "unchecked" };
  }

  /**
   * 单账号「更多」菜单 —— **卡片页脚与表格行尾消费同一份**（R07/R09）。
   *
   * 平台差异全部以数据表达：签到状态值、平台扩展动作（保存登录态 / 解除冷却）。
   */
  function renderAccountMenu(account: TraeAccount, compact = false) {
    if (api.isDemoMode()) return <AccountMoreMenuDemo />;
    const canSaveLogin = programsFor(account).some((program) => program.current);
    return (
      <AccountMoreMenu
        accountName={displayText(account.name) || account.userId}
        compact={compact}
        onRefreshPart={(kind) => void onRefreshPart(account, kind)}
        refreshKinds={TRAE_REFRESH_KINDS}
        refreshingKinds={refreshBusy.kindsOf(account.userId)}
        doneKinds={refreshBusy.doneKindsOf(account.userId)}
        /* 续期凭据 = 用 refresh_token 换新 JWT（写操作）。返回 Promise，菜单忙态才准。 */
        onRefresh={() => refreshJwt(account)}
        refreshingToken={busy === `jwt-${account.userId}`}
        checkinState={checkinStateOf(account)}
        onCheckin={() => checkinOne(account)}
        onSwitch={() => openDetail(account)}
        onExport={() => {
          setExportTargets([account]);
          setExportOpen(true);
        }}
        extraActions={[
          {
            id: "save-login",
            label: t("trae.comp.card.menu.save"),
            icon: <Save className="size-4" />,
            disabled: !canSaveLogin,
            title: canSaveLogin ? t("trae.comp.card.action.saveTip") : t("trae.comp.card.action.saveNoLogin"),
            busy: busy === `save-${account.userId}`,
            onSelect: () => saveLogin(account),
          },
          /* 冷却中的账号才需要「解除冷却」；没有冷却时该项不出现（不摆永远无效的入口）。 */
          ...(account.cooldownType
            ? [
                {
                  id: "clear-cooldown",
                  label: t("trae.comp.card.menu.thaw"),
                  icon: <CircleSlash className="size-4" />,
                  busy: busy === `thaw-${account.userId}`,
                  onSelect: () => clearCooldown(account),
                },
              ]
            : []),
        ]}
        onDelete={() => requestDelete(account)}
      />
    );
  }

  /**
   * 页头「一键刷新」：把**卡片上能看到的读数**刷到最新 —— 积分 / 签到状态 / 凭据状态。
   *
   * 与「批量刷新」的分工照 PLAN §3.4：一键作用于**全部账号**、只做只读刷新；
   * 批量作用于**勾选账号**、允许写操作。两者的按钮位置与文案也不同（页头 vs 勾选条）。
   *
   * ★ 2026-10-27（用户报障「刷新后积分还是旧值」）：**顺序**是这里的关键 ——
   * 积分刷新与签到查询可以并行，但账号快照必须在**积分刷新结束之后**再读。
   * 此前三项 `allSettled` 并行 ⇒ 快照先回来、积分后落盘 ⇒ 刷新结束仍显示旧值。
   * 积分部分失败时同样要回读（成功的那批已落盘，不能因为另一批失败就不显示）。
   *
   * 结果按**层**判定（成功 / 部分失败 / 失败），三层全失败才报整体失败；
   * 快照读取失败也计入 —— 否则错误提示旁仍会亮起「已刷新 N 个账号」。
   */
  async function quickRefreshAll(): Promise<boolean> {
    if (batchBusy || quickActionBusy || accounts.length === 0) return false;
    /* 前置校验 + **立即占位**：
       - 校验挡住「切页回来、按钮暂时可点」的重复请求；
       - 占位是必要的、不是冗余：按钮的 `coolingDown` 来自 state，state 在下一轮渲染才生效，
         连点两次时第二次进到这里，第一次的 await 还没结束 —— 只有写进模块级表才拦得住。
         完成后 `QuickRefreshAction` 会按**发起时的作用域**再写一次（起点因此落在「结束」）。 */
    if (quickRefreshCoolingDown(scope)) return false;
    startQuickRefreshCooldown(scope);
    setQuickActionBusy("refresh");
    try {
      const ids = accounts.map((account) => account.userId);
      /* 积分（批量端点）与签到状态（一次批量查询）互不依赖 ⇒ 并行。 */
      const [credits, checkin] = await Promise.allSettled([
        /* 不传 userId = 该产品线全部（后端有批量端点，不必逐账号）。 */
        api.traeRefreshCredits(undefined, variant),
        api.getTraeCheckinStatusMap(variant, ids),
      ]);
      if (checkin.status === "fulfilled") {
        setCheckinMap((prev) => ({ ...prev, ...checkin.value }));
      }
      /* 必须在积分落盘**之后**读快照；积分请求失败也要回读（部分成功的账号已更新）。 */
      const snapshotResult = await loadAllWithResult();

      const creditsOutcome: RefreshLayerOutcome =
        credits.status === "rejected"
          ? "fail"
          : credits.value.total == null || credits.value.failed == null
            ? credits.value.refreshed > 0
              ? "ok"
              : "fail"
            : credits.value.total === 0 || credits.value.failed === 0
              ? "ok"
              : credits.value.failed >= credits.value.total
                ? "fail"
                : "partial";

      const checkinEntries = checkin.status === "fulfilled" ? Object.values(checkin.value) : [];
      const checkinFailed = checkinEntries.filter((entry) => !entry.ok).length;
      const checkinMissing = Math.max(0, ids.length - checkinEntries.length);
      const checkinOutcome: RefreshLayerOutcome =
        checkin.status === "rejected"
          ? "fail"
          : checkinFailed === 0 && checkinMissing === 0
            ? "ok"
            : checkinFailed + checkinMissing >= ids.length
              ? "fail"
              : "partial";

      /* 快照被后发请求取代时，既不是成功也不是失败：本轮结论不可得，按「部分失败」处理，
         避免把过期结果说成「已刷新」。 */
      const snapshotOutcome: RefreshLayerOutcome = snapshotResult.superseded
        ? "partial"
        : snapshotResult.ok
          ? "ok"
          : "fail";
      const outcomes = [creditsOutcome, checkinOutcome, snapshotOutcome];
      /* ★ 与 `batchRefresh` / `batchRefreshCheckin` 同一守卫：切产品线即卸载，
         上一条产品线的「已刷新」不该出现在新页面上。返回 `true` 而非 `false` ——
         上游请求确实打过了，仍应进冷却，否则切回来可以立刻重刷。 */
      if (!aliveRef.current) return true;
      if (outcomes.every((outcome) => outcome === "ok")) {
        toast.success(t("trae.page.accounts.quickRefreshDone", { n: ids.length }));
      } else if (outcomes.every((outcome) => outcome === "fail")) {
        toast.error(t("trae.page.accounts.quickRefreshFail"));
      } else {
        /* 部分失败：**不报成全部成功**，也不报成全部失败 —— 说清有一层没拿到。 */
        toast.warning(t("trae.page.accounts.quickRefreshPartial", { n: ids.length }));
      }
      return true;
    } finally {
      setQuickActionBusy(null);
    }
  }

  /** 页头「一键签到」：对**全部账号**跑签到（后端先查状态，已签的自动跳过）。 */
  async function quickCheckinAll() {
    if (batchBusy || quickActionBusy || accounts.length === 0) return;
    setQuickActionBusy("checkin");
    try {
      /* 复用批量的执行与文案 —— 差别只在「谁来选账号」，不该有两套签到实现。 */
      await batchCheckin(accounts.map((account) => account.userId));
    } finally {
      setQuickActionBusy(null);
    }
  }

  /** Trae 账号的撤销 toast 副标题（过 `displayText` 白屏防线；全空则不显示副标题）。 */
  function traeUndoLabel(account: TraeAccount): string | undefined {
    return displayText(account.name) || displayText(account.userId) || undefined;
  }

  /**
   * 抽屉里的**分组编辑**（★ 2026-10-26 用户报障「没有分组功能」）。
   *
   * Trae 的分组是**实体**（`groupId` + `TraeGroup{name,color,order}`），不像 WB 那样是自由文本
   * ⇒ 抽屉给的「组名」要先落到 id 上：已有同名组就复用，没有就先 `create` 再 `move`。
   * 空串 = 移出分组（`groupId` 传 `null`）。
   *
   * 三个动作都走 `trae_group_op`（后端唯一入口），成功后 `loadAll()` 让列表与抽屉同时刷新 ——
   * 与备注保存同一套「先落库、再同步界面」的做法。
   */
  async function saveGroupFor(account: TraeAccount, name: string): Promise<boolean> {
    const target = name.trim();
    try {
      let groupId: string | null = null;
      if (target) {
        const existing = groups.find((group) => group.name === target);
        if (existing) {
          groupId = existing.id;
        } else {
          const created = await api.traeGroupOp("create", { name: target }, variant);
          groupId = created.id ?? null;
          if (!groupId) {
            toast.error(t("trae.page.accounts.groupCreateFailed"));
            return false;
          }
        }
      }
      await api.traeGroupOp("move", { userId: account.userId, groupId }, variant);
      await loadAll();
      toast.success(t("trae.page.accounts.groupSaved", { name: target || t("trae.page.accounts.groupNone") }));
      return true;
    } catch (e) {
      toast.error(api.asError(e));
      return false;
    }
  }

  /**
   * 删除成功后弹「已删除 · 撤销」（P6 T04 §1.4）—— Trae 侧。
   *
   * ★ 撤销走 `api.accountRestore`（**与回收站同一命令**）。Trae 账号的稳定键是 `userId`
   * （不是 `id` / `uid`）。恢复后 `loadAll()` 重取快照，否则「撤销了却看不到账号回来」。
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
        await loadAll();
        if (firstError) throw firstError;
      },
    });
  }

  /**
   * 单账号删除（软删除）→ 弹「已删除 · 撤销」。
   *
   * **不复用 `run`**：`run` 会额外弹一条通用「{label}完成」成功 toast，与撤销 toast 语义
   * 重复（用户会看到两条）。这里自己管忙标记 / 错误 / 重取，语义与批量删除一致。
   */
  async function performDelete(target: TraeAccount) {
    setBusy(`delete-${target.userId}`);
    try {
      await api.traeDeleteAccount(target.userId, false, variant);
      offerUndo([target.userId], traeUndoLabel(target));
      await loadAll();
    } catch (e) {
      toast.error(t("trae.page.accounts.actionFailed", { label: t("trae.page.accounts.actionDelete") }), {
        description: api.asError(e),
      });
    } finally {
      setBusy(null);
    }
  }

  /** 批量删除（先确认）：逐个删除，任一个失败不阻断其余；删完清空选择。 */
  async function batchDelete() {
    if (batchBusy) return;
    const targets = accounts.filter((account) => selectedKeys.has(selectionKey(account.userId)));
    setBatchDeleteOpen(false);
    if (targets.length === 0) return;
    setBatchBusy(true);
    const label = t("trae.page.accounts.actionDelete");
    try {
      const deleted: TraeAccount[] = [];
      let failed = 0;
    for (const account of targets) {
        try {
          await api.traeDeleteAccount(account.userId, false, variant);
          deleted.push(account);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        toast.error(t("trae.page.accounts.actionFailed", { label }), { description: `${failed}` });
      }
      clearSelection();
      await loadAll();
      if (deleted.length > 0) {
        offerUndo(
          deleted.map((account) => account.userId),
          deleted.length === 1 ? traeUndoLabel(deleted[0]) : undefined,
        );
      }
    } finally {
      setBatchBusy(false);
    }
  }

  const accounts = overview?.accounts ?? [];
  const groups = overview?.groups ?? [];

  /**
   * 该账号是不是**当前登录**（卡片头部高亮 + 幽灵 logo + 「当前登录」徽章 + 左侧竖条）。
   *
   * ## ★ 为什么不是 `logins[variant]`（2026-10-10 修的真实缺陷）
   *
   * `logins` 的键是**程序位标识**（`trae_work` / `trae_cn` / `global` / `global_trae_code`），
   * 而 `variant` 是**区域**（`cn` / `global`）。原实现写 `logins[variant]` ⇒
   * 只有「区域名恰好等于某个程序位标识」时才能查到 —— 国际版有个程序位就叫 `global`，
   * 所以那边**碰巧**正常；**国内版两个程序位叫 `trae_work` / `trae_cn`，永远查不到**
   * ⇒ 国内版作用域下**没有任何一张卡**会亮「当前登录」。
   *
   * 实测（`build:demo`，同一份数据）：`/s/trae-global/accounts` 主号卡有徽章 + 竖条；
   * `/s/trae-cn/accounts` 三张卡全无。
   *
   * 现改为**逐程序位判定**（`programsFor(account).some(p => p.current)`）——
   * 与 WorkBuddy 卡片 `isCurrentAccount`（「绑定任一程序位即当前」）**同一口径**，
   * 也与抽屉的 `detailIsCurrent` 同一实现。`logins[program.variant]` 的键是对得上的。
   */
  /* 用函数声明（与 `programsFor` 同形）而不是 `useCallback`：
     它只在渲染期被调用，包成 hook 反而要处理 `programsFor` 的依赖身份（每渲染都变）。 */
  function isCurrentAccount(account: TraeAccount): boolean {
    return programsFor(account).some((program) => program.current);
  }
  const switchBusy = busy?.startsWith("switch-") ?? false;

  /**
   * 该账号在**每条 Trae 程序**上的状态 —— 卡片上那排切换按钮的数据源。
   *
   * 与 WorkBuddy 卡片的 `workbuddyActive` / `codebuddyCnIdeActive` / `codebuddyCliActive`
   * 是同一层语义：先在本页把「有哪些程序、各自装没装、这个账号是不是它当前的账号」
   * 算清楚，卡片只负责画。**判断不下沉到卡片里** —— 否则同一账号会被各卡片各算一遍，
   * 迟早与状态条、详情弹窗的口径出现分歧。
   */
  function programsFor(account: TraeAccount): TraeProgram[] {
    // ★ 2026-10-10（**用户要求，决策反转**）：**只取当前区域**的程序位。
    //
    //   原设计（P4 §1.4 / §5）是「跨区域常显 + 显示层消歧」：任意区域页面上都列出 4 个程序位，
    //   跨区域那两枚可见但不可直接切（点了只是**引导切区域**）。实际效果是国内版页面上
    //   一直挂着「TraeWork AI 国际版 / Trae AI 国际版」两枚按钮 —— 用户明确要求
    //   **国内版不显示国际版的**。
    //
    //   改成本区域之后反而更自洽：账号库本就按区域分家（跨库切换会被后端守卫拒绝），
    //   所以本区域页面只该谈本区域的客户端；要管另一条产品线，切作用域即可（顶栏 `ScopeSwitch`）。
    //
    //   ⚠️ **仍然禁止按 `program` 去重**：`TraeProgramStatus.program` 不含区域，
    //      按它去重会把 `(cn, trae_work)` 与 `(global, trae_work)` 合并、丢掉「该写哪个客户端」。
    //      `variant`（区域限定）才是切换目标、天然唯一。
    return variantStatuses
      .filter((status) => status.variant === variant)
      .flatMap((status) =>
      status.programs.map((program) => ({
        // 来源区域（= 当前区域）。保留字段：抽屉徽标的 key 用它，且它标明「这个程序位属于哪条线」。
        region: status.variant,
        // 切换目标（区域限定）—— 真正喂给 `api.traeSwitchAccount` 的值。
        variant: program.variant,
        // 程序位标识（不含区域）：**只用于卡片按钮的可见短名**（`Work` / `Code`）。
        // ⚠️ 绝不参与去重 —— 它不含区域，按它去重会丢掉「该写哪个客户端」。
        program: program.program,
        label: program.label,
        installed: program.installed,
        // ★ 「装了」不等于「能用」：客户端从未启动过时它的 userData 目录压根不存在
        //   （本机：`Trae CN.exe` 装着、`%APPDATA%\Trae CN` 没有）⇒ 快照存不出也恢复不进，
        //   这个程序位上的切换**永远不可能成功**。取**写侧**目录的存在性
        //   （`writeDataDirExists`，与后端保存 / 恢复用的是同一个 `snapshot_data_dir_for`），
        //   而不是读侧的 `dataDirExists` —— 后者在「一个变体多个候选目录」时会指向另一个目录。
        hasDataDir: program.writeDataDirExists,
        // 登录态是**客户端级**的：比的是 `userId`（身份）而不是 `name`（展示名）
        // —— 后者改名即失配。`logins` 读不到时是 `null`，不能让 `null` 与空 userId 相互匹配。
        current:
          Boolean(account.userId) && logins[program.variant]?.userId === account.userId,
      })),
      );
  }
  /**
   * **当前区域**的探测结果（含该区域的 `dataDir` / `dataDirExists`）。
   *
   * 与 `env`（`get_trae_env`）的区别是本质的：`env` 走后端 `detect_data_dir()`，
   * 那是**横跨全部产品线**的全局探测，只适合「环境自检」。拿它在区域页里显示目录，
   * 会出现「国际版页签写着 `TRAE SOLO CN`」，而且本机一个候选都不存在时它会回落到
   * 候选表首项 ⇒ 把一个**不存在**的路径说成「已探测的登录态目录」。
   * 按区域取的是后端 `platform::select_data_dir_for(variant)`，不存在就是 `null`。
   */
  const regionStatus = variantStatuses.find((item) => item.variant === variant);

  /**
   * 「客户端环境」那一行要用的**本区域**客户端状态。
   *
   * ## ★ 为什么不能再用 `env`（`get_trae_env`）—— 用户报障现场
   *
   * `env` 是后端 `detect_data_dir()` / `detect_install()` 的**跨变体**全局探测
   * （按活跃度、首个命中挑一条线），只适合「环境自检」。放在区域页上它会**报错产品线**：
   * 本机实测国内版页签显示的是**国际版**客户端 —— `v1.107.1` +
   * `C:\...\AppData\Roaming\TRAE SOLO`，而该目录属 `packageType = SOLO_I18N`
   * （国际版）；真正装着登录态的是 `TRAE SOLO CN`（`SOLO_CN`）。
   *
   * ## 取「该区域的主程序」而不是区域级汇总
   *
   * 与状态条的登录态同源（`programs[0]`）。区域级汇总里的 `dataDir` 是**最近活跃**目录，
   * 而本行要核对的是「登录态在哪」⇒ 用**写侧**目录 `writeDataDir`
   * （与后端 `overview_for().dataDir` 同源）。本机两者不同值：
   * `writeDataDir` = `TRAE SOLO CN`（有登录态）、`dataDir` = `TRAE SOLO`（国际版、更活跃）。
   */
  function groupNameOf(account: TraeAccount): string | null {
    if (!account.groupId) return null;
    return groups.find((group) => group.id === account.groupId)?.name ?? t("trae.page.accounts.fallbackGroup");
  }

  /** 账号展示名（表格 / 无障碍标签共用；过 `displayText` 归一，防脏值白屏）。 */
  const traeAccountName = (account: TraeAccount): string =>
    displayText(account.name) || `UID · ${displayText(account.userId) ?? "—"}`;

  /** Trae 账号可用积分（`remainingCredits` 优先，回落 `credits`）。 */
  const traeCredits = (account: TraeAccount): number => account.remainingCredits ?? account.credits ?? 0;

  /**
   * 列表视图配置 —— 平台差异**全部以数据表达**（`P4-TOOLBAR-ARCH §3.1`）。
   *
   * ⚠️ **与设计稿的一处不一致（已报告 lead）**：设计 §1.5 / 决策 #3 称「Trae 有 `lastUsedAt`
   * （`trae-types.ts:796`）⇒ 排序 4 项」，但该行是 **`TraeApiKeyRecord.lastUsedAt`**（API Key
   * 记录），**不是 `TraeAccount` 的字段**。`TraeAccount` 只有 `addedAt` / `updatedAt`，没有
   * 「最近使用」口径。按决策 #3 自己的规则（**无数据不渲染**），Trae 的排序键与 WB 一致为 3 项。
   */
  const listConfig = useMemo<AccountListConfig<TraeAccount>>(() => {
    const priorityComparator: AccountComparator<TraeAccount> = (left, right) => {
      // 「积分优先级」：**快过期先用**（到期近的靠前），同到期再按剩余积分多的靠前。
      const leftExpiry = left.creditsExpireAt ?? Number.POSITIVE_INFINITY;
      const rightExpiry = right.creditsExpireAt ?? Number.POSITIVE_INFINITY;
      if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
      return traeCredits(right) - traeCredits(left);
    };
    const nameComparator: AccountComparator<TraeAccount> = (left, right) =>
      traeAccountName(left).localeCompare(traeAccountName(right), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    const expiryComparator: AccountComparator<TraeAccount> = (left, right) =>
      (left.creditsExpireAt ?? Number.POSITIVE_INFINITY) - (right.creditsExpireAt ?? Number.POSITIVE_INFINITY);
    return {
      searchText: (account) =>
        accountSearchText({
          name: displayText(account.name),
          uid: displayText(account.userId),
          remark: displayText(account.remark),
          group: groupNameOf(account),
        }),
      comparators: { priority: priorityComparator, name: nameComparator, expiry: expiryComparator },
      bucketKey: (account, key) => {
        if (key === "program") {
          const labels = programsFor(account)
            .filter((program) => program.current)
            .map((program) => displayText(program.label) ?? traeVariantLabel(program.variant));
          return labels.length > 0 ? labels.join(" + ") : t("trae.page.accounts.toolbar.programBucket.unbound");
        }
        if (key === "status") {
          // 状态集**各平台自备**（决策 #8）：Trae 有「冷却」等独有状态，不强行与 WB 统一。
          // 签到态走 `checkinTodayOf`（与徽章同源）：只看快照的话，刷新过签到状态后
          // 行里的徽章说「已签到」、分桶却把它归进「未签到」。
          if (account.cooldownType) return t("trae.page.accounts.toolbar.statusBucket.cooling");
          if (account.jwtStatus === "expired") return t("trae.page.accounts.toolbar.statusBucket.expired");
          if (!checkinTodayOf(account)) return t("trae.page.accounts.toolbar.statusBucket.notCheckedIn");
          return t("trae.page.accounts.toolbar.statusBucket.normal");
        }
        if (key === "group") return groupNameOf(account) ?? t("trae.page.accounts.toolbar.groupBucket.default");
        return null;
      },
      availableSorts: ["priority", "name", "expiry"],
      availableGroups: ["none", "program", "status", "group"],
    };
    // `programsFor` / `groupNameOf` / `checkinTodayOf` 读 `variantStatuses` / `logins` / `groups`
    // / `checkinMap`，故一并入依赖。
  }, [t, groups, variantStatuses, logins, checkinMap]);

  /** 筛选（搜索）→ 排序 → 分桶；视图参数全部留在页内。 */
  const filtered = filterAccounts(accounts, listConfig, query);
  const sorted = sortAccounts(filtered, sort, listConfig);
  const buckets = groupAccounts(sorted, group, listConfig);

  /** 排序 / 分组下拉选项 —— 由 `availableSorts` / `availableGroups`（数据）驱动，无假选项。 */
  const sortLabels: Partial<Record<AccountSortKey, string>> = {
    priority: t("trae.page.accounts.toolbar.sort.priority"),
    name: t("trae.page.accounts.toolbar.sort.name"),
    expiry: t("trae.page.accounts.toolbar.sort.expiry"),
  };
  const groupLabels: Partial<Record<AccountGroupKey, string>> = {
    none: t("trae.page.accounts.toolbar.group.none"),
    program: t("trae.page.accounts.toolbar.group.program"),
    status: t("trae.page.accounts.toolbar.group.status"),
    group: t("trae.page.accounts.toolbar.group.group"),
  };
  const sortOptions: ToolbarOption[] = listConfig.availableSorts.flatMap((key) => {
    const label = sortLabels[key];
    return label ? [{ value: key, label }] : [];
  });
  const groupOptions: ToolbarOption[] = listConfig.availableGroups.flatMap((key) => {
    const label = groupLabels[key];
    return label ? [{ value: key, label }] : [];
  });

  /** 已勾选的账号（按当前列表顺序）—— 批量条的「导出」用它，与 WorkBuddy 同一口径。 */
  const selectedAccounts = useMemo(
    () => accounts.filter((account) => selectedKeys.has(selectionKey(account.userId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, selectedKeys, scope],
  );

  /** 全选：只作用于**当前可见**（筛选后）的行；与表头全选读写同一份 `selectedKeys`。 */
  const allVisibleSelected =
    sorted.length > 0 && sorted.every((account) => selectedKeys.has(selectionKey(account.userId)));
  const someVisibleSelected =
    !allVisibleSelected && sorted.some((account) => selectedKeys.has(selectionKey(account.userId)));
  function toggleVisibleSelection() {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const account of sorted) {
        if (allVisibleSelected) next.delete(selectionKey(account.userId));
        else next.add(selectionKey(account.userId));
      }
      return next;
    });
  }
  function bucketAllSelected(items: TraeAccount[]): boolean {
    return items.length > 0 && items.every((account) => selectedKeys.has(selectionKey(account.userId)));
  }
  function bucketSomeSelected(items: TraeAccount[]): boolean {
    return !bucketAllSelected(items) && items.some((account) => selectedKeys.has(selectionKey(account.userId)));
  }
  function toggleBucketSelection(items: TraeAccount[], checked: boolean) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const account of items) {
        if (checked) next.add(selectionKey(account.userId));
        else next.delete(selectionKey(account.userId));
      }
      return next;
    });
  }

  /** 「清除筛选」出口：复位搜索 + 分桶（`§1.9` 两种空态绝不混用）。 */
  function clearListFilters() {
    if (!hasActiveFilter({ query, group })) return;
    setQuery("");
    setGroup("none");
  }

  /**
   * Trae 状态徽标（表格「状态」列）。
   *
   * ★ 2026-10-27（用户报障「今日未签到，卡片和列表标签不一致」）：**整列直接复用卡片的
   * `TraeStatusChips`**，不再在这里另拼一套。此前这边自己写了一份：未签到是 secondary
   * 灰、无图标，卡片是 warning 琥珀 + 日历勾 ⇒ 同一账号在两个视图像两种状态；
   * 凭据过期也一样（卡片「凭据已过期」、列表「已过期」）。冷却中徽章同样收进共享组件，
   * 两个视图的标签集合从此完全一致。
   *
   * `checkinTodayOf`：用户点过「刷新签到状态」后，上游 `checkinMap` 优先于列表快照 ——
   * 只读快照会让列表停在刷新前的签到态，而卡片已经变了。
   */
  function renderStatusBadges(account: TraeAccount) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <TraeStatusChips account={account} checkedToday={checkinTodayOf(account)} />
      </div>
    );
  }

  /**
   * 表格列定义（`§1.8`）。**无「今日 Token」**（Trae 无该口径 —— 与 `traeStats` 的既有说明一致）。
   * 单元格全部返回**已归一**节点，**绝不返回对象**（对象当 React 子节点会白屏）。
   * ⚠️「程序位」列是**只读徽标**（无 `onClick`、无按钮）：表格行只有 2 个可点区。
   */
  const columns: AccountColumn<TraeAccount>[] = [
    {
      key: "account",
      header: t("trae.page.accounts.table.account"),
      render: (account) => (
        /* ★ 与 WorkBuddy 表格**同一结构**（原型 `tableView` `:2551`）：头像 + 名称行（含「当前」徽章）
           + 身份行。此前 Trae 侧没有头像 ⇒ 两个分区的表格首列不同形。 */
        <div className="flex min-w-0 items-center gap-2.5">
          <AccountsTableAvatar name={traeAccountName(account)} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium" title={traeAccountName(account)}>
                {traeAccountName(account)}
              </span>
              {/* ★ 2026-10-27（用户要求）：与卡片头部**同一枚**徽章 —— 同一文案
                  （`trae.comp.card.currentLogin`）与同一变体（`info` = primary 16% 底）。
                  此前列表写「当前」+ secondary（几乎无底色），看起来像另一种状态。 */}
              {isCurrentAccount(account) && (
                <Badge variant="info" className={ACCOUNT_CHIP_CLASS}>
                  {t("trae.comp.card.currentLogin")}
                </Badge>
              )}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">UID · {displayText(account.userId) ?? "—"}</div>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: t("trae.page.accounts.table.status"),
      render: (account) => renderStatusBadges(account),
    },
    /* ★ 2026-10-26（复刻 WB）：积分列 = **主行（剩余/总量）+ 副行（最急一批的到期）**，
       与卡片指标行同一份口径；原来的独立「到期」列随之下线 —— 两列都写「到期」，
       读者分不清哪一列是积分到期、哪一列是凭据到期（WB 侧 2026-10-23 就删过同一列）。 */
    {
      key: "credits",
      header: t("trae.page.accounts.table.credits"),
      align: "right",
      render: (account) => {
        /* ★ 2026-10-27（用户报障）：与卡片**同一份合并口径**（`traeCreditPackages`）。
           此前这里只读账号快照的 `creditPackages`，而逐包明细其实在 `get_trae_credits`
           的 `packages[uid]` 里 ⇒ 卡片有 `剩余/总数` 与到期金额，列表只剩剩余和到期时刻。 */
        const packages = traeCreditPackages(account, credits?.packages);
        const expiry = summarizeExpiry(packages, { unit: "s", now: Date.now() });
        const next = expiry?.batches[0] ?? null;
        const label = nextExpiryLabel(expiry, t);
        const tip = expiry ? expiryTooltipLines(expiry, t) : null;
        const total = traeCreditTotal({ creditPackages: packages });
        return (
          <div className="flex w-full flex-col items-end gap-0.5 text-right tabular-nums">
            <span className="whitespace-nowrap">
              {account.remainingCredits == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <>
                  <b className="font-semibold text-foreground">{formatCredits(account.remainingCredits)}</b>
                  {total === null ? null : (
                    <span className="text-muted-foreground">/{formatCredits(total)}</span>
                  )}
                </>
              )}
            </span>
            {next ? (
              <span
                className={cn(
                  "whitespace-nowrap text-[11px]",
                  isExpiryUrgent(next.expireAt) ? "text-warning" : "text-muted-foreground",
                )}
                title={
                  tip ? [tip.title, ...tip.lines, tip.more ?? ""].filter(Boolean).join("\n") : undefined
                }
              >
                {label}
              </span>
            ) : account.creditsExpireAt ? (
              /* ★ 与卡片同一兜底：没有包明细（`creditPackages` 为空）也要给出到期时刻，
                 否则「这个号会不会过期」在表格里根本看不出来。`creditsExpireAt` 是**秒**。 */
              <span
                className={cn(
                  "whitespace-nowrap text-[11px]",
                  isExpiryUrgent(account.creditsExpireAt * 1000) ? "text-warning" : "text-muted-foreground",
                )}
                title={t("trae.comp.card.expiryOnTip")}
              >
                {t("trae.comp.card.expiryOn", { date: shortTime(account.creditsExpireAt) })}
              </span>
            ) : null}
          </div>
        );
      },
    },
    /* ★ 2026-10-26（与 WorkBuddy 同批）：卡片当日补了「凭据到期」⇒ 表格同批补列，
       两边说法一致。⚠️ 与左边「到期」列（积分包到期）**不是同一件事**，列名必须分开。
       单元格走卡片导出的 `CredentialExpiryMeta`（同一份日期格式与缺值分支），
       不在这里另拼字符串；`showRefreshToken={false}` 同卡片理由（Trae 无该字段）。 */
    {
      key: "credential",
      header: t("trae.page.accounts.table.credential"),
      render: (account) => (
        <CredentialExpiryMeta
          account={{ expiresAt: traeJwtExpiryMs(account) }}
          showRefreshToken={false}
          layout="column"
        />
      ),
    },
    {
      key: "programs",
      header: t("trae.page.accounts.table.programs"),
      render: (account) => {
        const active = programsFor(account).filter((program) => program.current);
        return active.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {/* ★ 2026-10-27（用户要求）：与卡片页脚的当前程序位**同一枚胶囊**
                （`TraeCurrentProgramChip`：primary 18% 底 + primary 40% 描边 + ✓）。
                此前这里是 secondary 徽章，主题下几乎看不到底色。 */}
            {active.map((program) => {
              const label = displayText(program.label) ?? traeVariantLabel(program.variant);
              return (
                <TraeCurrentProgramChip key={`${program.region}:${program.variant}`} title={label}>
                  {label}
                </TraeCurrentProgramChip>
              );
            })}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
  ];

  // ---- 详情抽屉的数据装配（字段全部过 `displayText` 出口，见 display-text.ts）----
  /* 抽屉的**身份**仍是打开时的快照（`detailAccount`），但展示数据必须跟随列表：
     续期 JWT / 单项刷新只会替换 `accounts`，**不会回写** `detailAccount`。
     直接用快照会让凭据块的「JWT 有效期」永远停在打开抽屉那一刻 —— 用户点完只看到
     toast，下方数字不动（与 WorkBuddy 侧 2026-10-26 修的同一个 bug）。
     ⚠️ 找不到（账号被删）时回落到快照：抽屉已经开着，此时切空态比留旧值更突兀。 */
  const detail = detailAccount
    ? accounts.find((account) => account.userId === detailAccount.userId) ?? detailAccount
    : null;
  /**
   * ★ 2026-10-27：抽屉的逐包明细与卡片 / 表格走**同一份合并口径**（`traeCreditPackages`）。
   *
   * 账号视图（`list_account_views_for`）只带聚合积分，逐包明细在积分总览的
   * `packages[uid]` 里；而 `TraeAccount` 的 `creditPackages` 字段只在演示数据里存在。
   * 此前抽屉直接读 `detail.creditPackages` ⇒ 生产上恒为空 ⇒ 积分页是空态、指标块没有分母，
   * 同一账号在卡片上有 `剩余/总量`、在抽屉里只剩剩余（2026-10-27 用户报障）。
   * `null` = **尚未查询**，`[]` = 已查询但没有积分包 —— 两者必须区分（见自动补拉）。
   */
  const detailPackages = detail ? traeCreditPackages(detail, credits?.packages) : null;
  const detailName = detail
    ? displayText(detail.name) || `UID · ${displayText(detail.userId) ?? "—"}`
    : "";

  /**
   * ★ 2026-10-27（用户报障「积分信息不正常」连带暴露）：**打开抽屉时静默补一次积分明细**。
   *
   * 为什么需要：`creditPackages`（逐包总量 / 剩余 / 到期）只在「单独刷过积分」后才存在，
   * 而抽屉的积分页与卡片的分母 `X/Y` 都依赖它 ⇒ 没刷过的账号，积分页是空态、卡片只有剩余。
   * WB 侧是打开抽屉时懒加载积分（`ensureCredits`），Trae 之前没有对应动作。
   *
   * 三条约束：
   * 1. **只读**（`traeRefreshCredits` 只查询，不改账号状态），每账号每次会话最多一次
   *    （`autoCreditsTried` 挡住重复进入抽屉时的重复请求）；
   * 2. **静默**：不弹 toast —— 用户只是打开看一眼，不需要一条「已刷新」的回执；
   * 3. **失败不打扰**：失败时保持空态，⟳ 仍是手动重试的出口。
   *
   * ⚠️ 去重键是 `scope:userId`（不是裸 `userId`）：国内版 / 国际版的同一个 uid 是两个账号，
   * 共用一把键会让切区后的补拉被上一区的记录挡掉。
   * ⚠️ 判据用**合并后的** `detailPackages`：`null` = 尚未查询（要补拉），
   * `[]` = 已查询但没有积分包（**不该再打一次**）—— 此前直接读 `detail.creditPackages`，
   * 生产上恒为 `null`，于是每次进抽屉都重复请求。
   */
  const autoCreditsTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!detail) return;
    if (detailPackages != null) return;
    const triedKey = `${scope}:${detail.userId}`;
    if (autoCreditsTried.current.has(triedKey)) return;
    autoCreditsTried.current.add(triedKey);
    void api
      .traeRefreshCredits(detail.userId, variant)
      .then(() => loadAll())
      .catch(() => {
        /* 静默失败：空态 + ⟳ 已足够表达。 */
      });
  }, [detail, detailPackages, scope, variant, loadAll]);
  /**
   * 概览「今日签到」行与顶部指标块**同一个判据**：上游读数（`checkinMap`）优先，
   * 没有时回落列表快照；上游读失败要显示「读不到」而不是「未签到」。
   * 两处各写一遍三元链，刷新失败时会出现「指标块说读不到、概览说未签到」的同屏矛盾。
   */
  const detailCheckinText = detail
    ? (() => {
        const entry = checkinMap[detail.userId];
        if (entry && !entry.ok) return t("shared.stat.checkinUnreadable");
        if (entry) {
          return entry.todayCheckedIn
            ? t("shared.stat.checkedIn")
            : entry.active === false
              ? t("shared.stat.checkinUnavailable")
              : t("shared.stat.notCheckedIn");
        }
        return detail.checkedToday ? t("shared.stat.checkedIn") : t("shared.stat.notCheckedIn");
      })()
    : "—";

  /**
   * 概览只留「账号信息」一块，字段对齐 WorkBuddy 的概览（凭据到期 / 今日签到 / 今日 Token）。
   *
   * ★ 2026-10-27（用户要求「参考 WorkBuddy，去掉概览里重复的积分 / 凭据区块」）：
   * 此前概览把「积分」「凭据」各摆成一整块，逐字段重复上方的指标块与下方同名页签 ——
   * 打开概览看到的是缩小版的积分页 + 凭据页。现在：
   * - 积分明细去「积分」页签看；
   * - JWT 自动刷新 / 设备标识去「凭据」页签看（那里还有续期动作）；
   * - 概览只答「这是哪个号、现在什么状态」。
   * 账号 ID 不再重复：抽屉副标题已经是 `{name} · UID {uid}`。
   */
  const detailSections: DetailSection[] = detail
    ? [
        {
          key: "account",
          title: t("trae.comp.card.detail.section.account"),
          rows: [
            {
              label: t("trae.comp.card.detail.cooldown"),
              value: detail.cooldownType
                ? `${detail.cooldownType}${detail.cooldownUntil ? ` · ${shortTime(detail.cooldownUntil)}` : ""}`
                : t("trae.comp.card.detail.none"),
            },
            {
              label: t("trae.comp.card.detail.jwtExpiry"),
              value: detail.jwtExpTimestamp
                ? shortTime(detail.jwtExpTimestamp)
                : t("trae.comp.card.detail.none"),
              mono: true,
            },
            { label: t("shared.stat.checkin"), value: detailCheckinText },
            /* 与 WB 概览同一行：只给 headline，客户端 / 网关拆分在用量统计页。 */
            {
              label: t("shared.stat.tokens"),
              value: formatTodayTokens(todayTokens[detail.userId], todayTokensTruncated, t),
            },
          ],
        },
      ]
    : [];

  /**
   * ★ 2026-10-26（用户报障「凭证页不显示内容」）：抽屉的**凭据页签**（`shared.drawer.tab.credential`）
   * 只渲染调用方注入的 `credential` 块 —— Trae 此前没传，页签里只剩两枚按钮。
   *
   * 数据来自本页已有的 JWT 字段，**不新增读法**：状态词 / 语气 / 三行明细。
   *
   * ★ 2026-10-27（用户要求「概览去掉重复的凭据区块」）：概览不再摆凭据明细，
   * 「自动刷新 JWT」「设备标识」只在这里出现 —— 所以这两行必须完整，
   * 包括「总开关关着（只能手动）」这一态，不能因为概览删了就把信息一起丢掉。
   */
  const detailCredential: DetailCredential | null = detail
    ? {
        statusText: jwtBadge(detail.jwtStatus, detail.jwtExpHours, t).text,
        tone:
          detail.jwtStatus === "expired"
            ? "bad"
            : detail.jwtStatus === "warn" || detail.jwtStatus === "unknown"
              ? "warn"
              : "ok",
        /* 第一行「凭据到期」是主时间；后两行是 Trae 有、WB 没有的字段。
           ⚠️ 不写 hint：WB 的 hint 是「可正常使用 / 建议续期」这类语气说明，
           Trae 的凭据状态已由徽章 + 到期行说清，再加一句就是同一件事说三遍。 */
        rows: [
          {
            label: t("trae.comp.card.detail.jwtExpiry"),
            value: detail.jwtExpTimestamp
              ? shortTime(detail.jwtExpTimestamp)
              : t("trae.comp.card.detail.none"),
            mono: true,
          },
          {
            label: t("trae.comp.card.detail.jwtAutoRefresh"),
            /* 三态：没 refresh_token（换不了）／总开关关着（只能手动）／开着（分「本次将续期」
               与「未到期」）。★ 判据与后台续期任务同源（`account::needs_jwt_refresh`
               → `jwtAutoRefresh`），所以这里说「本次将续期」的账号，正是下一轮会被换掉的那批。 */
            value: !detail.hasRefreshToken
              ? t("trae.comp.card.detail.noRefreshToken")
              : schedule?.trae_jwt_refresh_enabled === false
                ? t("trae.comp.card.detail.jwtAutoDisabled")
                : detail.jwtAutoRefresh
                  ? t("trae.comp.card.detail.jwtAutoOn")
                  : t("trae.comp.card.detail.jwtAutoOff"),
          },
          {
            label: t("trae.comp.card.detail.deviceId"),
            value: displayText(detail.deviceIdMasked) ?? t("trae.comp.card.detail.none"),
            mono: true,
          },
        ],
      }
    : null;
  /** 判定「临期」的同一时刻（下界与上界取同一个 `now`，口径见后端 `trae/credits.rs`）。 */
  const now = Date.now();
  /**
   * 抽屉顶部的指标块（Trae 侧只有三个：积分 / 签到 / 凭据）。
   *
   * ⚠️ 文本全部在这里格式化（抽屉只排版）；`refreshKind` 只给本平台真的能刷的项
   * （Trae 没有签到状态的只读重取接口，所以签到块不带 ⟳）。
   *
   * ★ 2026-10-26（用户报障）：**临期阈值原来是坏的** —— 旧代码写
   * `creditsExpireAt - Date.now() <= 7 * 86400000`，而 `creditsExpireAt` 是**秒**、
   * `Date.now()` 是毫秒 ⇒ 差值恒为巨大负数 ⇒ `soon` 永远为真，于是**再远的到期日也是黄色**
   * （用户看到的正是这个）。现在与卡片同一判据：`isExpiryUrgent(秒 * 1000)` = 3 天内。
   *
   * ★ 2026-10-27：指标块**只留这三块**；「今日 Token」不作块，而是像 WB 一样
   * 放进概览的信息行（见 `detailSections`），完整拆分仍在用量统计页。
   */
  const detailStats = useMemo<DetailStat[]>(() => {
    if (!detail) return [];
    const badge = jwtBadge(detail.jwtStatus, detail.jwtExpHours, t);
    /* 与卡片 / 表格同一份汇总：有包明细就报最急一批，没有就回落账号自带的到期时刻。 */
    const expiryForDetail = summarizeExpiry(detailPackages, { unit: "s", now });
    const totalForDetail = traeCreditTotal({ creditPackages: detailPackages });
    const nextBatchForDetail = expiryForDetail?.batches[0] ?? null;
    const soon = nextBatchForDetail
      ? isExpiryUrgent(nextBatchForDetail.expireAt, now)
      : detail.creditsExpireAt != null && isExpiryUrgent(detail.creditsExpireAt * 1000, now);
    const credBad = detail.jwtStatus === "expired";

    /* 签到：文案与概览行共用 `detailCheckinText`；这里只决定副行与 ⟳ ——
       被刷新过的账号用上游读数，没刷新过的如实标明来源是本地台账。 */
    const checkinEntry = checkinMap[detail.userId];
    const checkinBlock: DetailStat =
      checkinEntry === undefined
        ? {
            key: "checkin",
            label: t("shared.stat.checkin"),
            valueText: detailCheckinText,
            subText: t("shared.stat.checkinFromLedger"),
          }
        : {
            key: "checkin",
            label: t("shared.stat.checkin"),
            valueText: detailCheckinText,
            subText:
              checkinEntry.ok && checkinEntry.source === "ledger"
                ? t("shared.stat.checkinFromLedger")
                : undefined,
            refreshKind: "checkin",
          };

    return [
      {
        key: "credits",
        label: t("shared.stat.credits"),
        /* ★ 2026-10-27（用户报障「积分请参考 WB，实现不一样」）：WB 的积分块是
           **`剩余/总量` 两段式** + 副行「320 积分 10-29 00:00 到期」；
           Trae 此前只有总量一个数字、副行写「有效至 …」。同一个位置的同一个指标，
           两边读起来是两个概念 —— 现在按 WB 的口径重写：
           - 主值：`剩余/总量`（总量走 `traeCreditTotal`，与卡片同一函数）；
           - 副行：最急一批的「金额 + 到期」（`nextExpiryLabel`，与卡片同一函数），
             没有包明细时回落 `creditsExpireAt` 的「MM-DD HH:mm 到期」；
           - 语气：与卡片同一阈值（3 天内才警示）。 */
        valueText:
          detail.remainingCredits != null && traeCreditTotal({ creditPackages: detailPackages }) != null
            ? `${formatCredits(detail.remainingCredits)}/${formatCredits(totalForDetail ?? 0)}`
            : detail.remainingCredits != null
              ? formatCredits(detail.remainingCredits)
              : "—",
        subText: expiryForDetail
          ? nextExpiryLabel(expiryForDetail, t, now)
          : detail.creditsExpireAt != null
            ? t("trae.comp.card.expiryOn", { date: shortTime(detail.creditsExpireAt) })
            : t("shared.stat.noExpiring"),
        tone: soon ? "warn" : undefined,
        refreshKind: "credits",
      },
      checkinBlock,
      {
        key: "credential",
        label: t("shared.stat.credential"),
        valueText: badge.text,
        /* ★ 2026-10-26（与 WorkBuddy 同口径）：状态词不带信息，副行给**具体到期时刻**。
           三分支与 WB 一致，第三支不同：Trae 的 JWT **不存在「长期有效」** ——
           `jwtExpTimestamp` 缺值意味着读不到（`unparsable`），此时不写副行，而不是编一个
           「长期有效」。 */
        subText: credBad
          ? t("shared.stat.credentialBadSub")
          : detail.jwtExpTimestamp
            ? t("shared.stat.credentialValidUntil", { date: shortTime(detail.jwtExpTimestamp) })
            : undefined,
        tone: credBad ? "bad" : undefined,
        refreshKind: "credential",
      },
    ];
  }, [detail, detailPackages, t, detailCheckinText, checkinMap]);

  const detailPacks: DetailPack[] = detail
    ? (detailPackages ?? [])
        .filter((item) => item.remaining > 0)
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
          const leftExpiry = left.item.expireAt ?? Number.POSITIVE_INFINITY;
          const rightExpiry = right.item.expireAt ?? Number.POSITIVE_INFINITY;
          return leftExpiry === rightExpiry ? left.index - right.index : leftExpiry - rightExpiry;
        })
        .map(({ item }) => ({
          key: `${item.packageCode ?? item.packageName ?? "pack"}-${item.expireAt ?? "none"}`,
          // 同 WorkBuddy 账号页：`packageName` / `packageCode` 可能被后端吐成对象，
          // 直接当 React 子节点会白屏（issue #2）。过 `displayText` 出口归一。
          name: displayText(item.packageName) || displayText(item.packageCode) || t("trae.comp.card.package.fallback"),
          remainingText: formatCredits(item.remaining),
          totalText: formatCredits(item.total),
          usedText: t("trae.comp.card.package.used", { n: formatCredits(item.used) }),
          expiryText: item.expired
            ? t("trae.comp.card.package.expired")
            : item.expireAt
              ? t("trae.comp.card.expiry.short", { date: shortTime(item.expireAt) })
              : t("trae.comp.card.expiry.permanent"),
          expired: item.expired,
          /* ⚠️ `item.expireAt` 是**秒**（后端 `expire_times`，与 WB `CreditResource.expireAt`
             的毫秒口径**不同** —— 见 `trae-usage-charts.ts` 的同款说明）⇒ 必须 `* 1000`。
             下界 `> now` 与上界取**同一个** `now`：只判上界会依赖「`expired` 已覆盖过去时刻」
             这条隐式不变量。 */
          expiringSoon:
            !item.expired &&
            item.expireAt != null &&
            item.expireAt * 1000 > now &&
            item.expireAt * 1000 - now <= 7 * 86_400_000,
          ratio: item.total > 0 ? Math.min(100, Math.max(0, (item.remaining / item.total) * 100)) : 0,
        }))
    : [];
  // 只读程序位徽标（**非**切换控件）：复用卡片的 `programsFor`，标签带区域标识消歧。
  const detailPrograms: DetailProgramBadge[] = detail
    ? programsFor(detail).map((program) => ({
        key: `${program.region}:${program.variant}`,
        // `program.label` 来自后端 `TraeProgramStatus.label`，未经归一 —— 对象会当 React
        // 子节点卸载整棵树（issue #2）。过 `displayText` 出口，取不到回落占位。
        label: `${displayText(program.label) ?? "—"} · ${
          program.region === "global" ? t("shared.region.version.global") : t("shared.region.version.cn")
        }`,
        current: program.current,
        installed: program.installed,
        hasDataDir: program.hasDataDir,
      }))
    : [];
  const detailRemark = detail ? displayText(detail.remark)?.trim() || "" : "";

  /* ────────────── 抽屉装配：与 WorkBuddy **逐项同构** ──────────────
     ⚠️ 改造前 Trae 只注入了 `packs/sections/programs/remark` 四样，
     抽屉因此缺了「当前登录徽章 / 切换到此账号 / 操作区 / 签到历史」四块 ——
     同一个共享抽屉在两个分区里内容完全不同。下面按 WB 的口径补齐，
     差异**只在数据**（Trae 的切换目标是 Trae 产品线、凭据是 JWT）。 */

  /**
   * ★ 「当前登录」= 该账号是**任一** Trae 产品线的当前账号（与卡片 / WB 抽屉同口径，
   * 原型 `drawerAccount` :3467）。
   */
  const detailIsCurrent = detail ? isCurrentAccount(detail) : false;

  /**
   * ★ 「切换到此账号」程序位（可点）。回调复用页面既有的 `requestSwitchTo`（会走统一重启确认）。
   *
   * ⚠️ 2026-10-10：`programsFor` 现在只返回**本区域**的程序位 ⇒ 原先那条「跨区域不给 onSwitch、
   * 标签加区域后缀消歧」的分支已删除（永远走不到，留着就是死代码）。
   * 不可切换只剩一种原因：客户端没装 / 没有可读写的数据目录（`hasDataDir`）。
   */
  const detailSwitchTargets: DetailSwitchTarget[] = detail
    ? programsFor(detail).map((program) => {
        // 与卡片**同一取值**：程序位自己的展示名。抽成局部变量是因为它既要上界面，
        // 又要原样传给 `requestSwitchTo` —— 而**不能**在那里用 variant 反推
        // （合并版 `trae` 与遗留 `trae_code` 共用变体 `trae_cn`，反推会说成 `TraeCode`）。
        const label = displayText(program.label) || program.variant;
        return {
          key: `${program.region}:${program.variant}`,
          label,
          current: program.current,
          available: program.installed,
          busy: busy?.startsWith("switch-") ?? false,
          loading: busy === `switch-${detail.userId}@${program.variant}`,
          onSwitch:
            program.installed && program.hasDataDir
              ? () => requestSwitchTo(detail, program.variant, label)
              : undefined,
        };
      })
    : [];

  /**
   * 该账号凭据是否不可用（JWT 已过期 / 状态未知）—— 与卡片菜单的「不给签到入口」同口径。
   * ⚠️ `TraeJwtStatus` 只有 `ok | warn | expired | unknown`（**没有** `unparsable`，那是文案层的说法）。
   */
  const detailCredentialUnavailable = detail
    ? detail.jwtStatus === "expired" || detail.jwtStatus === "unknown"
    : false;

  /**
   * 「该账号今日是否已签到」的**唯一判据**：上游读数（`checkinMap`）优先，没有时回落列表快照。
   *
   * ★ 2026-10-26：抽屉的「签到积分」块、「签到」按钮的显隐都读它。此前一处读快照
   * （`detail.checkedToday`）、一处读 `checkinMap`，刷新完上游后两个地方给出相反的答案。
   */
  const detailCheckinToday = detail
    ? checkinMap[detail.userId]?.ok
      ? checkinMap[detail.userId].todayCheckedIn
      : detail.checkedToday
    : false;

  /**
   * ★ 抽屉「操作」区：回调全部复用页面**既有**处理函数（刷新 JWT / 签到 / 删除）。
   * 「手动签到」按与卡片菜单**同一门控**：今日未签到且凭据可用时才给入口。
   * ★ 2026-10-23：`导出` 已从抽屉移除（共享壳不再渲染该按钮，导出仍在卡片「更多」菜单里）。
   */
  const detailActions: DetailActions | null = detail
    ? {
        onRefresh: () => refreshJwt(detail),
        onCheckin: () => void checkinOne(detail),
        /* 与卡片菜单**同一门控**，且用**同一个**已签到判据（`detailCheckinToday`）——
           否则会出现「抽屉说未签到、按钮却因已签到而消失」这种自相矛盾的组合。 */
        showCheckin: !detailCheckinToday && !detailCredentialUnavailable,
        onDelete: () => requestDelete(detail),
        credentialUnavailable: detailCredentialUnavailable,
      }
    : null;

  /**
   * ★ 抽屉「签到积分」（原型 B5）：`todayCheckedIn` 必给；「今日获得」来自**最近一轮**签到摘要里
   * 该账号的 `delta`（上游实测字段）。
   *
   * ★ 2026-10-26（用户报障「今日已签到却显示未签到」）：`todayCheckedIn` **上游读数优先**
   * （`checkinMap`，用户点过「刷新签到状态」后就有），没有时才回落账号列表快照
   * `detail.checkedToday`。此前只读快照 ⇒ 刷新完上游、卡片已显示「已签到」，
   * 抽屉里还是「未签到」—— 同一屏上两个相反的答案。
   *
   * ⚠️ 摘要不是今天的、或该账号不在摘要里 ⇒ `todayCredit: null` ⇒ 抽屉**不渲染**那一行
   * （§3.4 规则 1：无数据不渲染）。**绝不**用固定奖励凑一个「+N」。
   */
  const detailCheckinEntry = detail ? checkinMap[detail.userId] : undefined;
  /** 「今日获得」优先取**本轮签到的实际增量**（`summary.delta`），没有才回落到条目里的 `todayCredit`。 */
  const detailCheckinDelta =
    detail && checkin?.summaryIsToday
      ? checkin.summary.results.find((row) => row.userId === detail.userId && row.ok)?.delta ?? null
      : null;
  /**
   * ★ 2026-10-27（用户问「签到天数 / 累计积分为什么不能统计」）：Trae 上游签到状态
   * **只有 `dailyCredit`**（`checkin.rs::status_entry`），从来没有 streak / total 概念
   * ⇒ 这两格以前恒为「—」。现用**本地积分明细**（`credits.records`，保留 90 天）统计：
   *
   * - 签到天数 = 有明细的**日期数**（`skip_already` 的 `delta=0` 也算签到日）；
   * - 累计积分 = `delta` 之和（只计非负；负数不是「获得」）。
   *
   * ⚠️ 口径与 WB 的上游 `streakDays`（连续天数）/ `totalCredits`（终身）**不同**：
   * 这是「本机明细 · 近 90 天」。`statsScope: "local"` 让抽屉在 tooltip 里如实说明，
   * 绝不冒充上游口径。上游哪天给了真值，`??` 的次序保证本地统计自动让位。
   */
  const localCheckinStats = (() => {
    if (!detail) return null;
    const rows = (credits?.records ?? []).filter((row) => row.userId === detail.userId);
    if (rows.length === 0) return null;
    return {
      days: new Set(rows.map((row) => row.date)).size,
      total: rows.reduce((sum, row) => sum + Math.max(0, row.delta), 0),
    };
  })();
  const detailCheckin = detail
    ? (() => {
        /* ★ 2026-10-27：上游读失败（`ok:false`）⇒ 整块如实置「未知」，**不回落快照** ——
           概览行（`detailCheckinText`）此时显示「读不到」，抽屉若还按快照摆「未签到」，
           就是同一屏两个答案。`null` 让抽屉显示未知 + ⟳ 出口。 */
        if (detailCheckinEntry && !detailCheckinEntry.ok) return null;
        const upstream = detailCheckinEntry?.ok ? api.checkinCreditsOf(detailCheckinEntry) : {};
        const streakFromLocal = upstream.streakDays == null && localCheckinStats != null;
        const totalFromLocal =
          upstream.totalCredits == null &&
          localCheckinStats != null &&
          localCheckinStats.total > 0;
        return {
          todayCheckedIn: detailCheckinToday,
          /* ★ 2026-10-26（用户报障「签到请参考 WB，实现不一样」）：三格里只有第一格有数，
             另外两格（签到天数 / 累计积分）恒为「—」。WB 用的是 `checkinCreditsOf(entry)`
             整组展开，这里改成同一个函数。⚠️ 没有上游条目时两格回落**本地明细统计** ——
             宁可注明口径，也不摆永恒的「—」。 */
          ...upstream,
          streakDays: upstream.streakDays ?? localCheckinStats?.days ?? null,
          totalCredits:
            upstream.totalCredits ??
            (localCheckinStats && localCheckinStats.total > 0 ? localCheckinStats.total : null),
          statsScope: streakFromLocal || totalFromLocal ? ("local" as const) : undefined,
          ...(detailCheckinDelta != null ? { todayCredit: detailCheckinDelta } : {}),
        };
      })()
    : null;

  /**
   * ★ 抽屉「签到历史（近 7 天）」：**只读结构化数据**，不再解析日志正文。
   *
   * ## 为什么要推翻旧实现（2026-10-27 用户报障「显示未签到、今日结果却是成功」）
   *
   * 旧实现按「行内含 `userId` + 不含失败关键字」把 `checkin.log` 二分，而那份日志是
   * 四类事件共用的：签到结果、OAuth 登录、JWT 续期、设备凭证回落。于是两个方向同时错：
   *
   * - 真签到那天的汇总行 `签到完成: 成功 1/…` **不含 uid** ⇒ 显示「未签到」；
   * - 只刷新过 JWT 的那天有 `JWT 自动刷新成功: user=<uid>` ⇒ 显示「成功」。
   *
   * 现按两路**结构化**来源取值，判定与取数分离：
   *
   * 1. **本机签到流水**（`TraeLogEntry.checkin`，后端解析写侧的 `签到记录 …` 行）：
   *    能区分 `claim_ok` / `skip_already` / `fail` 三态 —— 失败只有这里有。
   * 2. **积分明细**（`credits.records`，`date + userId + delta`）：跨版本可用，
   *    本功能上线前的成功记录也在，因此历史不会因为日志格式变更而整片变空。
   *
   * 「获得积分」优先取积分明细的 `delta`（唯一真值），取不到才用流水里的 `delta`；
   * 两者都没有 ⇒ `null` ⇒ 渲染「—」（**绝不**臆造固定奖励）。
   *
   * 同一账号同一天有多条流水时取**最新**一条（`get_trae_logs` 已按时间倒序）。
   */
  const detailCheckinHistory: DetailCheckinHistoryRow[] | null =
    detail && detailCheckinLogs
      ? lastSevenDays().map((day) => {
          const record = detailCheckinLogs.find(
            (log) =>
              log.kind === "checkin" && log.date === day && log.checkin?.userId === detail.userId,
          )?.checkin;
          const credit = credits?.records.find(
            (row) => row.date === day && row.userId === detail.userId,
          );
          const creditDelta = credit ? credit.delta : null;
          /* 「获得积分」列只放**获得**：正数是真收益，`0` 是「签过了但这轮没新增」，
             负数（理论上只有夹具会出现）不是获得 ⇒ 不显示，免得渲染成「+-8.5」。 */
          const earned = (delta: number | null): number | null =>
            delta == null ? null : delta >= 0 ? delta : null;

          if (record?.action === "fail") {
            return {
              date: day,
              resultLabel: t("shared.drawer.checkin.result.fail"),
              tone: "fail" as const,
              amount: null,
            };
          }
          if (record?.action === "claim_ok") {
            return {
              date: day,
              resultLabel: t("shared.drawer.checkin.result.success"),
              tone: "ok" as const,
              amount: earned(creditDelta) ?? (record.delta > 0 ? record.delta : null),
            };
          }
          if (record?.action === "skip_already") {
            return {
              date: day,
              resultLabel: t("shared.drawer.checkin.result.already"),
              tone: "warn" as const,
              /* `skip_already` 的 delta 恒为 0：有明细就显示 0（「签过了，这轮没新增」），
                 没有明细才显示「—」。 */
              amount: earned(creditDelta),
            };
          }
          if (credit) {
            /* 没有流水但有明细：`delta > 0` 说明那次签到**真拿到了积分**，
               `delta === 0` 是「上游已签、本轮跳过」。这是升级前的历史记录能给出的最强结论。 */
            return creditDelta != null && creditDelta > 0
              ? {
                  date: day,
                  resultLabel: t("shared.drawer.checkin.result.success"),
                  tone: "ok" as const,
                  amount: creditDelta,
                }
              : {
                  date: day,
                  resultLabel: t("shared.drawer.checkin.result.already"),
                  tone: "warn" as const,
                  amount: earned(creditDelta),
                };
          }
          return {
            date: day,
            resultLabel: t("shared.drawer.checkin.result.none"),
            tone: "none" as const,
            amount: null,
          };
        })
      : null;

  /* 页头作用域（原型 `viewAccounts`）复用上方的 `scope`；「需处理」= JWT 已过期，
     与 WorkBuddy 侧的 `needsRelogin` 同一层语义。 */
  const expiredCount = accounts.filter((account) => account.jwtStatus === "expired").length;

  /**
   * 页头一键动作的可用性 —— **做不了就禁用**，别让按钮点下去只弹一句「没活可干」。
   *
   * - 无账号 ⇒ 两枚全禁用（动作函数里的 early-return 用户看不见）。
   * - 一键签到：所有账号的今日签到都**已知为已签**才禁用；任一账号状态未知
   *   （`checkinMap` 还没回来）就保持可点 —— 不把「不知道」当成「已签」。
   */
  const noAccounts = accounts.length === 0;
  /**
   * 今日是否已签到：上游读数（`checkinMap`）优先，没有时回落列表快照 —— 与卡片同源。
   *
   * 用函数声明（而非 `const` 箭头）是为了**提升**：表格的 `renderStatusBadges` 也要读它，
   * 而那段位于本组件靠上的位置，`const` 会在 TDZ 里。
   */
  function checkinTodayOf(account: TraeAccount): boolean {
    return checkinMap[account.userId]?.ok ? checkinMap[account.userId].todayCheckedIn : account.checkedToday;
  }
  const checkinHasPending = accounts.some((account) => !checkinTodayOf(account));
  const quickBlocked = batchBusy || quickActionBusy !== null;

  /**
   * 收敛迁移的**一次性升级引导**（issue #28）。
   *
   * 为什么值得单独一个对话框而不是 toast：这次收敛**移除了用户看得见的按钮**
   * （每个区域从三枚程序位按钮变成一枚），并**改写了登录态快照的存放目录** ——
   * toast 会被下一条消息顶掉，而这两件事用户都需要能回看。
   *
   * 只在 `mergeGuide != null` 时渲染（后端的一次性标记保证只弹一次）。
   */
  const mergeGuideDialog = (
    <Dialog
      open={mergeGuide != null}
      onOpenChange={(open) => {
        if (!open) setMergeGuide(null);
      }}
    >
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("trae.page.accounts.mergeGuide.title")}</DialogTitle>
          <DialogDescription>{t("trae.page.accounts.mergeGuide.desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-[13px] text-muted-foreground">
          <p>
            {mergeGuide && mergeGuide.slotsCopied > 0
              ? t("trae.page.accounts.mergeGuide.copied", { count: mergeGuide.slotsCopied })
              : t("trae.page.accounts.mergeGuide.none")}
          </p>
          {mergeGuide && mergeGuide.slotsKept > 0 && (
            <p>{t("trae.page.accounts.mergeGuide.kept", { count: mergeGuide.slotsKept })}</p>
          )}
          {mergeGuide && mergeGuide.errors.length > 0 && (
            <p className="text-destructive">
              {t("trae.page.accounts.mergeGuide.errors", { count: mergeGuide.errors.length })}
            </p>
          )}
        </div>
        <div className="rounded-[10px] border border-warning/40 bg-warning/8 px-3.5 py-3">
          <p className="text-[13px] font-medium text-foreground">
            {t("trae.page.accounts.mergeGuide.adviceTitle")}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {t("trae.page.accounts.mergeGuide.advice")}
          </p>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => setMergeGuide(null)}>
            {t("trae.page.accounts.mergeGuide.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="mx-auto w-full max-w-[1240px] px-7 pt-[26px] pb-[60px]">
      {mergeGuideDialog}
      {/* 页头与 WorkBuddy 逐字同构：**只有标题与说明，不放任何动作按钮**。
          动作一律下沉到「添加与迁移账号」横幅与账号工具栏，
          这样两个分区的动作位置、视觉重量完全一致。
          曾经这里堆了 4 个按钮（刷新 / 刷新积分 / 全部签到 / 添加账号），
          与 WorkBuddy 的骨架冲突，也让同一功能出现两个入口。 */}
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">{t("trae.page.accounts.title")}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <ScopeChip scope={scope} />
            <span>
              ·{" "}
              {expiredCount > 0
                ? t("pageHead.accounts.pending", { n: accounts.length, m: expiredCount })
                : t("pageHead.accounts", { n: accounts.length })}
            </span>
          </p>
        </div>
        <div className="grow" />
        {/* ★ 2026-10-26（用户要求）：页头补「一键刷新 / 一键签到」，与 WorkBuddy 页头同位置、
            同控件、同冷却（30 秒）。一键作用于**全部账号**且只做只读刷新 / 自动跳过已签，
            写操作与破坏性操作仍只在勾选后的批量条与单账号菜单里（PLAN §3.4 三作用域）。 */}
        <div className="flex shrink-0 items-center gap-2">
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

      {/* ★ 账号工作台（**两平台共用容器**）—— 与 `AccountsPage` 是**同一个组件**，
          差异只在 props：排序/分组选项、工具栏专属控件、卡片渲染、列定义、首屏空态。
          这正是原型 `curPlatform()` 的机制（同一段 `viewAccounts`，只换数据）。 */}
      <AccountWorkbench
        query={query}
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
        /* ★ 主操作：两平台**同一入口** —— 都开「添加账号」抽屉（`AddAccountDrawer`）。
           原工具栏右侧还有 4 个 ghost 级入口（导入本机 / 粘贴 JWT / 导入备份 / 导出备份），
           已随「⋯」溢出菜单一起删除 ⇒ 全部搬进抽屉：粘贴 JWT 成为第 4 张添加方式卡，
           导出备份进「更多操作」，导入本机 / 导入备份本就与抽屉前两张卡同义（**不重复搬**）。 */
        addAction={{
          label: t("shared.addDrawer.title"),
          onClick: () => setAddDrawerOpen(true),
        }}
        /* ★ 一枚**常驻**控件（用户要求「回收站放出来」）——
           走结构化 prop 注入，几何与文案都留在工具栏壳里；其余入口仍在抽屉的「更多操作」。 */
        onOpenRecycleBin={() => setRecycleOpen(true)}
        loading={loading}
        /* 首屏空态：与 WorkBuddy 的 `EmptyRegionCard` 同构（可能原因 + 期望产物 + 动作）。 */
        emptyState={
          accounts.length === 0 ? (
            /* ★ 无客户端形态（issue #62）：本机没有该产品线的客户端时，
               「从本机导入 / 启动客户端」都是死路，换成「浏览器授权 + 导入备份」，
               并把「Trae 还需要客户端里的设备私钥」提前说清（`trae` 标记）。 */
            regionStatus && regionStatus.installed === false ? (
              <ClientlessEmptyCard
                scopeLabel={scopeLabel(t, scopeOf("trae", variant))}
                platformLabel={traeVariantLabel(variant)}
                trae
                onOauth={() => setOauthOpen(true)}
                onBackup={() => setImportOpen(true)}
                onRecheck={() => loadAll()}
              />
            ) : (
            <EmptyTraeCard
          // ⚠️ 三个字段都必须取**当前区域**那份（见 `EmptyTraeCard` 的 prop 文档）：
          // `env`（`get_trae_env`）是横跨全部产品线的全局探测，在区域页里会张冠李戴
          // —— 「装了」会取自另一条产品线，`dataDir` 会写成另一个客户端的目录。
          installed={regionStatus?.installed ?? false}
          dataDir={regionStatus?.dataDir ?? null}
          dataDirExists={regionStatus?.dataDirExists ?? false}
          onRecheck={() => loadAll()}
          onImport={() => void importLocal()}
          onOAuth={() => setOauthOpen(true)}
          onLaunch={() =>
            void run("launch-client", "trae.page.accounts.emptyLaunchClient", () =>
              api.launchTraeClient(variant),
            )
          }
              importing={importing}
              launching={busy === "launch-client"}
            />
            )
          ) : null
        }
        notices={
          <>
            {/* 有账号、但本机没有该产品线的客户端：一行说清影响面（网关不受影响）。 */}
            {regionStatus?.installed === false && accounts.length > 0 ? (
              <ClientlessStrip scopeLabel={scopeLabel(t, scopeOf("trae", variant))} />
            ) : null}
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertTriangle />
                <AlertTitle>{t("trae.page.accounts.loadFailed")}</AlertTitle>
                <AlertDescription>
                  <span>{error}</span>
                  {/* ★ 失败态**必须给一条出路**（本仓约定，与 WorkBuddy 同形）：
                      没有它，用户唯一能做的就是重启应用。此前 Trae 侧这条 Alert 只有文字。 */}
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={recheckAlertBusy}
                      onClick={() => void runRecheckAlert(() => loadAll())}
                    >
                      {recheckAlertBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      {t("trae.page.accounts.emptyRecheck")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </>
        }
        checkinResult={
          checkinResult
            ? {
                okCount: checkinResult.ok,
                failedNames: accounts
                  .filter((account) => checkinResult.failedIds.includes(account.userId))
                  .map((account) => displayText(account.name) || account.userId),
                onRetry:
                  checkinResult.failedIds.length + checkinResult.unprocessedIds.length > 0
                    ? () => batchCheckin([...checkinResult.failedIds, ...checkinResult.unprocessedIds])
                    : undefined,
                /* 取消后没发出的账号单独成档：既不是成功也不是失败（R12）。 */
                unprocessedCount: checkinResult.unprocessedIds.length,
              }
            : null
        }
        onDismissCheckinResult={() => setCheckinResult(null)}
        batch={{
          selectedCount: selectedKeys.size,
          busy: batchBusy,
          /* ★ R08：普通「刷新」只走读接口（下拉）；续期凭据是下拉外的写操作。 */
          onRefreshPart: batchRefreshPart,
          refreshKinds: TRAE_REFRESH_KINDS,
          onRefreshToken: () => void batchRenewTokens(),
          refreshingToken: renewBusy,
          onCheckin: () => void batchCheckin(),
          /* ★ 导出所选账号：原型 `batchBarHtml` 的固定动作之一（`:2453`）。
             Trae 侧此前缺这一项 ⇒ 同一个批量条在两个分区动作集不同。 */
          onExport:
            selectedAccounts.length > 0
              ? () => {
                  setExportTargets(selectedAccounts);
                  setExportOpen(true);
                }
              : undefined,
          onDelete: () => setBatchDeleteOpen(true),
          onClear: clearSelection,
          progress: batchProgress,
          onCancel: batchProgress ? cancelBatch : undefined,
        }}
        listAriaLabel={t("trae.page.accounts.sectionAria", { count: accounts.length })}
        totalCount={accounts.length}
        visibleCount={sorted.length}
        /* 本页「真没有账号」由 `emptyState`（`EmptyTraeCard`）承担，这里只留「被筛没」出口。 */
        emptyNone={{
          title: t("shared.list.empty.none"),
          description: t("shared.list.empty.noneDesc"),
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
        rowKey={(account) => selectionKey(account.userId)}
        selectedIds={selectedKeys}
        onToggleSelect={toggleSelect}
        onToggleBucketAll={toggleBucketSelection}
        bucketAllSelected={bucketAllSelected}
        bucketSomeSelected={bucketSomeSelected}
        onOpenRow={openDetail}
        /* ★ R07：表格行尾的「更多」与卡片页脚**同一个装配函数**。 */
        renderActions={(account) => renderAccountMenu(account, true)}
        isRowCurrent={isCurrentAccount}
        rowSelectLabel={(account) => t("shared.table.selectRowAria", { name: traeAccountName(account) })}
        rowOpenLabel={(account) => t("shared.table.openRowAria", { name: traeAccountName(account) })}
        renderCard={(account) => (
                            <TraeAccountCard
                              key={account.userId}
                              account={{
                                ...account,
                                // 逐包明细来自 `get_trae_credits` 的 `packages[uid]`：账号视图（`list_account_views_for`）
                                // 只带聚合积分，包粒度明细在积分总览里 —— 合并口径与表格积分列共用
                                // `traeCreditPackages`，两处不再各写一份。
                                creditPackages: traeCreditPackages(account, credits?.packages),
                              }}
                              current={isCurrentAccount(account)}
                              programs={programsFor(account)}
                              busy={busy}
                              switchBusy={switchBusy}
                              /* ★ 与 WorkBuddy 卡片**同一取值**（见下方说明 / `AccountsPage` 同处）。 */
                              featuresDisabled={false}
                              selected={selectedKeys.has(selectionKey(account.userId))}
                              onToggleSelect={toggleSelect}
                              onOpenDetail={openDetail}
                              /* ★ R10：标签直达详情页签。 */
                              onOpenTab={(target, tab) => openDetail(target, tab)}
                              /* ★ R07/R09：卡片页脚与表格行尾**同一个菜单装配函数**。 */
                              menu={renderAccountMenu(account)}
                              /* 「把这个账号挂到哪条 Trae 线上」——对应 WorkBuddy 卡片上的
                                 WorkBuddy / CodeBuddy IDE / CodeBuddy CLI 三枚按钮。
                                 `variant` 取按钮自己那条线（不是当前页面那条）：用户就是要
                                 在当前页面上给另一条线挂账号，用页面的 `variant` 会挂错线。

                                 ★ 失败**不需要**这里兜底：`api.traeSwitchAccount` 在
                                 `outcome.success === false` 时抛错（见该函数的说明），
                                 `run()` 的 catch 会报「{label}失败」并带上后端给的可操作原因。
                                 曾经这里用 `after` 补一条 error toast，而 `run()` 的成功 toast
                                 是**无条件**弹的 ⇒ 用户同时收到「完成」与「未完成」，
                                 绿勾那条还在，正是「谎报成功」的来源（2026-09-29 报障）。 */
                              onSwitchTo={requestSwitchTo}
                              onCheckin={(target) => void checkinOne(target)}
                              onRefreshCredits={refreshCreditsOne}
                              onRefreshPart={onRefreshPart}
                              doneKinds={refreshBusy.doneKindsOf(account.userId)}
                              refreshingKinds={refreshBusy.kindsOf(account.userId)}
                              refreshKinds={TRAE_REFRESH_KINDS}
                              /* ★ 2026-10-26：卡片不再收 `todayTokens` —— 今日 Token 只在
                                 抽屉概览的信息行展示（与 WorkBuddy 同口径）。 */
                              checkedTodayOverride={
                                checkinMap[account.userId]?.ok
                                  ? checkinMap[account.userId].todayCheckedIn
                                  : undefined
                              }
                              /* 「保存登录态」＝把客户端**此刻**的登录态存到这个账号名下，
                                 因此目标只能是「这个账号当前登录着的那个程序位」。
                                 此前这里传的是页面所属的**区域**（`variant`），而区域只能推出
                                 该区域的主程序（`cn` → TraeWork）⇒ 两个后果：
                                 ① **TraeCode 的快照永远存不出来**，它的切换按钮是条死路
                                    （2026-09-29 报障里那枚按钮点不动就是这个原因）；
                                 ② 目标与客户端实际登录不符时被后端保存守卫拒绝，用户收到一句
                                    看不懂的「客户端当前登录的是另一个账号…」（本机实测复现过）。

                                 ⚠️ 这里**重新算一遍** `current` 而不是复用卡片渲染时的那份：
                                 卡片可能已经渲染了几十秒，期间 `logins` 被轮询刷新过 ⇒
                                 按钮的 disabled 与此刻的事实可能不一致。一个都没命中就如实报错，
                                 不要静默什么都不做（那正是本次要修的毛病）。 */
                              onSaveLogin={saveLogin}
                              onRefreshJwt={refreshJwt}
                              onClearCooldown={clearCooldown}
                              onDelete={requestDelete}
                            />
        )}
      />

      {/* 签到进度 / 结果：与「全部签到」同源，就地展开不做成独立页。 */}
      {(progress || report) && (
        <Card className="mt-6 gap-0 py-0">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
            <span className="text-sm font-semibold">{t("trae.page.accounts.resultTitle")}</span>
            {progress?.type === "account" && (
              <span className="text-xs text-muted-foreground">
                {t("trae.page.accounts.resultProgress", { index: progress.index, total: report?.total ?? "…" })}
              </span>
            )}
          </div>
          <div className="divide-y divide-border/60">
            {(report?.results ?? []).map((item) => (
              <div key={item.userId + item.name} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 truncate">{item.name}</span>
                <span className="flex shrink-0 items-center gap-3">
                  {item.delta > 0 && <span className="text-success">+{item.delta}</span>}
                  <span className="text-xs text-muted-foreground">{item.message || item.action}</span>
                  <Badge variant={item.ok ? "secondary" : "destructive"}>
                    {item.action === "skip_already"
                      ? t("trae.page.accounts.resultSkipped")
                      : item.ok
                        ? t("trae.page.accounts.resultSuccess")
                        : t("trae.page.accounts.resultFailed")}
                  </Badge>
                </span>
              </div>
            ))}
            {!report && progress?.type === "account" && (
              <div className="px-5 py-2.5 text-sm text-muted-foreground">
                {t("trae.page.accounts.resultLine", {
                  name: progress.name,
                  status:
                    progress.status === "success"
                      ? t("trae.page.accounts.resultSuccess")
                      : progress.status === "already"
                        ? t("trae.page.accounts.resultSkipped")
                        : t("trae.page.accounts.resultFailed"),
                })}
              </div>
            )}
            {/* 空队列要说明白「为什么一条都没有」，否则看着像功能坏了 ——
                打开「跳过今日已签到」后这是最常见的一种正常结果。 */}
            {report && report.results.length === 0 && (
              <div className="px-5 py-2.5 text-sm text-muted-foreground">
                {t("trae.page.accounts.resultEmpty")}
              </div>
            )}
          </div>
          {report && report.warnings.length > 0 && (
            <div className="border-t border-border/60 px-5 py-3 text-xs text-warning">
              {report.warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          )}
        </Card>
      )}

      <AddAccountDrawer
        open={addDrawerOpen}
        onOpenChange={setAddDrawerOpen}
        scopeLabel={scopeLabel(t, scope)}
        installed={regionStatus?.installed ?? false}
        onPick={(way: AddAccountWay) => {
          /* 与 WorkBuddy 同构：先关抽屉，再进入对应流程。 */
          /* 无客户端时「从本机导入」没有目录可读 —— 给替代路径，不静默失败（issue #62）。 */
          if (way === "local" && regionStatus?.installed === false) {
            toast.error(t("shared.srv.localUnavailable"), {
              description: t("shared.srv.localUnavailableDesc"),
            });
            return;
          }
          if (way === "oauth") setOauthOpen(true);
          else if (way === "backup") setImportOpen(true);
          else void importLocal();
        }}
        /* Trae 独有的一条兜底路径（OAuth 才是主路径）：手动粘贴 Cloud-IDE-JWT。 */
        extraOptions={[
          {
            key: "paste-jwt",
            icon: UserPlus,
            title: t("trae.page.accounts.pasteJwt"),
            desc: t("trae.page.accounts.pasteJwtTitle"),
            onClick: () => setAddOpen(true),
          },
        ]}
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

      <TraeOAuthLoginDialog
        open={oauthOpen}
        onOpenChange={setOauthOpen}
        /* 无客户端时弹窗要多讲一条「设备私钥」—— 只讲端口转发会让用户以为是网络问题。 */
        clientless={regionStatus?.installed === false}
        onSuccess={(account) => {
          toast.success(t("trae.page.accounts.accountAdded"), {
            description: `${account.name || account.userId}${account.hasRefreshToken ? t("trae.page.accounts.autoRenewSuffix") : ""}`,
          });
          void loadAll();
        }}
      />

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        groups={groups}
        variant={variant}
        onAdded={() => void loadAll()}
      />

      <TraeExportAccountsDialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open);
          /* 关闭时清掉「所选」范围，否则下次从工具栏打开会莫名只导出上次勾的那几个。 */
          if (!open) setExportTargets(null);
        }}
        accounts={exportTargets ?? accounts}
        variant={variant}
        onExported={(count) => toast.success(t("trae.page.accounts.exportedCount", { count }))}
      />

      <TraeImportAccountsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        variant={variant}
        onImported={(result) => {
          toast.success(t("trae.page.accounts.importDone"), {
            description: t("trae.page.accounts.importSummary", {
              added: result.imported,
              overwritten: result.overwritten,
              skipped: result.skipped,
            }),
          });
          void loadAll();
        }}
      />

      {/* 统一重启确认（P8 T03 / §3.15.3）：TraeWork / TraeCode 切换先关再开 ⇒ 与 WorkBuddy /
          CodeBuddy IDE 走**同一条**流程。`restart` 映射到 `api.traeSwitchAccount` 的 `launch`。 */}
      <RestartConfirmDialog
        open={switchConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchConfirm(null);
        }}
        clientLabel={switchConfirm?.label ?? ""}
        isCli={false}
        onConfirm={(restart) => {
          const target = switchConfirm;
          setSwitchConfirm(null);
          if (target) void doSwitchTo(target.userId, target.variant, target.label, restart);
        }}
      />

      {/* 删除确认 */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("trae.page.accounts.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("trae.page.accounts.deleteBody", {
                name: pendingDelete?.name || pendingDelete?.userId || t("trae.page.accounts.unknownAccount"),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("trae.page.accounts.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy?.startsWith("delete-")}
              onClick={() => {
                const target = pendingDelete;
                if (!target) return;
                setPendingDelete(null);
                void performDelete(target);
              }}
            >
              {t("trae.page.accounts.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 账号详情抽屉（P4）：共享壳 + 本页装配的 sections / packs / programs。 */}
      <AccountDetailDrawer
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailAccount(null);
            setDetailTab(null);
          }
        }}
        // 页签记忆的身份键：`scope:userId`（国内版 / 国际版的同一个 userId 是两个账号）。
        accountKey={detail ? `${scope}:${displayText(detail.userId) ?? ""}` : ""}
        initialTab={detailTab}
        name={detailName}
        subtitle={
          detail
            ? t("trae.comp.card.detail.subtitle", {
                name: detailName,
                uid: displayText(detail.userId) ?? "—",
              })
            : ""
        }
        avatarSeed={detailName}
        /* ★ 以下五项是**补齐**的（此前 Trae 只注入 packs/sections/programs/remark）——
           它们让共享抽屉在两个分区里内容一致：当前登录徽章 / 切换到此账号 / 操作区 / 签到历史 / 签到积分。

           ⚠️ 不传 `loading`：Trae 的抽屉数据（积分包 / 信息区块）全部来自**已加载**的账号对象，
           没有 WorkBuddy 那种「打开抽屉才逐账号拉积分」的懒加载 ⇒ 没有「未就绪」这个态。
           传一个恒 `false` 的值只会让下一个人以为这里有异步加载。
           ⚠️ 不传 `onWizardSwitch`：那是 WorkBuddy 的「会话复制向导」，Trae 没有会话复制能力
           （`PLAN` §3.15.1）—— 摆一个点不开的向导比不摆更差。 */
        current={detailIsCurrent}
        switchTargets={detailSwitchTargets}
        actions={detailActions}
        checkinHistory={detailCheckinHistory}
        checkin={detailCheckin}
        credential={detailCredential}
        packs={detailPacks}
        stats={detailStats}
        snapshots={detailSnapshots}
        refreshingKinds={detail ? refreshBusy.kindsOf(detail.userId) : []}
        onRefreshPart={detail ? (kind) => void onRefreshPart(detail, kind) : undefined}
        /* ★ 2026-10-26：把「本平台能刷哪些项」交给抽屉 —— 积分页签据此**常驻**
           （没有包明细时给空态 + ⟳，而不是整个页签消失）。 */
        refreshKinds={TRAE_REFRESH_KINDS}
        sections={detailSections}
        programs={detailPrograms}
        remark={detailRemark}
        onSaveRemark={detail ? (remark) => saveRemark(detail, remark) : undefined}
        /* ★ 2026-10-26（用户报障「没有分组功能」）：分组是**实体**（id + 名称），
           抽屉收「组名」、页面负责落到 id 上（见 `saveGroupFor`）。
           候选列表给的是全部组名 —— 用户要能看见「已经有哪些组」，避免打成三种写法。 */
        group={detail ? groupNameOf(detail) ?? "" : ""}
        groups={groups.map((group) => group.name)}
        onSaveGroup={detail ? (name) => saveGroupFor(detail, name) : undefined}
        /* ★ 与 WorkBuddy 抽屉**同一取值**：WB 侧不传（默认 `false`），这里显式写 `false`。
           ⚠️ 此前 Trae 传 `api.isDemoMode()` ⇒ 演示构建里 Trae 抽屉的备注**不可编辑**、WB 可编辑。 */
        featuresDisabled={false}
        empty={{
          title: t("shared.drawer.empty.title"),
          description: t("shared.drawer.empty.description"),
          action: (
            <Button
              size="sm"
              variant="outline"
              disabled={recheckDrawerBusy}
              onClick={() => void runRecheckDrawer(() => loadAll())}
            >
              {recheckDrawerBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("trae.page.accounts.emptyRecheck")}
            </Button>
          ),
        }}
      />

      {/* 批量删除确认（桌面 App 不支持 window.confirm）。 */}
      <Dialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <DialogContent className="sm:max-w-md">
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

      {/* 回收站（P5 §2.7.1）：恢复 = 移回 live ⇒ 成功后重取快照，让恢复的账号立刻回到列表。 */}
      <RecycleBinSheet
        open={recycleOpen}
        onOpenChange={setRecycleOpen}
        scope={scope}
        onRestored={() => void loadAll()}
      />
    </div>
  );
}

/**
 * 空态卡：与 WorkBuddy 的 `EmptyRegionCard` 同构（可能原因 + 期望产物 + 动作）。
 *
 * ## 文案必须说实话：旧版说「登录一次即可自动识别」，那是错的
 *
 * 这张卡原先写着「Cloud-IDE-JWT 存放在该目录下，登录一次 Trae 后即可自动识别」，
 * 并把「从本机导入」作为**主**按钮。但实测 Trae 1.107.1 已改为**加密存储**凭据
 * （`storage.json` / `state.vscdb` / `Local Storage\leveldb` 里都搜不到明文
 * `Cloud-IDE-JWT`），本机导入在这条产品线上**注定失败**。
 *
 * 于是用户看到的正是那句文案：明明已经登录，却怎么都识别不到——这不是探测 bug，
 * 是我们给了一条走不通的路还写了包票。现在把 OAuth 登录提为主入口，
 * 并把本机导入的真实适用范围讲清楚。
 */
function EmptyTraeCard({
  installed,
  dataDir,
  dataDirExists,
  onRecheck,
  onImport,
  onOAuth,
  onLaunch,
  importing,
  launching,
}: {
  installed: boolean;
  /**
   * **当前区域**的客户端数据目录（后端 `platform::select_data_dir_for`）。
   *
   * 不能传 `get_trae_env` 那份 —— 它走 `detect_data_dir()`（**横跨全部产品线**
   * 的全局探测），在区域页里会显示**另一条产品线**的目录名
   * （实测：国际版页签显示 `TRAE SOLO CN`），且本机一个候选都不存在时它会
   * 回落到候选表首项，把一个**根本不存在**的路径说成「已探测」。
   */
  dataDir: string | null;
  dataDirExists: boolean;
  onRecheck: () => void | Promise<void>;
  onImport: () => void;
  onOAuth: () => void;
  onLaunch: () => void;
  importing: boolean;
  launching: boolean;
}) {
  const t = useT();
  /** 「重新检测」的进行中态（最小展示 500ms，本地探测快于 500ms 时也能看见转圈）。 */
  const { busy, run } = useRefreshAction();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 px-5 py-5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{t("trae.page.accounts.emptyTitle")}</h2>

          <div className="mt-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground/80">{t("trae.page.accounts.emptyReasons")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>{t("trae.page.accounts.emptyReasonNotInstalled")}</li>
              {installed && <li>{t("trae.page.accounts.emptyReasonNoSession")}</li>}
              <li>
                <span className="text-foreground/80">{t("trae.page.accounts.emptyReasonEncryptedLead")}</span>
                {t("trae.page.accounts.emptyReasonEncryptedMid")}
                <code className="mx-1 rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">storage.json</code>
                {t("trae.page.accounts.emptyReasonEncryptedTail")}
              </li>
              <li>{t("trae.page.accounts.emptyReasonEmpty")}</li>
            </ul>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3.5 py-3">
            <p className="text-sm text-foreground/80">
              <span className="font-medium">{t("trae.page.accounts.emptyRecommendLabel")}</span>
              {t("trae.page.accounts.emptyRecommendBody")}
            </p>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={onOAuth}>
              <QrCode />
              {t("trae.page.accounts.oauthLogin")}
            </Button>
            {/* 启动客户端是「客户端从没启动过 ⇒ 没有设备凭证」的唯一解。
                放在这里而不是只放在 OAuth 弹窗里：本空态的「尝试从本机导入」
                同样依赖客户端数据目录，两个入口的前置条件是一样的。 */}
            <Button size="sm" variant="outline" onClick={onLaunch} disabled={launching}>
              {launching ? <Loader2 className="animate-spin" /> : <Rocket />}
              {t("trae.page.accounts.emptyLaunchClient")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => onRecheck())}
            >
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("trae.page.accounts.emptyRecheck")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onImport}
              disabled={importing}
              title={t("trae.page.accounts.emptyImportHint")}
            >
              {importing ? <Loader2 className="animate-spin" /> : <Download />}
              {t("trae.page.accounts.emptyImportTry")}
            </Button>
          </div>

          <div className="mt-4">
            {/* 目录不存在时不许写「已探测」——拿一个并不存在的路径当「探测结果」
                会把用户引向「文件在、只是读不出」，而真相是客户端从没启动过。 */}
            <p className="text-sm font-medium text-foreground/80">
              {dataDirExists ? t("trae.page.accounts.emptyDetectedDir") : t("trae.page.accounts.emptyExpectedDir")}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {dataDir ? `${dataDir}\\User\\globalStorage\\storage.json` : t("trae.page.accounts.emptyNoDataDir")}
              </code>
              {!dataDirExists && (
                <span className="text-xs text-warning">
                  {t("trae.page.accounts.dataDirMissing")}
                </span>
              )}
            </div>
            {dataDirExists && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("trae.page.accounts.emptyDirNote")}
              </p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** 添加账号对话框：粘贴 JWT + 可选分组。 */
function AddAccountDialog({
  open,
  onOpenChange,
  groups,
  variant,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: TraeAccountsOverview["groups"];
  /** 写进哪个产品线的账号库。 */
  variant: TraeVariantId;
  onAdded: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [jwt, setJwt] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!jwt.trim()) {
      toast.error(t("trae.page.accounts.needJwt"));
      return;
    }
    setSaving(true);
    try {
      await api.traeAddAccount(name.trim(), jwt.trim(), groupId || null, variant);
      toast.success(t("trae.page.accounts.accountAdded"));
      setName("");
      setJwt("");
      setGroupId("");
      onOpenChange(false);
      onAdded();
    } catch (e) {
      toast.error(t("trae.page.accounts.addFailed"), { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("trae.page.accounts.addDialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("trae.page.accounts.addDialogDesc")}
            <br />
            <span className="text-foreground/80">
              {t("trae.page.accounts.addDialogNote")}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="trae-jwt">JWT</Label>
            <Input
              id="trae-jwt"
              value={jwt}
              onChange={(event) => setJwt(event.target.value)}
              placeholder="Cloud-IDE-JWT eyJ…"
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trae-name">{t("trae.page.accounts.addDialogName")}</Label>
            <Input id="trae-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("trae.page.accounts.addDialogNamePlaceholder")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="trae-group">{t("trae.page.accounts.addDialogGroup")}</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger id="trae-group" className="w-full">
                <SelectValue placeholder={t("trae.page.accounts.ungroupedPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("trae.page.accounts.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {t("trae.page.accounts.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
