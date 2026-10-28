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
import {
  AlertTriangle,
  KeyRound,
  Loader2,
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
import {
  QoderAccountCard,
  QoderForeignBadge,
  QoderStatusChips,
  qoderAccountName,
  qoderSourceLabel,
} from "@/components/qoder/qoder-account-card";
import { QoderLocalSourceRow } from "@/components/qoder/qoder-local-source-row";
import { QoderOAuthDialog } from "@/components/qoder/qoder-oauth-dialog";
import { ScopeChip, scopeLabel } from "@/components/scope-chip";
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
import {
  QuickActionButton,
  QuickRefreshAction,
  quickRefreshCoolingDown,
  startQuickRefreshCooldown,
} from "@/components/account-quick-actions";
import { CheckinIcon } from "@/lib/semantic-icons";
import { displayText } from "@/lib/display-text";
import { demoModeEnabled } from "@/lib/demo-mode";
import { ACCOUNT_CHIP_CLASS, CredentialExpiryMeta, formatCreditExpiry, formatCredits, nextExpiryLabel } from "@/components/account-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { isExpiryUrgent, summarizeExpiry } from "@/lib/credit-expiry";
import { REFRESH_DONE_LABEL, useAccountRefreshBusy, type AccountRefreshKind } from "@/lib/account-refresh";
import { mapWithConcurrency } from "@/lib/concurrency";
import { useT } from "@/lib/i18n";
import { platformDescriptor, platformOfPath, type Product } from "@/lib/platforms/registry";
import { scopeOf, type Scope } from "@/lib/scope";
import type { Region } from "@/lib/types";
import { useScope } from "@/lib/use-scope";
import { useMediaQuery } from "@/lib/use-media-query";
import { useRefreshAction } from "@/lib/use-refresh-action";

/** ISO-8601 → 毫秒时间戳（解析不了给 `null` ⇒ 调用方**省掉那一行**，不显示 1970）。 */
const stampToMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
};

/** 批量签到 / 批量刷新的失败项（`uid` 用于只重试失败项，`name` 用于展示）。 */
interface FailedItem {
  uid: string;
  name: string;
}

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

  const [accounts, setAccounts] = useState<QoderAccountView[] | null>(null);
  const [sources, setSources] = useState<QoderLocalSourcesView | null>(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);

  /* ── 额度 / 签到（**上游调用**，与账号列表分开加载；见文件头「加载策略」） ── */
  const [credits, setCredits] = useState<Record<string, QoderCreditsRow>>({});
  const [checkinRows, setCheckinRows] = useState<Record<string, QoderCheckinRow>>({});
  /** 本区域签到通道是否未开放（`qoder_checkin_status.unavailable`）—— 菜单要如实说「未开放」。 */
  const [checkinUnavailable, setCheckinUnavailable] = useState(false);
  /* 程序位状态（只读）：决定页脚程序位行、「当前登录」徽章与「切换到此账号」的可用性。 */
  const [programs, setPrograms] = useState<QoderProgramStatus[] | null>(null);

  /* ── 视图参数（页内 state，不进 URL、不进全局 store —— `account-list-view.ts` 的纪律） ── */
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AccountSortKey>("name");
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
  /** 本次打开要直达的页签（`null` = 按账号记忆）。只在本次打开生效，关闭即清。 */
  const [detailTab, setDetailTab] = useState<DrawerTab | null>(null);
  const [detailAutoEditRemark, setDetailAutoEditRemark] = useState(false);
  const [detailAutoEditGroup, setDetailAutoEditGroup] = useState(false);
  /** 待确认的切换（账号 × 程序位）。 */
  const [switchTarget, setSwitchTarget] = useState<{ account: QoderAccountView; program: QoderProgramStatus } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
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
  /* 四档：成功数 / 通道未开放 / 失败 / **未处理**（协作式取消后没发出的）。 */
  const [checkinResult, setCheckinResult] = useState<{
    okCount: number;
    /** 本次**真领到**的额度合计（活动通道；只作展示，不参与成败判定）。 */
    earned: number;
    disabled: FailedItem[];
    failed: FailedItem[];
    unprocessed: FailedItem[];
  } | null>(null);

  /** 失败态「重新检测」按钮的进行中态（操作进行中 ⇒ 按钮内 Loader2）。 */
  const { busy: refreshBusy, run } = useRefreshAction();

  /**
   * 读取请求的序号：同一作用域内可能重叠（页头一键 + 用户点刷新 + 写操作回读），
   * **旧响应不得覆盖更新的结果**。作用域之间的隔离由外层 `key` 重挂载承担。
   */
  const reloadSeq = useRef(0);
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

  const reload = useCallback(async () => {
    const request = ++reloadSeq.current;
    setError("");
    try {
      const [accountsView, localSources] = await Promise.all([
        api.getQoderAccounts(scope),
        api.getQoderLocalSources(scope),
      ]);
      if (request !== reloadSeq.current) return false;
      setAccounts(accountsView.accounts ?? []);
      setSources(localSources);
      return true;
    } catch (e) {
      if (request !== reloadSeq.current) return false;
      setError(api.asError(e));
      setAccounts((prev) => prev ?? []);
      return false;
    }
  }, [scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 拉额度与签到状态。
   *
   * ⚠️ `allSettled`：两条互不依赖，**一条失败不该拖垮另一条**（区域未开放签到 ≠ 额度也拿不到）。
   * 失败时**保持上一份快照**（不清空）—— 清空会把「暂时取不到」显示成「没有额度」。
   */
  const loadEnrichment = useCallback(async () => {
    const request = ++enrichmentSeq.current;
    const [creditsView, checkinView, programView] = await Promise.allSettled([
      api.qoderCredits(scope),
      api.qoderCheckinStatus(scope),
      api.qoderProgramStatus(scope),
    ]);
    /* 被更新的读取取代 ⇒ 丢弃整批（三份同批写入，保持同一时刻的快照）。 */
    if (request !== enrichmentSeq.current) return;
    if (programView.status === "fulfilled") {
      setPrograms(programView.value.programs ?? []);
    }
    if (creditsView.status === "fulfilled") {
      setCredits(Object.fromEntries(creditsView.value.accounts.map((row) => [row.uid, row])));
    }
    if (checkinView.status === "fulfilled") {
      setCheckinRows(Object.fromEntries(checkinView.value.accounts.map((row) => [row.uid, row])));
      setCheckinUnavailable(Boolean(checkinView.value.unavailable));
    }
  }, [scope]);

  const hasAccounts = accounts !== null && accounts.length > 0;
  useEffect(() => {
    if (!hasAccounts) {
      // 空库时清掉旧快照：切到另一个区域后残留上一个区域的额度 = 撒谎。
      setCredits({});
      setCheckinRows({});
      setCheckinUnavailable(false);
      setPrograms(null);
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
   * 排序键三个，各有数据支撑：
   * - `priority`（复用共享的排序键名，语义 = **积分余额降序**，与 WB 的「优先级」同义）：
   *   额度来自 `qoder_credits`；**未取到额度的账号排最后**（`-1`），不是排最前
   *   —— 把「不知道」当成「最高」会让用户去用一个可能没余额的号。
   * - `name` / `recent`（`updatedAt`，记录最后一次被导入 / 改备注的时刻）。
   *
   * **不提供**「按到期」：排序键与 WB 对齐（优先级 / 名称 / 最近）——
   * 凭据到期已归一成 Unix 毫秒并可展示（见抽屉「凭据」页签），但不因此新增第四种排序。
   */
  const listConfig = useMemo<AccountListConfig<QoderAccountView>>(() => {
    const nameComparator: AccountComparator<QoderAccountView> = (left, right) =>
      qoderAccountName(left).localeCompare(qoderAccountName(right), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    const recentComparator: AccountComparator<QoderAccountView> = (left, right) =>
      (stampToMs(right.updatedAt) ?? -Infinity) - (stampToMs(left.updatedAt) ?? -Infinity);
    const creditComparator: AccountComparator<QoderAccountView> = (left, right) =>
      (credits[right.uid]?.remaining ?? -1) - (credits[left.uid]?.remaining ?? -1);
    return {
      searchText: (account) =>
        accountSearchText({
          name: displayText(account.name),
          uid: displayText(account.uid),
          remark: displayText(account.remark),
        }),
      comparators: { priority: creditComparator, name: nameComparator, recent: recentComparator },
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
      availableSorts: ["priority", "name", "recent"],
      availableGroups: ["none", "program", "status", "group"],
    };
  }, [t, credits, programs]);

  const sortOptions = useMemo(
    () =>
      (
        [
          ["priority", t("qoder.page.accounts.toolbar.sort.credits")],
          ["name", t("qoder.page.accounts.toolbar.sort.name")],
          ["recent", t("qoder.page.accounts.toolbar.sort.recent")],
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
   * 逐账号签到状态（`qoder_checkin_status_map`）——**只覆盖被刷新过的账号**。
   *
   * 刻意不在进页面时全量拉：那要逐账号打上游（N 个账号 = N 次请求），
   * 而 `qoder_checkin_status` 的区域快照足够画初值。用户点刷新才去问。
   */
  const [checkinMap, setCheckinMap] = useState<Record<string, CheckinStatusEntry>>({});

  /** 今日签到状态的**唯一来源**：单账号刷新的上游读数优先，其次区域快照。 */
  const checkinEntryOf = useCallback(
    (uid: string): CheckinStatusEntry | undefined => checkinMap[uid] ?? checkinRows[uid],
    [checkinMap, checkinRows],
  );

  /** 今日签到三态（`null` = 未知，**不伪装成未签**）。
   *
   * ⚠️ 卡片、表格、抽屉指标块与签到页签**全部**经由 {@link checkinEntryOf} / 本函数取值：
   * 两处各读一份（`checkinMap` vs `checkinRows`）会出现「刷新后卡片已签到、抽屉仍说未签到」。
   */
  const checkinTodayOf = useCallback(
    (account: QoderAccountView): boolean | null => {
      const entry = checkinEntryOf(account.uid);
      if (!entry || !entry.ok) return null;
      return entry.todayCheckedIn === true;
    },
    [checkinEntryOf],
  );

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
   * `available` 的判据 = **该程序位已就绪且客户端没在跑**：
   * - 四态不是 `ready` ⇒ 没装 / 没登录 / 读不出来，切换无处可写；
   * - 客户端在跑 ⇒ 后端会拒绝（退出时内存态会覆盖），界面提前置灰。
   * `current` 为真时不再重复切换（只读高亮）。
   */
  const switchTargetsFor = useCallback(
    (account: QoderAccountView): DetailSwitchTarget[] =>
      (programs ?? []).map((program) => ({
        key: program.id,
        label: program.label,
        current: program.currentUid === account.uid,
        available: program.state === "ready" && !program.running,
        busy: switchBusy,
        onSwitch: () => setSwitchTarget({ account, program }),
      })),
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
   * ⚠️ 后端会在客户端运行时拒绝、写后校验失败时自动还原备份 —— 前端**如实转述**后端的话，
   * 不要自己编「切换成功」。
   */
  async function confirmSwitch() {
    if (!switchTarget || switchBusy) return;
    const { account, program } = switchTarget;
    setSwitchBusy(true);
    try {
      const result = await api.qoderSwitchAccount(scope, program.id, account.uid);
      toast.success(t("qoder.page.accounts.switch.done", { name: qoderAccountName(account) }), {
        description: result.backupPath
          ? t("qoder.page.accounts.switch.backup", { path: result.backupPath })
          : undefined,
      });
      setSwitchTarget(null);
      /* 切换改的是**客户端登录态**⇒ 必须重取程序位状态（「当前登录」徽章才会跟着动）。 */
      await loadEnrichment();
    } catch (e) {
      toast.error(api.asError(e));
    } finally {
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
          } else if (kind === "checkin") {
            /* 只问这一个账号（批量接口传 1 个 id 即可，不新增「单账号」变体）。 */
            const map = await api.qoderCheckinStatusMap(scope, [account.uid]);
            const current = map[account.uid];
            if (!current) throw new Error(t("shared.refreshPart.fail"));
            if (!current.ok) throw new Error(current.error ?? t("shared.refreshPart.fail"));
            setCheckinMap((prev) => ({ ...prev, ...map }));
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
    [refreshPartBusy, scope, reload, t],
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
    if (synced) await loadEnrichment();
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
   * ★ **四档**：成功（含 `already`）/ 通道未开放（`disabled`，重试永远无效）/ 失败 /
   * **未处理**（用户取消、请求根本没发出 —— 它既不是成功也不是失败）。
   */
  async function runCheckin(targets: QoderAccountView[], baseOk = 0, baseEarned = 0) {
    if (targets.length === 0 || busy) return;
    setBusy(true);
    try {
      const outcomes = await runBatch(targets, async (account) => {
        try {
          return await api.qoderCheckinClaim(scope, account.uid);
        } catch {
          return null;
        }
      });
      const failed: FailedItem[] = [];
      const disabled: FailedItem[] = [];
      const unprocessed: FailedItem[] = [];
      const checkedUids: string[] = [];
      let ok = baseOk;
      let earned = baseEarned;
      outcomes.forEach((outcome, index) => {
        const account = targets[index];
        /* 先按**目标索引**取结果：稠密数组里未执行项是 `undefined`，
           这里必须算进「未处理」而不是被跳过（取消后不能报全部成功）。 */
        const item = { uid: account.uid, name: qoderAccountName(account) };
        if (outcome === undefined) {
          unprocessed.push(item);
          return;
        }
        if (!outcome) {
          failed.push(item);
          return;
        }
        if (outcome.ok) {
          ok += 1;
          checkedUids.push(account.uid);
          // 活动通道会带「真领到多少」；旧通道没这个字段 ⇒ 记 0，不编数。
          earned += outcome.rewardCredits ?? 0;
        } else if (outcome.disabled) disabled.push(item);
        else failed.push(item);
      });
      setCheckinMap((prev) => {
        const next = { ...prev };
        for (const uid of checkedUids) {
          const entry = next[uid];
          if (entry?.ok && !entry.todayCheckedIn) {
            next[uid] = { ...entry, todayCheckedIn: true, source: "ledger" };
          } else if (entry && !entry.ok) {
            /* ★ 旧条目是「读取失败」：签到成功是**更新的事实**，必须整体替换 ——
               否则这条 `ok:false` 优先级高于区域快照，卡片 / 详情仍显示「读取失败」。
               失败条目没有可信统计字段，只保留「已签到 + ledger」。 */
            next[uid] = { ok: true, todayCheckedIn: true, source: "ledger" };
          }
        }
        return next;
      });
      setCheckinResult({ okCount: ok, earned, disabled, failed, unprocessed });
      await loadEnrichment();
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
      await loadEnrichment();
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
        const failed = ids.filter((uid) => !view.accounts.some((row) => row.uid === uid && row.ok));
        if (!aliveRef.current) return;
        if (failed.length > 0) {
          toast.error(t("qoder.page.accounts.quickRefreshPartial", { n: failed.length }));
        } else {
          toast.success(t("qoder.page.accounts.quickRefreshDone", { n: ids.length }));
        }
      } else if (kind === "checkin") {
        const map = await api.qoderCheckinStatusMap(scope, ids);
        setCheckinMap((prev) => ({ ...prev, ...map }));
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
      }
      if (checkinResult.status === "fulfilled") {
        setCheckinMap((prev) => ({ ...prev, ...checkinResult.value }));
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
      if (failed === 0) toast.success(t("qoder.page.accounts.quickRefreshDone", { n: ids.length }));
      else if (failed === 3) {
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
   * 签到状态的**显式取值**（菜单与卡片共用同一个判据）。
   * 未知 / 读取失败 / 未开放各自成态，绝不把「不知道」画成「未签到」。
   */
  function checkinStateOf(account: QoderAccountView): AccountCheckinState {
    const entry = checkinEntryOf(account.uid);
    if (!entry) {
      /* 通道未开放 ⇒ 明说「未开放」（重试永远不会成功）；否则才是「还没查」= 未知。 */
      return checkinUnavailable ? { kind: "unavailable" } : { kind: "unknown" };
    }
    if (!entry.ok) return { kind: "unreadable", reason: entry.error };
    if (entry.active === false) return { kind: "unavailable" };
    return entry.todayCheckedIn ? { kind: "checked" } : { kind: "unchecked" };
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
        /* 「切换账号」：打开**当前账号详情**并定位到程序位选择区（不另造切换向导）。 */
        onSwitch={() => openDetail(account)}
        onExport={() => {
          /* 单账号导出必须只含这一条，与勾选 / 全量导出隔离。 */
          setExportTargets([account]);
          setExportOpen(true);
        }}
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
    let ok = 0;
    let fail = 0;
    for (const account of targets) {
      try {
        await api.qoderDeleteAccount(scope, account.uid);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBusy(false);
    setBatchDeleteOpen(false);
    if (fail === 0) toast.success(t("qoder.page.accounts.delete.done", { n: String(ok) }));
    else toast.error(t("qoder.page.accounts.delete.partial", { ok: String(ok), fail: String(fail) }));
    setSelected(new Set());
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
   */
  const detailCheckinText = useMemo(() => {
    if (!detailLive) return "—";
    const entry = checkinEntryOf(detailLive.uid);
    if (entry && !entry.ok) return t("shared.stat.checkinUnreadable");
    if (entry) {
      return entry.todayCheckedIn
        ? t("shared.stat.checkedIn")
        : entry.active === false
          ? t("shared.stat.checkinUnavailable")
          : t("shared.stat.notCheckedIn");
    }
    return "—";
  }, [detailLive, checkinEntryOf, t]);

  /**
   * 概览只留「账号信息」一块 —— 与 WorkBuddy 同构（身份 / 元数据 / 今日签到）。
   *
   * ★ 2026-10-27（用户要求「参考 WorkBuddy，去掉概览里重复的凭据信息」）：
   * 「凭据」「访问令牌」两行与「凭据」页签逐字段重复（那边还带令牌有无与续期入口）
   * ⇒ 从概览移除；访问令牌掩码在卡片底部仍然可见。
   * UID 不再重复：抽屉副标题已经是 `{name} · UID {uid}`。
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
    const row = credits[detailLive.uid];
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
           （那是「确实没有」，不是「不知道」）—— 宁可少一行，不编一个结论。 */
        subText: row?.ok
          ? nextBatch
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
        subText:
          checkinEntryOf(detailLive.uid)?.source === "ledger" ||
          !checkinEntryOf(detailLive.uid)
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
        /* ⚠️ 2026-10-27：凭据到期已由 core **归一成 Unix 毫秒**（`normalize_expiry_ms`），
           因此可以在「凭据」页签如实展示（缺失 ⇒ 不写该行）。副行仍只写语气，不重复日期。 */
        subText: credBad ? t("shared.stat.credentialBadSub") : t("shared.stat.credentialOkSub"),
        tone: credBad ? "bad" : undefined,
        refreshKind: "credential",
      },
    ];
  }, [detailLive, credits, detailCheckinText, checkinEntryOf, t]);

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
   * 抽屉的积分包 —— **只在拿到额度时**渲染（`packs` 空数组 = 抽屉不渲染该区块）。
   *
   * Qoder 的额度是**一整包**：`userQuota` 与 `addOnQuota` 共用顶层 `expiresAt`
   * （Unix **毫秒**，Qoder SDK 口径）⇒ 只有一行，剩余即「到期时会作废的积分数」。
   * 缺 `expiresAt` ⇒ 到期写「—」（不编日期）。
   */
  const detailPacks = useMemo<DetailPack[]>(() => {
    if (!detail) return [];
    const row = credits[detail.uid];
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
        expiryText:
          expiresAt == null
            ? "—"
            : expiresAt <= now
              ? t("qoder.page.accounts.metric.expired")
              : t("qoder.page.accounts.metric.expiresOn", { date: formatCreditExpiry(expiresAt, t) }),
        expired: expiresAt != null && expiresAt <= now,
        /* 与 WB / Trae 同一窗口（7 天）：下界 `> now` 不能省 —— 已过期的包只算 expired。 */
        expiringSoon: expiresAt != null && expiresAt > now && expiresAt - now <= 7 * 86_400_000,
        ratio: total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 0,
      },
    ];
  }, [detail, credits, t]);

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
    if (!row || !row.ok || row.todayCheckedIn === undefined) return null;
    return {
      todayCheckedIn: row.todayCheckedIn === true,
      todayCredit: row.todayCredit ?? null,
      streakDays: row.streakDays ?? null,
      totalCredits: row.totalCredits ?? null,
    };
  }, [detailLive, checkinEntryOf]);

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
        return (
          /* 与 WB / Trae 表格同一结构：头像 + 名称（含「当前登录」徽章）+ 身份行。 */
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
              <div className="truncate font-mono text-xs text-muted-foreground">
                UID · {displayText(account.uid) ?? "—"}
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
          <QoderStatusChips account={account} checkinToday={checkinTodayOf(account)} />
          <QoderForeignBadge account={account} />
        </div>
      ),
    },
    {
      key: "credits",
      header: t("qoder.page.accounts.metric.credits"),
      align: "right",
      render: (account) => {
        const row = credits[account.uid];
        if (!row || !row.ok) return <span className="text-muted-foreground">—</span>;
        /* ★ 2026-10-26（与 WB 表格同形）：`<b>剩余</b>/总额`，千分位走共享 `formatCredits`。
           此前是 `String()` 拼 `"558 / 700"`（无千分位、斜杠两侧带空格），与卡片那一行也不一致。
           ★ 2026-10-27（用户要求两种视图一致）：补**副行**「X 积分 MM-DD HH:mm 到期」——
           与卡片指标行同一份 `summarizeExpiry` + `nextExpiryLabel`，3 天内转警示色。
           `expiresAt` 是顶层额度到期（Unix 毫秒，Qoder SDK 口径），缺值就不编到期日。 */
        const now = Date.now();
        const expiry =
          row.expiresAt != null
            ? summarizeExpiry([{ remaining: row.remaining ?? 0, expireAt: row.expiresAt }], { now })
            : null;
        const next = expiry?.batches[0] ?? null;
        return (
          <div className="flex w-full flex-col items-end gap-0.5 text-right tabular-nums">
            <span className="whitespace-nowrap">
              <b className="font-semibold text-foreground">{formatCredits(row.remaining ?? 0)}</b>
              <span className="text-muted-foreground">/{formatCredits(row.total ?? 0)}</span>
            </span>
            {next ? (
              <span
                className={cn(
                  "whitespace-nowrap text-[11px]",
                  isExpiryUrgent(next.expireAt, now) ? "text-warning" : "text-muted-foreground",
                )}
              >
                {nextExpiryLabel(expiry, t, now)}
              </span>
            ) : null}
          </div>
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
    {
      key: "source",
      header: t("qoder.page.accounts.table.source"),
      render: (account) => (
        <span className="text-muted-foreground">{qoderSourceLabel(t, account.source) ?? "—"}</span>
      ),
    },
    {
      key: "remark",
      header: t("qoder.page.accounts.table.remark"),
      render: (account) => (
        <span className="text-muted-foreground">{displayText(account.remark) ?? "—"}</span>
      ),
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
   * 签到判据走 `checkinTodayOf`（上游读数优先、快照兜底），与卡片/抽屉同源。
   */
  const noRows = rows.length === 0;
  const checkinHasPending = rows.some((row) => checkinTodayOf(row) !== true);
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
          </p>
        </div>
        <div className="grow" />
        {/* ★ 2026-10-26（用户要求）：页头补「一键刷新 / 一键签到」，与 WB / Trae 同位置、
            同控件、同冷却。一键作用于**全部账号**且只做只读刷新 / 自动跳过已签；
            删除等破坏性动作仍只在勾选后的批量条。 */}
        <div className="flex shrink-0 items-center gap-2">
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
                  ? t("shared.toolbar.quickCheckinNone")
                  : undefined
            }
            onClick={() => void quickCheckinAll()}
          />
        </div>
      </header>

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
                failedNames: checkinResult.failed.map((item) => item.name),
                /* ⚠️ 「通道未开放」单独一档：不算成功、也不进重试桶。 */
                skippedNames: checkinResult.disabled.map((item) => item.name),
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
          const row = credits[account.uid];
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
                      plan: row.plan ?? null,
                    }
                  : null
              }
              checkinToday={checkinTodayOf(account)}
              programs={programs}
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
          void reload().then(() => loadEnrichment());
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

      {/* ── 切换确认（**写客户端登录态**，与 WB 的切换同级 ⇒ 必须先确认） ── */}
      <Dialog open={switchTarget !== null} onOpenChange={(open) => !open && setSwitchTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("qoder.page.accounts.switch.title")}</DialogTitle>
            <DialogDescription>
              {switchTarget
                ? t("qoder.page.accounts.switch.desc", {
                    name: qoderAccountName(switchTarget.account),
                    program: switchTarget.program.label,
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwitchTarget(null)} disabled={switchBusy}>
              {t("qoder.page.accounts.switch.cancel")}
            </Button>
            <Button onClick={() => void confirmSwitch()} disabled={switchBusy}>
              {switchBusy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("qoder.page.accounts.switch.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        subtitle={
          detail
            ? t("qoder.page.accounts.drawer.subtitle", {
                name: qoderAccountName(detail),
                uid: displayText(detail.uid) ?? "—",
              })
            : ""
        }
        avatarSeed={detail ? qoderAccountName(detail) : ""}
        sections={detail ? [{ key: "account", title: t("qoder.page.accounts.drawer.info"), rows: detailRows }] : []}
        packs={detailPacks}
        stats={detailStats}
        refreshingKinds={detail ? refreshPartBusy.kindsOf(detail.uid) : []}
        onRefreshPart={detailLive ? (kind) => void onRefreshPart(detailLive, kind) : undefined}
        checkin={detailCheckin}
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
