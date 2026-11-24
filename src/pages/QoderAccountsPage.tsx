/**
 * Qoder 账号页。
 *
 * ## 与原型的关系（`buddy-switch-prototype.html` 是唯一原型）
 *
 * 原型的账号页是**平台无关的工作台**：`viewAccounts()`（工具栏一行：搜索 / 排序 / 分组 /
 * 视图切换 / 全选 / 添加账号）+ `accountCard()`（勾选 → 整卡可点开详情 → 页脚更多菜单）
 * + `drawerAccount()`（详情抽屉：账号信息 / 备注编辑 / 操作区含删除）+ `batchBarHtml()`
 * （批量条）。本页**逐件复用**了共享壳 —— `AccountWorkbench`（工具栏 / 批量条 / 空态 /
 * 分桶 / 卡片栅格与表格切换）、`AccountDetailDrawer`、`AddAccountDrawer`、
 * `RecycleBinSheet`、`ImportAccountsDialog`、`ExportAccountsDialog` —— 与
 * `AccountsPage`（WB）/ `TraeAccountsPage` 是**同一条交互链**，差异只有数据。
 *
 * ## ★ 备注编辑在**抽屉**里（不在卡上）
 *
 * 与原型 `drawerAccount(id, editing)` 同构：卡片点开抽屉 → 抽屉里「编辑备注」→
 * 就地输入 + 保存 / 取消。卡片**不再堆按钮**（原型 `acct-more` 的明说：
 * 「操作都在账号抽屉里 —— 点账号卡打开抽屉即可操作」）。
 *
 * ## 与后端能力的对齐（缺的就不渲染，绝不摆假控件）
 *
 * 2026-10-15 本轮把三块「后端早就绪、前端没接线」的能力补齐，并新增两块：
 *
 * | 能力 | 落点 |
 * |:--|:--|
 * | **OAuth 设备授权** | 添加抽屉第一张卡 → `QoderOAuthDialog`（后端 PKCE S256 设备流） |
 * | **回收站**（软删除） | 工具栏回收站按钮 → 共用 `RecycleBinSheet`；删除文案随之改 |
 * | **导入 / 导出备份** | 添加抽屉「导入备份」卡 + 抽屉 / 批量条的「导出」 |
 * | **签到 / 额度** | 卡片指标行（积分）+ 状态槽（今日已签 / 未签）+ 抽屉签到区与积分包 + 批量签到 |
 *
 * 仍**不渲染**的：程序位胶囊（Qoder 的「切换客户端登录态」尚未落地）。
 * （★ 2026-10-27：`expiresAt` 已在 core 归一成 Unix 毫秒，凭据到期可在详情展示。）
 *
 * ## 两处刻意的加载策略
 *
 * 1. **账号列表与「额度 / 签到」分开加载**：前者是本地文件（快），后者要打上游（慢，且
 *    可能失败）。串在一起会让「上游 401」变成「整页打不开」——而账号列表本来是可读的。
 * 2. **额度 / 签到失败只影响那两块**：不弹错误条、不清空列表，卡片自然回落成
 *    「没有积分指标 / 状态槽显示凭据可用」。**未知不伪装成已知**。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Globe,
  KeyRound,
  Loader2,
  PackageSearch,
  Plus,
  RefreshCw,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";

import {
  AccountDetailDrawer, DetailStat,
  type DetailActions,
  type DetailCredential,
  type DetailPack,
  type DetailSwitchTarget,
} from "@/components/account-detail-drawer";
import type { DrawerTab } from "@/lib/drawer-tab-preference";
import {
  AccountMoreMenu,
  AccountMoreMenuDemo,
  type AccountCheckinState,
} from "@/components/account-more-menu";
import type { AccountColumn } from "@/components/account-table";
import { AccountsTableAvatar } from "@/components/account-list-parts";
import { AccountWorkbench } from "@/components/account-workbench";
import { AddAccountDrawer } from "@/components/add-account-drawer";
import { ExportAccountsDialog } from "@/components/export-accounts-dialog";
import { ImportAccountsDialog } from "@/components/import-accounts-dialog";
import { RecycleBinSheet } from "@/components/recycle-bin-sheet";
import { RestartConfirmDialog } from "@/components/restart-confirm-dialog";
import {
  QoderAccountCard,
  QoderForeignBadge,
  QoderStatusChips,
  qoderAccountName,
  qoderSourceLabel,
  type QoderCheckinDisplay,
} from "@/components/qoder/qoder-account-card";
import { QoderLocalSourceRow } from "@/components/qoder/qoder-local-source-row";
import { QoderOAuthDialog } from "@/components/qoder/qoder-oauth-dialog";
import { ScopeChip, scopeLabel } from "@/components/scope-chip";
import { SwitchProgressBanner } from "@/components/switch-progress-banner";
import { SyncIndicator } from "@/components/sync-indicator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClientlessStrip } from "@/components/clientless-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/api";
import type {
  CheckinStatusEntry,
  QoderAccountView,
  QoderCheckinRow,
  QoderCreditsRow,
  QoderLocalSourcesView,
  QoderProgramStatus,
} from "@/lib/api";
import { accountSearchText } from "@/lib/account-search";
import {
  filterAccounts,
  groupAccounts,
  sortAccounts,
  type AccountComparator,
  type AccountGroupKey,
  type AccountListConfig,
  type AccountSortKey,
  type AccountViewMode,
} from "@/lib/account-list-view";
import { formatAbsoluteTime } from "@/lib/catalog-source";
import { formatDate } from "@/lib/format";
import {
  PACKS_TTL_MS,
  packSourceLabel,
  packState,
  packUnavailableCopy,
  visibleQoderPacks,
} from "@/lib/qoder-packs";
import {
  QuickActionButton,
  QuickRefreshAction,
  quickRefreshCoolingDown,
  startQuickRefreshCooldown,
} from "@/components/account-quick-actions";
import { CheckinIcon } from "@/lib/semantic-icons";
import { displayText } from "@/lib/display-text";
import { demoModeEnabled } from "@/lib/demo-mode";
import {
  ACCOUNT_CHIP_CLASS,
  CredentialExpiryMeta,
  ProgramSlotChip,
  creditMetricTip,
  drawerTabOpenAria,
  expiryTooltipLines,
  formatCredits,
  nextExpiryLabel,
} from "@/components/account-card";
import { Badge } from "@/components/ui/badge";
import {
  readQoderCreditCache,
  writeQoderCreditCacheEntries,
  type CachedQoderCredit,
} from "@/lib/credit-cache";
import { isExpiryUrgent, summarizeExpiry } from "@/lib/credit-expiry";
import { REFRESH_DONE_LABEL, useAccountRefreshBusy, type AccountRefreshKind } from "@/lib/account-refresh";
import { mapWithConcurrency } from "@/lib/concurrency";
import { useT } from "@/lib/i18n";
import { platformDescriptor, platformOfPath, type Product } from "@/lib/platforms/registry";
import { scopeOf, type Scope } from "@/lib/scope";
import { useSwitchProgress, waitForClientRunning } from "@/lib/switch-progress";
import type { Region } from "@/lib/types";
import { useScope } from "@/lib/use-scope";
import { useMediaQuery } from "@/lib/use-media-query";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { useCachedResource } from "@/lib/use-cached-resource";
import { useCheckinStatusFill } from "@/lib/use-checkin-status-fill";
import { useVisibleRevalidate } from "@/lib/use-visible-revalidate";

/** ISO-8601 → 毫秒时间戳（解析不了给 `null` ⇒ 调用方**省掉那一行**，不显示 1970）。 */
const stampToMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
};

/**
 * 本地签到台账的**初值条目**（上游读数缺席 / 读取失败时用）。
 *
 * 与 Trae 的 `account.checkedToday` 同一口径：本地盖章就是今天 ⇒ 敢断言「已签到」；
 * 更早的盖章**不能**说明今天签没签 ⇒ 返回 `undefined`，保持「未知」（不伪装成未签到）。
 *
 * ⚠️ 条目标 `source: "ledger"`：指标块据此写「按本地台账（刷新签到状态可向上游确认）」，
 * 绝不把它说成上游答案。
 */
function ledgerCheckinEntry(account: QoderAccountView | undefined): CheckinStatusEntry | undefined {
  if (!account?.lastCheckinToday) return undefined;
  return { ok: true, todayCheckedIn: true, source: "ledger" };
}

/** 批量签到 / 批量刷新的失败项（`uid` 用于只重试失败项，`name` 用于展示）。 */
interface FailedItem {
  uid: string;
  name: string;
}

/**
 * 额度 / 签到 / 程序位的**上次成功快照**（按作用域隔离）。
 *
 * 这三份数据是页面私有 state，且带「部分失败保留旧值」的合并语义，搬进通用
 * `useCachedResource` 会改变失败规则。这里只做**首屏占位**：重挂载先渲染上次结果，
 * 同时照常向后台上游请求 —— 请求次数与失败语义都不变，只消除「空白等几十秒」。
 */
interface QoderEnrichmentSnapshot {
  credits: Record<string, QoderCreditsRow>;
  checkinRows: Record<string, QoderCheckinRow>;
  checkinUnavailable: boolean;
  programs: QoderProgramStatus[] | null;
}
const enrichmentCache = new Map<string, QoderEnrichmentSnapshot>();

/**
 * 三路快照的**短新鲜窗口**：窗口内重挂载不重复打上游。
 *
 * 额度与签到都是真上游请求（签到链路的身份探测还可能跑本机组件），
 * 切到别的页再切回来就再等一轮没有意义。写操作 / 用户主动刷新必须传
 * `force` 绕开窗口，保证变更后立刻拿到新值。
 */
const ENRICHMENT_FRESH_MS = 30_000;
const enrichmentFetchedAt = new Map<string, number>();

/**
 * Qoder 账号页 —— 作用域外壳。
 *
 * 按**完整作用域**渲染带 `key` 的内容面板（`docs/specs/P4-TOOLBAR-ARCH.md` §1.11①）：
 * 查询 / 排序 / 分组 / 视图 / 勾选 / 已打开的抽屉 / 刷新结果条都随作用域重挂载，
 * 而不是逐项清理。Qoder 的账号 id（uid）**不带区域命名空间**，同一 uid 在两条线
 * 是两个账号 ⇒ 只换 prop 不换实例会把 A 区的勾选、抽屉和积分显示到 B 区。
 */
export default function QoderAccountsPage() {
  const location = useLocation();
  const product = platformOfPath(location.pathname);
  const [region] = useScope(product);
  const scope = scopeOf(product, region);
  return <QoderAccountsPanel key={scope} product={product} region={region} scope={scope} />;
}

/** 作用域内复用只读列表快照，交互状态随面板卸载清理。 */
function QoderAccountsPanel({
  product,
  region,
  scope,
}: {
  product: Product;
  region: Region;
  scope: Scope;
}) {
  const t = useT();

  // 来源探测不阻塞本地列表；缓存按完整作用域隔离，返回页面时直接复用快照。
  const accountResource = useCachedResource(`qoder:accounts:${scope}`, () => api.getQoderAccounts(scope));
  /* 后台保活会直接改写账号库；定时重取账号列表，让「已过期 / 需重新登录」自愈。 */
  useVisibleRevalidate(accountResource.revalidate);
  const sourceResource = useCachedResource(`qoder:local-sources:${scope}`, () => api.getQoderLocalSources(scope));
  const accounts = useMemo(
    () => accountResource.data?.accounts ?? (accountResource.loading ? null : []),
    [accountResource.data, accountResource.loading],
  );
  const sources = sourceResource.data ?? null;
  const error = accountResource.error ?? sourceResource.error ?? "";
  const refreshAccounts = accountResource.refreshWithResult;
  const refreshSources = sourceResource.refreshWithResult;
  const [importing, setImporting] = useState(false);

  /* ── 额度 / 签到（**上游调用**，与账号列表分开加载；见文件头「加载策略」） ── */
  const cachedEnrichment = enrichmentCache.get(scope);
  const [credits, setCredits] = useState<Record<string, QoderCreditsRow>>(
    () => cachedEnrichment?.credits ?? {},
  );
  /**
   * 跨重启的**展示层**额度缓存（`localStorage`）。
   *
   * 只用于卡片 / 表格首屏占位；排序、优先级、抽屉实时值仍读 `credits`。
   * 每条都带写入时刻 ⇒ 展示时必须补「上次读数 · N 分钟前」。
   */
  const [cachedCredits, setCachedCredits] = useState<Record<string, CachedQoderCredit>>({});
  const [checkinRows, setCheckinRows] = useState<Record<string, QoderCheckinRow>>(
    () => cachedEnrichment?.checkinRows ?? {},
  );
  /**
   * 区域签到快照是否**本轮已经尝试过**（成功 / 失败都算）—— 抽屉的按需补取要等它落地，避免重复请求。
   *
   * ⚠️ 初值**不能**看 `enrichmentCache` 有没有条目（spec §11 的契约是「已尝试过」）。
   * 快照缓存只代表「上次会话读到过」，不代表这一轮的区域请求已经回来：
   * 拿它当 `true`，缓存里恰好没有某账号的签到行时，抽屉会立刻补发
   * `qoder_checkin_status_map([uid])`，与在途的区域快照并发多打一轮上游。
   * 缓存只用于 `credits` / `checkinRows` 的**初值占位**（上面两行）。
   */
  const [checkinLoaded, setCheckinLoaded] = useState(false);
  /** 本区域签到通道是否未开放（`qoder_checkin_status.unavailable`）—— 菜单要如实说「未开放」。 */
  const [checkinUnavailable, setCheckinUnavailable] = useState(
    () => cachedEnrichment?.checkinUnavailable ?? false,
  );
  /* 程序位状态（只读）：决定页脚程序位行、「当前登录」徽章与「切换到此账号」的可用性。 */
  const [programs, setPrograms] = useState<QoderProgramStatus[] | null>(
    () => cachedEnrichment?.programs ?? null,
  );
  /**
   * 额度 / 签到 / 程序位这一轮是否在飞 —— 页头「正在同步…」判据之一。
   *
   * 不需要「哪一路」的粒度：页头只回答「在同步吗」，逐值反馈归卡片自己。
   */
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  /**
   * 页头同步指示的总判据。
   *
   * ⚠️ 账号列表 / 本机来源用资源缓存的 `pending`（`loading` 只是骨架屏判据，
   * 有旧值时恒为 false）；额度那一路是页面自己的 state（见 `loadEnrichment`）。
   * 三者任一在飞都算「正在同步」，否则用户看到的仍是「几秒后突然刷新」。
   */
  const syncing = accountResource.pending || sourceResource.pending || enrichmentLoading;

  /* ── 视图参数（页内 state，不进 URL、不进全局 store —— `account-list-view.ts` 的纪律） ── */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AccountSortKey>("priority");
  const [group, setGroup] = useState<AccountGroupKey>("none");
  const [view, setView] = useState<AccountViewMode>("card");
  const tableEnabled = useMediaQuery("(min-width: 900px)");
  const searchRef = useRef<HTMLInputElement>(null);

  /* ── 选择（批量） ── */
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /* ── 抽屉 / 弹层 ── */
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [patOpen, setPatOpen] = useState(false);
  const [oauthOpen, setOauthOpen] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTargets, setExportTargets] = useState<QoderAccountView[] | null>(null);
  const [detail, setDetail] = useState<QoderAccountView | null>(null);
  /**
   * 逐包明细（issue #111）：按 uid 缓存。
   *
   * ⚠️ 与 `credits` **并存、不互替**：`credits` 是 openapi 的聚合三标量（任何形态都有），
   * 逐包要走网页会话（仅桌面端 + 需登录一次）。拿不到逐包时**回落聚合行**，
   * 绝不显示空区块 —— 那是「不知道」伪装成「没有」。
   */
  const [webPacks, setWebPacks] = useState<Record<string, api.QoderWebCreditPacks>>({});
  /** 正在取逐包的账号（浮层里显示「读取中」而不是「未登录」）。 */
  const [packsLoading, setPacksLoading] = useState<Record<string, boolean>>({});
  /** 每账号上次取数时刻（TTL 用 ref：改它不该触发重渲染）。 */
  const packsFetchedAt = useRef<Record<string, number>>({});
  /**
   * 聚合额度的最新值。
   *
   * `loadPacks` 是异步回调，闭包里的 `credits` 可能已过期；补取判断必须读 ref。
   */
  const creditsRef = useRef(credits);
  useEffect(() => {
    creditsRef.current = credits;
  }, [credits]);
  /** 单账号聚合额度补取的进行中集合（逐包与聚合是两条独立通道）。 */
  const creditFetchInflight = useRef<Set<string>>(new Set());

  /* 切换区域（Qoder CN ↔ 国际版）时清空逐包缓存：UID 在两个区域可能相同，
     不清会把上一个区域的包/到期日显示到当前账号上。 */
  useEffect(() => {
    setWebPacks({});
    setPacksLoading({});
    packsFetchedAt.current = {};
  }, [scope]);
  /** 本次打开要直达的页签（`null` = 按账号记忆）。只在本次打开生效，关闭即清。 */
  const [detailTab, setDetailTab] = useState<DrawerTab | null>(null);
  const [detailAutoEditRemark, setDetailAutoEditRemark] = useState(false);
  const [detailAutoEditGroup, setDetailAutoEditGroup] = useState(false);
  /** 待确认的切换（账号 × 程序位）。 */
  const [switchTarget, setSwitchTarget] = useState<{ account: QoderAccountView; program: QoderProgramStatus } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  /** 切换 / 启动客户端的长任务状态（页头状态条，见 `switch-progress-banner.tsx`）。 */
  const switchProgress = useSwitchProgress();
  const [pendingDelete, setPendingDelete] = useState<QoderAccountView | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);

  /** 批量动作 / 删除的进行中态（**按钮态**，与区块加载态分家）。 */
  const [busy, setBusy] = useState(false);
  /**
   * 页头「一键」动作的进行中标识（与 `busy` 分开：一键作用于全部账号、批量作用于勾选账号，
   * 共享一个布尔会让批量条的按钮跟着一起转，用户分不清是哪一个在跑）。
   */
  const [quickBusy, setQuickBusy] = useState<"refresh" | "checkin" | null>(null);
  /** 批量续期凭据进行中（与 `busy` 分开：批量条要单独给「续期凭据」转圈）。 */
  const [renewBusy, setRenewBusy] = useState(false);
  /**
   * 续期进行中的账号集合（菜单项忙态）。
   *
   * ★ 用集合而不是单个 uid：批量续期有 3 个并发，单值只能表示最后一个 uid，
   * 其余在途账号的菜单项会显示成「可点」—— 那是在骗用户。
   */
  const [renewingUids, setRenewingUids] = useState<ReadonlySet<string>>(() => new Set());
  /** 批量签到结果条（含失败项，可只重试失败项）。`null` = 不渲染。 */
  /* 五档：成功数 / 不可签到 / **未到签到时间** / 失败 / 未处理（协作式取消后没发出的）。 */
  const [checkinResult, setCheckinResult] = useState<{
    /** 本次**真领到**的账号数（不含「今日已签、此前领过」那一档）。 */
    okCount: number;
    /** 确认今日已签、但本轮没有实际领取的账号数（此前在别处 / 更早领过）。 */
    alreadyCount: number;
    /** 本次**真领到**的额度合计（活动通道；只作展示，不参与成败判定）。 */
    earned: number;
    disabled: FailedItem[];
    /** `disabled` 中由「上游未下发活动」构成的条数（等于总数才讲资格原因）。 */
    disabledMissing: number;
    /** 每日 10:00 窗口还没开 / 活动尚未刷新：跳过且不发起领取，既不是成功也不是失败。 */
    notStarted: FailedItem[];
    failed: FailedItem[];
    unprocessed: FailedItem[];
  } | null>(null);

  /** 失败态「重新检测」按钮的进行中态（操作进行中 ⇒ 按钮内 Loader2）。 */
  const { busy: refreshBusy, run } = useRefreshAction();

  /**
   * 辅助读取可能重叠，旧响应不得覆盖更新的结果；账号列表由资源缓存处理同类竞态。
   */
  const enrichmentSeq = useRef(0);

  /**
   * 组件是否仍挂载（切换作用域即卸载）。
   *
   * 卸载时**中止尚未开始的批处理**，并让在途批次的收尾不再弹 toast ——
   * 否则用户切到另一条产品线后，还会收到上一条线的「已续期 N 个」。
   * 已发出的写请求仍会跑完（协作式取消），但它们的结果只属于原作用域，不回灌新页面。
   */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      batchAbortRef.current?.abort();
    };
  }, []);

  /** 同 uid 续期的在途 Promise（菜单 / 详情 / 批量共用，避免重复消耗续期材料）。 */
  const renewInFlightRef = useRef(new Map<string, Promise<void>>());

  /** 写操作后强制回读两份资源，任一失败或被取代均不回报成功。 */
  const reload = useCallback(async () => {
    const results = await Promise.all([refreshAccounts(), refreshSources()]);
    return results.every((result) => result.ok);
  }, [refreshAccounts, refreshSources]);

  /** 把成功读数写进跨重启展示缓存（失败行不落盘，避免把抖动固化成「上次读数」）。 */
  const rememberCredits = useCallback(
    (rows: readonly QoderCreditsRow[]) => {
      if (rows.length === 0) return;
      const now = Date.now();
      setCachedCredits((prev) => {
        const next = { ...prev };
        for (const row of rows) if (row.ok) next[row.uid] = { at: now, value: row };
        return next;
      });
      writeQoderCreditCacheEntries(scope, rows);
    },
    [scope],
  );

  /**
   * 拉额度 / 签到 / 程序位（三路互不依赖）。
   *
   * ⚠️ 每路独立结算：**一条失败不该拖垮另一条，也不该拖慢另一条**
   * （区域未开放签到 ≠ 额度也拿不到；本机程序位更不能等上游）。失败时
   * **保持上一份快照**（不清空）—— 清空会把「暂时取不到」显示成「没有额度」。
   */
  const loadEnrichment = useCallback(async (options?: { force?: boolean }) => {
    /* ★ 新鲜窗口：本轮快照刚成功落地过，重挂载/切回作用域直接用内存值，
       不再打一轮上游（签到链路的身份探测冷启动要数秒）。
       `checkinLoaded` 同步置位，抽屉的按需补取不会被这个「跳过」永久挂起。 */
    if (
      !options?.force &&
      enrichmentCache.has(scope) &&
      Date.now() - (enrichmentFetchedAt.get(scope) ?? 0) < ENRICHMENT_FRESH_MS
    ) {
      setCheckinLoaded(true);
      return;
    }

    const request = ++enrichmentSeq.current;
    const live = () => request === enrichmentSeq.current;
    /**
     * 页头「正在同步…」的额度 / 签到 / 程序位这一路。
     *
     * 账号列表有自己的资源缓存（`pending`），但额度与签到是**上游请求**（实测 ~4s），
     * 它们的落地此前完全静默 —— 卡片上的数字就是「几秒后突然变」。
     * 收尾放在 `finally` 且**只有本轮仍是最新**才清（见下），避免被取代的一轮
     * 把新请求的提示一起关掉。
     */
    setEnrichmentLoading(true);

    /**
     * ★ 分层落地，不再等 `Promise.allSettled` 齐活。
     *
     * 三路快慢差很大：程序位是本机文件探测（毫秒级），积分 / 签到是上游请求
     * （实测 ~4s）。旧实现等三路全部结束才一起 setState ⇒ 本地的「程序位 / 当前登录」
     * 被最慢的上游层拖到同一刻才显示。现在谁先回来谁先落地；模块级快照仍在
     * 三路都结束后**整批**写（§12.7 的「同一时刻的三份数据」约束不变）。
     */
    const programTask = api.qoderProgramStatus(scope).then(
      (view) => {
        if (!live()) return null;
        const next = view.programs ?? [];
        setPrograms(next);
        return next;
      },
      () => null,
    );
    const creditTask = api.qoderCredits(scope).then(
      (view) => {
        if (!live()) return null;
        const next = Object.fromEntries(view.accounts.map((row) => [row.uid, row]));
        setCredits(next);
        rememberCredits(view.accounts);
        return next;
      },
      () => null,
    );
    const checkinTask = api.qoderCheckinStatus(scope).then(
      (view) => {
        if (!live()) return null;
        const next = Object.fromEntries(view.accounts.map((row) => [row.uid, row]));
        const unavailable = Boolean(view.unavailable);
        /* ★ `checkinLoaded` 的契约是「本轮区域快照**已尝试过**」：成功与失败都要置位，
           否则抽屉的按需补取会永远等一个不会来的快照。 */
        setCheckinLoaded(true);
        setCheckinRows(next);
        setCheckinUnavailable(unavailable);
        return { rows: next, unavailable };
      },
      () => {
        if (!live()) return null;
        setCheckinLoaded(true);
        return null;
      },
    );

    const [nextPrograms, nextCredits, nextCheckin] = await Promise.all([
      programTask,
      creditTask,
      checkinTask,
    ]).finally(() => {
      /* 只有「仍是本轮最新」时才收尾：被取代的那一轮若清标志，
         会把接替它的新请求的「正在同步」一起关掉。 */
      if (live()) setEnrichmentLoading(false);
    });

    /* 被更新的读取取代 ⇒ 不再写快照（已落地的 state 由新请求覆盖）。 */
    if (!live()) return;

    /* 只有真拿到至少一层结果才刷新快照：整批失败时保留旧缓存，下次重挂载仍有东西可看。 */
    if (nextPrograms || nextCredits || nextCheckin) {
      const previous = enrichmentCache.get(scope);
      enrichmentCache.set(scope, {
        credits: nextCredits ?? previous?.credits ?? {},
        checkinRows: nextCheckin?.rows ?? previous?.checkinRows ?? {},
        checkinUnavailable: nextCheckin?.unavailable ?? previous?.checkinUnavailable ?? false,
        programs: nextPrograms ?? previous?.programs ?? null,
      });
      /* 额度与签到两路都完成（对象非空）才开新鲜窗口：
         任一失败时保持旧语义 —— 下次重挂载仍会重试，不让失败被缓存 30 秒。 */
      if (nextCredits && nextCheckin) enrichmentFetchedAt.set(scope, Date.now());
    }
  }, [rememberCredits, scope]);

  const hasAccounts = accounts !== null && accounts.length > 0;

  /** 手动刷新写入了更新的读数 ⇒ 作废新鲜窗口，避免重进页面被窗口挡成旧值。 */
  function invalidateEnrichmentFreshness() {
    enrichmentFetchedAt.delete(scope);
  }

  /* 首屏从落盘缓存取上次成功读数（只补「实时值还没到」的账号）。 */
  useEffect(() => {
    if (!hasAccounts) {
      setCachedCredits({});
      return;
    }
    const ids = (accounts ?? []).map((account) => account.uid);
    const cached = readQoderCreditCache(scope, ids);
    setCachedCredits((prev) => {
      const next = { ...prev };
      for (const [uid, entry] of Object.entries(cached)) next[uid] = entry;
      return next;
    });
  }, [accounts, hasAccounts, scope]);

  useEffect(() => {
    if (!hasAccounts) {
      // 空库时清掉旧快照：切到另一个区域后残留上一个区域的额度 = 撒谎。
      setCredits({});
      setCheckinRows({});
      setCheckinUnavailable(false);
      setPrograms(null);
      setEnrichmentLoading(false);
      return;
    }
    void loadEnrichment();
  }, [hasAccounts, loadEnrichment]);

  /** `/` 键聚焦搜索框（与另两平台同一条规则）；在输入框里打字时不劫持。 */
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
   * P6：命令面板跳过来的 **`?q=` 一次性种子** —— 读一次播种页内搜索 state，
   * 随后 `replace` 清参（视图参数留页内）。`seededRef` 保证只读一次。
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

  /* ── 取数后的派生数据 ── */

  const rows = accounts ?? [];
  const attentionCount = rows.filter(
    (a) => !a.hasCredential || a.credential.unrecognized || a.domainMismatch,
  ).length;
  const foreignAccounts = rows.filter((a) => a.domainMismatch);

  /**
   * 列表配置 —— 差异**全部以数据表达**（共享组件里不写平台判断）。
   *
   * 排序键与 WB / Trae **同一套口径**：
   * - `priority` = **积分优先级**：额度到期最近的先用，同到期按剩余积分降序；无额度数据 /
   *   已全部过期 ⇒ 沉底（把「不知道」当成「最高」会让用户去用一个可能没余额的号）。
   * - `name`（名称）。
   * - `expiry` = **凭据到期**（`expiresAt`，core 已归一成 Unix 毫秒；缺值沉底），
   *   与抽屉 / 表格的「凭据」列同口径。
   *
   * 积分到期与凭据到期是两根不同的轴：前者回答「先用哪个号」，后者回答「哪个号快失效」。
   */
  const listConfig = useMemo<AccountListConfig<QoderAccountView>>(() => {
    const nameComparator: AccountComparator<QoderAccountView> = (left, right) =>
      qoderAccountName(left).localeCompare(qoderAccountName(right), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    /* 积分优先级：**额度到期最近的先用**，同到期按剩余积分降序；无额度 / 已过期沉底。
       与 WB / Trae 同义（「该先用谁」），不是「余额最多的排前面」。 */
    const creditComparator: AccountComparator<QoderAccountView> = (left, right) => {
      const now = Date.now();
      const expiryOf = (account: QoderAccountView): number | null => {
        const row = credits[account.uid];
        if (!row?.ok || row.expiresAt == null || row.expiresAt <= now) return null;
        if ((row.remaining ?? 0) <= 0) return null;
        return row.expiresAt;
      };
      const leftExpiry = expiryOf(left);
      const rightExpiry = expiryOf(right);
      if (leftExpiry == null || rightExpiry == null) {
        return leftExpiry == null ? (rightExpiry == null ? 0 : 1) : -1;
      }
      if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
      return (credits[right.uid]?.remaining ?? 0) - (credits[left.uid]?.remaining ?? 0);
    };
    /* 凭据到期升序；缺值沉底（显式判相等，避免 `Infinity - Infinity = NaN`）。 */
    const expiryComparator: AccountComparator<QoderAccountView> = (left, right) => {
      const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY;
      const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY;
      if (leftExpiry === rightExpiry) return 0;
      return leftExpiry - rightExpiry;
    };
    /* 桶的固定顺序 —— 与当前排序键解耦（见 `AccountListConfig.bucketCompare`）。
       状态集仍按平台自备（决策 #8）：Qoder 的三桶是凭据态，不是签到态。 */
    const statusOrder = [
      t("qoder.page.accounts.toolbar.statusBucket.noCredential"),
      t("qoder.page.accounts.toolbar.statusBucket.unrecognized"),
      t("qoder.page.accounts.toolbar.statusBucket.normal"),
    ];
    const programOrder = (programs ?? []).map((program) => program.label);
    const unboundProgram = t("qoder.page.accounts.toolbar.programBucket.none");
    const ungrouped = t("qoder.page.accounts.toolbar.groupBucket.ungrouped");
    const rank = (order: readonly string[], value: string) => {
      const index = order.indexOf(value);
      return index < 0 ? order.length : index;
    };
    return {
      searchText: (account) =>
        accountSearchText({
          name: displayText(account.name),
          uid: displayText(account.uid),
          remark: displayText(account.remark),
        }),
      comparators: {
        priority: creditComparator,
        name: nameComparator,
        expiry: expiryComparator,
      },
      bucketKey: (account, key) => {
        if (key === "status") {
          if (!account.hasCredential) return t("qoder.page.accounts.toolbar.statusBucket.noCredential");
          if (account.credential.unrecognized) return t("qoder.page.accounts.toolbar.statusBucket.unrecognized");
          return t("qoder.page.accounts.toolbar.statusBucket.normal");
        }
        if (key === "program") {
          /* 按**程序位**分桶（与 WB 的 `program` 桶同义）：这条账号当前登在哪个程序位里。
             没登在任何程序位 ⇒ 单独的桶名（**不能返回 null** —— 那会让这些行落进「无桶名」桶，
             与其它桶的渲染不一致）。 */
          const hit = (programs ?? []).filter((program) => program.currentUid === account.uid);
          if (hit.length === 0) return t("qoder.page.accounts.toolbar.programBucket.none");
          return hit.map((program) => program.label).join(" + ");
        }
        if (key === "group") {
          // 未分组**必须有自己的桶名**（不能返回 null）—— 返回 null 会让这些行落进
          // 「无桶名」桶、与其它桶的渲染不一致（WB 侧同样的处理）。
          return displayText(account.group) ?? t("qoder.page.accounts.toolbar.groupBucket.ungrouped");
        }
        return null;
      },
      bucketCompare: (left, right, key) => {
        if (key === "status") return rank(statusOrder, left) - rank(statusOrder, right);
        if (key === "program") {
          /* 程序位桶名可能是「A + B」组合 ⇒ 取第一个程序位的次序；未登录任何程序位排最后。 */
          const programRank = (value: string) =>
            value === unboundProgram ? programOrder.length : rank(programOrder, value.split(" + ")[0]);
          return programRank(left) - programRank(right);
        }
        if (key === "group") {
          if (left === ungrouped || right === ungrouped) {
            return left === right ? 0 : left === ungrouped ? 1 : -1;
          }
          return left.localeCompare(right, "zh-Hans-CN");
        }
        return 0;
      },
      availableSorts: ["priority", "name", "expiry"],
      availableGroups: ["none", "program", "status", "group"],
    };
  }, [t, credits, programs]);

  const sortOptions = useMemo(
    () =>
      (
        [
          ["priority", t("qoder.page.accounts.toolbar.sort.priority")],
          ["name", t("qoder.page.accounts.toolbar.sort.name")],
          ["expiry", t("qoder.page.accounts.toolbar.sort.expiry")],
        ] as const
      ).map(([value, label]) => ({ value, label })),
    [t],
  );
  const groupOptions = useMemo(
    () =>
      (
        [
          ["none", t("qoder.page.accounts.toolbar.group.none")],
          ["program", t("qoder.page.accounts.toolbar.group.program")],
          ["status", t("qoder.page.accounts.toolbar.group.status")],
          ["group", t("qoder.page.accounts.toolbar.group.group")],
        ] as const
      ).map(([value, label]) => ({ value, label })),
    [t],
  );

  const filtered = useMemo(() => filterAccounts(rows, listConfig, query), [rows, listConfig, query]);
  const sorted = useMemo(() => sortAccounts(filtered, sort, listConfig), [filtered, sort, listConfig]);
  const buckets = useMemo(() => groupAccounts(sorted, group, listConfig), [sorted, group, listConfig]);

  /**
   * 只服务「优先」标记（与 WB / Trae 同义）：按积分优先级排一遍，
   * 取第一个**有未来到期额度且仍有剩余**的账号；与当前 `sort` 无关。
   */
  const priorityAccountId = (() => {
    const now = Date.now();
    return sortAccounts(rows, "priority", listConfig).find((account) => {
      const row = credits[account.uid];
      return row?.ok && row.expiresAt != null && row.expiresAt > now && (row.remaining ?? 0) > 0;
    })?.uid;
  })();

  /**
   * 逐账号签到状态（`qoder_checkin_status_map`）——**只覆盖被刷新过的账号**。
   *
   * 刻意不在进页面时全量拉：那要逐账号打上游（N 个账号 = N 次请求），
   * 而 `qoder_checkin_status` 的区域快照足够画初值。用户点刷新才去问。
   */
  const [checkinMap, setCheckinMap] = useState<Record<string, CheckinStatusEntry>>({});

  /**
   * 今日签到状态的**唯一来源**，三档优先级：
   *
   * 1. 单账号刷新的上游读数（`checkinMap`，可信）；
   * 2. 区域快照（`checkinRows`，页面打开时那一批上游读数，**`ok:false` 不算数**）；
   * 3. 本地盖章今天（`lastCheckinToday`，标 `source: "ledger"`）。
   *
   * ★ 2026-10-29（用户报障「签到状态总是无，刷新后下次打开还是无」）：此前只有前两档，
   * 上游读数缺席 / 失败时界面只能写「—」；而刷新结果只是页面内存态，重开页面即丢。
   * 本地盖章**落盘在账号库里** ⇒ 重开后仍画得出「今日已签」（并注明按台账），
   * 与 Trae / WB 的初值口径一致。
   *
   * ⚠️ 上游**明确**答了（`ok:true`）就以上游为准 —— 哪怕它是「未签到」。
   * 只有读不到 / 还没查时才让台账兜底，且台账**只会**给出「已签到」（盖章就是今天）；
   * 更早的盖章不构成任何结论，状态仍是「未知」。
   * 唯一的例外是 `campaignMissing`（上游压根没下发签到活动）：那句答复不携带
   * 「今天签没签」的结论，此时今天的本地盖章可以补正布尔值（见下方内联注释）。
   */
  const checkinEntryOf = useCallback(
    (uid: string): CheckinStatusEntry | undefined => {
      const account = accounts?.find((row) => row.uid === uid);
      const upstream = checkinMap[uid] ?? checkinRows[uid];
      if (upstream?.ok) {
        /* ★ 2026-11-19：上游答复里**没有**今日签到活动（`campaignMissing`，既不是列表
           落后也不是窗口未开）时，它只能证明「现在没东西可领」，**不能**证明「今天没签」
           —— 我们自己在 10:00 领过之后，服务端会把这条活动从列表里撤掉，于是同一份答复
           会把「刚签成功」读成「未签」。这一档只补正布尔值，上游的额度字段原样保留，
           并把来源标成 `ledger`（与 Trae / WB 的台账口径一致：不冒称上游答案）。
           ⚠️ 三个前置条件缺一不可：窗口**已开**（否则「没有活动」只是还没开放）、
           列表**没落后**（stale 时上游的答复整体不可信）、今天**确实盖过章**。 */
        if (
          upstream.todayCheckedIn !== true &&
          upstream.windowOpen !== false &&
          upstream.stale !== true &&
          upstream.campaignMissing === true &&
          account?.lastCheckinToday
        ) {
          return { ...upstream, todayCheckedIn: true, source: "ledger" };
        }
        return upstream;
      }
      return ledgerCheckinEntry(account) ?? upstream;
    },
    [checkinMap, checkinRows, accounts],
  );

  /**
   * 今日签到**展示态**（卡片 / 表格 / 菜单 / 一键按钮**全部**经由这里取值）。
   *
   * ★ Qoder 的「今天」是 UTC+8 10:00 起的窗口，不是自然日：
   * - 窗口未开时上游的 `CLAIMED` 属于上一轮 ⇒ `notStarted`（不是「今日已签」）；
   * - 窗口已开但列表仍是上一轮（`stale`）⇒ `refreshing`（真·刷新中，再刷可能变）。
   * 把这两档压回布尔，就会出现「10 点前显示已签、10 点后显示未签」的假状态。
   *
   * ★ 2026-11-19（用户报障「一键刷新一直显示签到刷新中，刷新也不变」）：
   * `status === "NONE"` **不等于**「刷新中」—— 上游 200 正常答复、但列表里根本没有
   * 积分类签到活动（只剩「首次订阅福利」这类详情活动）时也是 `NONE`，而这一档
   * 再刷新一百次也不会变。此前两者共用「刷新中」，用户看到的是一个永不结束的转圈态，
   * 而详情页签（按 `todayCheckedIn` 渲染）写的是「未签到」—— 同一份数据两种说法。
   * ⇒ 只有 `stale` 才是「刷新中」；`NONE` 的其余情况按 `active` 分档（见下一条）。
   *
   * ★ 2026-11-24（用户要求）：上游 **`active === false`**（没向该账号下发签到活动 /
   * 当前没有可领项 ⇒ 官方客户端也没有入口）不再画成「今日未签」，而是 `unavailable`
   * （「不可签到」）。原因：这一档用户做什么都不会变，画成「漏签」等于把上游规则
   * 说成用户的失误。`checked` 仍优先：本地台账补正过的「今天已签」不能被它盖掉；
   * `stale` 也先判 —— 落后于时钟的列表 `active` 同样是 `false`，但那是「刷新中」。
   * ★ 同日补齐**区域级**：旧通道 404/405/410 时行上带 `unavailable: true`（缺行时用
   * 页面布尔兜底）—— 同样写「不可签到」，不再落回「凭据可用」/「读取失败」。
   */
  const checkinDisplayOf = useCallback(
    (account: QoderAccountView): QoderCheckinDisplay => {
      const entry = checkinEntryOf(account.uid);
      if (!entry) return checkinUnavailable ? "unavailable" : "unknown";
      if (entry.unavailable === true) return "unavailable";
      /* 单账号刷新在整区未开放时会落一条 `ok:false`（不带行级标志）——
         区域结论优先：仍是「不可签到」，不能翻回「未知 / 正常」。 */
      if (!entry.ok) return checkinUnavailable ? "unavailable" : "unknown";
      if (entry.windowOpen === false) return "notStarted";
      if (entry.todayCheckedIn === true) return "checked";
      if (entry.status === "NONE" && entry.stale === true) return "refreshing";
      if (entry.active === false) return "unavailable";
      return "unchecked";
    },
    [checkinEntryOf, checkinUnavailable],
  );

  /**
   * 「不可签到」是否由**上游本轮没有下发签到活动**导致（`campaignMissing`）。
   *
   * ★ 2026-11-19（用户报障「一键签到显示成功，刷新又显示未签」）：这一档在界面上
   * 与「你忘了签」长得一模一样，但用户做什么都没用 —— 上游本轮没向该账号下发这条活动。
   * ★ 2026-11-20 纠正：下发按**账号**资格（试用 / 套餐状态）决定，与设备数无关；
   * 同一设备同日两个账号可各自领到（`docs/specs/QODER-PLATFORM.md` §4）。
   * ★ 2026-11-24：这一档现在**单独画成「不可签到」**；本函数只用于装配 tooltip /
   * 抽屉里的原因说明。
   * ⇒ 只有**同时满足**「上游答了 ok」「窗口已开」「列表不落后」「确实缺这条」才是它：
   *   - `windowOpen === false` ⇒ 是「未开始」，有自己的提示；
   *   - `stale === true`        ⇒ 是「刷新中」，再刷可能变；
   *   - `todayCheckedIn === true` ⇒ 已签，无需解释；
   *   - 其它未签（读取失败 / 还没查）⇒ **不猜**，只显示「未知」。
   */
  const checkinCampaignMissing = useCallback(
    (account: QoderAccountView): boolean => {
      const entry = checkinEntryOf(account.uid);
      return (
        !!entry?.ok &&
        entry.todayCheckedIn !== true &&
        entry.windowOpen !== false &&
        entry.stale !== true &&
        entry.campaignMissing === true
      );
    },
    [checkinEntryOf],
  );

  /**
   * 领取**已知无效**、批量时**不发起 claim** 的账号：
   * - 账号级 `campaignMissing`（上游本轮没下发活动，重试永远不变）；
   * - 区域级 `unavailable`（旧通道 404/405/410，整区没有入口）。
   *
   * ⚠️ 只跳「确定无效」的：`active === false` 但**仍有活动**（名额锁定 / 待领）的一档
   * 保留尝试 —— 晚些可能恢复。跳过项仍计入「不可签到」，与后端 `disabled` 回执同档。
   * ⇒ 工具栏「一键签到」的可用性必须跟着这条判据走（见 `checkinHasPending`）：只剩可尝试
   * 的「不可签到」时按钮仍可点，别把「晚些可能恢复」的账号一起锁死在禁用态。
   */
  const checkinSkipClaim = useCallback(
    (account: QoderAccountView): boolean => {
      const entry = checkinEntryOf(account.uid);
      if (entry?.unavailable === true) return true;
      if (!entry || !entry.ok) return checkinUnavailable;
      return checkinCampaignMissing(account);
    },
    [checkinEntryOf, checkinUnavailable, checkinCampaignMissing],
  );

  /** 卡片 / 表格徽章（「不可签到」/「今日未签」）的 tooltip（**短句**：只讲这一档的结论）。 */
  const checkinHintOf = useCallback(
    (account: QoderAccountView): string | undefined =>
      checkinCampaignMissing(account)
        ? t("qoder.page.accounts.chip.notCheckedInMissingTip")
        : undefined,
    [checkinCampaignMissing, t],
  );

  /**
   * 每个账号签到读数的**写入序号**：手动刷新 / 签到成功都算「已有更新的事实」，
   * 让仍在途的自动补取作废 —— 旧响应晚到不得把「已签到」覆盖回「未签到」。
   */
  const checkinWriteSeq = useRef<Record<string, number>>({});
  function markCheckinWrite(uid: string) {
    checkinWriteSeq.current[uid] = (checkinWriteSeq.current[uid] ?? 0) + 1;
  }

  /**
   * 抽屉打开时**补齐该账号的签到明细**（一次只读请求，按 uid 只发一次）。
   *
   * ★ 2026-10-29（用户报障「详情卡显示已签到（按本地台账），签到页签三格全是 —，每次都要手动刷新」）：
   * 本地台账只能证明「今天签过」，没有今日积分 / 连签天数 / 累计积分 —— 那些只有上游知道；
   * 区域快照（`checkinRows`）读取失败时也不会为账号留下 `ok` 行。WB 打开抽屉就查一次
   * 该账号的签到状态，Qoder 此前没有这一拍 ⇒ 页签只能等用户点 ⟳。
   *
   * ⚠️ 只在**上游读数缺席**（台账兜底 / 读取失败 / 没有条目）时才发；失败**不写** map、
   * 也**不记账** —— 「暂时读不到」不能被固化成结论，下次打开抽屉再试。
   * ⚠️ 本区域未开放签到（`checkinUnavailable`）⇒ 不发：结论已知（不可签到），
   * 逐账号再问一遍只会得到同一条区域原因。
   * ⚠️ 在途期间用户手动刷新 / 签到成功 ⇒ 写入序号已前进，这份旧响应必须丢弃。
   */
  const checkinAutoFetched = useRef<Set<string>>(new Set());
  const checkinAutoFetching = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!detail || !checkinLoaded || checkinUnavailable) return;
    const uid = detail.uid;
    const entry = checkinEntryOf(uid);
    if (entry?.ok && entry.source !== "ledger") return;
    if (checkinAutoFetched.current.has(uid) || checkinAutoFetching.current.has(uid)) return;
    checkinAutoFetching.current.add(uid);
    const seq = checkinWriteSeq.current[uid] ?? 0;
    void api
      .qoderCheckinStatusMap(scope, [uid])
      .then((map) => {
        const row = map[uid];
        if (!aliveRef.current || !row?.ok) return;
        checkinAutoFetched.current.add(uid);
        if ((checkinWriteSeq.current[uid] ?? 0) !== seq) return;
        setCheckinMap((prev) => ({ ...prev, [uid]: row }));
      })
      .catch(() => {
        /* 后台补取失败不打扰：页签仍写「未知」并保留 ⟳；下次打开抽屉重试。 */
      })
      .finally(() => {
        checkinAutoFetching.current.delete(uid);
      });
  }, [detail, checkinLoaded, checkinUnavailable, checkinEntryOf, scope]);

  /**
   * 首屏**补齐**：区域快照落地后，对**仍没有上游读数**的账号补一次逐账号查询。
   *
   * ★ 2026-11-16（用户报障「打开账号页默认没有签到状态，手点刷新才显示」）：
   * 首屏唯一的上游来源是 `qoder_checkin_status` 的**区域快照**；它一次失败
   * （冷启动的身份探测互相踩、上游限流、某账号 401）就会让整批卡片落回「凭据可用」
   * 徽章 —— 而逐账号的 `qoder_checkin_status_map` 此前**只在你手点刷新时**才发
   * （见 `checkinMap` 的注释）。于是「打开没有、刷新才有」成了固定观感。
   * 这里把抽屉已有的补取口径（`checkinAutoFetched`）搬到首屏：只补**缺读数**的账号，
   * 每个 uid 每次挂载只试一次，失败不记账、不打扰。
   *
   * 边界：
   * - `checkinUnavailable`（本区域未开放签到）⇒ 整批跳过，不做 N 次必失败的请求；
   * - 台账已给出「今日已签」的账号**不再补取**（`entry.ok` 已成立，卡片画得出结论）；
   * - 与抽屉补取**共用同一份在途记账**（`checkinAutoFetching`）：补齐的那几秒里用户点开
   *   抽屉，抽屉那条 effect 会据此跳过，不会对同一账号再打一次上游；
   * - 在途期间用户手动刷新 / 签到成功 ⇒ 写入序号已前进，这份旧响应丢弃。
   */
  /* 三端共用同一份补取实现（`useCheckinStatusFill`）：分片 50、每账号每作用域一次、
     失败静默、只合并 `ok:true`。Qoder 的额外语义通过回调保留：
     · `checkinAutoFetching` —— 与抽屉补取共用「在途」记账，避免同一账号并发两轮；
     · `checkinWriteSeq` —— 等响应回来期间若用户手动刷新 / 签到成功，这份旧响应丢弃；
     · `checkinAutoFetched` —— 成功项记「已得」，抽屉以后不必再补。 */
  const checkinFillSeq = useRef<Record<string, number>>({});
  const qoderCheckinFillIds = useMemo(() => (accounts ?? []).map((account) => account.uid), [accounts]);
  useCheckinStatusFill({
    enabled: checkinLoaded && !checkinUnavailable,
    ids: qoderCheckinFillIds,
    scopeKey: scope,
    needsFetch: (uid) => !checkinEntryOf(uid)?.ok,
    fetchMap: (uids) => api.qoderCheckinStatusMap(scope, uids),
    onFetchStart: (uids) => {
      for (const uid of uids) {
        checkinAutoFetching.current.add(uid);
        checkinFillSeq.current[uid] = checkinWriteSeq.current[uid] ?? 0;
      }
    },
    accept: (uid) => (checkinWriteSeq.current[uid] ?? 0) === (checkinFillSeq.current[uid] ?? 0),
    onEntries: (entries) => {
      for (const uid of Object.keys(entries)) checkinAutoFetched.current.add(uid);
      setCheckinMap((prev) => ({ ...prev, ...entries }));
    },
    onFetchSettled: (uids) => {
      /* 失败项**不**记 `checkinAutoFetched`：下次打开抽屉仍会单独试一次（与 §11 同口径）。 */
      for (const uid of uids) checkinAutoFetching.current.delete(uid);
    },
    isStale: () => !aliveRef.current,
  });

  /* ── 选择（照 Trae：全选只作用于**当前可见**的行） ── */

  const allVisibleSelected = sorted.length > 0 && sorted.every((a) => selected.has(a.uid));
  const someVisibleSelected = !allVisibleSelected && sorted.some((a) => selected.has(a.uid));
  function toggleSelect(account: QoderAccountView) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(account.uid)) next.delete(account.uid);
      else next.add(account.uid);
      return next;
    });
  }
  function toggleVisibleSelection() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const account of sorted) {
        if (allVisibleSelected) next.delete(account.uid);
        else next.add(account.uid);
      }
      return next;
    });
  }
  function bucketAllSelected(items: QoderAccountView[]): boolean {
    return items.length > 0 && items.every((a) => selected.has(a.uid));
  }
  function bucketSomeSelected(items: QoderAccountView[]): boolean {
    return !bucketAllSelected(items) && items.some((a) => selected.has(a.uid));
  }
  function toggleBucketSelection(items: QoderAccountView[], checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const account of items) {
        if (checked) next.add(account.uid);
        else next.delete(account.uid);
      }
      return next;
    });
  }

  /** 当前选中的账号行（按列表顺序，不是 Set 的插入顺序）。 */
  const selectedRows = useMemo(() => rows.filter((a) => selected.has(a.uid)), [rows, selected]);

  /* ── 动作 ── */

  /** 探测 + 导入（一个动作走完：结果由 toast 汇报；来源四态在首屏空态卡里可查）。 */
  async function onImportLocal() {
    if (importing) return;
    setImporting(true);
    try {
      const outcome = await api.qoderImportLocal(scope);
      const imported = outcome.imported ?? 0;
      const updated = outcome.updated ?? 0;
      if (imported + updated === 0) {
        /* 没导到东西时把**逐来源的问题说明**带上 —— 只说「没有可导入的」等于什么都不说。 */
        const detail = (outcome.problems ?? [])
          .map((problem) => `${problem.label}：${problem.detail ?? problem.state}`)
          .join("；");
        if (detail) toast.message(t("qoder.page.accounts.import.none"), { description: detail });
        else toast.message(t("qoder.page.accounts.import.none"));
      } else {
        toast.success(
          t("qoder.page.accounts.import.result", {
            imported: String(imported),
            updated: String(updated),
          }),
        );
      }
      await reload();
    } catch (e) {
      toast.error(api.asError(e));
    } finally {
      setImporting(false);
    }
  }

  /**
   * 保存备注（抽屉的就地编辑器调用）。
   *
   * ⚠️ 后端在 uid 不存在时返回 `{ ok: false }`（**不是**抛错）—— 必须如实报错，
   * 否则用户会以为「改成功了」，而库里根本没这条账号。
   * 成功后**同步抽屉里的快照**：抽屉的展示值来自 `remark` prop，只调 `reload()`
   * 不会让它重渲（那是「保存成功但界面还是旧值」的经典缺陷）。
   */
  async function saveRemark(account: QoderAccountView, remark: string): Promise<boolean> {
    const value = remark.trim();
    try {
      const result = await api.qoderSetAccountRemark(scope, account.uid, value === "" ? null : value);
      if (!result.ok) {
        toast.error(t("qoder.page.accounts.remark.missing"));
        return false;
      }
      setDetail((prev) => (prev && prev.uid === account.uid ? { ...prev, remark: value === "" ? null : value } : prev));
      await reload();
      toast.success(t("qoder.page.accounts.remark.saved"));
      return true;
    } catch (e) {
      toast.error(api.asError(e));
      return false;
    }
  }

  /**
   * 抽屉里的「切换到此账号」目标（原型 :3480-3486）。
   *
   * ## 可用性判据（2026-10-31 改为与 WorkBuddy 同档）
   *
   * - 四态不是 `ready` ⇒ 没装 / 没登录 / 读不出来，切换无处可写，禁用；
   * - **桌面版在运行**不再禁用：确认框里勾选「自动重开」后，后端会先关掉客户端、
   *   写完再拉起（此前这里直接置灰，用户必须自己去退出客户端 —— 那正是
   *   「Qoder 切换不如 WorkBuddy 好用」的主因）；
   * - **CLI 在运行**仍然禁用：那是用户自己终端里的会话，本工具不替用户杀掉它
   *   （后端的守卫语义对 CLI 保持不变）。
   *
   * `current` 为真时不再重复切换（只读高亮）。
   */
  const switchTargetsFor = useCallback(
    (account: QoderAccountView): DetailSwitchTarget[] =>
      (programs ?? []).map((program) => {
        const cliRunning = program.id === "cli" && program.running;
        return {
          key: program.id,
          label: program.label,
          current: program.currentUid === account.uid,
          available: program.state === "ready" && !cliRunning,
          busy: switchBusy,
          onSwitch: () => setSwitchTarget({ account, program }),
        };
      }),
    [programs, switchBusy],
  );

  /** 保存自定义分组（与备注同构）。 */
  async function saveGroup(account: QoderAccountView, group: string): Promise<boolean> {
    const value = group.trim();
    try {
      const result = await api.qoderSetAccountGroup(scope, account.uid, value === "" ? null : value);
      if (!result.ok) {
        toast.error(t("qoder.page.accounts.group.missing"));
        return false;
      }
      setDetail((prev) => (prev && prev.uid === account.uid ? { ...prev, group: value === "" ? null : value } : prev));
      await reload();
      toast.success(t("qoder.page.accounts.group.saved"));
      return true;
    } catch (e) {
      toast.error(api.asError(e));
      return false;
    }
  }

  /**
   * 执行切换（把凭据写回指定程序位的登录态）。
   *
   * ## 与 WorkBuddy 对齐的三件事（2026-10-31）
   *
   * 1. **一键**：`restart=true` 时后端会自动关闭客户端、写完再拉起 —— 用户不再需要
   *    「先自己去退出 Qoder」；
   * 2. **有进度**：关闭客户端可能等好几秒，这里订阅后端的 `qoder-switch-progress`
   *    把每一步写进 loading toast（webui 没有事件通道，如实只显示一条「正在切换」）；
   * 3. **如实转述**：后端会在写后校验失败时还原备份、在启动失败时把原因放进
   *    `relaunchError` —— 前端不自己编「切换成功」，也不把「客户端没起来」说成失败
   *    （登录态确实已经换好了）。
   */
  async function doSwitch(account: QoderAccountView, program: QoderProgramStatus, restart: boolean) {
    if (switchBusy) return;
    const name = qoderAccountName(account);
    setSwitchBusy(true);
    /**
     * 页头状态条：从「开始切换」一直跟到「客户端进程真的在跑」。
     *
     * 接口返回时客户端往往**还没起来**（后端只是 `spawn` 了进程），此前 busy 态
     * 立刻清掉 ⇒ 卡片看起来已经恢复正常，用户以为没切成功或已经不在切了。
     */
    const op = switchProgress.begin(
      t("qoder.page.accounts.switch.loading", { name }),
      restart
        ? t("qoder.page.accounts.switch.loadingAuto", { program: program.label })
        : t("qoder.page.accounts.switch.loadingManual", { program: program.label }),
    );
    const toastId = toast.loading(t("qoder.page.accounts.switch.loading", { name }), {
      description: restart
        ? t("qoder.page.accounts.switch.loadingAuto", { program: program.label })
        : t("qoder.page.accounts.switch.loadingManual", { program: program.label }),
    });

    /* 进度事件（桌面端）：失败不影响主流程，切换本身的返回才是事实来源。 */
    let unlisten: (() => void) | undefined;
    /** 已进入「等待客户端启动」：后端收尾事件不该再把状态条改回「切换中」。 */
    let awaitingLaunch = false;
    if (!api.isWebui()) {
      try {
        unlisten = await listen<{ message: string }>("qoder-switch-progress", (event) => {
          if (awaitingLaunch) return;
          const message = event.payload?.message;
          if (!message) return;
          op.update({ detail: message });
          toast.loading(t("qoder.page.accounts.switch.loading", { name }), {
            id: toastId,
            description: message,
          });
        });
      } catch {
        /* 事件通道不可用（非 Tauri 环境）⇒ 只保留初始那条 loading。 */
      }
    }

    try {
      const result = await api.qoderSwitchAccount(scope, program.id, account.uid, restart);
      const backupNote = result.backupPath
        ? t("qoder.page.accounts.switch.backup", { path: result.backupPath })
        : undefined;

      if (result.relaunchError) {
        /* 启动失败**不改变**「切换是否成功」：登录态已写好并通过校验，只是客户端没起来。 */
        /* 切换改的是**客户端登录态**⇒ 重取程序位状态（「当前登录」徽章才会跟着动）。 */
        await loadEnrichment({ force: true });
        const description = t("qoder.page.accounts.switch.relaunchFailed", {
          error: result.relaunchError,
        });
        op.settle({
          phase: "warning",
          title: t("shared.switchProgress.switchedNotLaunched", { name, client: program.label }),
          detail: description,
        });
        /* toast 标题与状态条一致（switchedNotLaunched）：这里是警告分支，
           沿用「已切换到 {name}」会让人以为客户端也起来了。 */
        toast.warning(t("shared.switchProgress.switchedNotLaunched", { name, client: program.label }), {
          id: toastId,
          description,
        });
      } else if (restart && program.id === "desktop") {
        /* 自动重开：继续等客户端**真的跑起来**，而不是启动命令一发出去就报完成。
           先把状态条切到「正在启动」，再回读程序位（回读可能还要一两秒）。 */
        awaitingLaunch = true;
        op.update({
          phase: "launching",
          title: t("shared.switchProgress.launching", { client: program.label }),
          detail: t("shared.switchProgress.launchingDetail"),
        });
        toast.loading(t("shared.switchProgress.launching", { client: program.label }), {
          id: toastId,
          description: t("shared.switchProgress.launchingDetail"),
        });
        /* 切换改的是**客户端登录态**⇒ 重取程序位状态（「当前登录」徽章才会跟着动）。 */
        await loadEnrichment({ force: true });

        const started = await waitForClientRunning(
          async () => {
            const view = await api.qoderProgramStatus(scope);
            if (op.signal.aborted) return false;
            const next = view.programs ?? [];
            /* 顺手把程序位状态落地：客户端起来后胶囊上的「运行中」立刻跟着变。 */
            setPrograms(next);
            return next.some((item) => item.id === program.id && item.running);
          },
          { signal: op.signal },
        );
        if (op.signal.aborted) {
          /* 页面已卸载 / 新一轮切换已开始：别把 loading toast 永远挂在屏幕上。 */
          toast.dismiss(toastId);
          return;
        }

        if (started) {
          op.settle({
            phase: "done",
            title: t("shared.switchProgress.doneLaunched", { name, client: program.label }),
            detail: backupNote,
          });
          toast.success(t("qoder.page.accounts.switch.done", { name }), {
            id: toastId,
            description: [t("shared.switchProgress.clientStarted", { client: program.label }), backupNote]
              .filter(Boolean)
              .join(t("shared.punct.semicolon")),
          });
        } else {
          const description = t("shared.switchProgress.launchTimeout", {
            client: program.label,
          });
          op.settle({
            phase: "warning",
            title: t("shared.switchProgress.switchedNotLaunched", { name, client: program.label }),
            detail: description,
          });
          toast.warning(t("shared.switchProgress.switchedNotLaunched", { name, client: program.label }), {
            id: toastId,
            description: [description, backupNote].filter(Boolean).join(t("shared.punct.semicolon")),
          });
        }
      } else {
        /* 切换改的是**客户端登录态**⇒ 重取程序位状态（「当前登录」徽章才会跟着动）。 */
        await loadEnrichment({ force: true });
        op.settle({
          phase: "done",
          title: t("shared.switchProgress.done", { name }),
          detail: [backupNote, t("sessions.restart.resultNotRestarted", { client: program.label })]
            .filter(Boolean)
            .join(t("shared.punct.semicolon")),
        });
        toast.success(t("qoder.page.accounts.switch.done", { name }), {
          id: toastId,
          description: backupNote,
        });
      }
    } catch (e) {
      const description = api.asError(e);
      op.settle({
        phase: "failed",
        title: t("shared.switchProgress.failed"),
        detail: description,
      });
      toast.error(t("qoder.page.accounts.switch.failed"), {
        id: toastId,
        description,
      });
    } finally {
      unlisten?.();
      setSwitchBusy(false);
    }
  }

  /**
   * 本平台真的能刷的项。
   *
   * issue #47 新增 `checkin`：Qoder 的签到读侧此前只有**整区域**快照
   * （`qoder_checkin_status`），现在多了**逐账号**的只读重取
   * （`qoder_checkin_status_map`）。仍然**没有** `tokens` —— Qoder 的计量单位是
   * credits、没有 token 概念（见 `qoder::usage` 模块头），摆一个点了只能重读缓存的
   * 菜单项比不摆更坏。
   */
  const QODER_REFRESH_KINDS = ["credits", "checkin", "credential"] as const;
  const refreshPartBusy = useAccountRefreshBusy();


  /** 单项刷新（与卡片「更多」里的三项同源）。 */
  const onRefreshPart = useCallback(
    async (account: QoderAccountView, kind: AccountRefreshKind) => {
      const label = qoderAccountName(account);
      /* ⚠️ 错误 toast 放在 `run` **外面**：任务抛错 ⇒ `run` 不亮「已更新」。
         此前 catch 在任务内部吞掉错误，失败项也会亮绿勾（错误提示旁挂着「已更新」）。 */
      try {
        const refreshed = await refreshPartBusy.run(account.uid, kind, async () => {
          if (kind === "credits") {
            /* ★ R11：只查这一个账号（core 在上游请求前按筛选过滤），不再「顺手刷全区域」。 */
            const view = await api.qoderCredits(scope, [account.uid]);
            const current = view.accounts.find((row) => row.uid === account.uid);
            /* 缺条目 = 没取得数据（未知 uid / 上游没回）⇒ 不算成功，也不覆盖旧值。 */
            if (!current) throw new Error(t("shared.refreshPart.fail"));
            if (!current.ok) throw new Error(current.error ?? t("shared.refreshPart.fail"));
            setCredits((prev) => ({ ...prev, [current.uid]: current }));
            rememberCredits([current]);
            invalidateEnrichmentFreshness();
          } else if (kind === "checkin") {
            /* 只问这一个账号（批量接口传 1 个 id 即可，不新增「单账号」变体）。 */
            const map = await api.qoderCheckinStatusMap(scope, [account.uid]);
            const current = map[account.uid];
            if (!current) throw new Error(t("shared.refreshPart.fail"));
            if (!current.ok) throw new Error(current.error ?? t("shared.refreshPart.fail"));
            markCheckinWrite(account.uid);
            setCheckinMap((prev) => ({ ...prev, ...map }));
            invalidateEnrichmentFreshness();
          } else if (!(await reload())) {
            throw new Error(t("shared.refreshPart.fail"));
          }
          return true;
        });
        /* 单账号回执合成一行（同 AccountsPage 2026-10-23 调整）。 */
        if (refreshed && aliveRef.current) {
          toast.success(`${label}${t("shared.punct.colon")}${t(REFRESH_DONE_LABEL[kind])}`);
        }
      } catch (e) {
        if (aliveRef.current) {
          toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
        }
      }
    },
    [refreshPartBusy, scope, reload, rememberCredits, t],
  );

  /**
   * 刷新一条账号的令牌（**续期凭据**）。
   *
   * ★ 走的是**同一份** `qoder_refresh_account`（网关页的「恢复」用的也是它）——
   * 不另造一条「账号页专用刷新」。
   *
   * ★ 2026-10-27（R03/R06）：
   * 1. 续期成功后**等待账号列表回读**（`reload`）与区域快照刷新，卡片 / 表格 / 抽屉读到活值；
   * 2. 回读失败不能报「成功后再来一次」—— 令牌已经换新，重试会**重复消耗续期材料**，
   *    因此只提示「续期已完成，界面同步失败」并提供重新读取；
   * 3. 返回 Promise：抽屉与菜单的忙态要跟着真实耗时走（`void refreshOne()` 会让忙态提前结束）。
   */
  async function refreshOne(account: QoderAccountView): Promise<boolean> {
    const name = qoderAccountName(account);
    try {
      await renewAccount(account.uid);
    } catch (e) {
      if (aliveRef.current) toast.error(api.asError(e));
      return false;
    }
    const synced = await reload();
    if (synced) await loadEnrichment({ force: true });
    if (!aliveRef.current) return synced;
    if (synced) toast.success(t("qoder.page.accounts.refresh.done", { name }));
    else
      toast.warning(t("qoder.page.accounts.refresh.syncFailed"), {
        description: t("qoder.page.accounts.refresh.syncFailedDesc"),
      });
    return synced;
  }

  /**
   * 单账号续期的**唯一入口**（菜单 / 详情 / 批量都走这里）。
   *
   * 按 uid 去重：同一账号已在续期中 ⇒ 复用同一个 Promise，不再发第二次请求
   * （并发续期会重复消耗 `refresh_token`，两次回写还会互相覆盖）。
   * core 侧另有 `(region, uid)` 串行闸门，挡住两个客户端同时对同一条账号续期。
   */
  function renewAccount(uid: string): Promise<void> {
    const existing = renewInFlightRef.current.get(uid);
    if (existing) return existing;
    setRenewingUids((prev) => new Set(prev).add(uid));
    const task = (async () => {
      try {
        await api.qoderRefreshAccount(scope, uid);
      } finally {
        renewInFlightRef.current.delete(uid);
        setRenewingUids((prev) => {
          const next = new Set(prev);
          next.delete(uid);
          return next;
        });
      }
    })();
    renewInFlightRef.current.set(uid, task);
    return task;
  }

  /**
   * 批量动作的并发档位 —— 与 WorkBuddy **同一口径**（`lib/concurrency.ts` 的
   * `BATCH_WRITE_CONCURRENCY=3` + `BATCH_WRITE_GAP_MS=150`）：写操作会消耗上游材料，
   * 打太快换来 429 与「一半成功一半失败」。串行则在 20 个账号时是 20 次 RTT 起步。
   */
  const BATCH_CONCURRENCY = 3;
  const BATCH_GAP_MS = 150;
  /** 当前批次的协作式中止句柄（`null` = 没有在跑的批次）。 */
  const batchAbortRef = useRef<AbortController | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);

  /** 中止当前批次：只拦**尚未开始**的账号，在途请求会跑完（协作式）。 */
  function cancelBatch() {
    batchAbortRef.current?.abort();
  }

  /**
   * 跑一批逐账号任务，带进度与协作式取消。
   *
   * 返回与入参**同序同长**；被取消而没跑的项是 `undefined`（缺席 ≠ 失败）。
   */
  async function runBatch<T, R>(targets: T[], worker: (item: T) => Promise<R>): Promise<(R | undefined)[]> {
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setBatchProgress({ done: 0, total: targets.length });
    try {
      return await mapWithConcurrency(targets, worker, {
        concurrency: BATCH_CONCURRENCY,
        gapMs: BATCH_GAP_MS,
        signal: controller.signal,
        onProgress: (done, total) => setBatchProgress({ done, total }),
      });
    } finally {
      batchAbortRef.current = null;
      setBatchProgress(null);
    }
  }

  /**
   * 批量 / 单条签到。
   *
   * ⚠️ 后端只有**单账号** `qoder_checkin_claim` ⇒ 逐条调，并**如实汇报成败**
   * （批量操作必然可能部分失败，不能让「批量签到」看起来永远 100% 成功）。
   * `baseOk` 用于「只重试失败项」时把上一轮的成果累计进去。
   *
   * ★ **四档**：成功（含 `already`）/ 不可签到（`disabled`，重试永远无效）/ 失败 /
   * **未处理**（用户取消、请求根本没发出 —— 它既不是成功也不是失败）。
   */
  async function runCheckin(
    targets: QoderAccountView[],
    baseOk = 0,
    baseEarned = 0,
    baseAlready = 0,
  ) {
    if (targets.length === 0 || busy) return;
    /* ★ 窗口没开 / 活动还没刷出来的账号**不发起领取**：
       Qoder 每日 10:00 才切到新一天，此时上游的 CLAIMED 属于上一轮，领不出今天的奖励。
       这些账号既不是成功也不是失败，单列一档（否则它们会被记成失败、反复重试）。 */
    const notStartedTargets = targets.filter((account) => {
      const state = checkinDisplayOf(account);
      return state === "notStarted" || state === "refreshing";
    });
    /* ★ 2026-11-24：**已知领取无效**的账号不发起 claim（上游没下发活动 / 整区未开放），
       直接计入「不可签到」；与后端 `disabled` 回执同档，不重试、不浪费一次写请求。 */
    const skippedTargets = targets.filter(
      (account) => !notStartedTargets.includes(account) && checkinSkipClaim(account),
    );
    const runnable = targets.filter(
      (account) => !notStartedTargets.includes(account) && !skippedTargets.includes(account),
    );
    if (runnable.length === 0 && skippedTargets.length === 0) {
      toast.info(t("qoder.page.accounts.checkin.notStartedToast"));
      return;
    }
    setBusy(true);
    try {
      const outcomes =
        runnable.length > 0
          ? await runBatch(runnable, async (account) => {
              try {
                return { result: await api.qoderCheckinClaim(scope, account.uid) };
              } catch (e) {
                /* 错误文本要留着：只报「失败」不给原因，用户不知道是该重试还是该去客户端。 */
                return { error: api.asError(e) };
              }
            })
          : [];
      const failed: FailedItem[] = [];
      const disabled: FailedItem[] = skippedTargets.map((account) => ({
        uid: account.uid,
        name: qoderAccountName(account),
      }));
      const notStarted: FailedItem[] = notStartedTargets.map((account) => ({
        uid: account.uid,
        name: qoderAccountName(account),
      }));
      const unprocessed: FailedItem[] = [];
      const checkedUids: string[] = [];
      /** `disabled` 中由 `campaignMissing` 构成的条数：等于总数时才讲「官方未下发」。
       */
      let disabledMissing = skippedTargets.filter(checkinCampaignMissing).length;
      let ok = baseOk;
      let alreadyCount = baseAlready;
      let earned = baseEarned;
      /* ★ 本轮（**不含**重试累计的 `baseOk`）的计数：toast 只报这一轮，
         否则「只重试失败项」会把上一轮的成果再加一遍。 */
      let roundOk = 0;
      let roundAlready = 0;
      let firstError: string | undefined;
      outcomes.forEach((outcome, index) => {
        const account = runnable[index];
        /* 先按**目标索引**取结果：稠密数组里未执行项是 `undefined`，
           这里必须算进「未处理」而不是被跳过（取消后不能报全部成功）。 */
        const item = { uid: account.uid, name: qoderAccountName(account) };
        if (outcome === undefined) {
          unprocessed.push(item);
          return;
        }
        if ("error" in outcome) {
          firstError ??= outcome.error;
          failed.push(item);
          return;
        }
        const claim = outcome.result;
        if (claim.ok) {
          checkedUids.push(account.uid);
          /* ⚠️ `already` 是「今日已签」（可能在公司 / 更早由另一台机器领过），
             不是**本轮真领到**。两者混算会让回执把「本身已签」说成本次成功
             （2026-11-19 用户报障：两台机器各签一个，批量却显示「已签到 2 个账号」）。 */
          if (claim.already) {
            roundAlready += 1;
            alreadyCount += 1;
          } else {
            roundOk += 1;
            ok += 1;
          }
          // 活动通道会带「真领到多少」；旧通道没这个字段 ⇒ 记 0，不编数。
          earned += claim.rewardCredits ?? 0;
        } else if (claim.disabled) {
          disabled.push(item);
          /* 「上游没下发这条活动」与「通道坏了」在回执上要分开说（见下方 toast）。 */
          if (claim.campaignMissing) disabledMissing += 1;
        }
        /* 后端也可能回 `notStarted` / `refreshing`（状态行还没刷新）：
           跳过，不算失败、不进重试。 */
        else if (claim.notStarted || claim.refreshing) notStarted.push(item);
        else failed.push(item);
      });
      for (const uid of checkedUids) markCheckinWrite(uid);
      setCheckinMap((prev) => {
        const next = { ...prev };
        for (const uid of checkedUids) {
          const entry = next[uid];
          if (entry?.ok) {
            if (!entry.todayCheckedIn) next[uid] = { ...entry, todayCheckedIn: true, source: "ledger" };
          } else {
            /* ★ 没有条目（区域快照也没覆盖到）或旧条目是「读取失败」：签到成功是**更新的事实**，
               必须整体写入 —— 否则 `ok:false` / 缺条目会让卡片与详情继续显示「读不到 / 未知」。 */
            next[uid] = { ok: true, todayCheckedIn: true, source: "ledger" };
          }
        }
        return next;
      });
      /* ★ §1.12 规则 2：**单条不摆结果条** —— 一屏放一条结果不值，且抽屉打开时它根本看不见
         （回执由下面的 toast 承担）。`baseOk > 0` 是「只重试失败项」的续跑：那时结果条已是
         这一批的记录，必须继续更新，不能停在上一轮的计数上。 */
      if (targets.length > 1 || baseOk > 0 || baseAlready > 0) {
        setCheckinResult({
          okCount: ok,
          alreadyCount,
          earned,
          disabled,
          disabledMissing,
          notStarted,
          failed,
          unprocessed,
        });
      }
      /* ★ 2026-11-19（用户报障「三个客户端的页面通知方式不统一」）：签到此前**只有结果条**，
         而结果条渲染在工作台工具栏与列表之间 —— 抽屉一打开就被压在下面，
         「在抽屉里点签到」等于没有任何回执。这里补 toast（单条报账号名、批量报数量），
         结果条**仍保留**：它承担「可回看 + 只重试失败项」，与 toast 不互相替代。 */
      /* ★ `okThisRound` 只算**本轮真领到**：`already` 是「今日已签」（可能在另一台机器 /
         更早领过），把它算进「本次成功」会让回执口径失真。 */
      const okThisRound = roundOk;
      const single = targets.length === 1 ? targets[0] : null;
      const extras: string[] = [];
      if (roundAlready > 0) {
        extras.push(
          t("qoder.page.accounts.checkin.batchAlreadyPart", { n: String(roundAlready) }),
        );
      }
      if (disabled.length > 0 && targets.length > 1) {
        extras.push(t("qoder.page.accounts.checkin.disabledPart", { n: String(disabled.length) }));
      }
      if (notStarted.length > 0) {
        extras.push(t("shared.checkinResult.notStartedBadge", { n: String(notStarted.length) }));
      }
      if (unprocessed.length > 0) {
        extras.push(t("shared.batch.cancelled", { n: String(unprocessed.length) }));
      }
      const description =
        [...extras, ...(firstError ? [firstError] : [])].join(t("shared.punct.comma")) || undefined;
      /* 「部分成功 + 其余未下发」是最常见的一屏（2026-11-19 本机三个账号即 1 成功 2 未下发）：
         成功回执的 description 里必须带原因，否则那句「2 个不可签到」仍像接口故障。
         ⚠️ 只有 disabled **全部**是 `campaignMissing` 才讲「官方未下发活动」；混入
         legacy DISABLED / 区域未开放时用通用一句，别替上游编原因。 */
      const disabledReason =
        disabled.length > 0
          ? disabledMissing === disabled.length
            ? t("qoder.page.accounts.checkin.missingHint")
            : t("qoder.page.accounts.checkin.disabledHint")
          : null;
      const descriptionWithReason = [disabledReason, description]
        .filter(Boolean)
        .join(t("shared.punct.comma")) || undefined;
      if (single) {
        const name = qoderAccountName(single);
        if (roundAlready > 0) {
          toast.success(t("qoder.page.accounts.checkin.already", { name }));
        } else if (roundOk > 0) {
          toast.success(t("qoder.page.accounts.checkin.done", { name }));
        } else if (failed.length > 0) {
          toast.error(t("qoder.page.accounts.checkin.failed", { name }), {
            description: firstError,
            /* 单条没有结果条 ⇒ 重试出口必须跟着 toast 走（批量仍走结果条里的「重试失败项」）。 */
            action: { label: t("shared.checkinResult.retryFailed"), onClick: () => void runCheckin([single]) },
          });
        } else if (disabled.length > 0) {
          /* ★ 2026-11-19：单条回执也要讲原因 —— 用户点的是这一个账号，结果条不会出现。 */
          toast.warning(t("qoder.page.accounts.checkin.disabled"), {
            description: descriptionWithReason,
          });
        }
        /* `notStarted` / `refreshing` 的**单条**情形已在上方「全部跳过」分支提示过，不重复弹。 */
      } else if (okThisRound > 0 && failed.length === 0 && unprocessed.length === 0) {
        toast.success(t("qoder.page.accounts.checkin.batchDone", { n: String(okThisRound) }), {
          description: descriptionWithReason,
        });
      } else if (roundAlready > 0 && failed.length === 0 && unprocessed.length === 0) {
        /* 本轮没有**新**领取，只是确认「今日已签」：单独一句话，不能混进「成功 N 个」。 */
        toast.success(t("qoder.page.accounts.checkin.batchAlready", { n: String(roundAlready) }), {
          description: descriptionWithReason,
        });
      } else if (failed.length > 0) {
        /* 一个都没签上 ⇒ error；部分成功 ⇒ warning。用同一句话报数量，不谎报成功。 */
        const args = { ok: String(okThisRound), fail: String(failed.length) };
        const text = t("qoder.page.accounts.checkin.batchPartial", args);
        /* 失败与「未下发」可能同屏出现 ⇒ 描述统一带上原因（`extras` 里还有未开放计数）。 */
        if (okThisRound === 0) toast.error(text, { description: descriptionWithReason });
        else toast.warning(text, { description: descriptionWithReason });
      } else if (disabled.length > 0) {
        /* 全部「通道未开放」：既不是成功也不是失败，如实说清。
           ★ 2026-11-19：若成因是「上游本轮没下发」，把规则讲在前面 —— 否则「通道未开放」
           听起来像接口故障，用户会一直重试。 */
        toast.warning(t("qoder.page.accounts.checkin.disabled"), {
          description: descriptionWithReason,
        });
      } else if (unprocessed.length > 0) {
        toast.info(t("shared.batch.cancelled", { n: String(unprocessed.length) }));
      }
      /* 回读账号库：`lastCheckinToday` 是签到状态的**落盘初值**（重开页面时唯一的依据），
         签到成功后必须让它跟上，否则下次打开又变回「未知」。 */
      await reload();
      await loadEnrichment({ force: true });
    } finally {
      setBusy(false);
    }
  }

  /**
   * 批量**续期凭据**（写 `refresh_token`；与单账号「续期凭据」同一条路径）。
   *
   * 结果区分成功 / 失败 / 未处理（取消），重试名单**不含**已成功项 ——
   * 重复续期会白耗 refresh_token。
   */
  async function runRenewBatch(targets: QoderAccountView[]) {
    if (targets.length === 0 || busy) return;
    setBusy(true);
    setRenewBusy(true);
    try {
      const outcomes = await runBatch(targets, async (account) => {
        try {
          await renewAccount(account.uid);
          return true;
        } catch {
          return false;
        }
      });
      const ok = outcomes.filter((outcome) => outcome === true).length;
      const fail = outcomes.filter((outcome) => outcome === false).length;
      const unprocessed = outcomes.filter((outcome) => outcome === undefined).length;
      /* 切换作用域后不再弹旧批次的结果（写请求仍会跑完，结果只属于原作用域）。 */
      if (!aliveRef.current) return;
      if (fail === 0 && unprocessed === 0) {
        toast.success(t("qoder.page.accounts.refresh.batchDone", { n: String(ok) }));
      } else {
        toast.error(t("qoder.page.accounts.checkin.batchPartial", { ok: String(ok), fail: String(fail) }), {
          description:
            unprocessed > 0 ? t("shared.batch.cancelled", { n: unprocessed }) : undefined,
        });
      }
      /* 续期是写操作 ⇒ 必须回读账号元数据（新令牌的到期时刻在列表载荷里）。 */
      await reload();
      await loadEnrichment({ force: true });
    } finally {
      setBusy(false);
      setRenewBusy(false);
    }
  }

  /**
   * 批量**只读刷新**（勾选范围）：积分 / 签到状态 / 凭据状态。
   *
   * ⚠️ 只调用读接口，**不**触发签到领取、也**不**续期 —— 这是与「续期凭据」的分界线。
   * 积分按勾选 id 过滤（core 在上游请求前过滤），不扩大到未选账号。
   */
  async function runRefreshPartBatch(kind: AccountRefreshKind) {
    const targets = selectedRows;
    if (targets.length === 0 || busy) return;
    const ids = targets.map((account) => account.uid);
    setBusy(true);
    try {
      if (kind === "credits") {
        const view = await api.qoderCredits(scope, ids);
        setCredits((prev) => {
          const next = { ...prev };
          for (const row of view.accounts) next[row.uid] = row;
          return next;
        });
        rememberCredits(view.accounts);
        invalidateEnrichmentFreshness();
        const failed = ids.filter((uid) => !view.accounts.some((row) => row.uid === uid && row.ok));
        if (!aliveRef.current) return;
        if (failed.length > 0) {
          toast.error(t("qoder.page.accounts.quickRefreshPartial", { n: failed.length }));
        } else {
          toast.success(t("qoder.page.accounts.quickRefreshDone", { n: ids.length }));
        }
      } else if (kind === "checkin") {
        const map = await api.qoderCheckinStatusMap(scope, ids);
        for (const uid of Object.keys(map)) markCheckinWrite(uid);
        setCheckinMap((prev) => ({ ...prev, ...map }));
        invalidateEnrichmentFreshness();
        const failed = ids.filter((uid) => !map[uid]?.ok);
        if (!aliveRef.current) return;
        if (failed.length > 0) {
          toast.error(t("qoder.page.accounts.quickRefreshPartial", { n: failed.length }));
        } else {
          toast.success(t("qoder.page.accounts.quickRefreshDone", { n: ids.length }));
        }
      } else if (!(await reload())) {
        if (aliveRef.current) toast.error(t("shared.refreshPart.fail"));
      }
    } catch (e) {
      if (aliveRef.current) {
        toast.error(t("shared.refreshPart.fail"), { description: api.asError(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  /** 页头「一键刷新」只重取积分、签到状态与账号元数据，不续期或回写凭据。 */
  async function quickRefreshAll(): Promise<boolean> {
    if (busy || quickBusy || rows.length === 0) return false;
    if (quickRefreshCoolingDown(scope)) return false;
    startQuickRefreshCooldown(scope);
    setQuickBusy("refresh");
    try {
      const ids = rows.map((row) => row.uid);
      const [creditsResult, checkinResult, accountsResult] = await Promise.allSettled([
        api.qoderCredits(scope),
        api.qoderCheckinStatusMap(scope, ids),
        reload(),
      ]);
      if (creditsResult.status === "fulfilled") {
        setCredits(Object.fromEntries(creditsResult.value.accounts.map((row) => [row.uid, row])));
        rememberCredits(creditsResult.value.accounts);
      }
      if (checkinResult.status === "fulfilled") {
        for (const uid of Object.keys(checkinResult.value)) markCheckinWrite(uid);
        setCheckinMap((prev) => ({ ...prev, ...checkinResult.value }));
      }
      if (creditsResult.status === "fulfilled" || checkinResult.status === "fulfilled") {
        invalidateEnrichmentFreshness();
      }
      const failed =
        Number(creditsResult.status === "rejected") +
        Number(creditsResult.status === "fulfilled" && creditsResult.value.summary.failedAccounts > 0) +
        Number(checkinResult.status === "rejected") +
        Number(
          checkinResult.status === "fulfilled" &&
            Object.values(checkinResult.value).some((entry) => !entry.ok),
        ) +
        Number(accountsResult.status === "rejected" || !accountsResult.value);
      if (!aliveRef.current) return true;
      if (failed === 0) {
        toast.success(t("qoder.page.accounts.quickRefreshDone", { n: ids.length }), {
          description: t("qoder.page.accounts.quickRefreshScope"),
        });
      } else if (failed === 3) {
        toast.error(t("qoder.page.accounts.quickRefreshFail"));
      } else {
        toast.warning(t("qoder.page.accounts.quickRefreshPartial", { n: ids.length }));
      }
      return true;
    } finally {
      setQuickBusy(null);
    }
  }

  /** 页头「一键签到」：对**全部账号**跑签到（后端对已签账号返回 `disabled`，不重复领取）。 */
  async function quickCheckinAll() {
    if (busy || quickBusy || rows.length === 0) return;
    setQuickBusy("checkin");
    try {
      await runCheckin(rows);
    } finally {
      setQuickBusy(null);
    }
  }

  function openDetail(account: QoderAccountView, tab: DrawerTab | null = null) {
    setDetailAutoEditRemark(false);
    setDetailAutoEditGroup(false);
    setDetailTab(tab);
    setDetail(account);
  }

  /** 「更多 → 编辑备注」：打开抽屉并**直接进入编辑态**（原型 `drawerAccount(id, true)`）。 */
  function openRemark(account: QoderAccountView) {
    setDetailAutoEditRemark(true);
    setDetailAutoEditGroup(false);
    setDetailTab(null);
    setDetail(account);
  }

  /** 「更多 → 设置分组」。 */
  function openGroup(account: QoderAccountView) {
    setDetailAutoEditRemark(false);
    setDetailAutoEditGroup(true);
    setDetailTab(null);
    setDetail(account);
  }

  /**
   * 补取**单账号**的聚合额度（openapi）。
   *
   * 逐包走网页会话、聚合走 access token，是两条独立通道。逐包读成功并不代表
   * 卡片主积分行 / 抽屉指标（都读 `credits`）有值；聚合缺席或上次失败时补一次，
   * 让用户不必再手动点一次「刷新积分」。已有成功值时由调用方挡掉。
   */
  async function loadCreditOne(uid: string) {
    if (!uid || creditFetchInflight.current.has(uid)) return;
    creditFetchInflight.current.add(uid);
    try {
      const view = await api.qoderCredits(scope, [uid]);
      if (!aliveRef.current) return;
      const rows = Object.fromEntries(view.accounts.map((row) => [row.uid, row]));
      if (Object.keys(rows).length > 0) {
        setCredits((prev) => ({ ...prev, ...rows }));
        rememberCredits(view.accounts);
      }
    } catch {
      /* 聚合失败不打扰：逐包合计已可用于展示（见 `creditForDisplay`）。 */
    } finally {
      creditFetchInflight.current.delete(uid);
    }
  }

  /**
   * **展示用**额度行：聚合额度优先；缺失 / 失败时用逐包合计兜底。
   *
   * 为什么需要：卡片「资源包」浮层取的是逐包（网页会话），而卡片主积分行、表格积分列
   * 与抽屉指标读的是聚合额度（openapi）。两条通道互相独立 —— 用户只读了逐包时，
   * 上面三个展示位会停在「—」，看起来像「详情页没有带过去、还要再取一次」。
   *
   * ⚠️ **只用于展示**：排序 / 「优先」标记仍读实时 `credits`（与 WorkBuddy 的
   * `displayCreditMap` 同一纪律）—— 派生值不参与列表重排。
   */
  const creditForDisplay = useCallback(
    (uid: string): QoderCreditsRow | undefined => {
      const row = credits[uid];
      if (row?.ok) return row;
      const web = webPacks[uid];
      if (!web?.available) return row;
      /* 与列表同一口径：用完的包不参与合计（否则总量里会混着 0/0 的占位包）。 */
      const active = visibleQoderPacks(web.packs);
      if (active.length === 0) return row;
      const now = Date.now();
      const futureExpiries = active
        .map((pack) => pack.expiresAtMs)
        .filter((ms): ms is number => typeof ms === "number" && ms > now);
      return {
        uid,
        name: row?.name ?? "",
        ok: true,
        remaining: active.reduce((sum, pack) => sum + pack.remaining, 0),
        used: active.reduce((sum, pack) => sum + pack.used, 0),
        total: active.reduce((sum, pack) => sum + pack.limit, 0),
        // 逐包有自己的到期时刻；聚合到期未知时取**最近的未来一批**，没有就留空。
        expiresAt: futureExpiries.length > 0 ? Math.min(...futureExpiries) : null,
        expiresForever: row?.expiresForever === true,
        plan: row?.plan ?? null,
      };
    },
    [credits, webPacks],
  );

  /**
   * 首屏展示行：实时值优先，缺席 / 失败时回落**上次成功读数**。
   *
   * 与 `creditForDisplay` 分开：后者只做「聚合 / 逐包」兜底，本函数额外允许
   * 跨重启缓存。排序 / 「优先」标记仍只读 `credits`，缓存不参与任何业务判定。
   */
  const displayCreditFor = useCallback(
    (account: QoderAccountView): QoderCreditsRow | undefined => {
      /* 实时值优先（并保持 `creditForDisplay(account.uid)` 这一展示兜底入口）。 */
      const live = creditForDisplay(account.uid);
      if (live?.ok) return live;
      return cachedCredits[account.uid]?.value ?? live;
    },
    [creditForDisplay, cachedCredits],
  );

  /**
   * 取某账号的逐包明细（带 TTL；`force` 绕过 TTL）。
   *
   * ★ 并发去重：浮层与抽屉可能同时触发同一个账号 —— 用 `packsLoading` 挡第二次，
   * 否则会并发打两次上游（逐包接口要带会话 Cookie，重复调用没有意义）。
   */
  async function loadPacks(uid: string, force = false) {
    if (!uid) return;
    if (packsLoading[uid]) return;
    const last = packsFetchedAt.current[uid] ?? 0;
    if (!force && webPacks[uid] && Date.now() - last < PACKS_TTL_MS) return;
    setPacksLoading((prev) => ({ ...prev, [uid]: true }));
    try {
      const result = await api.qoderWebCreditPacks(scope, uid);
      packsFetchedAt.current[uid] = Date.now();
      setWebPacks((prev) => ({ ...prev, [uid]: result }));
      /* 逐包是网页会话读的；卡片主积分行 / 抽屉指标读聚合额度。聚合缺席 / 上次失败
         时补一次该账号，避免「逐包已经读到了，详情页还要再点一次刷新」。 */
      if (result.available && !creditsRef.current[uid]?.ok) {
        void loadCreditOne(uid);
      }
    } catch {
      /* 静默：详情拿不到不是错误，浮层会按 `packs` 为空给出引导。 */
    } finally {
      setPacksLoading((prev) => {
        const next = { ...prev };
        delete next[uid];
        return next;
      });
    }
  }

  /**
   * 探一次逐包接口：**认领**登录窗里的会话（带 uid 归属校验），成功即刷新该账号逐包。
   */
  async function probeAndLoad(account: QoderAccountView): Promise<boolean> {
    const uid = account.uid;
    setPacksLoading((prev) => ({ ...prev, [uid]: true }));
    try {
      const probe = await api.qoderWebCreditPacksProbe(scope, uid);
      if (!probe.hasSession) return false;
      if (probe.uidMatches === false) {
        // 归属不符：后端已丢弃该会话，界面必须说清楚「不是这个账号」。
        toast.error(t("qoder.page.accounts.web.readMismatch"));
        await loadPacks(uid, true);
        return false;
      }
      await loadPacks(uid, true);
      /* 与列表同一口径：只报**还能用**的包数（用完的已不展示）。 */
      toast.success(
        t("qoder.page.accounts.web.readDone", {
          n: String(visibleQoderPacks(probe.packs ?? []).length),
        }),
      );
      return true;
    } catch {
      /* 上游拒绝 / 网络失败：让浮层与抽屉按结构化原因给下一步，这里不重复报错。 */
      await loadPacks(uid, true);
      return false;
    } finally {
      setPacksLoading((prev) => {
        const next = { ...prev };
        delete next[uid];
        return next;
      });
    }
  }

  /**
   * 「我已登录，读取逐包明细」：登录在另一个窗口完成，用户很可能登录完直接关窗；
   * 给一个能自己按的入口，比让用户猜「是不是还要再等」强。
   */
  async function readPacks(account: QoderAccountView) {
    const ok = await probeAndLoad(account);
    if (!ok) toast.error(t("qoder.page.accounts.web.readFailed"));
  }

  /** 「退出网页登录」：清除本机会话缓存（会话等价于完整身份凭据，必须给出口）。 */
  async function logoutWebSession() {
    try {
      await api.qoderWebSessionLogout(scope);
      setWebPacks({});
      packsFetchedAt.current = {};
      toast.success(t("qoder.page.accounts.web.logoutDone"));
      const uid = detail?.uid;
      if (uid) await loadPacks(uid, true);
    } catch (e) {
      toast.error(api.asError(e));
    }
  }

  /**
   * 「登录 Qoder 网页端」：开一个独立窗口让用户登录一次。
   *
   * 两段式轮询：先问登录窗里的 cookie 集合变没变（本地命令，不打上游），变了才探一次
   * 逐包接口认领会话。不要改成每 2 秒直接 probe —— 未登录时的匿名 Cookie 会换来 401，
   * 而 401 会清缓存，等于打出一串注定失败的请求。
   */
  async function openWebLogin(account: QoderAccountView) {
    try {
      await api.qoderWebLoginOpen(scope);
      toast.success(t("qoder.page.accounts.web.loginToast"));
    } catch (e) {
      toast.error(api.asError(e));
      return;
    }
    const baseline = await api.qoderWebWindowCookies(scope).catch(() => null);
    let seen = baseline?.fingerprint ?? "";
    let probes = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = await api.qoderWebWindowCookies(scope).catch(() => null);
      if (!current) continue;
      if (!current.windowOpen) {
        /* 关窗前后端已兜底收割；`pending` 为真才值得探一次。 */
        const status = await api.qoderWebSessionStatus(scope, account.uid).catch(() => null);
        if (status?.pending) await probeAndLoad(account);
        return;
      }
      if (!current.fingerprint || current.fingerprint === seen) continue;
      seen = current.fingerprint;
      probes += 1;
      if (await probeAndLoad(account)) return;
      if (probes >= 3) return;
    }
  }

  /**
   * 签到状态的**显式取值**（菜单用；与卡片 / 表格的 `checkinDisplayOf` 同一口径）。
   * 未知 / 读取失败 / 不可签到各自成态，绝不把「不知道」画成「未签到」。
   */
  function checkinStateOf(account: QoderAccountView): AccountCheckinState {
    const entry = checkinEntryOf(account.uid);
    if (!entry) {
      /* 通道未开放 ⇒ 明说「不可签到」（重试永远不会成功）；否则才是「还没查」= 未知。 */
      return checkinUnavailable
        ? { kind: "unavailable", reason: t("shared.stat.checkinUnavailable") }
        : { kind: "unknown" };
    }
    /* 区域级结论（旧通道 404/405/410，行上带 `unavailable: true`）：
       这不是「读取失败」—— 结论已知，再试也不会出现入口。 */
    if (entry.unavailable === true) {
      return { kind: "unavailable", reason: t("shared.stat.checkinUnavailable") };
    }
    if (!entry.ok) {
      /* 单账号刷新在整区未开放时会落一条不带行级标志的 `ok:false` ——
         区域结论优先，别把它说成「读取失败」。 */
      return checkinUnavailable
        ? { kind: "unavailable", reason: t("shared.stat.checkinUnavailable") }
        : { kind: "unreadable", reason: entry.error };
    }
    /* 窗口未开（每日 10:00 前）：上游的 CLAIMED 属于上一轮 —— 到点再签，不是「未签」。 */
    if (entry.windowOpen === false) return { kind: "notStarted" };
    if (entry.todayCheckedIn) return { kind: "checked" };
    /* 窗口已开但列表还是上一轮（`stale`）：不是「未签」，稍后刷新即可。
       ⚠️ 只认 `stale` —— `status === "NONE"` 还包含「上游没下发签到活动」那一档，
       它再刷新也不会变，落到下面的 `unavailable`（见 `checkinDisplayOf` 的注释）。 */
    if (entry.status === "NONE" && entry.stale === true) return { kind: "refreshing" };
    if (entry.active === false) {
      /* 「不可签到」：上游没下发活动（官方客户端也没有入口）。菜单别用通用那句
         「官方未开放签到」—— 区域通道是好的，缺的是这个账号的资格 / 可领项。 */
      return {
        kind: "unavailable",
        reason: checkinCampaignMissing(account)
          ? t("qoder.page.accounts.chip.notCheckedInMissingTip")
          : t("qoder.page.accounts.chip.checkinUnavailableTip"),
      };
    }
    return { kind: "unchecked" };
  }

  /**
   * 单账号「更多」菜单 —— **卡片页脚与表格行尾消费同一份**（R07/R09）。
   *
   * ★ 2026-10-27：菜单装配只留在这里。卡片与表格各写一份必然漂移
   * （此前表格没有菜单、卡片有刷新没有续期）。
   */
  function renderAccountMenu(account: QoderAccountView, compact = false) {
    if (demoModeEnabled) return <AccountMoreMenuDemo />;
    return (
      <AccountMoreMenu
        accountName={qoderAccountName(account)}
        compact={compact}
        onRefreshPart={(kind) => void onRefreshPart(account, kind)}
        refreshKinds={QODER_REFRESH_KINDS}
        refreshingKinds={refreshPartBusy.kindsOf(account.uid)}
        doneKinds={refreshPartBusy.doneKindsOf(account.uid)}
        onRefresh={async () => {
          /* 忙态统一由 `renewAccount` 维护（与详情 / 批量共用同一个在途 Promise）。 */
          await refreshOne(account);
        }}
        refreshingToken={renewingUids.has(account.uid)}
        checkinState={checkinStateOf(account)}
        onCheckin={() => void runCheckin([account])}
        /* ★ 2026-10-29（用户要求）：Qoder 菜单**不提供**「切换账号」——
           切换走卡片程序位胶囊 / 详情程序位区，不需要先跳详情再切。 */
        onExport={() => {
          /* 单账号导出必须只含这一条，与勾选 / 全量导出隔离。 */
          setExportTargets([account]);
          setExportOpen(true);
        }}
        extraActions={
          api.isWebui()
            ? undefined
            : [
                {
                  id: "qoder-web-login",
                  label: t("qoder.page.accounts.web.loginMenu"),
                  icon: <Globe className="size-4" />,
                  onSelect: () => void openWebLogin(account),
                },
                {
                  id: "qoder-read-packs",
                  label: t("qoder.page.accounts.web.read"),
                  icon: <PackageSearch className="size-4" />,
                  busy: !!packsLoading[account.uid],
                  onSelect: () => void readPacks(account),
                },
              ]
        }
        onDelete={() => setPendingDelete(account)}
      />
    );
  }

  /**
   * 单账号删除（**软删除**：移入回收站，可恢复）。
   *
   * 弹层确认仍是必需的（账号会离开列表），但文案已从「永久删除、没有回收站」改成
   * 「可在回收站恢复」—— 后端自 2026-10-15 起就是软删除，旧文案会**谎报**。
   * 删完给「撤销」入口（`accountRestore`），与回收站同一条命令。
   */
  async function confirmSingleDelete() {
    if (!pendingDelete || busy) return;
    const target = pendingDelete;
    setBusy(true);
    try {
      await api.qoderDeleteAccount(scope, target.uid);
      setPendingDelete(null);
      toast.success(t("qoder.page.accounts.removed", { name: qoderAccountName(target) }), {
        action: {
          label: t("qoder.page.accounts.trash.undo"),
          onClick: () => {
            void api
              .accountRestore(scope, target.uid)
              .then(() => {
                toast.success(t("qoder.page.accounts.trash.restored", { name: qoderAccountName(target) }));
                return reload();
              })
              .catch((e) => toast.error(api.asError(e)));
          },
        },
      });
      await reload();
    } catch (e) {
      toast.error(api.asError(e));
    } finally {
      setBusy(false);
    }
  }

  /** 批量删除：顺序逐条调单删命令，并如实汇报成败。 */
  async function confirmBatchDelete() {
    if (busy) return;
    const targets = selectedRows;
    if (targets.length === 0) return;
    setBusy(true);
    const deleted: string[] = [];
    try {
      for (const account of targets) {
        try {
          await api.qoderDeleteAccount(scope, account.uid);
          deleted.push(account.uid);
        } catch {
          /* 逐条失败不影响其余；下面按 deleted / 目标数报差集，不谎报「全部删除」。 */
        }
      }
      const fail = targets.length - deleted.length;
      setBatchDeleteOpen(false);
      if (fail === 0) {
        /* ★ 2026-11-19：与单条删除**同一个撤销出口**（`accountRestore`）—— 另两端
           批量删除都给了撤销，只有 Qoder 此前只报「已删除 N 个」，与软删除语义不符。 */
        toast.success(t("qoder.page.accounts.delete.done", { n: String(deleted.length) }), {
          action: deleted.length > 0
            ? { label: t("qoder.page.accounts.trash.undo"), onClick: () => void restoreAccounts(deleted) }
            : undefined,
        });
      } else {
        toast.error(
          t("qoder.page.accounts.delete.partial", {
            ok: String(deleted.length),
            fail: String(fail),
          }),
          deleted.length > 0
            ? {
                action: {
                  label: t("qoder.page.accounts.trash.undo"),
                  onClick: () => void restoreAccounts(deleted),
                },
              }
            : undefined,
        );
      }
      setSelected(new Set());
      await reload();
    } finally {
      setBusy(false);
    }
  }

  /**
   * 批量撤销：把刚删掉的账号从回收站恢复回来（与单条撤销同一条命令）。
   *
   * 逐条调、逐条计数：一个失败不该把其余已恢复的账号报成失败，也不该中断整批。
   */
  async function restoreAccounts(uids: string[]) {
    let ok = 0;
    for (const uid of uids) {
      try {
        await api.accountRestore(scope, uid);
        ok += 1;
      } catch {
        /* 计数即可，逐个 toast 会把整屏刷满。 */
      }
    }
    if (ok > 0) toast.success(t("qoder.page.accounts.trash.restoredMany", { n: String(ok) }));
    if (ok < uids.length) {
      toast.error(t("qoder.page.accounts.trash.restoreFailed", { n: String(uids.length - ok) }));
    }
    await reload();
  }

  /* ── 抽屉与表格的装配 ── */

  /**
   * 抽屉的**展示用**账号：以列表里的活值为准，找不到（账号刚被删）才回落快照。
   *
   * ★ 2026-10-26：`detail` 是打开抽屉那一刻的快照，只用于「打开了谁」与备注 / 分组的
   * 乐观更新；凡是会被「刷新」改写的字段（凭据到期 / 凭据摘要 / 掩码令牌）都必须读这里。
   */
  const detailLive = useMemo<QoderAccountView | null>(
    () =>
      detail ? (rows.find((row) => row.uid === detail.uid) ?? (accounts === null ? detail : null)) : null,
    [detail, rows, accounts],
  );

  /**
   * 账号已从库里消失（删除 / 回收站）⇒ 关闭详情。
   *
   * 不关闭会留下一个「对已失效快照继续续期 / 签到」的抽屉 —— 那正是 R01 的残留形态。
   * `accounts === null`（首屏加载中）不判，避免刚打开就闪关。
   */
  useEffect(() => {
    if (!detail || accounts === null) return;
    if (!accounts.some((row) => row.uid === detail.uid)) setDetail(null);
  }, [accounts, detail]);

  /** 抽屉是否展示「当前登录」：任一程序位此刻登着这条账号（与卡片 / 表格同一判据）。 */
  const detailIsCurrent = Boolean(
    (programs ?? []).some((program) => program.currentUid === (detailLive ?? detail)?.uid),
  );

  /**
   * 「今日签到」的展示词 —— 概览信息行与顶部指标块共用，避免同屏两种说法
   * （上游读失败时，两处各写一遍三元链会出现「指标块说读不到、概览说未签到」）。
   *
   * ★ 2026-11-24：逐档对齐 `checkinDisplayOf` —— 未开始 / 刷新中 / 不可签到各有
   * 自己的词。区域级未开放与账号级未下发**统一写「不可签到」**（不再用
   * 「本区域未开放」或「未签到」两套说法）。
   */
  const detailCheckinText = useMemo(() => {
    if (!detailLive) return "—";
    const entry = checkinEntryOf(detailLive.uid);
    const state = checkinDisplayOf(detailLive);
    /* 区域级未开放 / 账号未下发：结论已知 ⇒ 不可签到（优先于「读不到」）。 */
    if (state === "unavailable") return t("qoder.page.accounts.chip.checkinUnavailable");
    if (entry && !entry.ok) return t("shared.stat.checkinUnreadable");
    if (!entry) return "—";
    switch (state) {
      case "checked":
        return t("shared.stat.checkedIn");
      case "notStarted":
        return t("shared.drawer.checkin.notStarted");
      case "refreshing":
        return t("shared.drawer.checkin.refreshing");
      case "unchecked":
        return t("shared.stat.notCheckedIn");
      default:
        return "—";
    }
  }, [detailLive, checkinEntryOf, checkinDisplayOf, t]);

  /**
   * 概览只留「账号信息」一块 —— 与 WorkBuddy 同构（身份 / 元数据 / 今日签到）。
   *
   * ★ 2026-10-27（用户要求「参考 WorkBuddy，去掉概览里重复的凭据信息」）：
   * 「凭据」「访问令牌」两行与「凭据」页签逐字段重复（那边还带令牌有无与续期入口）
   * ⇒ 从概览移除。
   * ★ 2026-10-28：卡片底部的凭据摘要与掩码令牌也已移除（用户要求）⇒ 令牌类信息
   * **只在「凭据」页签**展示。
   * ★ 2026-10-29：UID 只在头部副标题（`shared.drawer.subtitleUid`）展示，概览不再成行。
   */
  const detailRows = useMemo(() => {
    if (!detail) return [];
    const live = detailLive ?? detail;
    const rowsOut = [
      { label: t("qoder.page.accounts.drawer.domain"), value: displayText(live.domain) ?? "—" },
      { label: t("qoder.page.accounts.drawer.source"), value: qoderSourceLabel(t, live.source) ?? "—" },
    ];
    const addedAt = stampToMs(live.addedAt);
    if (addedAt !== null) {
      rowsOut.push({ label: t("qoder.page.accounts.drawer.addedAt"), value: formatAbsoluteTime(addedAt) });
    }
    const updatedAt = stampToMs(live.updatedAt);
    if (updatedAt !== null) {
      rowsOut.push({ label: t("qoder.page.accounts.drawer.updatedAt"), value: formatAbsoluteTime(updatedAt) });
    }
    rowsOut.push({ label: t("shared.stat.checkin"), value: detailCheckinText });
    return rowsOut;
  }, [detail, detailLive, detailCheckinText, t]);

  /** 分组候选（本作用域已用过的组名）—— 抽屉里的分组选择器用，见 WB 页同名变量。 */
  const detailGroups = useMemo(() => {
    const names = new Set<string>();
    for (const account of accounts ?? []) {
      const name = displayText(account.group)?.trim();
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [accounts]);

  /**
   * 抽屉顶部的指标块（Qoder 侧只有三个：积分 / 签到 / 凭据 —— 没有「今日 Token」的数据源，
   * 不摆一个永远「—」的块）。
   *
   * ⚠️ 文本全部在这里格式化（抽屉只排版）；`refreshKind` 只给本平台真的能刷的项。
   */
  const detailStats = useMemo<DetailStat[]>(() => {
    if (!detailLive) return [];
    /* 展示用：聚合额度优先，逐包合计兜底（见 `creditForDisplay`）。 */
    const row = creditForDisplay(detailLive.uid);
    const expired = detailLive.expiresAt != null && detailLive.expiresAt < Date.now();
    const credBad = expired || !detailLive.hasCredential;
    /* ★ 2026-10-27（用户报障「详情页积分卡没像 WB 显示剩余/总数与到期」）：
       与 WB / Trae **同一口径** —— 副行报最急一批的「金额 + 到期」，3 天内警示。
       `expiresAt` 是顶层额度到期（Unix 毫秒，Qoder SDK 口径）：`userQuota` 与
       `addOnQuota` 共用这一个时刻 ⇒「到期积分数」就是聚合后的剩余；缺值或已过期 ⇒
       `summarizeExpiry` 返回 null ⇒ 写「无临期积分」，**不编**到期日。
       套餐名不再占副行 —— 它是静态属性，积分页签的包名已经写着（WB 的副行也只有到期）。 */
    const now = Date.now();
    const expiry = row?.ok
      ? summarizeExpiry(
          row.expiresAt != null ? [{ remaining: row.remaining ?? 0, expireAt: row.expiresAt }] : [],
          { now },
        )
      : null;
    const nextBatch = expiry?.batches[0] ?? null;
    return [
      {
        key: "credits",
        label: t("shared.stat.credits"),
        valueText:
          row && row.ok
            ? `${formatCredits(row.remaining ?? 0)}/${formatCredits(row.total ?? 0)}`
            : "—",
        /* 额度没取到、或取到了但上游没给到期 ⇒ 不写「无临期积分」
           （那是「确实没有」，不是「不知道」）—— 宁可少一行，不编一个结论。
           ★ 2026-10-29：「9999-12-31」哨兵已在 core 识别为 `expiresForever`
           ⇒ 写「长期有效」，不是「到期未知」也不是一个假日期。 */
        subText: row?.ok
          ? row.expiresForever
            ? t("qoder.page.accounts.metric.neverExpires")
            : nextBatch
              ? nextExpiryLabel(expiry, t, now)
              : row.expiresAt != null
                ? t("shared.stat.noExpiring")
                : undefined
          : undefined,
        tone: nextBatch && isExpiryUrgent(nextBatch.expireAt, now) ? "warn" : undefined,
        refreshKind: "credits",
      },
      {
        key: "checkin",
        label: t("shared.stat.checkin"),
        // 三档必须分开（issue #47）：文案与概览行共用 `detailCheckinText`
        // （上游读数优先 → 读不到 / 未开放 / 未签到，没刷新过回落本地台账）。
        valueText: detailCheckinText,
        /* 只有**真的**取自台账才注明来源；一条数据都没有时值就是「—」，不写一句
           看似有结论的副行（⟳ 就在块右上角）。 */
        subText:
          checkinEntryOf(detailLive.uid)?.source === "ledger"
            ? t("shared.stat.checkinFromLedger")
            : undefined,
        refreshKind: "checkin",
      },
      {
        key: "credential",
        label: t("shared.stat.credential"),
        valueText: credBad
          ? expired
            ? t("shared.stat.credentialExpired")
            : t("shared.stat.credentialRelogin")
          : t("shared.stat.credentialOk"),
        /* ★ 2026-10-29（用户要求，与 WB / Trae 同口径）：「可正常使用」不携带信息，
           副行改为**具体到期时刻**（`formatDate` = `MM-DD HH:mm`，与 WB 的
           `credentialHintOf` 同一格式）。`expiresAt` 已由 core 归一成 Unix 毫秒；
           缺值 / 无法识别 ⇒ **不写副行** —— Qoder 没有可靠依据说「长期有效」，
           不编结论（Trae 同处理）。 */
        subText: credBad
          ? t("shared.stat.credentialBadSub")
          : detailLive.expiresAt != null
            ? t("shared.stat.credentialValidUntil", { date: formatDate(detailLive.expiresAt) })
            : undefined,
        tone: credBad ? "bad" : undefined,
        refreshKind: "credential",
      },
    ];
  }, [detailLive, creditForDisplay, detailCheckinText, checkinEntryOf, t]);

  /**
   * ★ 2026-10-26（用户报障「凭证页不显示内容」）：抽屉的**凭据页签**只渲染调用方注入的
   * `credential` 块 —— Qoder 此前没传，页签里只剩按钮。
   *
   * 数据全部来自 `QoderAccountView` 已有的凭据形态（`credential.access / refresh / pat`），
   * **不新增读法**。状态语气与指标块同一判据（`expired || !hasCredential`）。
   *
   * ★ 2026-10-27：`expiresAt` 已在 core 归一成 Unix 毫秒（无效 / 无法识别 ⇒ null），
   * 因此「凭据到期」行可如实展示；缺值时不写该行，不编日期。
   */
  const detailCredential: DetailCredential | null = detailLive
    ? (() => {
        const expired = detailLive.expiresAt != null && detailLive.expiresAt < Date.now();
        const bad = expired || !detailLive.hasCredential;
        const present = (value: boolean) =>
          value ? t("qoder.page.accounts.drawer.present") : t("qoder.page.accounts.drawer.absent");
        return {
          statusText: bad
            ? expired
              ? t("shared.stat.credentialExpired")
              : t("shared.stat.credentialRelogin")
            : t("shared.stat.credentialOk"),
          tone: bad ? ("bad" as const) : ("ok" as const),
          rows: [
            {
              label: t("qoder.page.accounts.drawer.credential"),
              value: displayText(detailLive.credentialSummary) ?? "—",
            },
            /* ★ 2026-10-27（T02）：`expiresAt` 已在 core 归一成 Unix 毫秒（无效/无法识别 ⇒ null），
               因此可以如实展示；缺值就不写这一行（不编日期）。 */
            ...(detailLive.expiresAt != null
              ? [
                  {
                    label: t("qoder.page.accounts.drawer.expiresAt"),
                    value: formatAbsoluteTime(detailLive.expiresAt),
                  },
                ]
              : []),
            {
              label: t("qoder.page.accounts.drawer.accessToken"),
              value: present(detailLive.hasAccessToken),
            },
            {
              label: t("qoder.page.accounts.drawer.refreshToken"),
              value: present(detailLive.hasRefreshToken),
            },
            {
              label: t("qoder.page.accounts.drawer.personalToken"),
              value: present(detailLive.hasPersonalToken),
            },
          ],
        };
      })()
    : null;

  /**
   * 抽屉的积分包 —— **有逐包用逐包，没有回落聚合行**（不是空区块）。
   *
   * 逐包来自网页会话（`qoderWebCreditPacks`），需要桌面端 + 登录过一次；
   * 聚合三标量在任意形态都拿得到，所以回落行永远有内容。
   */
  const detailPacks = useMemo<DetailPack[]>(() => {
    if (!detail) return [];
    const web = webPacks[detail.uid];

    // ① 有逐包 ⇒ 只渲染**还能用**的包，按最近到期排序（与浮层同一函数）。
    const visible = web?.available ? visibleQoderPacks(web.packs) : [];
    if (visible.length > 0) {
      const now = Date.now();
      const seen = new Map<string, number>();
      return visible.map((pack, index) => {
        const source = packSourceLabel(t, pack.source);
        const ordinal = (seen.get(source) ?? 0) + 1;
        seen.set(source, ordinal);
        const state = packState(pack, now);
        const expired = state === "expired";
        const expiringSoon = state === "expiring";
        const ratio =
          pack.limit > 0
            ? Math.min(100, Math.max(0, (pack.remaining / pack.limit) * 100))
            : 0;
        return {
          key: pack.id ?? `${pack.group}-${index}`,
          name: t("qoder.page.accounts.web.packName", {
            source,
            n: String(ordinal),
          }),
          remainingText: String(pack.remaining),
          totalText: String(pack.limit),
          usedText: String(pack.used),
          expiryText: expired
            ? t("qoder.page.accounts.web.expired")
            : pack.expiresAtMs !== undefined
              ? formatAbsoluteTime(pack.expiresAtMs)
              : t("qoder.page.accounts.web.neverExpires"),
          expired,
          expiringSoon,
          ratio,
        };
      });
    }

    // ② 没有逐包 ⇒ 回落聚合行（逐包合计也参与兜底，见 `creditForDisplay`）。
    const row = creditForDisplay(detail.uid);
    if (!row || !row.ok) return [];
    const remaining = row.remaining ?? 0;
    const total = row.total ?? 0;
    const used = row.used ?? 0;
    const expiresAt = row.expiresAt ?? null;
    const now = Date.now();
    return [
      {
        key: detail.uid,
        name: displayText(row.plan) ?? t("qoder.page.accounts.metric.credits"),
        remainingText: formatCredits(remaining),
        totalText: formatCredits(total),
        usedText: t("qoder.page.accounts.metric.used", { n: formatCredits(used) }),
        expiryText: row.expiresForever
          ? t("qoder.page.accounts.metric.neverExpires")
          : expiresAt == null
            ? "—"
            : expiresAt <= now
              ? t("qoder.page.accounts.metric.expired")
              : formatAbsoluteTime(expiresAt),
        expired: expiresAt != null && expiresAt <= now,
        expiringSoon: expiresAt != null && expiresAt > now && expiresAt - now <= 7 * 86_400_000,
        ratio: total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0,
      },
    ];
  }, [detail, creditForDisplay, t, webPacks]);

  /**
   * 抽屉积分包区块下方的说明与动作（#111）。
   *
   * 三态：拿到逐包 ⇒ 「N 个包 · 会话已存本机」+「退出网页登录」；
   * 没拿到（桌面端）⇒ 「需要登录一次」+「读取逐包明细」；headless ⇒ 不渲染。
   */
  const detailPacksNotice = useMemo(() => {
    if (!detail) return null;
    const web = webPacks[detail.uid];
    /* 还没取到结果（首次打开 / 取数失败）：不摆动作，避免把「未知」说成未登录或已登录。 */
    if (!web) return null;
    if (web.available) {
      const activeCount = visibleQoderPacks(web.packs).length;
      return {
        text:
          activeCount > 0
            ? t("qoder.page.accounts.web.packsNoticeReady", { n: String(activeCount) })
            : t("qoder.page.accounts.web.packsNoticeNoUsablePacks"),
        actionLabel: t("qoder.page.accounts.web.logout"),
        onAction: () => void logoutWebSession(),
        busy: false,
      };
    }
    /* 演示站按「桌面端」渲染（与浮层的 `demoModeEnabled || !api.isWebui()` 同口径），
       否则这条引导在演示里永远看不到。 */
    if (api.isWebui() && !demoModeEnabled) return null;

    /* ★ 与浮层共用 `packUnavailableCopy`：未登录 / 会话过期 / 登错账号给「登录」，
       上游抖动 / 未知给「读取」。此前这里无条件写「已登录，读取逐包明细」，
       未登录时会谎报状态（用户报障，2026-11-11）。 */
    const copy = packUnavailableCopy(t, web.reason);
    const needLogin = copy.action === "login";
    return {
      text:
        web.reason === "no_session"
          ? t("qoder.page.accounts.web.packsNotice")
          : `${copy.title}。${copy.hint}`,
      actionLabel: needLogin
        ? t("qoder.page.accounts.web.loginMenu")
        : t("qoder.page.accounts.web.read"),
      onAction: needLogin
        ? () => detail && void openWebLogin(detail)
        : () => detail && void readPacks(detail),
      busy: needLogin ? false : !!packsLoading[detail.uid],
    };
    // `logoutWebSession` / `openWebLogin` / `readPacks` 每次渲染都是新函数，
    // 进依赖会让 memo 恒失效；它们只读当前闭包里的 scope / detail。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, webPacks, packsLoading, t]);

  /** 打开抽屉时取一次逐包（TTL 内不重复请求；切区域后重新取）。 */
  useEffect(() => {
    const uid = detail?.uid;
    if (uid) void loadPacks(uid);
    // `loadPacks` 是纯读取 + setState；只按 uid / scope 变化触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.uid, scope]);

  /** 抽屉的签到区 —— 只在签到状态**明确可读**时渲染（未知 = 不摆「+0」）。 */
  /**
   * 抽屉「签到」三格的数据。
   *
   * ★ 2026-10-26（用户报障「签到请参考 WB，实现不一样」）：此前传的是 `rewardCredits`
   * —— 那不是 `DetailCheckin` 的字段名（抽屉读 `todayCredit`），于是「今日签到」那格
   * 恒显示 `+0`；同时也没传累计积分，第三格恒为「—」。现在按抽屉的字段名逐个映射，
   * 与 WB 的 `checkinCreditsOf` 落到同一组语义上。
   *
   * ⚠️ `totalClaimDays`（累计领取天数）与 `streakDays`（连续天数）是**两个**概念，
   * 抽屉那格叫「签到天数」用的是 `streakDays`，与 WB / Trae 一致。
   */
  const detailCheckin = useMemo(() => {
    if (!detailLive) return null;
    /* 与卡片 / 表格 / 指标块**同一来源**（`checkinEntryOf`）：否则单账号刷新后
       卡片已是「已签到」，签到页签还停在区域快照的「未签到」。 */
    const row = checkinEntryOf(detailLive.uid);
    const display = checkinDisplayOf(detailLive);
    /* 区域级未开放（旧通道 404/405/410）：没有三格数据，但「不可签到」是已知结论，
       不能落回「签到状态未知」。账号级 `active === false` 但缺少 `todayCheckedIn`
       （字段缺席）时同样如此 —— 已知结论优先于「读不到」。 */
    if (display === "unavailable" && (!row || !row.ok || row.todayCheckedIn === undefined)) {
      return { todayCheckedIn: false, unavailable: true };
    }
    if (!row || !row.ok || row.todayCheckedIn === undefined) return null;
    return {
      todayCheckedIn: row.todayCheckedIn === true,
      /* 窗口未开（每日 10:00 前）⇒ 抽屉写「未开始」并把签到按钮禁用；
         否则上游的「已签」是上一轮的事实，不能当成今天。 */
      windowOpen: row.windowOpen !== false,
      /* 窗口已开但上游列表还是上一轮 ⇒ 抽屉写「活动刷新中」，按钮禁用。
         ⚠️ 只有 `stale` 才算 —— 「上游没下发签到活动」那一档不是刷新中，
         它按「不可签到」渲染（与卡片 / 表格同一口径，见 `checkinDisplayOf`）。 */
      refreshing: row.windowOpen !== false && row.status === "NONE" && row.stale === true,
      /* ★ 2026-11-24：官方没给该账号下发活动（`active === false`）⇒ 签到按钮换成
         「不可签到」并禁用 —— 点下去只会命中同一条上游规则。 */
      unavailable: display === "unavailable",
      nextWindowText: row.nextWindowText ?? null,
      todayCredit: row.todayCredit ?? null,
      streakDays: row.streakDays ?? null,
      totalCredits: row.totalCredits ?? null,
    };
  }, [detailLive, checkinEntryOf, checkinDisplayOf]);

  /**
   * 抽屉动作基于**活账号**（当前账号集合里的那一条），不是打开时的快照：
   * 账号已从库里删掉时（{@link detailLive} 为 `null`）动作整块消失，不再对失效快照续期 / 签到。
   *
   * ⚠️ `onRefresh` 返回 Promise —— 抽屉的 ⟳ 要等续期 + 回读真正结束才退出忙态。
   */
  const detailActions: DetailActions | null = detailLive
    ? {
        onRefresh: () => refreshOne(detailLive),
        onCheckin: () => runCheckin([detailLive]),
        /* 「手动签到」只在凭据可用时出现（凭据坏了点它必然失败）。 */
        showCheckin: detailLive.hasCredential,
        /* ★ 2026-10-23：`导出` 已从共享抽屉移除（卡片「更多」里仍有）。 */
        onDelete: () => {
          const target = detailLive;
          setDetail(null);
          setPendingDelete(target);
        },
        credentialUnavailable: !detailLive.hasCredential,
      }
    : null;

  const columns: AccountColumn<QoderAccountView>[] = [
    {
      key: "account",
      header: t("qoder.page.accounts.table.account"),
      render: (account) => {
        /* 「当前登录」与卡片头部**同一判据、同一枚徽章**（任一程序位登着这条账号）。
           2026-10-27 补：此前 Qoder 表格只有整行底色，没有徽章 —— 与 WB / Trae 的首列不同形。 */
        const isCurrent = (programs ?? []).some((program) => program.currentUid === account.uid);
        /* ★ 2026-10-28（用户要求）：身份行不再显示 UID，改为备注；没有备注时保留空行位。
           原先表格另有一列「备注」，身份行改用备注后该列重复，已随来源列一并删除。 */
        const remark = displayText(account.remark);
        return (
          /* 与 WB / Trae 表格同一结构：头像 + 名称（含「当前登录」徽章）+ 身份行（备注）。 */
          <div className="flex min-w-0 items-center gap-2.5">
            <AccountsTableAvatar name={qoderAccountName(account)} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium" title={qoderAccountName(account)}>
                  {qoderAccountName(account)}
                </span>
                {isCurrent ? (
                  <Badge variant="info" className={ACCOUNT_CHIP_CLASS}>
                    {t("qoder.page.accounts.program.current")}
                  </Badge>
                ) : null}
              </div>
              {/* 无备注也保留这一行（空占位），避免名称在头像旁垂直居中。 */}
              <div className="truncate text-xs text-muted-foreground" title={remark ?? undefined}>
                {remark || "\u00A0"}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "status",
      header: t("qoder.page.accounts.table.status"),
      render: (account) => (
        <div className="flex flex-wrap items-center gap-1">
          {/* ★ 2026-10-28（口径对齐）：注入 `onOpenTab` —— 此前列表把与卡片同一枚的标签
              渲染成**不可点的死文字**（光标也不变手型）。共享组件自带
              `data-no-account-open`，点标签跳页签不会被行点击覆盖成「打开概览」。 */}
          <QoderStatusChips
            account={account}
            checkin={checkinDisplayOf(account)}
            checkinHint={checkinHintOf(account)}
            onOpenTab={(tab) => openDetail(account, tab)}
          />
          <QoderForeignBadge account={account} />
        </div>
      ),
    },
    {
      key: "credits",
      header: t("qoder.page.accounts.metric.credits"),
      align: "right",
      render: (account) => {
        /* ★ 2026-10-26（与 WB 表格同形）：`<b>剩余</b>/总额`，千分位走共享 `formatCredits`。
           此前是 `String()` 拼 `"558 / 700"`（无千分位、斜杠两侧带空格），与卡片那一行也不一致。
           ★ 2026-10-27（用户要求两种视图一致）：补**副行**「X 积分 MM-DD HH:mm 到期」——
           与卡片指标行同一份 `summarizeExpiry` + `nextExpiryLabel`，3 天内转警示色。
           `expiresAt` 是顶层额度到期（Unix 毫秒，Qoder SDK 口径），缺值就不编到期日。
           ★ 2026-10-28（对齐 WB / Trae 表格）：整格是**一个真按钮** → 抽屉「积分」，
           取不到额度快照时也给 `—` 且**仍可点**（点进去正是「为什么没有」）；
           主行补「剩余 · 总额 · 已用」（`creditMetricTip`），副行补逐批明细（`expiryTooltipLines`），
           都用原生 `title` —— 表格里不用 Radix 浮层，与 WB 同一纪律。 */
        /* 展示用：实时聚合优先 → 逐包兜底 → 跨重启缓存。 */
        const row = displayCreditFor(account);
        const hasCredits = Boolean(row?.ok);
        const now = Date.now();
        const expiry =
          hasCredits && row?.expiresAt != null
            ? summarizeExpiry([{ remaining: row.remaining ?? 0, expireAt: row.expiresAt }], { now })
            : null;
        const next = expiry?.batches[0] ?? null;
        /* ★ 2026-10-29：「9999-12-31」哨兵 ⇒ core 标记 `expiresForever`（`expiresAt` 为 null）。
           副行写「长期有效」，不渲染成日期。 */
        const forever = hasCredits && row?.expiresForever === true;
        const expiryTip = expiry ? expiryTooltipLines(expiry, t) : null;
        const priority = account.uid === priorityAccountId;
        const creditTip = creditMetricTip(
          {
            current: hasCredits ? row?.remaining ?? 0 : null,
            total: hasCredits ? row?.total ?? 0 : null,
            expiry,
          },
          t,
        );
        return (
          <button
            type="button"
            data-no-account-open
            onClick={() => openDetail(account, "credits")}
            aria-label={drawerTabOpenAria("credits", qoderAccountName(account), t)}
            className="flex w-full cursor-pointer flex-col items-end gap-0.5 text-right tabular-nums transition-opacity hover:opacity-85"
          >
            <span className="whitespace-nowrap" title={creditTip ?? undefined}>
              {hasCredits ? (
                <>
                  <b className="font-semibold text-foreground">{formatCredits(row?.remaining ?? 0)}</b>
                  <span className="text-muted-foreground">/{formatCredits(row?.total ?? 0)}</span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </span>
            {(next || forever || priority) && (
              <span className="flex flex-wrap items-center justify-end gap-x-1.5 whitespace-nowrap text-[11px]">
                {next ? (
                  <span
                    className={
                      isExpiryUrgent(next.expireAt, now) ? "text-warning" : "text-muted-foreground"
                    }
                    title={
                      expiryTip
                        ? [expiryTip.title, ...expiryTip.lines, expiryTip.more ?? ""].filter(Boolean).join("\n")
                        : undefined
                    }
                  >
                    {nextExpiryLabel(expiry, t, now)}
                  </span>
                ) : forever ? (
                  <span className="text-muted-foreground">
                    {t("qoder.page.accounts.metric.neverExpires")}
                  </span>
                ) : null}
                {priority ? (
                  <span className="text-primary" title={t("qoder.page.accounts.card.priorityTip")}>
                    {t("qoder.page.accounts.card.priority")}
                  </span>
                ) : null}
              </span>
            )}
          </button>
        );
      },
    },
    /* ★ 2026-10-27（T05）：补「凭据」列 —— `expiresAt` 已由 core 的 `normalize_expiry_ms`
       归一成 Unix 毫秒，「T02 完成后接真实到期信息」的前提已成立。
       单元格复用卡片导出的 `CredentialExpiryMeta`（同一份日期格式与缺值分支）；
       `showRefreshToken={false}` 与 Trae 同理由：Qoder 只有 `hasRefreshToken`，没有其到期时间。 */
    {
      key: "credential",
      header: t("qoder.page.accounts.table.credential"),
      render: (account) => (
        <CredentialExpiryMeta
          account={{ expiresAt: account.expiresAt }}
          showRefreshToken={false}
          layout="column"
        />
      ),
    },
    /* ★ 2026-10-28（用户要求）：删除「来源」与「备注」两列 —— 来源只保留在详情抽屉
       （同一信息在列表里是重复列）；备注已上移到「账号」列的身份行。 */
    /* ★ 2026-10-28（用户要求）：补「程序位」列 —— 此前只有账号列的「当前登录」徽章，
       看不到这条账号登在桌面版还是 CLI 上；与 WB / Trae 同列、同一枚只读胶囊。 */
    {
      key: "programs",
      header: t("qoder.page.accounts.table.programs"),
      render: (account) => {
        const active = (programs ?? []).filter((program) => program.currentUid === account.uid);
        return active.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {active.map((program) => (
              <ProgramSlotChip key={program.id} title={program.label}>
                {program.label}
              </ProgramSlotChip>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
  ];

  /* ── 首屏空态（「真没有账号」由它承担：出口 = 添加账号抽屉） ── */

  const emptyState =
    accounts !== null && accounts.length === 0 ? (
      <QoderEmptyCard
        error={error}
        sources={sources}
        onAdd={() => setAddDrawerOpen(true)}
        onReload={async () => {
          await reload();
        }}
      />
    ) : null;

  /**
   * 「从本机导入」是否可用：任一来源不是 `missing` 即可点（`unreadable` 也要放行 ——
   * 点下去会给出可读的原因；禁用它等于把「读不出来」变成「点不动」）。
   * 探测未返回时**放行**：点了最坏也是一条诚实的报错，比一个闪烁的禁用态好。
   */
  const localInstalled = sources === null ? true : sources.sources.some((s) => s.state !== "missing");

  /**
   * 页头一键动作的可用性 —— **做不了就禁用**，别让按钮点下去只弹一句「没活可干」。
   * 签到判据走 `checkinDisplayOf`（上游读数优先、快照兜底），与卡片/抽屉同源。
   * 「未开始 / 刷新中」不算待签（窗口没开时点它必然什么都不做）。
   */
  const noRows = rows.length === 0;
  const checkinHasPending = rows.some((row) => {
    const state = checkinDisplayOf(row);
    /* `unavailable` 里有一档不是死路：`active === false` 但仍有活动（名额锁定 / 待领），
       晚些可能恢复 —— `checkinSkipClaim` 故意保留尝试，这里也必须算作待签；
       否则「全是不可签到」会把一键入口一并禁用，那条尝试路径永远走不到。 */
    return (
      state === "unchecked" ||
      state === "unknown" ||
      (state === "unavailable" && !checkinSkipClaim(row))
    );
  });
  const allCheckinNotStarted =
    rows.length > 0 &&
    rows.every((row) => {
      const state = checkinDisplayOf(row);
      return state === "notStarted" || state === "refreshing";
    });
  /* 有任何「不可签到」（官方没下发活动）：没有待签账号时，禁用原因不能说成
     「今日已全部签到」—— 那会把上游规则说成用户已经完成。「已签 + 不可签到」的
     混合在批量签到后最常见（用户截图：成功 2 + 未开放 1）。 */
  const checkinHasUnavailable = rows.some(
    (row) => checkinDisplayOf(row) === "unavailable",
  );
  const quickBlocked = busy || quickBusy !== null;

  const productLabel = t(platformDescriptor(product).labelKey);

  return (
    <div className="mx-auto w-full max-w-[1240px] px-7 pt-[26px] pb-[60px]">
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-[640] tracking-[-0.02em]">{t("qoder.page.accounts.title")}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <ScopeChip scope={scope} />
            <span>
              ·{" "}
              {attentionCount > 0
                ? t("pageHead.accounts.pending", { n: rows.length, m: attentionCount })
                : t("pageHead.accounts", { n: rows.length })}
            </span>
            {/* 额度 / 签到 / 程序位与账号列表的后台读取，此前对用户完全静默（「突然刷新」根因）。 */}
            <SyncIndicator syncing={syncing} />
          </p>
        </div>
        <div className="grow" />
        {/* ★ 2026-10-26（用户要求）：页头补「一键刷新 / 一键签到」，与 WB / Trae 同位置、
            同控件、同冷却。一键作用于**全部账号**且只做只读刷新 / 自动跳过已签；
            删除等破坏性动作仍只在勾选后的批量条。 */}
        {/* `flex-wrap` + `justify-end`：进度与「取消」是**临时**多出来的两个元素，
            窄窗下必须能换行 —— 否则它们会把一键刷新 / 一键签到挤出可视区。 */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {/* ★ 2026-11-19（三端通知口径统一）：一键动作**不依赖勾选**，而批量条在无勾选时
              整块不渲染（`AccountBatchBar` 的 `selectedCount <= 0`）—— 此前「一键签到」
              跑十几秒页面上一句进度都没有。进度与取消在此渲染；有勾选时交给批量条里的
              同一份，两处互斥，不重复画。 */}
          {batchProgress && selected.size === 0 ? (
            <>
              <span className="text-[12px] tabular-nums text-muted-foreground">
                {t("shared.batch.progress", {
                  done: batchProgress.done,
                  total: batchProgress.total,
                })}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={cancelBatch}>
                {t("shared.batch.cancel")}
              </Button>
            </>
          ) : null}
          <QuickRefreshAction
            scope={scope}
            busy={quickBusy === "refresh"}
            disabled={quickBlocked || noRows}
            disabledReason={noRows ? t("shared.toolbar.quickNoAccounts") : undefined}
            onRefresh={quickRefreshAll}
          />
          <QuickActionButton
            icon={<CheckinIcon />}
            label={t("shared.toolbar.quickCheckin")}
            busy={quickBusy === "checkin"}
            disabled={quickBlocked || noRows || !checkinHasPending}
            disabledReason={
              noRows
                ? t("shared.toolbar.quickNoAccounts")
                : !checkinHasPending
                  ? allCheckinNotStarted
                    ? t("qoder.page.accounts.toolbar.checkinNotStarted")
                    : checkinHasUnavailable
                      ? t("qoder.page.accounts.toolbar.checkinUnavailable")
                      : t("shared.toolbar.quickCheckinNone")
                  : undefined
            }
            onClick={() => void quickCheckinAll()}
          />
        </div>
      </header>

      {/* 切换 / 启动客户端的长任务状态：接口返回 ≠ 客户端已经打开，状态条一直跟到进程真的在跑。 */}
      <SwitchProgressBanner state={switchProgress.state} className="mt-4" />

      {/* ★ 账号工作台（**三平台共用容器**）—— 与 `AccountsPage` / `TraeAccountsPage`
          是**同一个组件**；差异只在数据（排序/分组选项、卡片渲染、列定义、空态）。 */}
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
        /* ★ 主操作 = 原型工具栏最右侧的 `+ 添加账号`（打开添加抽屉，方式卡由页面注入）。 */
        addAction={{
          label: t("shared.addDrawer.title"),
          onClick: () => setAddDrawerOpen(true),
        }}
        /* ★ 回收站入口（软删除的唯一恢复路径；后端已是软删除，没有入口 = 假承诺）。 */
        onOpenRecycleBin={() => setRecycleOpen(true)}
        loading={accounts === null}
        emptyState={emptyState}
        notices={
          <>
            {/* 无客户端形态（issue #62）：本机没有 Qoder 来源时，登录授权与网关照常可用 ——
                缺的只是「从本机导入」这条读客户端目录的路。空态卡片仍保留来源四态诊断。 */}
            {sources !== null && !localInstalled ? (
              <ClientlessStrip scopeLabel={scopeLabel(t, scopeOf("qoder", region))} />
            ) : null}
            {error && rows.length > 0 ? (
              <Alert variant="destructive" className="mb-4">
                <AlertTriangle />
                <AlertTitle>{t("qoder.page.accounts.loadFailed")}</AlertTitle>
                <AlertDescription>
                  <span>{error}</span>
                  {/* ★ 失败态**必须给一条出路**：没有它，用户唯一能做的就是重启应用。 */}
                  <div className="mt-2">
                    <Button size="sm" variant="outline" onClick={() => void run(() => reload())} disabled={refreshBusy}>
                      {refreshBusy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      {t("qoder.page.accounts.recheck")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {/* 归属不符的账号**逐条列出**（不静默丢弃）—— 它们确实在这个库里，
                只是 domain 属于另一个区域；删除或迁走是用户要做的决定。 */}
            {foreignAccounts.length > 0 ? (
              <Card className="mb-4 gap-0 border-warning/40 py-0">
                <div className="flex items-start gap-2.5 px-4 py-3.5">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                  <div className="min-w-0 text-[12.5px]">
                    {t("qoder.page.accounts.domainMismatch")}：
                    {foreignAccounts.map((a) => qoderAccountName(a)).join("、")}
                  </div>
                </div>
              </Card>
            ) : null}
          </>
        }
        checkinResult={
          checkinResult
            ? {
                okCount: checkinResult.okCount,
                alreadyCount: checkinResult.alreadyCount,
                failedNames: checkinResult.failed.map((item) => item.name),
                /* ⚠️ 「不可签到」单独一档：不算成功、也不进重试桶。 */
                skippedNames: checkinResult.disabled.map((item) => item.name),
                /* 只有「不可签到」**全部**由 `campaignMissing` 构成才说「官方未下发活动」；
                   混入 legacy DISABLED / 区域未开放时用通用一句，避免结果条替上游编原因。 */
                skippedHint:
                  checkinResult.disabled.length > 0
                    ? checkinResult.disabledMissing === checkinResult.disabled.length
                      ? t("qoder.page.accounts.checkin.missingHint")
                      : t("qoder.page.accounts.checkin.disabledHint")
                    : undefined,
                /* 「未到签到时间 / 活动未刷新」单独一档：跳过了、没发请求，也不是失败。 */
                notStartedNames: checkinResult.notStarted.map((item) => item.name),
                /* 真领到的额度合计：只说「成功 1 个」不足以证明到账。 */
                earnedCredits: checkinResult.earned,
                /* 协作式取消后的「未处理」：既不是成功也不是失败，单列一档。 */
                unprocessedCount: checkinResult.unprocessed.length,
                /* 只重试**可重试**的项：失败 + 未处理；已成功 / 通道未开放不重试
                   （前者重复领取、后者永远不会成功）。 */
                onRetry:
                  checkinResult.failed.length + checkinResult.unprocessed.length > 0
                    ? () => {
                        const retryUids = new Set(
                          [...checkinResult.failed, ...checkinResult.unprocessed].map((item) => item.uid),
                        );
                        void runCheckin(
                          rows.filter((a) => retryUids.has(a.uid)),
                          checkinResult.okCount,
                          checkinResult.earned,
                          checkinResult.alreadyCount,
                        );
                      }
                    : undefined,
              }
            : null
        }
        onDismissCheckinResult={() => setCheckinResult(null)}
        batch={{
          selectedCount: selected.size,
          busy,
          /* ★ R08：普通「刷新」只走读接口（下拉），续期凭据是下拉外的写操作。 */
          onRefreshPart: (kind) => void runRefreshPartBatch(kind),
          refreshKinds: QODER_REFRESH_KINDS,
          onRefreshToken: () => void runRenewBatch(selectedRows),
          refreshingToken: renewBusy,
          onCheckin: () => void runCheckin(selectedRows),
          onExport: () => {
            setExportTargets(selectedRows);
            setExportOpen(true);
          },
          onDelete: () => setBatchDeleteOpen(true),
          onClear: () => setSelected(new Set()),
          /* 进度与取消只对逐账号循环的动作出现；只读批量刷新是整批请求，不显示进度。 */
          progress: batchProgress,
          onCancel: batchProgress ? cancelBatch : undefined,
        }}
        listAriaLabel={t("qoder.page.accounts.sectionAria", { count: rows.length })}
        totalCount={rows.length}
        visibleCount={sorted.length}
        emptyNone={{
          title: t("shared.list.empty.none"),
          description: t("shared.list.empty.noneDesc"),
        }}
        emptyFiltered={{
          title: t("shared.list.empty.filtered"),
          description: t("shared.list.empty.filteredDesc"),
          action: (
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setGroup("none");
              }}
            >
              {t("shared.list.empty.clearFilters")}
            </Button>
          ),
        }}
        buckets={buckets}
        columns={columns}
        rowKey={(account) => displayText(account.uid) ?? ""}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
        onToggleBucketAll={toggleBucketSelection}
        bucketAllSelected={bucketAllSelected}
        bucketSomeSelected={bucketSomeSelected}
        onOpenRow={openDetail}
        /* ★ R07：表格行尾的「更多」与卡片页脚**同一个装配函数**。 */
        renderActions={(account) => renderAccountMenu(account, true)}
        /* 「当前登录」= 任一程序位登着这条账号（与卡片上的徽章**同一判据**）。 */
        isRowCurrent={(account) =>
          (programs ?? []).some((program) => program.currentUid === account.uid)
        }
        rowSelectLabel={(account) => t("shared.table.selectRowAria", { name: qoderAccountName(account) })}
        rowOpenLabel={(account) => t("shared.table.openRowAria", { name: qoderAccountName(account) })}
        renderCard={(account) => {
          /* 展示用：实时聚合优先 → 逐包兜底 → 跨重启缓存。 */
          const row = displayCreditFor(account);
          return (
            <QoderAccountCard
              key={account.uid}
              account={account}
              selected={selected.has(account.uid)}
              onToggleSelect={toggleSelect}
              onOpenDetail={openDetail}
              /* ★ R10：标签直达详情页签（积分 / 签到 / 凭据）。 */
              onOpenTab={(target, tab) => openDetail(target, tab)}
              /* ★ R07/R09：卡片页脚与表格行尾**同一个菜单装配函数**。 */
              menu={renderAccountMenu(account)}
              onEditRemark={openRemark}
              onRefreshPart={onRefreshPart}
              doneKinds={refreshPartBusy.doneKindsOf(account.uid)}
              refreshingKinds={refreshPartBusy.kindsOf(account.uid)}
              refreshKinds={QODER_REFRESH_KINDS}
              onDelete={setPendingDelete}
              onSetGroup={openGroup}
              credits={
                row && row.ok
                  ? {
                      remaining: row.remaining ?? 0,
                      total: row.total ?? 0,
                      expiresAt: row.expiresAt ?? null,
                      expiresForever: row.expiresForever === true,
                    }
                  : null
              }
              checkin={checkinDisplayOf(account)}
              checkinHint={checkinHintOf(account)}
              creditPriority={account.uid === priorityAccountId}
              programs={programs}
              packs={webPacks[account.uid]}
              packsLoading={!!packsLoading[account.uid]}
              onRequestPacks={(target) => void loadPacks(target.uid)}
              onWebLogin={(target) => void openWebLogin(target)}
              onReadPacks={(target) => void readPacks(target)}
              onSwitch={(program) => setSwitchTarget({ account, program })}
            />
          );
        }}
      />

      {/* 产品名走注册表（唯一来源）—— 本页在 Qoder 分区下渲染，但产品名不写死。 */}
      <p className="mt-6 text-[11.5px] text-muted-foreground">{productLabel}</p>

      {/* ── 添加账号抽屉（原型 `drawerAdd`：方式卡 + 平台专属注入） ── */}
      <AddAccountDrawer
        open={addDrawerOpen}
        onOpenChange={setAddDrawerOpen}
        scopeLabel={scopeLabel(t, scope)}
        installed={localInstalled}
        /* 基础三张卡**全部已落地**：OAuth 设备授权（本轮新增）/ 从本机导入 / 导入备份。
           粘贴 PAT 走 extraOptions（它不属于原型的三种「添加方式」）。 */
        ways={["oauth", "local", "backup"]}
        onPick={(way) => {
          /* 本机没有 Qoder 来源时，「从本机导入」没有目录可读 —— 给替代路径（issue #62）。 */
          if (way === "local" && !localInstalled) {
            toast.error(t("shared.srv.localUnavailable"), {
              description: t("shared.srv.localUnavailableDesc"),
            });
            return;
          }
          if (way === "oauth") setOauthOpen(true);
          if (way === "local") void onImportLocal();
          if (way === "backup") setImportOpen(true);
        }}
        extraOptions={[
          {
            key: "paste-pat",
            icon: KeyRound,
            title: t("qoder.page.accounts.pat.title"),
            desc: t("qoder.page.accounts.pat.description"),
            onClick: () => setPatOpen(true),
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

      {/* ── OAuth 设备授权弹窗（本轮新增） ── */}
      <QoderOAuthDialog
        open={oauthOpen}
        onOpenChange={setOauthOpen}
        scope={scope}
        onCollected={() => {
          void reload().then(() => loadEnrichment({ force: true }));
        }}
      />

      {/* ── 粘贴 PAT 弹层（「从本机导入」读不出来时的兜底路径） ── */}
      <PastePatDialog
        open={patOpen}
        onOpenChange={setPatOpen}
        scope={scope}
        onImported={() => void reload()}
      />

      {/* ── 导入 / 导出备份（**共用壳**，按 scope 分家） ── */}
      <ImportAccountsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        scope={scope}
        onImported={(result) => {
          toast.success(
            t("qoder.page.accounts.import.result", {
              imported: String(result.imported),
              updated: String(result.overwritten),
            }),
          );
          void reload();
        }}
      />
      <ExportAccountsDialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open);
          // 关闭即清掉「导出所选」的目标：下次从抽屉进来仍是「全部」，不残留上一次的范围。
          if (!open) setExportTargets(null);
        }}
        accounts={(exportTargets ?? rows).map((account) => ({
          id: account.uid,
          label: qoderAccountName(account),
        }))}
        scope={scope}
      />

      {/* ── 回收站抽屉（**三平台共用壳**；恢复 = 移回 live，必须重取列表） ── */}
      <RecycleBinSheet
        open={recycleOpen}
        onOpenChange={setRecycleOpen}
        scope={scope}
        onRestored={() => void reload()}
      />

      {/* ── 切换确认：走**统一重启确认框**（§3.15.3「不要各写一套」） ──
          与 WorkBuddy / Trae 同一条流程：桌面版告知未保存文件风险 + 默认勾选「自动重开」，
          CLI 例外（不重开、只提示会话会中断）。确认后带着 `restart` 调后端。 */}
      <RestartConfirmDialog
        open={switchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSwitchTarget(null);
        }}
        clientLabel={switchTarget?.program.label ?? ""}
        isCli={switchTarget?.program.id === "cli"}
        onConfirm={(restart) => {
          const target = switchTarget;
          setSwitchTarget(null);
          if (target) void doSwitch(target.account, target.program, restart);
        }}
      />

      {/* ── 账号详情抽屉（备注编辑在这里；操作区 = 刷新 / 签到 / 导出 / 删除） ── */}
      <AccountDetailDrawer
        open={detail !== null}
        // 页签记忆的身份键：`scope:uid`（国内版 / 国际版的同一个 uid 是两个账号）。
        accountKey={detail ? `${scope}:${displayText(detail.uid) ?? ""}` : ""}
        initialTab={detailTab}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setDetailTab(null);
          }
        }}
        name={detail ? qoderAccountName(detail) : ""}
        /* ★ 2026-10-29（用户要求）：头部名称下**只显示 UID** —— 名称已经在标题里，
           副标题再写第二遍身份没有信息量。 */
        subtitle={
          detail
            ? t("shared.drawer.subtitleUid", { uid: displayText(detail.uid) ?? "—" })
            : ""
        }
        avatarSeed={detail ? qoderAccountName(detail) : ""}
        sections={detail ? [{ key: "account", title: t("qoder.page.accounts.drawer.info"), rows: detailRows }] : []}
        packs={detailPacks}
        packsNotice={detailPacksNotice}
        stats={detailStats}
        refreshingKinds={detail ? refreshPartBusy.kindsOf(detail.uid) : []}
        onRefreshPart={detailLive ? (kind) => void onRefreshPart(detailLive, kind) : undefined}
        checkin={detailCheckin}
        /* 「不可签到 / 未签」的**原因**：抽屉是用户点进来找解释的地方。
           下发缺失 → 长解释；其余 `active === false`（如名额未开放）→ 短句。 */
        checkinHint={
          detailLive && checkinCampaignMissing(detailLive)
            ? t("qoder.page.accounts.checkin.missingHint")
            : detailLive && checkinDisplayOf(detailLive) === "unavailable"
              ? t("qoder.page.accounts.chip.checkinUnavailableTip")
              : undefined
        }
        credential={detailCredential}
        /* ★ 2026-10-27（R10）：与卡片 / 表格同一判据的「当前登录」徽章。 */
        current={detailIsCurrent}
        /* ★ 2026-10-26：交给抽屉「本平台能刷哪些项」⇒ 积分页签常驻（无明细时给空态 + ⟳）。 */
        refreshKinds={QODER_REFRESH_KINDS}
        remark={detail?.remark ?? ""}
        onSaveRemark={detail ? (remark) => saveRemark(detail, remark) : undefined}
        autoEditRemark={detailAutoEditRemark}
        group={detail?.group ?? ""}
        onSaveGroup={detail ? (group) => saveGroup(detail, group) : undefined}
        groups={detailGroups}
        autoEditGroup={detailAutoEditGroup}
        switchTargets={detail ? switchTargetsFor(detail) : []}
        /* 与 WB / Trae 抽屉**同一取值**（备注是否可编辑不受演示模式影响）。 */
        featuresDisabled={false}
        actions={detailActions}
      />

      {/* ── 单账号删除确认（**软删除** ⇒ 文案如实说「可在回收站恢复」） ── */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("qoder.page.accounts.delete.title")}</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? t("qoder.page.accounts.delete.desc", { name: qoderAccountName(pendingDelete) })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={busy}>
              {t("qoder.page.accounts.delete.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmSingleDelete()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("qoder.page.accounts.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 批量删除确认 ── */}
      <Dialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("qoder.page.accounts.delete.batchTitle")}</DialogTitle>
            <DialogDescription>
              {t("qoder.page.accounts.delete.batchDesc", { n: String(selected.size) })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDeleteOpen(false)} disabled={busy}>
              {t("qoder.page.accounts.delete.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void confirmBatchDelete()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("qoder.page.accounts.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 展示名走卡片模块的**唯一回落链**（页面、卡片、抽屉、toast 同一份）。 */

/**
 * 首屏空态卡（「这个区域还没有账号」）。
 *
 * 照原型 `emptyBlock`（标题 / 说明 / 出口按钮），出口 = 「添加账号」抽屉；并附
 * **本机来源四态**（`missing / unreadable / empty / ready` 对应四种不同的用户动作：
 * 去装 / 去客户端重新登录 / 换个来源 / 直接导入 —— 压成一个「未检测到」就会给错引导）。
 * 失败信息也在这里兜底展示（工作台在首屏空态时会整块替换，含 notices 槽）。
 */
function QoderEmptyCard({
  error,
  sources,
  onAdd,
  onReload,
}: {
  error: string;
  sources: QoderLocalSourcesView | null;
  onAdd: () => void;
  onReload: () => Promise<void>;
}) {
  const t = useT();
  const { busy, run } = useRefreshAction();
  return (
    <Card className="gap-0 py-0">
      {error ? (
        <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3.5">
          <ShieldAlert className="size-4 shrink-0 text-destructive" />
          <div className="min-w-0 grow text-[12.5px]">{error}</div>
          <Button size="sm" variant="outline" onClick={() => void run(() => onReload())} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("qoder.page.accounts.recheck")}
          </Button>
        </div>
      ) : null}
      <EmptyState
        icon={UserRound}
        title={t("qoder.page.accounts.empty.title")}
        description={t("qoder.page.accounts.empty.description")}
        action={
          <Button onClick={onAdd}>
            <Plus className="size-4" />
            {t("qoder.page.accounts.empty.action")}
          </Button>
        }
      />
      {sources ? (
        <div className="border-t">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pb-1 pt-3">
            <span className="text-[12.5px] font-[550]">{t("qoder.page.accounts.empty.sources")}</span>
            <span className="text-[11px] text-muted-foreground">
              {t("qoder.page.accounts.import.description")}
            </span>
          </div>
          {sources.sources.map((source) => (
            <QoderLocalSourceRow key={source.kind} source={source} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/** 粘贴 PAT 弹层：前缀校验（`pt-`）在客户端先拦一道，导入走 `qoder_import_pat`。 */
function PastePatDialog({
  open,
  onOpenChange,
  scope,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: Scope;
  onImported: () => void;
}) {
  const t = useT();
  const [pat, setPat] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    const value = pat.trim();
    if (!value.startsWith("pt-")) {
      setError(t("qoder.page.accounts.pat.invalid"));
      return;
    }
    setError("");
    setSaving(true);
    try {
      await api.qoderImportPat(scope, value);
      toast.success(t("qoder.page.accounts.import.result", { imported: "1", updated: "0" }));
      setPat("");
      onOpenChange(false);
      onImported();
    } catch (e) {
      setError(api.asError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("qoder.page.accounts.pat.title")}</DialogTitle>
          <DialogDescription>{t("qoder.page.accounts.pat.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="qoder-pat">PAT</Label>
          <Input
            id="qoder-pat"
            value={pat}
            onChange={(event) => {
              setPat(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !saving) void submit();
            }}
            placeholder={t("qoder.page.accounts.pat.placeholder")}
            className="font-mono text-[12.5px]"
            spellCheck={false}
          />
          {error ? <div className="text-[11.5px] text-destructive">{error}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("qoder.page.accounts.pat.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !pat.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("qoder.page.accounts.pat.action")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
