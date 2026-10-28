import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Info, KeyRound, Loader2, MessageSquare, Pencil, RefreshCw, StickyNote, XIcon } from "lucide-react";

import { AVATAR_TEXT_CLASS, accountInitials, avatarTone, formatCredits } from "@/components/account-card";
import { AccountGroupPicker } from "@/components/account-group-picker";
import { GrowthTasksPanel } from "@/components/growth-tasks-panel";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { displayText } from "@/lib/display-text";
import {
  isDrawerTab,
  resolveDrawerTab,
  useDrawerTab,
  type DrawerTab,
} from "@/lib/drawer-tab-preference";
import { useT } from "@/lib/i18n";
import { useRefreshAction } from "@/lib/use-refresh-action";
import { CheckinIcon } from "@/lib/semantic-icons";
import { cn } from "@/lib/utils";

/**
 * 账号详情抽屉（**两平台共用壳**）。
 *
 * ## 为什么是「壳 + 数据注入」而不是两平台各写一份
 *
 * WorkBuddy 与 Trae 的详情**字段不同、结构相同**（头部 + 备注 + 明细区块 + 只读程序位）。
 * 若各写一份，两边会立刻在间距、空态、加载态上漂移 —— 本仓在 Tab、空态、片段上
 * 都踩过「两份实现各自演化」的坑（见 `gateway-snippets.ts` 的头注释）。
 * 因此这里只做**排版与交互**，平台差异一律由调用方装配成
 * `sections` / `packs` / `programs` 注入（PLAN §3.3：差异用数据表达）。
 *
 * ## 为什么是抽屉而不是模态（PLAN §3.5）
 *
 * 用户在账号列表里逐个查看详情，模态会盖住列表、打断对照；抽屉从右侧推入，
 * 列表仍在原位可见。原语是 `ui/sheet.tsx`（shadcn `Sheet`）。
 *
 * ## 两条硬约束（违反会出事故）
 *
 * 1. **所有展示字段必须是已归一的字符串**。`DetailRow.value` / `DetailPack.*Text` /
 *    头部 `name` / `subtitle` 的类型都是 `string` —— 调用方必须过 `displayText`
 *    （`@/lib/display-text`）。对象当 React 子节点渲染会让 React **卸载整棵树** ⇒ 白屏
 *    （issue #2）。这里用 `string` 而非 `unknown` 是为了让「忘了归一」在编译期暴露。
 * 2. **动作只留「必须看上下文才敢做」的那几个**。抽屉是**看**的地方：
 *    备注 / 分组就地编辑（改之前必须看见原文、看见已有哪些组）、续期 JWT、
 *    签到（签到页签顶部）、刷新凭据状态；**删除**这类一步就能做完的动作只在卡片的「更多」菜单里
 *    （2026-10-18 分工判据，见 `docs/specs/PLAN.md` §3.3）。
 *    ★ 2026-10-23（用户要求）：抽屉里的 `导出` 与 `切换权限诊断` 已移除 ——
 *    导出在卡片「更多」与批量条已有（同一动作三步可达，不必在抽屉里再摆一次），
 *    权限诊断与「这个账号的凭据是什么状态」无关。签到按钮则相反：它此前**没有**任何
 *    抽屉入口（`showCheckin` 是死字段），用户要签到得退回卡片菜单。
 *    程序位只以**只读徽标**呈现（切换属于列表页）。
 *
 * ## 状态语言（PLAN §3.6）
 *
 * 区块**首次加载**用 `<Skeleton>`；空态用 `<EmptyState>`（四要素，出口由 `empty.action` 提供）。
 * 注意：`loading` 是**区块加载态**，不是按钮操作态 —— 按钮转圈归卡片，不进这里。
 */

/**
 * 空值占位符的固定字形。
 *
 * ★ 2026-10-26 用户报障：同一个「—」在抽屉里两种长相 —— 邮箱行带 `mono`、今日 Token 行
 * 不带，两套字体下横线的字形与宽度都不一致。空值同义，字形也必须同源 ⇒ 占位符一律按
 * `mono` 渲染，不跟随行字体。
 */
const EMPTY_VALUE = "—";

/** 详情里的一行「标签 / 值」。`value` 必须**已归一为字符串**（见文件头约束 1）。 */
export interface DetailRow {
  /** 已 i18n 的标签。 */
  label: string;
  /** 已过 `displayText` 出口的值；绝不可能是对象。 */
  value: string;
  /** 等宽（uid / 路径 / 时间戳）。 */
  mono?: boolean;
  /** 悬停完整值（`value` 被截断时）。 */
  title?: string;
}

/**
 * 顶部指标块（积分 / 今日 Token / 签到 / 凭据）。
 *
 * ⚠️ 四段文本**已在调用方格式化**（与本文件其余区块同一约束）：抽屉不判断单位与日期格式。
 * `refreshKind` 指向 `lib/account-refresh` 的某一项 ⇒ 块右上角出现就地 ⟳，
 * 与卡片「更多」菜单里的刷新项**同源**（同一个 `onRefreshPart`）。
 */
export interface DetailStat {
  key: string;
  /** 已 i18n 的指标名。 */
  label: string;
  /** 已格式化的主值（如 `1,240/2,000`）。 */
  valueText: string;
  /** 已格式化的副文本（如「320 积分 3 天内到期」）。 */
  subText?: string;
  /** 副文本语气：临期用 warn、凭据失效用 bad。 */
  tone?: "warn" | "bad";
  /** 该指标对应的刷新项；不传 ⇒ 不渲染 ⟳。 */
  refreshKind?: AccountRefreshKind;
  /**
   * 自定义刷新回调（与 `refreshKind` **互斥**）。
   *
   * ★ 2026-10-23：给「任务」卡用 —— 任务摘要是「重扫上游」（`growth_tasks_scan`），
   * 不属于 `AccountRefreshKind` 那几项「重读某一层现成数据」的语义
   * （见 `docs/specs/GROWTH-TASKS.md` §6），硬塞进去会污染菜单的刷新组。
   */
  onRefresh?: () => void;
  /** 自定义刷新的进行中态（转圈 + 禁用）。 */
  refreshBusy?: boolean;
}

/**
 * 登录态快照的一行（只有声明了 `snapshot` 能力的平台才有）。
 *
 * ⚠️ 与 `DetailPack` 同一条约束：四段文本**已在调用方格式化**，抽屉不判断单位与日期格式。
 */
export interface DetailSnapshot {
  key: string;
  timeText: string;
  sizeText: string;
  fileCountText: string;
}

/** 详情里的一个区块（标题 + 若干行）。 */
export interface DetailSection {
  /** React key，稳定。 */
  key: string;
  /** 已 i18n 的区块标题。 */
  title: string;
  rows: DetailRow[];
}

/**
 * 积分 / 资源包明细行（WB 与 Trae 同形）。
 *
 * ⚠️ 四段文本**已在调用方格式化**（含「已用」这类标签）—— 抽屉内不再判断单位 / 日期格式，
 * 否则又会出现「同一句话两处各写一遍」。
 */
export interface DetailPack {
  key: string;
  name: string;
  remainingText: string;
  totalText: string;
  usedText: string;
  expiryText: string;
  expired: boolean;
  expiringSoon: boolean;
  /** 0..100，已夹紧。 */
  ratio: number;
}

/** 只读程序位徽标（**不是**切换控件）。 */
export interface DetailProgramBadge {
  /** 含区域，稳定唯一。 */
  key: string;
  /** 已消歧（含区域标识）。 */
  label: string;
  current: boolean;
  installed: boolean;
  hasDataDir: boolean;
}

/**
 * 可点的「切换到此账号」程序位（原型 `drawerAccount` :3480-3484）。
 *
 * ⚠️ 与只读徽标 `DetailProgramBadge` 是**两套输入**：调用方注入 `switchTargets` 时渲染可点行
 * （WB）；不注入时退回只读徽标（Trae），不改变现有行为。
 */
export interface DetailSwitchTarget {
  /** 稳定唯一。 */
  key: string;
  /** 已 i18n 的程序位名。 */
  label: string;
  /** 已是该程序位的当前账号（只读高亮，不再重复切换）。 */
  current: boolean;
  /** 该程序位可切换（已接入 / 已检测到）。false ⇒ 渲染为不可用并标注「未检测到」。 */
  available: boolean;
  busy?: boolean;
  loading?: boolean;
  onSwitch?: () => void;
}

/**
 * 「操作」区回调。**全部可选** —— 缺哪个回调就不渲染哪枚按钮，
 * 不摆点不动的灰按钮。`编辑备注` 由抽屉内部的就地编辑器承担，不需回调。
 *
 * ★ 2026-10-23（用户要求）：
 * - **移除 `导出` 与 `切换权限诊断`** —— 前者属于「一步做完」的动作（卡片「更多」/ 批量条已有），
 *   后者指向的是设置页 `?section=diagnostics`，与本抽屉「看这个账号」的职责无关；
 * - **`showCheckin` 终于被用上了**：签到页签顶部出现「签到」按钮（此前该字段只有声明、
 *   没有任何渲染点，等于死字段 —— 用户反馈「签到页没有签到入口」正是它）。
 */
export interface DetailActions {
  /**
   * 「续期凭据」（写 `refresh_token`）。
   *
   * ★ 返回 Promise：抽屉的⟳ 忙态必须跟真实耗时走 —— 调用方若是
   * `() => void refreshOne()`，Promise 被截断，按钮几乎立刻退出忙态（R06）。
   */
  onRefresh?: () => Promise<unknown> | void;
  /** 「签到」按钮（签到页签顶部）。只在 `showCheckin` 为真时渲染。 */
  onCheckin?: () => void;
  /** 是否展示「签到」按钮（凭据可用且今日未签到）。 */
  showCheckin?: boolean;
  onDelete?: () => void;
  /** 凭据已过期 / 需重登 ⇒ 展示「不提供签到入口」的说明（与卡片 / 批量签到同口径）。 */
  credentialUnavailable?: boolean;
}

/**
 * 「凭据」页签的内容：状态徽标 + 凭证明细行。
 *
 * ⚠️ 与其余区块同一条约束：`statusText` / `rows[].value` 全部**已在调用方格式化**，
 * 抽屉只排版。不传 ⇒ 该页签退化为「只有两枚按钮」（Trae / Qoder 的现状），
 * 不会凭空多出一个空的「凭证信息」区块。
 */
export interface DetailCredential {
  /** 已 i18n 的状态文案（有效 / 已过期 / 需重登）。 */
  statusText: string;
  /** 状态语气：有效 = ok，临期 / 需重登 = warn，过期 = bad。 */
  tone: "ok" | "warn" | "bad";
  /** 状态补充说明（如「可正常使用」/「先重新登录」）。 */
  hint?: string;
  /** 凭证明细（凭据到期 / 刷新令牌到期 / 最近续期 …）。 */
  rows: DetailRow[];
}

/**
 * 签到历史一行（近 7 天；原型 `checkinHistoryHtml` :3428-3439）。
 *
 * ⚠️ `amount` 来自**积分统计的签到事件**（账号 + 日期），取不到时为 `null` ⇒ 渲染「—」。
 * **绝不**用固定奖励（原型里那个 `checkinReward || 100` 是假数据，本仓不照抄）。
 */
export interface DetailCheckinHistoryRow {
  date: string;
  /** 已 i18n 的结果文案（成功 / 已签到 / 失败 / 未签到）。 */
  resultLabel: string;
  tone: "ok" | "warn" | "fail" | "none";
  /** `null` = 上游未给额度 ⇒ 渲染「—」。 */
  amount: number | null;
}

export interface AccountDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * ★ 账号的**稳定身份键**（`${scope}:${id}`，见 issue #49）。
   *
   * 只用来记住「这个账号上次停在哪个页签」：同一 `uid` 在国内版与国际版是**两个**账号，
   * 所以键里必须带作用域。设为**必填**是有意的 —— 漏传会在 `tsc` 阶段报错，
   * 而不是静默退化成「不记忆」。
   */
  accountKey: string;
  /** 头部展示名（已过 `displayText` 出口）。 */
  name: string;
  /** 头部副标题（身份 / uid，已归一）。 */
  subtitle: string;
  /** 头像底色种子（复用 `avatarTone`，与卡片同一套色板）。 */
  avatarSeed: string;
  /** 区块加载中（首次打开、数据未就绪）→ `<Skeleton>`；**不是**按钮态。 */
  loading?: boolean;
  /** 积分 / 资源包明细；空数组 = 不渲染该区块。 */
  packs?: DetailPack[];
  /**
   * 调用方**真的能刷**的刷新项（与卡片 / 批量条用的 `refreshKinds` 同一份）。
   *
   * ★ 2026-10-26（用户报障「没有积分页」）：积分页签此前**只在有包明细时**出现，
   * 而包明细要单独刷过积分才有 ⇒ 没刷过的账号连页签都没有，用户以为「这个平台没有积分页」。
   * 现在只要本平台能刷积分（`refreshKinds` 含 `credits`），页签就常驻；页内空态给出 ⟳ 出口。
   *
   * WB 不传（它的抽屉打开时会懒加载积分，很快就有明细）⇒ 行为不变。
   */
  refreshKinds?: readonly AccountRefreshKind[];
  /** 登录态快照（空数组 = 不渲染「快照」页签）。 */
  snapshots?: DetailSnapshot[];
  /** 顶部指标块（按序渲染；空数组 = 不渲染该区域）。 */
  stats?: DetailStat[];
  /** 本账号正在进行中的刷新项（指标块上的 ⟳ 用它显示转圈）。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 指标块上的就地刷新；不传 ⇒ 块上不出现 ⟳。 */
  onRefreshPart?: (kind: AccountRefreshKind) => void;
  /** 信息区块（按序渲染）。 */
  sections?: DetailSection[];
  /** 只读程序位徽标；空数组 = 不渲染。 */
  programs?: DetailProgramBadge[];
  /** 备注就地编辑（与卡片同语义：返回 true 才收起编辑器）。 */
  remark: string;
  onSaveRemark?: (remark: string) => Promise<boolean>;
  /**
   * 自定义分组就地编辑（与备注**同一交互**）。
   *
   * ⚠️ 只在调用方**注入 `onSaveGroup`** 时渲染该区块 —— 未注入（如 Trae，其分组是
   * `groupId` 而非自由文本）时保持原样，不凭空多出一个「分组」区。空串 = 未分组。
   */
  group?: string;
  onSaveGroup?: (group: string) => Promise<boolean>;
  /**
   * 本作用域里**已有的分组名**（去重，不含空串）。
   *
   * 只给「分组选择器」用：用户要能看见「已经有哪些组」（避免把同一个组打成三种写法），
   * 也要能建新组（自由文本）。缺省 = 只知道当前值 —— 选择器仍然可用，只是列表更短。
   */
  groups?: string[];
  featuresDisabled?: boolean;
  /** 由「更多 → 编辑备注」打开时，直接进入备注编辑态。 */
  autoEditRemark?: boolean;
  /** 由「更多 → 设置分组」打开时，直接进入分组编辑态。 */
  autoEditGroup?: boolean;
  /**
   * 本次打开**直接落在**指定页签（目前只由卡片 / 表格的成长任务标签传 `tasks`）。
   *
   * 与「记住的上次页签」的关系：本次打开以它为准（且该页签可用时）；
   * 用户切换页签后失效，但**不改写记忆** —— 点标签去「看任务」不等于把
   * 「上次停在任务」写进偏好（记忆只记用户主动切页签的结果，见 issue #49）。
   */
  initialTab?: DrawerTab | null;
  /** 详情区块**全空**时的空态出口（`EmptyState` 四要素）。 */
  empty?: { title: string; description: string; action?: ReactNode };
  /**
   * ★ B5：**签到积分**数据（字段来自**上游实测响应**，不是推测）。
   *
   * ⚠️ 传 `null` / 不传 = **不渲染签到区** —— 不摆「+0」「0 天」这种无信息量的行
   * （§3.4 规则 1：无数据不渲染）。
   */
  checkin?: {
    todayCheckedIn: boolean;
    dailyCredit?: number | null;
    todayCredit?: number | null;
    totalCredits?: number | null;
    streakDays?: number | null;
    checkinDates?: string[] | null;
    /**
     * 「签到天数 / 累计积分」的**口径**（2026-10-27）。
     *
     * `"local"` = 这两个数是**本机积分明细**统计出来的（保留 90 天），不是上游的
     * 连续天数 / 终身累计 —— tooltip 必须说清，绝不冒充上游口径。缺省 = 上游口径。
     */
    statsScope?: "upstream" | "local";
  } | null;
  /** 头部是否展示「当前登录」徽章（原型 :3475）。缺省不展示。 */
  current?: boolean;
  /** ★ 可点「切换到此账号」程序位；传空数组 / 不传 = 不渲染该区块（退回只读 `programs`）。 */
  switchTargets?: DetailSwitchTarget[];
  /** 「使用向导切换（可选迁移内容）」入口（原型 :3485）。 */
  onWizardSwitch?: () => void;
  /**
   * ★ P14 S4a · 打开「插件会话」抽屉（VS Code 插件 / CodeBuddy IDE 的会话仓）。
   *
   * ⚠️ 只在**该账号绑定了有会话仓的程序位**时注入（映射见 `lib/ext-sessions.ts`）——
   * JetBrains 等没有会话仓的程序位**不注入**，于是入口不渲染。
   * 渲染一个点了会去读错目录的按钮，比没有这个功能坏得多。
   */
  onExtSessions?: () => void;
  /** 入口文案里的客户端名（已 i18n）；`onExtSessions` 提供时才用得到。 */
  extClientLabel?: string;
  /** 「操作」区回调。`null` / 不传 = 不渲染该区块。 */
  actions?: DetailActions | null;
  /**
   * ★ 「凭据」页签的凭证信息（状态 + 明细行）。
   *
   * `null` / 不传 = 该页签只渲染动作按钮（Trae / Qoder 现状，行为不变）。
   */
  credential?: DetailCredential | null;
  /** 签到历史（近 7 天）；`null` / 空数组 = 不渲染该区块。 */
  checkinHistory?: DetailCheckinHistoryRow[] | null;
  /**
   * ★ 成长任务中心（仅 **WorkBuddy 国内版**）。
   *
   * 传「账号定位」而不是数据：任务列表只在**切到该页签时**才有意义，
   * 让账号页为每个账号预先拉一遍把它们撑成常态开销（详见 `growth-tasks-panel.tsx` 文件头）。
   *
   * ⚠️ 不传 / `null` = **不渲染该页签**。国际版没有这套成长体系，Trae / Qoder 也没有 ——
   * 画一个永远拉不到数据的页签，比没有这个功能坏得多。
   *
   * ★ 2026-10-26：`refreshing` / `onRefresh` 把页签 ⟳ 与指标卡 ⟳
   * 接到页面同一条统一刷新上（摘要重扫 + 列表重拉），两边共享忙态与回执。
   */
  growthTasks?: {
    scope: string;
    accountId: string;
    /** 统一刷新进行中（与指标卡 ⟳ 同源）。 */
    refreshing: boolean;
    /** 统一刷新入口：页面等待摘要重扫与传入的列表重拉。 */
    onRefresh: (reload: () => Promise<boolean>) => void;
  } | null;
  /**
   * 成长任务面板跑完一次动作后的通知（用于刷新列表卡片上的「可领 N」标签）。
   *
   * 由页面注入；不注入也完全可用 —— 只是卡片标签要等下次整页扫描才更新。
   */
  onGrowthTasksChanged?: () => void;
}

function packTone(pack: DetailPack): string {
  if (pack.expired) return "text-destructive";
  if (pack.expiringSoon) return "text-warning";
  return "text-muted-foreground";
}

function programBadgeText(
  program: DetailProgramBadge,
  t: ReturnType<typeof useT>,
): string {
  if (program.current) return t("shared.drawer.program.current");
  if (!program.installed) return t("shared.drawer.program.missing");
  if (!program.hasDataDir) return t("shared.drawer.program.noDataDir");
  return t("shared.drawer.program.installed");
}

/**
 * 签到页签的一格指标（标签 + 数字）。
 *
 * 与顶部 `DetailStat` 卡片**不是**同一套：这里的值只有「一个数」，不需要 ⟳，
 * 也必须在窄列里对齐（`tabular-nums`）。刻意不抽成公共组件 —— 抽了就要给两边
 * 加一堆开关，反而更难读。
 */
function CheckinStat({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "muted";
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-[10px] border border-border bg-muted/40 px-2.5 py-2">
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm font-semibold tabular-nums",
          tone === "ok" ? "text-success" : tone === "muted" ? "text-muted-foreground" : "text-foreground",
        )}
        title={title ?? value}
      >
        {value}
      </div>
    </div>
  );
}

export function AccountDetailDrawer({
  open,
  onOpenChange,
  accountKey,
  name,
  subtitle,
  avatarSeed,
  loading = false,
  packs = [],
  refreshKinds = [],
  stats = [],
  snapshots = [],
  refreshingKinds,
  onRefreshPart,
  sections = [],
  programs = [],
  remark,
  onSaveRemark,
  group,
  onSaveGroup,
  groups = [],
  featuresDisabled = false,
  autoEditRemark = false,
  autoEditGroup = false,
  initialTab = null,
  empty,
  checkin,
  current = false,
  switchTargets = [],
  onWizardSwitch,
  onExtSessions,
  extClientLabel,
  actions = null,
  credential = null,
  checkinHistory = null,
  growthTasks = null,
  onGrowthTasksChanged,
}: AccountDetailDrawerProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  /** 「续期凭据」按钮的进行中态（回调是 fire-and-forget ⇒ 最小展示时长保证可见）。 */
  const { busy: refreshBusy, run: runRefresh } = useRefreshAction();
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 取消编辑时置位，用来抵掉紧随其后的那次 blur。
   *
   * 编辑态结束时输入框会被卸载，浏览器 / React 可能仍补发一次 blur；
   * 不拦的话「按 Esc 取消」会被那次 blur 反向提交成一次保存。
   *
   * ⚠️ 卡片时代那个 `keepRemarkFocusRef` hack **不再需要**：它绕开的是「Radix 菜单关闭后
   * 把焦点还给触发按钮」的竞态，而编辑框当时位于菜单背后。编辑器搬进抽屉后
   * 不再处于菜单之后，那个竞态在结构上消失 —— 所以这里只有一道 skip 闸。
   */
  const skipCommitRef = useRef(false);
  /** 「本次打开是否已按 `autoEditRemark` 进入过编辑态」，避免保存后因依赖变化重复进入。 */
  const autoEditDoneRef = useRef(false);

  const savedRemark = displayText(remark)?.trim() || "";
  const canEdit = !featuresDisabled && Boolean(onSaveRemark);

  /* 分组编辑器：**与备注编辑器完全同构**（同一套 editing / draft / saving / autoEdit 语义），
     只是状态与渲染分开 —— 两个字段各自独立编辑，互不干扰。仅在调用方注入 `onSaveGroup`
     时渲染（未注入 = 不显示该区块，见 `Props.group` 的注释）。 */
  const showGroup = Boolean(onSaveGroup);
  const savedGroup = displayText(group)?.trim() || "";
  const canEditGroup = !featuresDisabled && showGroup;

  useEffect(() => {
    if (!editing) return;
    // 等 DOM 提交后再聚焦。
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  // 打开 / 关闭时同步编辑态：关闭一律收起并丢弃草稿（下次打开重新从已保存值起算）。
  useEffect(() => {
    if (!open) {
      autoEditDoneRef.current = false;
      setEditing(false);
      setDraft("");
      return;
    }
    if (autoEditRemark && canEdit && !autoEditDoneRef.current) {
      autoEditDoneRef.current = true;
      skipCommitRef.current = false;
      setDraft(savedRemark);
      setEditing(true);
    }
    /* 分组不再有「编辑态」：选择器自己管展开（`autoEditGroup` 直接透给它）。
       这一处只保留备注的自动进入编辑。 */
  }, [open, autoEditRemark, canEdit, savedRemark]);

  function beginEdit() {
    if (!canEdit || saving) return;
    skipCommitRef.current = false;
    setDraft(savedRemark);
    setEditing(true);
  }

  function cancelEdit() {
    skipCommitRef.current = true;
    setEditing(false);
    setDraft("");
  }

  async function commit() {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (!onSaveRemark || saving) return;
    if (draft.trim() === savedRemark) {
      cancelEdit();
      return;
    }
    setSaving(true);
    const saved = await onSaveRemark(draft);
    setSaving(false);
    if (saved) setEditing(false);
  }

  /* 操作区只在调用方**显式注入** `actions` 时出现 —— 未注入（如 Trae）时保持原样，
     不因为共享壳新增了一个「编辑备注」入口而改变另一平台的行为。 */
  /**
   * 操作区是否渲染。
   *
   * ⚠️ 只数**抽屉独有**的动作（续期凭据 —— 即凭据续期）。
   * 手动签到 / 编辑备注 / 编辑分组 / 删除**不在这里**：签到有自己的页签入口，
   * 其余三个已经在卡片的「更多」菜单里。
   *
   * ★ 2026-10-23：`导出` 与 `切换权限诊断` 已从抽屉移除（见 `DetailActions` 注释），
   * 所以判据只剩 `onRefresh`。
   */
  const hasActions = Boolean(actions?.onRefresh);
  /**
   * 今日签到**真领到**的积分；`null` = 已签到但金额未知（上游只回状态）。
   * 抽屉与 tooltip 都据此显示「—」，**不补 0**（R：未知 ≠ 零）。
   */
  const todayGain = checkin?.todayCheckedIn
    ? (checkin.todayCredit ?? checkin.dailyCredit ?? null)
    : null;
  const isEmpty =
    packs.length === 0 &&
    sections.length === 0 &&
    programs.length === 0 &&
    switchTargets.length === 0 &&
    (checkinHistory === null || checkinHistory.length === 0) &&
    !hasActions;

  /**
   * 本次**可用**的页签，按渲染顺序排列（issue #49）。
   *
   * 页签的「是否渲染」与「记住的值还可用吗」**共用这一份数组** —— 两处各写一遍条件
   * 是这类缺陷的经典来源：条件漂移后会出现「记住了但触发器不存在」的空页签。
   */
  const availableTabs: DrawerTab[] = ["overview"];
  /* 积分页：有明细 **或** 本平台能刷积分 ⇒ 常驻（空态给出 ⟳ 出口）。 */
  if (packs.length > 0 || refreshKinds.includes("credits")) availableTabs.push("credits");
  /* 签到页：有当日数据 / 有历史 / **本平台支持签到** ⇒ 常驻。
     ★ 2026-10-27：此前只在有数据时出现 —— 读取失败或还没查时整个页签消失，
     用户看不到「未知」也找不到刷新出口。平台能读签到就必须有这一页。 */
  if (checkin || (checkinHistory && checkinHistory.length > 0) || refreshKinds.includes("checkin"))
    availableTabs.push("checkin");
  // 成长任务：调用方注入账号定位才出现（仅 WB·CN）。**不依赖**其它区块是否为空 ——
  // 任务列表与积分 / 签到是独立数据源，没有积分明细也一样能领任务奖励。
  if (growthTasks) availableTabs.push("tasks");
  if (hasActions) availableTabs.push("credential");
  if (snapshots.length > 0) availableTabs.push("snapshot");

  const [rememberedTab, rememberTab] = useDrawerTab(accountKey);
  /**
   * 入口指定的页签（`initialTab`）只对**本次打开**生效：
   * 用户在抽屉里切过页签后置空，关闭 / 换账号 / 再次打开时按新入口参数重置。
   */
  const [forcedTab, setForcedTab] = useState<DrawerTab | null>(initialTab);
  useEffect(() => {
    setForcedTab(initialTab);
  }, [initialTab, open, accountKey]);
  // 记住的页签当前不可用 ⇒ 回落第一枚可用页签，且**不改写**记忆（R3 / R4）。
  const activeTab =
    forcedTab && availableTabs.includes(forcedTab)
      ? forcedTab
      : resolveDrawerTab(rememberedTab, availableTabs);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-md">
        <SheetClose asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 z-10 size-8 rounded-lg text-muted-foreground hover:text-foreground"
            aria-label={t("shared.drawer.close")}
          >
            <XIcon />
          </Button>
        </SheetClose>

        <SheetHeader>
          <div className="flex items-center gap-3 pr-9">
            {/* 与卡片同一套头像（原型 `.avatar`，`demo.css:332-335`，仅尺寸/圆角放大到 44/13）：
                深底 + 近白字、字重 640、首字取前 2 位；原型的抽屉头像没有白描边。 */}
            <div
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-[13px] text-base font-[640]",
                AVATAR_TEXT_CLASS,
                avatarTone(avatarSeed),
              )}
            >
              {accountInitials(name)}
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate" title={name}>
                {name}
              </SheetTitle>
              <SheetDescription className="mt-0.5 truncate" title={subtitle}>
                {subtitle}
              </SheetDescription>
            </div>
            {/* 与卡片同口径的「当前登录」徽章（原型 :3475）。 */}
            {current && (
              <Badge variant="secondary" className="shrink-0 border-transparent bg-primary/15 text-primary">
                {t("shared.drawer.currentLogin")}
              </Badge>
            )}
          </div>
        </SheetHeader>

        {/* ⚠️ `[&>*]:shrink-0` 不是装饰：滚动容器是 flex 列，子元素默认可收缩，
            一旦内容超高，`<Tabs>`（内含很长的 TabContent）会被压扁 —— 它内部的
            TabsList 因此被裁成一条 8px 的缝（2026-10-18 用户截图）。
            让每个直接子元素都不收缩，超出的部分交给 `overflow-y-auto` 滚动。 */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
          {/* 指标块：一打开就知道「这个账号现在什么状态」，不用滚。
              每块右上角的 ⟳ 与卡片「更多」里的刷新项**同一个回调**（同源，不是第二套实现）。 */}
          {!loading && stats.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {stats.map((stat) => {
                const kindBusy = stat.refreshKind
                  ? (refreshingKinds ?? []).includes(stat.refreshKind)
                  : false;
                const busy = kindBusy || Boolean(stat.refreshBusy);
                return (
                  <div
                    key={stat.key}
                    className="min-w-0 rounded-[10px] border border-border bg-muted/40 px-2.5 py-2"
                  >
                    <div className="flex items-center gap-1">
                      <span className="truncate text-[10.5px] text-muted-foreground">{stat.label}</span>
                      {(stat.refreshKind ? Boolean(onRefreshPart) : Boolean(stat.onRefresh)) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            stat.refreshKind
                              ? onRefreshPart?.(stat.refreshKind as AccountRefreshKind)
                              : stat.onRefresh?.()
                          }
                          aria-label={stat.label}
                          className="ml-auto grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 transition-colors hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-60"
                        >
                          {busy ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                        </button>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-base font-semibold tabular-nums">{stat.valueText}</div>
                    {stat.subText ? (
                      <div
                        className={cn(
                          "mt-0.5 truncate text-[10.5px]",
                          stat.tone === "warn"
                            ? "text-warning"
                            : stat.tone === "bad"
                              ? "text-destructive"
                              : "text-muted-foreground",
                        )}
                        title={stat.subText}
                      >
                        {stat.subText}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {/* 备注区：就地编辑，自包含（失败保持编辑态让用户改完重试）。 */}
          <section>
            <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
              {t("shared.drawer.remark.title")}
            </h3>
            {editing ? (
              <Input
                ref={inputRef}
                value={draft}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelEdit();
                  }
                }}
                onBlur={() => void commit()}
                maxLength={80}
                placeholder={t("shared.drawer.remark.placeholder")}
                spellCheck={false}
                autoComplete="off"
                aria-label={t("shared.drawer.remark.aria", { name })}
                className="h-8 w-full text-xs"
              />
            ) : savedRemark ? (
              canEdit ? (
                <button
                  type="button"
                  onClick={beginEdit}
                  title={savedRemark}
                  aria-label={t("shared.drawer.remark.editAria", { name })}
                  className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs leading-5 text-foreground/80 transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                >
                  <StickyNote className="size-3.5 shrink-0 stroke-[1.75] text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{savedRemark}</span>
                </button>
              ) : (
                <p className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-foreground/80">
                  <StickyNote className="size-3.5 shrink-0 stroke-[1.75] text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" title={savedRemark}>
                    {savedRemark}
                  </span>
                </p>
              )
            ) : canEdit ? (
              <button
                type="button"
                onClick={beginEdit}
                className="-mx-1 flex items-center gap-1.5 rounded-md px-1 text-left text-xs leading-5 text-muted-foreground/70 transition-colors hover:bg-foreground/[0.04] hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <Pencil className="size-3 shrink-0" aria-hidden="true" />
                {t("shared.drawer.remark.add")}
              </button>
            ) : (
              <p className="text-xs text-muted-foreground">—</p>
            )}
          </section>

          {/* 分组区：**选择器**（既有分组 + 就地新建），不是自由文本框。
              理由见 `account-group-picker.tsx` 的文件头：分组是自由文本，但让用户每次手打
              必然把同一个组写成三种；只给下拉又建不出新组。 */}
          {showGroup && (
            <section>
              <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                {t("shared.drawer.group.title")}
              </h3>
              <AccountGroupPicker
                value={savedGroup}
                groups={groups}
                disabled={!canEditGroup}
                autoOpen={autoEditGroup}
                accountName={name}
                onCommit={(next) => (onSaveGroup ? onSaveGroup(next) : Promise.resolve(false))}
              />
            </section>
          )}

          {/* ★ 切换到此账号（原型 :3480-3486）：可点程序位行 + 向导入口。
              仅在调用方注入 `switchTargets` 时渲染；未注入时下面的只读徽标区（Trae）保持原样。 */}
          {switchTargets.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                {t("shared.drawer.switch.title")}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {switchTargets.map((target) => {
                  const enabled = Boolean(target.onSwitch) && !target.busy && !target.loading;
                  return (
                    <Button
                      key={target.key}
                      type="button"
                      variant={target.current ? "secondary" : "outline"}
                      size="sm"
                      className={cn(
                        "h-[26px] rounded-[8px] px-2 text-[11px]",
                        target.current && "border-primary/40 bg-primary/15 text-primary",
                        !target.available && "border-dashed text-muted-foreground",
                      )}
                      aria-pressed={target.current}
                      disabled={target.current || !enabled}
                      onClick={() => target.onSwitch?.()}
                      title={
                        target.current
                          ? t("shared.drawer.program.current")
                          : target.available
                            ? t("shared.drawer.switch.available")
                            : t("shared.drawer.program.missing")
                      }
                    >
                      {target.current ? <Check className="size-3" /> : null}
                      {target.label}
                      {!target.available ? <span className="opacity-70">（{t("shared.drawer.program.missing")}）</span> : null}
                    </Button>
                  );
                })}
              </div>
              {onExtSessions && (
                /* ★ P14 S4a · 插件会话复制的入口。
                   为什么在**这里**、不在「关联会话」页：那边是**副本组**模型
                   （有账本、可双向同步、有「谁落后 / 谁分叉」），而插件侧是
                   **一次性单向复制**（副本恒取新 id）⇒ 塞进去只会多出一个永远空的组列表。 */
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-2 mt-2.5"
                  onClick={onExtSessions}
                >
                  <MessageSquare className="size-4" />
                  {t("sessions.ext.entry", { client: extClientLabel ?? "" })}
                </Button>
              )}
            </section>
          )}

          {loading ? (
            // 区块级加载态：**不是**按钮态，所以用骨架屏而不是 Loader2。
            <div className="space-y-3" aria-busy="true" aria-label={t("shared.drawer.loading")}>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : isEmpty ? (
            empty ? (
              <EmptyState
                icon={Info}
                title={empty.title}
                description={empty.description}
                action={empty.action}
              />
            ) : null
          ) : (
            /* 页签只切「看」的部分：概览（信息区块 + 程序位）/ 积分 / 签到 / 凭据。
               ⚠️ 备注、分组、程序位切换**留在页签之上** —— 它们是身份与操作，
               藏进页签会让「改个备注」变成「先猜在哪个页签里」。 */
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                // 只记**用户主动点击**的结果；`resolveDrawerTab` 的回落不写盘（R4）。
                if (isDrawerTab(value)) {
                  // 用户一旦自己切页签，入口指定的页签就让位。
                  setForcedTab(null);
                  rememberTab(value);
                }
              }}
              className="min-h-0"
            >
              {/* 页签最多六个（含「快照」与「任务」），抽屉又窄 ⇒ 必须**不换行**：
                  `inline-flex` 默认允许折行，页签会挤成两排。
                  改成 nowrap + 横向滚动：一行排开，实在放不下时能滑，而不是折行。
                  ⚠️「任务」页签只在 WB·CN 出现，其它账号仍是五枚。 */}
              <TabsList className="max-w-full flex-nowrap overflow-x-auto">
                {availableTabs.map((tab) => (
                  <TabsTrigger key={tab} value={tab}>
                    {t(`shared.drawer.tab.${tab}`)}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="overview" className="space-y-4 pt-1">
{/* 信息区块（按序渲染）。 */}
              {sections.map((section) => (
                <section key={section.key}>
                  <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                    {section.title}
                  </h3>
                  {/* 原型 `.kv`（`demo.css:492-495`）：`flex gap10` + `12.5px` + `padding:7px 0`
      + **`border-bottom:1px dashed --border`**（虚线分隔，此前完全没有）+末行无边框；
      `.kv .k` 是**固定 `width:96px`** 的标签列（此前 `auto` 随内容伸缩 ⇒ 每行标签起点都在变）。*/}
                  <dl className="space-y-0">
                    {section.rows.map((row, index) => (
                      <div
                        key={`${section.key}-${index}`}
                        className={cn(
                          "grid min-w-0 grid-cols-[96px_minmax(0,1fr)] items-baseline gap-2.5 border-b border-dashed border-border py-1.5 text-[12.5px] last:border-b-0",
                        )}
                      >
                        <dt className="shrink-0 text-[11.5px] text-muted-foreground">{row.label}</dt>
                        <dd
                          className={cn(
                            "min-w-0 truncate text-right text-foreground/80",
                            row.mono && "font-mono tabular-nums",
                            row.value === EMPTY_VALUE && "font-mono",
                          )}
                          title={row.title ?? row.value}
                        >
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}

              {/* 只读程序位徽标 —— **不是**切换控件（见文件头约束 2）。 */}
              {programs.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                    {t("shared.drawer.programs.title")}
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {programs.map((program) => (
                      <Badge
                        key={program.key}
                        variant={program.current ? "success" : "secondary"}
                        className={cn(!program.current && "text-muted-foreground")}
                      >
                        {program.label}
                        <span className="opacity-80">· {programBadgeText(program, t)}</span>
                      </Badge>
                    ))}
                  </div>
                </section>
              )}
              </TabsContent>

              {availableTabs.includes("credits") && (
                <TabsContent value="credits" className="space-y-4 pt-1">
                  <section>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-[11.5px] font-medium text-muted-foreground">
                        {t("shared.drawer.packs.title")}
                      </h3>
                      {onRefreshPart && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={(refreshingKinds ?? []).includes("credits")}
                          onClick={() => onRefreshPart("credits")}
                          aria-label={t("shared.drawer.actions.refreshCredits")}
                          title={t("shared.drawer.actions.refreshCredits")}
                        >
                          {(refreshingKinds ?? []).includes("credits") ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                        </Button>
                      )}
                    </div>
                    {packs.length > 0 ? (
                      <div className="space-y-3">
                        {packs.map((pack) => (
                          <div key={pack.key} className="min-w-0">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <span className="min-w-0 truncate text-xs font-medium" title={pack.name}>
                                {pack.name}
                              </span>
                              <span className={cn("shrink-0 text-[11px] tabular-nums", packTone(pack))}>
                                {pack.expiryText}
                              </span>
                            </div>
                            <div className="mt-1 flex items-baseline justify-between gap-3 text-[11px]">
                              <span className="font-medium tabular-nums">
                                {pack.remainingText} / {pack.totalText}
                              </span>
                              <span className="text-muted-foreground tabular-nums">{pack.usedText}</span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  pack.expired ? "bg-destructive/60" : pack.expiringSoon ? "bg-warning/80" : "bg-primary/75",
                                )}
                                style={{ width: `${Math.min(100, Math.max(0, pack.ratio))}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                        {t("shared.drawer.packs.empty")}
                      </p>
                    )}
                  </section>
                </TabsContent>
              )}

              {availableTabs.includes("checkin") && (
                <TabsContent value="checkin" className="space-y-4 pt-1">
{/* ★ B5：签到积分 + **签到入口**（2026-10-23 用户要求）。
   旧版把「+100 / 已连签 / 累计」竖排成三行，右侧整片空白；标题行只剩一个标题，
   而「签到」这个页签里居然没有签到按钮 —— 标题行右侧正好是它的位置。
   ⚠️ 正文跟着**页签可见性**走（`availableTabs.includes("checkin")`），不能再判
   `checkin || history`：页签只要出现（含「平台能刷签到但还没读到」）正文就必须有内容，
   否则 Qoder 未刷新时页签在、里面一片空白 —— 连「未知 + ⟳」都看不到。
   「有 `checkin` 就渲染」的旧规则本身是对的（未签到恰恰最需要这个区块），已并入上方闸门。
   ★ 同日（用户确认）：**标题行（含 ⟳）无条件渲染** —— 页签既然出现，
   刷新入口就得在（⟳ 是只读重拉，对任何账号都安全），不能因
   「只有历史、没有当日数据」就跟着消失；签到按钮仍跟随 `checkin`。 */}
                <section>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-[11.5px] font-medium text-muted-foreground">
                      {t("shared.drawer.checkin.title")}
                    </h3>
                    {/* ★ 2026-10-23（用户要求）：按钮**常驻**，状态只改文字与可用性 ——
                        时隐时现的按钮比禁用的按钮更难预期。
                        - 今日未签到 + 凭据可用 ⇒ 「签到」可点；
                        - 今日已签到 ⇒ 「今日已签到」禁用（点了必然是「已签到」回执）；
                        - 凭据不可用 ⇒ 禁用（说明见下方 credentialNote 一行）。
                        ★ 同批补充：最左侧加一枚**仅图标** ⟳ 刷新签到数据（只读），
                        与凭据 / 积分页签同款 —— 指标卡上的 ⟳ 是快捷入口，
                        页签内再给一个，功能才完整。 */}
                    <div className="flex items-center gap-1.5">
                      {onRefreshPart && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={(refreshingKinds ?? []).includes("checkin")}
                          onClick={() => onRefreshPart("checkin")}
                          aria-label={t("shared.drawer.actions.refreshCheckin")}
                          title={t("shared.drawer.actions.refreshCheckin")}
                        >
                          {(refreshingKinds ?? []).includes("checkin") ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                        </Button>
                      )}
                      {checkin && actions?.onCheckin ? (
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2.5 text-[11px]"
                          disabled={checkin.todayCheckedIn || !actions.showCheckin}
                          onClick={actions.onCheckin}
                        >
                          <CheckinIcon className="size-3.5" />
                          {checkin.todayCheckedIn
                            ? t("shared.drawer.checkin.done")
                            : t("shared.drawer.checkin.action")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {!checkin && onRefreshPart ? (
                    /* 读取失败 / 还没查：如实写「未知」并指向右上角的 ⟳，不摆 0 或「未签到」。 */
                    <p className="text-[11.5px] text-muted-foreground">
                      {t("shared.drawer.checkin.unknown")}
                    </p>
                  ) : null}
                  {checkin && (
                    <>
                  {/* 三列横排：今日签到（+100）/ 签到天数 / 累计积分 —— 把右侧的空白用掉，
                      高度也是竖排的三分之一。数字用 tabular-nums 对齐。 */}
                  <div className="grid grid-cols-3 gap-2">
                    <CheckinStat
                      label={t("shared.drawer.checkin.today")}
                      value={
                        !checkin.todayCheckedIn
                          ? t("shared.drawer.checkin.notCheckedIn")
                          : /* 金额未知（上游只回了「已签到」）⇒ 显示「—」，**不补成 +0**
                               —— 补零会让用户以为确实领到 0 积分。 */
                            todayGain !== null
                            ? `+${todayGain}`
                            : "—"
                      }
                      tone={checkin.todayCheckedIn ? "ok" : "muted"}
                      title={
                        todayGain !== null
                          ? t("shared.drawer.checkin.todayGain", { n: todayGain })
                          : undefined
                      }
                    />
                    <CheckinStat
                      label={t("shared.drawer.checkin.statStreak")}
                      value={
                        typeof checkin.streakDays === "number" && checkin.streakDays > 0
                          ? t("shared.drawer.checkin.days", { n: checkin.streakDays })
                          : "—"
                      }
                      title={
                        checkin.statsScope === "local"
                          ? t("shared.drawer.checkin.localStats")
                          : undefined
                      }
                    />
                    <CheckinStat
                      label={t("shared.drawer.checkin.statTotal")}
                      value={
                        typeof checkin.totalCredits === "number"
                          ? formatCredits(checkin.totalCredits)
                          : "—"
                      }
                      title={
                        checkin.statsScope === "local"
                          ? t("shared.drawer.checkin.localStats")
                          : typeof checkin.totalCredits === "number"
                            ? t("shared.drawer.checkin.total", { n: checkin.totalCredits })
                            : undefined
                      }
                    />
                  </div>
                  {!checkin.todayCheckedIn && actions?.credentialUnavailable && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {t("shared.drawer.actions.credentialNote")}
                    </p>
                  )}
                    </>
                  )}
                </section>

              {/* ★ 签到历史（近 7 天）：日期 / 结果 / 获得积分（原型 checkinHistoryHtml :3428）。
                  「签没签到」由调用方按上游 `checkin_dates` 判定（本地台账只记本工具发起的
                  签到，仅用于区分 success/already/fail）；获得积分取积分统计的签到事件
                  （账号 + 日期），取不到时渲染「—」（绝不臆造固定奖励）。 */}
              {checkinHistory && checkinHistory.length > 0 && (
                <section>
                  <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                    {t("shared.drawer.checkin.historyTitle")}
                  </h3>
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full border-collapse text-[12px]">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th scope="col" className="px-2.5 py-1.5 text-left text-[11px] font-medium">
                            {t("shared.drawer.checkin.historyDate")}
                          </th>
                          <th scope="col" className="px-2.5 py-1.5 text-left text-[11px] font-medium">
                            {t("shared.drawer.checkin.historyResult")}
                          </th>
                          <th scope="col" className="px-2.5 py-1.5 text-right text-[11px] font-medium">
                            {t("shared.drawer.checkin.historyAmount")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {checkinHistory.map((row) => (
                          <tr key={row.date} className="border-b border-border/60 last:border-0">
                            <td className="whitespace-nowrap px-2.5 py-1.5 tabular-nums">{row.date}</td>
                            <td className="px-2.5 py-1.5">
                              <Badge
                                variant={
                                  row.tone === "ok"
                                    ? "success"
                                    : row.tone === "fail"
                                      ? "destructive"
                                      : "secondary"
                                }
                                className={cn("rounded-md px-1.5 py-0 text-[11px] font-medium", row.tone === "none" && "text-muted-foreground")}
                              >
                                {row.resultLabel}
                              </Badge>
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {row.amount === null ? "—" : `+${formatCredits(row.amount)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

                              </TabsContent>
              )}

              {/* 成长任务（仅 WB·CN）：面板自带取数与进行中态 —— 任务列表不参与
                  列表页的排序 / 筛选，没必要由页面预取（见面板文件头）。
                  ⟳ 走页面下发的统一刷新（摘要 + 列表），与指标卡同源。 */}
              {growthTasks && (
                <TabsContent value="tasks" className="space-y-3 pt-1">
                  <GrowthTasksPanel
                    scope={growthTasks.scope}
                    accountId={growthTasks.accountId}
                    refreshing={growthTasks.refreshing}
                    onRefresh={growthTasks.onRefresh}
                    onChanged={onGrowthTasksChanged}
                  />
                </TabsContent>
              )}

              {hasActions && (
                <TabsContent value="credential" className="space-y-4 pt-1">
{/* ★ 凭据页签（2026-10-23 用户要求重做）：**先看凭据信息与有效状态，再做动作**。
                  旧版这一页只有两枚按钮，点了才知道凭据是什么状态 —— 顺序反了。

                  动作只剩两个，且**语义不同**（所以不是一个「刷新」了事）：
                  - 「刷新凭据状态」= 重读本机凭据元数据（续期状态、是否需重登），只读；
                  - 「续期凭据」= 真的去续期（写 refresh_token，会消耗令牌），有副作用。
                  ★ 2026-10-23：两枚动作从页签底部挪到**标题行右侧**（布局对标任务页签
                  的汇总行）：⟳ 仅图标 = 刷新凭据状态（只读）；「续期凭据」= 钥匙
                  图标 + 文字的主按钮 —— 钥匙即 `KeyRound`，与卡片「更多」菜单、
                  批量栏的续期凭据图标同源，暗示「动的是令牌本身」。
                  逐项进行中态来自页面的 `refreshingKinds`，与指标块右上角 ⟳ **同源**。 */}
              {hasActions && (
                <section>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[11.5px] font-medium text-muted-foreground">
                      {t("shared.drawer.tab.credential")}
                    </h3>
                    <div className="flex items-center gap-1.5">
                      {onRefreshPart && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={(refreshingKinds ?? []).includes("credential")}
                          onClick={() => onRefreshPart("credential")}
                          aria-label={t("shared.drawer.actions.refreshStatus")}
                          title={t("shared.drawer.actions.refreshStatus")}
                        >
                          {(refreshingKinds ?? []).includes("credential") ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <RefreshCw />
                          )}
                        </Button>
                      )}
                      {actions?.onRefresh && (
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2.5"
                          disabled={refreshBusy}
                          onClick={() => void runRefresh(() => actions.onRefresh?.())}
                        >
                          {refreshBusy ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <KeyRound />
                          )}
                          {t("shared.drawer.actions.refresh")}
                        </Button>
                      )}
                    </div>
                  </div>

                  {credential && (
                    <div className="rounded-lg border border-border px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            credential.tone === "ok"
                              ? "success"
                              : credential.tone === "warn"
                                ? "warning"
                                : "destructive"
                          }
                        >
                          {credential.statusText}
                        </Badge>
                        {credential.hint ? (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {credential.hint}
                          </span>
                        ) : null}
                      </div>
                      {credential.rows.length > 0 && (
                        <dl className="mt-1.5 space-y-0">
                          {credential.rows.map((row, index) => (
                            <div
                              key={`${row.label}-${index}`}
                              className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-2.5 border-b border-dashed border-border py-1.5 text-[12.5px] last:border-b-0"
                            >
                              <dt className="shrink-0 text-[11.5px] text-muted-foreground">{row.label}</dt>
                              <dd
                                className={cn(
                                  "min-w-0 truncate text-right text-foreground/80",
                                  row.mono && "font-mono tabular-nums",
                                  row.value === EMPTY_VALUE && "font-mono",
                                )}
                                title={row.title ?? row.value}
                              >
                                {row.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  )}
                  {actions?.credentialUnavailable && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {t("shared.drawer.actions.credentialNote")}
                    </p>
                  )}
                </section>
              )}
                </TabsContent>
              )}
              {snapshots.length > 0 && (
                <TabsContent value="snapshot" className="space-y-4 pt-1">
                  <section>
                    <h3 className="mb-2 text-[11.5px] font-medium text-muted-foreground">
                      {t("shared.drawer.snapshot.title")}
                    </h3>
                    <div className="overflow-hidden rounded-lg border border-border">
                      <table className="w-full text-[11.5px]">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="px-2.5 py-1.5 text-left font-normal">
                              {t("shared.drawer.snapshot.time")}
                            </th>
                            <th className="px-2.5 py-1.5 text-right font-normal">
                              {t("shared.drawer.snapshot.size")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshots.map((snapshot) => (
                            <tr key={snapshot.key} className="border-t border-border">
                              <td className="px-2.5 py-1.5 tabular-nums">
                                {snapshot.timeText}
                                <span className="ml-2 text-muted-foreground">{snapshot.fileCountText}</span>
                              </td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums">{snapshot.sizeText}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </TabsContent>
              )}
            </Tabs>
          )}
        </div>

        {/* 固定底栏：全抽屉**唯一**的流程出口。
            放在滚动区外，永远在视野内 —— 上一版它在正文最下面，长列表时要滚到底才找得到。 */}
        {onWizardSwitch && (
          <div className="shrink-0 border-t border-border p-4">
            <Button type="button" className="w-full" onClick={onWizardSwitch}>
              <ArrowRight className="size-4" />
              {t("shared.drawer.switch.wizard")}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
