/**
 * Qoder 账号卡片。
 *
 * 结构与 WorkBuddy / Trae 的账号卡**一一对应**（同样的 header / chips / body / footer
 * 四块、同样的「勾选 → 整卡可点开详情 → 页脚更多菜单」交互、同样的头像色板与几何）。
 *
 * ## 交互边界（原型 `accountCard()` 的纪律：**卡片不堆按钮**）
 *
 * 原型的「更多操作」在弹出层里明说：*「操作都在账号抽屉里 —— 点账号卡打开抽屉即可操作；
 * 续期凭据 / 手动签到 / 编辑备注 / 删除 —— 卡片不再堆按钮」*。
 * ⇒ 本卡片的**常规可点区只有三处**：勾选框 / 整卡（打开详情）/ 页脚「更多」菜单；
 * **备注编辑与删除都不在卡上**（它们住在 `account-detail-drawer.tsx` 里）。
 *
 * ## 与另两个平台卡的差异只有数据
 *
 * | 块 | WB / Trae | Qoder（本文件） |
 * |:--|:--|:--|
 * | header | 头像 + 昵称 + 备注（身份行）+ 「当前登录」徽章 | 同形（「当前登录」= 任一程序位 `currentUid` 命中本账号） |
 * | chips | 状态（+ WB 的任务、旅行） | 状态槽（凭据可用 / 凭据未识别 / 无可用凭据）+ 归属异常 |
 * | body | 指标行（积分 · 临期）+ 凭据到期行 + 凭据明细 | 指标行（积分 · 临期 · 优先）+ 凭据到期 |
 * | footer | 程序位行 + 更多菜单 | 同形（程序位状态**未取到时不渲染整行**，不摆一排灰胶囊） |
 *
 * ⚠️ 2026-10-26：上表按**实现**重写。原表写「chips 含使用中 N 工具 / 临期 / 优先」
 * 「body 没有积分数据源」「footer 仅更多菜单」，三项都与代码不符 —— 注释漂移比没有注释更坏。
 * ★ 2026-10-28（用户要求）：身份行改显示备注（不再显示 UID）；卡上去掉来源徽章、
 * 凭据摘要与访问令牌掩码、**套餐** —— 四者在详情抽屉里仍可见。
 *
 * ## 三个刻意的取舍（都有出处）
 *
 * 1. **状态槽恒有一枚**（`凭据可用` / `凭据未识别` / `无可用凭据`）—— 与另两平台的
 *    状态槽同义（WB 的「已签到」/ Trae 的默认成功徽章都是恒有一枚）；「归属异常」
 *    是**正交**的独立徽章（正常时不渲染 —— 与 `travelChip` 的「默认态不渲染」同源）。
 * 2. **程序位行只在拿到状态时渲染**：没数据不摆一排「未检测到」的灰胶囊。
 * 3. ★ **凭据到期已可渲染**（2026-10-27）：core 的 `account_view` 通过
 *    `normalize_expiry_ms` 把秒 / 毫秒统一成 Unix 毫秒（无效 ⇒ null），因此卡片、列表与
 *    详情页签都复用 `CredentialExpiryMeta` 如实展示「凭据到期」；卡片指标行仍只放
 *    **额度到期**（`qoder_credits.expiresAt`），两者是不同字段，不要混用。
 */

import type { ReactNode } from "react";
import { Ellipsis, FolderTree, Info, StickyNote, Trash2 } from "lucide-react";

import {
  AVATAR_TEXT_CLASS,
  CredentialExpiryMeta,
  PROGRAM_SLOT_BUTTON_CLASS,
  PROGRAM_SLOT_UNAVAILABLE_CLASS,
  ProgramSlotChip,
  accountInitials,
  avatarTone,
  cardFocusHint,
  checkinBadgeTip,
  creditMetricTip,
  drawerTabOpenAria,
  expiryTooltipLines,
  formatCredits,
  nextExpiryLabel,
} from "@/components/account-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DemoAction } from "@/components/demo-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuGroupLabel, MenuHead, MenuNote, RefreshMenuGroup } from "@/components/account-menu-parts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import type { DrawerTab } from "@/lib/drawer-tab-preference";
import type { QoderAccountView, QoderProgramStatus } from "@/lib/api";
import { isExpiryUrgent, summarizeExpiry } from "@/lib/credit-expiry";
import { demoModeEnabled } from "@/lib/demo-mode";
import { displayText } from "@/lib/display-text";
import { useT, type Translate } from "@/lib/i18n";
import { CheckinIcon } from "@/lib/semantic-icons";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/zh";

/* 与 `account-card.tsx` 同一处理：几何交给 `Badge` 基础样式（已逐值对齐原型 `.badge`），
   这里只抵消它的 1px 透明边框（原型 `.badge` 没有边框）。 */
const CHIP_CLASS = "border-0 px-[7px] font-medium";

/**
 * 来源 id → 词条键（id 是**后端数据**，见 `qoder::account::SOURCE_*`）。
 *
 * ⚠️ 与 `companion-row.tsx` 的 `SOURCE_LABEL_KEY` 同一手法：**表外的新取值原样显示**，
 * 不隐藏也不猜 —— 后端加了新来源时，界面宁可显示 `mystery-source` 也不要显示空白。
 */
const SOURCE_LABEL_KEY: Record<string, TranslationKey> = {
  pat: "qoder.page.accounts.origin.pat",
  "desktop-app": "qoder.page.accounts.origin.desktopApp",
  cli: "qoder.page.accounts.origin.cli",
  oauth: "qoder.page.accounts.origin.oauth",
};

/** 来源的展示名（表外取值原样回落；空值给 `null` 让调用方决定省不省这一行）。 */
export function qoderSourceLabel(t: Translate, source: string | null | undefined): string | null {
  if (!source) return null;
  const key = SOURCE_LABEL_KEY[source];
  return key ? t(key) : source;
}

/**
 * 账号展示名（卡片 / 表格 / 抽屉 / toast / 无障碍名**同一份回落链**，避免各区各拼一遍）。
 *
 * 回落顺序与另两平台同一纪律：昵称 → 名字 → uid → `—`；**绝不渲染对象**
 * （脏值会让 React 卸整棵树 ⇒ 白屏，issue #2）。
 */
export function qoderAccountName(account: QoderAccountView): string {
  return displayText(account.nickname) || displayText(account.name) || displayText(account.uid) || "—";
}

/**
 * 账号的**状态徽章**（卡片 chips 行与表格「状态」列**同一份实现**，避免两处口径漂移）。
 *
 * 优先级（顺序即优先级，与 WB 侧同一纪律）：**凭据问题 > 签到态 > 正常**。
 * 凭据坏了的账号，「今天签没签到」是次要信息 —— 它根本调不动上游；反过来，
 * 把「今日未签」盖在「无可用凭据」上会让用户去点一个必然失败的签到按钮。
 *
 * ⚠️ `checkinToday` 的**三态**必须区分：
 * - `true` / `false` = 上游明确答复了；
 * - `null` / `undefined` = **还没查到**（额度查询在途、或该区域没有签到接口）。
 *   ⇒ 落回「凭据可用」而不是硬报「今日未签」—— 后者是**把未知说成已知**。
 */
export function QoderStatusChips({
  account,
  checkinToday,
  onOpenTab,
}: {
  account: QoderAccountView;
  /** 三态：`true` 已签 / `false` 未签 / `null|undefined` 未知。 */
  checkinToday?: boolean | null;
  /** 标签直达详情页签（R10）：凭据类 → 凭据；签到类 → 签到。 */
  onOpenTab?: (tab: DrawerTab) => void;
}) {
  const t = useT();
  const name = qoderAccountName(account);

  /**
   * 一枚标签的**唯一渲染口径** —— 与 WB 的 `AccountStatusBadge`、Trae 的 `TraeStatusChips`
   * 逐件一致（2026-10-28 对齐，此前 Qoder 用「外层裸 button + `stopPropagation`」）：
   *
   * · **可点** ⇒ `Badge asChild` 包一层 `<button data-no-account-open>`，并给
   *   `cursor-pointer transition-opacity hover:opacity-85` —— 裸按钮那版能点但**光标不变手型、
   *   悬停没有任何反馈**，用户读不出它可点；
   * · `data-no-account-open` 是**必须**的：整卡与表格行的 `onClick` 只排除
   *   `[data-row-actions]` / `[data-no-account-open]`，缺了它「点标签跳页签」会被
   *   覆盖成「打开概览」（卡片里靠 `stopPropagation` 侥幸拦下，表格行拦不下）；
   * · **有 tip ⇒ Radix `Tooltip`**，不用原生 `title`（三平台只保留一种浮层形态）；
   *   不可点时用 `aria-label` 把同一句话给读屏（与 WB 的旅行 / 任务标签同处理）。
   */
  const chip = ({
    variant,
    content,
    tip,
    tab,
  }: {
    variant: "destructive" | "warning" | "success";
    content: ReactNode;
    tip?: string;
    tab?: "credential" | "checkin";
  }) => {
    /* 先把「能点的话点是哪个页签」收进一个变量：`tab && onOpenTab` 在条件表达式里
       会把 `tab` 收窄到非 undefined，不必在下面各处重复判空。 */
    const openTab = tab && onOpenTab ? tab : null;
    const badge = (
      <Badge
        asChild={Boolean(openTab)}
        variant={variant}
        className={cn(CHIP_CLASS, openTab && "cursor-pointer transition-opacity hover:opacity-85")}
        aria-label={openTab ? drawerTabOpenAria(openTab, name, t) : tip}
      >
        {openTab ? (
          <button type="button" data-no-account-open onClick={() => onOpenTab?.(openTab)}>
            {content}
          </button>
        ) : (
          content
        )}
      </Badge>
    );
    if (!tip) return badge;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top">{tip}</TooltipContent>
      </Tooltip>
    );
  };

  /* 凭据三态不给 tip（与 WB 同口径：`需重新登录` / `凭据已过期` 的下一步已在字面上）：
     「无可用凭据」自明，「凭据未识别」的细节（为什么识别不了）在抽屉「凭据」页签。 */
  if (!account.hasCredential) {
    return chip({
      variant: "destructive",
      content: t("qoder.page.accounts.chip.noCredential"),
      tab: "credential",
    });
  }
  if (account.credential.unrecognized) {
    return chip({
      variant: "warning",
      content: t("qoder.page.accounts.chip.unrecognized"),
      tab: "credential",
    });
  }
  /* ★ 2026-10-26（与 WB / Trae 同批）：签到两态**共用 `CheckinIcon`**，状态由文字与底色
     （success / warning）区分。此前 Qoder 的这两枚是纯文字 —— 同一件事在三张卡上
     两种画法，正是「语义图标一个概念一枚」要防的漂移。
     tip 也共用 `checkinBadgeTip` —— 同一句话在三张卡上不会长成两种说法。 */
  if (checkinToday === true) {
    return chip({
      variant: "success",
      content: (
        <>
          <CheckinIcon /> {t("qoder.page.accounts.chip.checkedIn")}
        </>
      ),
      tip: checkinBadgeTip(true, t),
      tab: "checkin",
    });
  }
  if (checkinToday === false) {
    return chip({
      variant: "warning",
      content: (
        <>
          <CheckinIcon /> {t("qoder.page.accounts.chip.notCheckedIn")}
        </>
      ),
      tip: checkinBadgeTip(false, t),
      tab: "checkin",
    });
  }
  /* 「凭据可用」= 一切正常，但仍**可点** → 凭据页签（与 WB / Trae 的凭据徽章同一角色：
     健康态也是关于凭据的信息，点进去看的是同一份明细）。 */
  return chip({ variant: "success", content: t("qoder.page.accounts.chip.ok"), tab: "credential" });
}

/** 「归属异常」徽章（与状态槽**正交**的独立一枚；正常时不渲染）。 */
export function QoderForeignBadge({ account }: { account: QoderAccountView }) {
  const t = useT();
  if (!account.domainMismatch) return null;
  const tip = t("qoder.page.accounts.chip.foreignTip");
  /* ★ 2026-10-28：原生 `title` → Radix `Tooltip`（与 WB 的旅行 / 任务标签同一形态）。
     不可点的标签仍把同一句话放进 `aria-label`：原生 `title` 读屏听不到。 */
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning" className={CHIP_CLASS} aria-label={tip}>
          {t("qoder.page.accounts.chip.foreign")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** 一条账号的额度快照（来自 `qoder_credits`；取不到就是 `null`，**不编 0**）。 */
/** 程序位四态 → 展示文案（四态是四种不同的用户动作，压成一个布尔会给错引导）。 */
export function stateLabel(t: Translate, state: string): string {
  switch (state) {
    case "ready":
      return t("qoder.page.accounts.program.switchTo");
    case "unreadable":
      return t("qoder.page.accounts.program.unreadable");
    case "empty":
      return t("qoder.page.accounts.program.empty");
    default:
      return t("qoder.page.accounts.program.missing");
  }
}

/**
 * 程序位 id → 页脚胶囊上的**短名**（与 WB 的 `WB` / `IDE` / `CLI`、Trae 的 `Trae` 同一口径）。
 *
 * 完整展示名（`Qoder 桌面版` / `Qoder CLI`）仍用于 tooltip、无障碍名与表格程序位列；
 * 页脚按钮只放短名，三平台程序位行的宽度才一致。
 */
const PROGRAM_SHORT_KEY: Record<string, TranslationKey> = {
  "desktop-app": "qoder.page.accounts.program.desktopShort",
  cli: "qoder.page.accounts.program.cliShort",
};

function programShortLabel(t: Translate, program: QoderProgramStatus): string {
  const key = PROGRAM_SHORT_KEY[program.id];
  return key ? t(key) : program.label;
}

export interface QoderCardCredits {
  remaining: number;
  total: number;
  /** 当前套餐/额度的到期时刻（Unix **毫秒**，`qoder_credits` 的 `expiresAt`）；缺值 ⇒ 不渲染临期。 */
  expiresAt?: number | null;
  /**
   * 上游哨兵「9999-12-31」= **不过期**（此时 `expiresAt` 为 null）。
   *
   * ★ 2026-10-29（用户报障）：它此前被当真实日期渲染成「9999-12-31 08:00 到期」。
   * 现在指标行写「长期有效」，与 WB 的 `wbAccounts.card.forever` 同一口径。
   */
  expiresForever?: boolean;
}

export interface QoderAccountCardProps {
  account: QoderAccountView;
  /** 是否被勾选（批量操作）。 */
  selected?: boolean;
  /** 切换勾选。 */
  onToggleSelect?: (account: QoderAccountView) => void;
  /** 打开详情抽屉（抽屉状态由页面持有）。 */
  onOpenDetail?: (account: QoderAccountView) => void;
  /** 「更多 → 编辑备注」：打开抽屉并进入编辑态。 */
  onEditRemark?: (account: QoderAccountView) => void;
  /**
   * 「更多 → 删除账号」：页面弹确认。
   *
   * ⚠️ 自 2026-10-15 起 Qoder 侧是**软删除**（进回收站，可恢复）—— 弹层文案随之改了，
   * 别再写「没有回收站」。
   */
  onDelete?: (account: QoderAccountView) => void;
  /** 额度快照；`null` / 不传 ⇒ 不渲染积分指标（无数据不渲染，不摆「0 / 0」）。 */
  credits?: QoderCardCredits | null;
  /** 是否为积分优先级最高的账号（指标行「优先」，与 WorkBuddy 同一口径）。 */
  creditPriority?: boolean;
  /** 今日签到三态（`null` / 不传 = 未知）。 */
  checkinToday?: boolean | null;
  /**
   * 程序位状态（只读）。
   *
   * 传入才渲染页脚的**程序位行** —— 未传入（例如程序位数据还没回来）时不渲染，
   * 不摆一排「未检测到」的灰胶囊：那是「没数据」伪装成「没装」。
   */
  programs?: QoderProgramStatus[] | null;
  /** 点击某个程序位胶囊 → 页面弹切换确认。未传 ⇒ 胶囊只读（不可点）。 */
  onSwitch?: (program: QoderProgramStatus) => void;
  /** 「更多 → 设置分组」。 */
  onSetGroup?: (account: QoderAccountView) => void;
  /** 标签 / 指标直达详情页签（R10）。 */
  onOpenTab?: (account: QoderAccountView, tab: DrawerTab) => void;
  /**
   * 单项刷新（积分 / 签到状态 / 凭据状态）。
   * 传了 ⇒ 菜单出现「刷新」分组（各项独立）；不传 ⇒ 菜单与原来一致。
   */
  onRefreshPart?: (account: QoderAccountView, kind: AccountRefreshKind) => void;
  /** 本账号正在进行中的刷新项。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刚刷新成功（自行淡出）的项，菜单里显示「已更新」。 */
  doneKinds?: readonly AccountRefreshKind[];
  /** 本平台真的能刷的项（缺省四项）；见 `RefreshMenuGroup` 的注释。 */
  refreshKinds?: readonly AccountRefreshKind[];
  /**
   * 「更多」菜单节点（由**页面装配**）：卡片与表格消费同一份，卡片只负责摆到页脚。
   * 不传 ⇒ 退回卡片内的旧装配。
   */
  menu?: ReactNode;
}

export function QoderAccountCard({
  account,
  selected = false,
  onToggleSelect,
  onOpenDetail,
  onEditRemark,
  onDelete,
  credits = null,
  creditPriority = false,
  checkinToday,
  programs = null,
  onSwitch,
  onSetGroup,
  onOpenTab,
  onRefreshPart,
  refreshingKinds,
  doneKinds,
  refreshKinds,
  menu,
}: QoderAccountCardProps) {
  const t = useT();
  const name = qoderAccountName(account);
  /* ★ 2026-10-28（用户要求）：身份行不再显示 UID，改为用户自填备注；
     没有备注时**保留空行位**（不让名称垂直居中）。 */
  const remark = displayText(account.remark);
  /* 「当前登录」= **任一**程序位当前登着的就是这个 uid。
     判定放在卡片里（同一个 currentUid 要跟列表每条账号比），后端只给事实。 */
  const currentPrograms = (programs ?? []).filter((program) => program.currentUid === account.uid);
  const isCurrent = currentPrograms.length > 0;

  /**
   * 临期（最急一批）—— 与 WB / Trae 卡片**同一份**汇总与措辞（`summarizeExpiry` /
   * `nextExpiryLabel`），只报最急一批的金额与到期日。
   *
   * `expiresAt` 是**顶层**额度到期（Unix 毫秒，Qoder SDK 口径）：`userQuota` 与
   * `addOnQuota` 共用这一个时刻 ⇒「到期积分数」就是聚合后的剩余。缺值 / 已过期 ⇒
   * `summarizeExpiry` 返回 `null`，整段不渲染（不编到期日）。
   */
  const expiryNow = Date.now();
  const creditExpiry =
    credits && credits.expiresAt != null
      ? summarizeExpiry([{ remaining: credits.remaining, expireAt: credits.expiresAt }], { now: expiryNow })
      : null;
  const expiringLabel = nextExpiryLabel(creditExpiry, t, expiryNow);
  const expiryUrgent = creditExpiry ? isExpiryUrgent(creditExpiry.batches[0].expireAt, expiryNow) : false;

  /** 「优先」——与 WB / Trae 卡片同位置同形态：指标行末尾的纯文字（`text-primary`）。 */
  const priorityNote = creditPriority ? (
    <span className="text-primary" title={t("qoder.page.accounts.card.priorityTip")}>
      {t("qoder.page.accounts.card.priority")}
    </span>
  ) : null;

  /* 「积分 x/y」的 tip 走共享的 `creditMetricTip`：三平台那句「剩余 · 总额 · 已用」只可能有一份。 */
  const creditTip = creditMetricTip(
    { current: credits?.remaining ?? null, total: credits?.total ?? null, expiry: creditExpiry },
    t,
  );

  /**
   * 指标行里**可点的那一段** —— 与 WB / Trae 卡片同一个形状：真
   * `<button data-no-account-open>`（此前是 `span` + `stopPropagation`：在卡片里靠拦冒泡
   * 侥幸生效，表格行那边拦不下），`cursor-pointer` + 悬停降透明，无障碍名说明
   * 「按下去落在抽屉的哪一页」。
   *
   * 没有 `onOpenTab` 时退回 `cursor-default` 的纯文字：不摆一个点下去毫无反应的假控件。
   */
  const creditsTrigger = (content: ReactNode) =>
    onOpenTab ? (
      <button
        type="button"
        data-no-account-open
        onClick={() => onOpenTab(account, "credits")}
        className="cursor-pointer text-left tabular-nums transition-opacity hover:opacity-85"
        aria-label={drawerTabOpenAria("credits", name, t)}
      >
        {content}
      </button>
    ) : (
      <span className="cursor-default tabular-nums">{content}</span>
    );

  /** `积分 x/y` 的**内容**（与是否可点解耦）。无额度快照时 `积分 —`，**仍然可点** —— 点进去正是「为什么没有」。 */
  const creditLine = (
    <>
      {t("qoder.page.accounts.metric.credits")}{" "}
      {credits ? (
        <>
          <b className="font-semibold tabular-nums text-foreground">{formatCredits(credits.remaining)}</b>
          /{formatCredits(credits.total)}
        </>
      ) : (
        <b className="font-semibold tabular-nums text-foreground">—</b>
      )}
    </>
  );

  /** 临期：可点 → 抽屉「积分」，浮层给逐批明细（`expiryTooltipLines` 与 WB / Trae 同一份）。 */
  const expiringTip = creditExpiry ? expiryTooltipLines(creditExpiry, t) : null;
  const expiringNote = creditExpiry ? (
    <Tooltip>
      <TooltipTrigger asChild>
        {creditsTrigger(
          <span className={expiryUrgent ? "text-warning" : "text-muted-foreground"}>{expiringLabel}</span>,
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        {expiringTip ? (
          <>
            <div className="whitespace-nowrap font-medium">{expiringTip.title}</div>
            {expiringTip.lines.map((line) => (
              <div key={line} className="whitespace-nowrap tabular-nums">
                {line}
              </div>
            ))}
            {expiringTip.more ? (
              <div className="whitespace-nowrap text-muted-foreground">{expiringTip.more}</div>
            ) : null}
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  ) : null;

  /** 上游「不过期」哨兵 ⇒ 写「长期有效」（`expiresAt` 已被 core 置空，两者互斥）。 */
  const foreverNote = credits?.expiresForever ? (
    creditsTrigger(
      <span className="text-muted-foreground">{t("qoder.page.accounts.metric.neverExpires")}</span>,
    )
  ) : null;

  /**
   * 「当前登录」徽章 —— **与昵称同一行**（WB `account-card.tsx` 与 Trae 卡同位置）。
   *
   * ★ 2026-10-26（复刻 WB）：此前它在 chips 行第三位，与「凭据可用」「桌面版导入」连成一片，
   * 读起来像第三个状态；而 WB / Trae 都把它放在**身份行右侧**（它是「这个号此刻在客户端里」
   * 的归属信息，不是状态）。三张卡片的头部必须同构。
   */
  const currentLoginBadge = isCurrent ? (
    <Badge variant="info" className={cn(CHIP_CLASS, "shrink-0")}>
      {t("qoder.page.accounts.program.current")}
    </Badge>
  ) : null;

  const inlineMenu = demoModeEnabled ? (
    <DemoAction>
      <Button
        variant="ghost"
        size="sm"
        className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t("qoder.page.accounts.card.manageAria", { name })}
        title={t("qoder.page.accounts.card.moreActions")}
      >
        <Ellipsis className="size-4" />
      </Button>
    </DemoAction>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("qoder.page.accounts.card.manageAria", { name })}
          title={t("qoder.page.accounts.card.moreActions")}
        >
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuHead>{displayText(account.name) || account.uid}</MenuHead>
        <DropdownMenuItem disabled={!onOpenDetail} onSelect={() => onOpenDetail?.(account)}>
          <Info />
          {t("qoder.page.accounts.card.viewDetail")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {onRefreshPart && (
          <>
            <RefreshMenuGroup refreshingKinds={refreshingKinds} doneKinds={doneKinds} kinds={refreshKinds} onPick={(kind) => onRefreshPart(account, kind)} />
            <DropdownMenuSeparator />
            <MenuGroupLabel>{t("shared.cardMenu.accountGroup")}</MenuGroupLabel>
          </>
        )}
        <DropdownMenuItem disabled={!onEditRemark} onSelect={() => onEditRemark?.(account)}>
          <StickyNote />
          {t("qoder.page.accounts.card.editRemark")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!onSetGroup} onSelect={() => onSetGroup?.(account)}>
          <FolderTree />
          {t("qoder.page.accounts.card.setGroup")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* 删除是**危险动作**（虽可恢复，但会移出账号库）⇒ 落到页面统一弹确认。 */}
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/5 focus:text-destructive"
          onSelect={() => onDelete?.(account)}
        >
          <Trash2 />
          {t("qoder.page.accounts.card.deleteAccount")}
        </DropdownMenuItem>
              <MenuNote>{t("shared.cardMenu.note")}</MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    /* 自备 `TooltipProvider`（不产生 DOM）：与 Trae 卡同一处理 —— 卡片在 App 内的全局
       provider 之下渲染，但截图 / 演示等独立挂载场景不该因为缺 provider 就崩。 */
    <TooltipProvider>
    <article
      /* 键盘可达：整卡可 Tab 聚焦，Enter / Space 打开详情（与 WB / Trae 卡同一交互）。 */
      tabIndex={0}
      role="article"
      onClick={(event) => {
        if (!onOpenDetail) return;
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, a, input, [role='checkbox'], [role='switch'], [data-no-account-open]")
        ) {
          return;
        }
        onOpenDetail(account);
      }}
      onKeyDown={(event) => {
        if (!onOpenDetail || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail(account);
        }
      }}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-lg border border-border bg-card px-3.5 py-[13px] shadow-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        /* 整卡可点 ⇒ 指针光标；否则文字上默认的 I 形光标会被读成「可编辑文本」。 */
        onOpenDetail && "cursor-pointer",
        selected && "border-ring bg-primary/[0.07]",
      )}
    >
      {/* 读屏说明：卡片可 Tab 聚焦 + Enter 打开详情（与 WB / Trae 卡片同一句，见 `cardFocusHint`）。 */}
      {onOpenDetail ? <span className="sr-only">{cardFocusHint(t)}</span> : null}
      {/* ★ 「当前账号」的两重信号：**左侧 3px 竖条 + 头部「当前登录」徽章**。
          与 WB（`account-card.tsx`）和 Trae 卡同一实现 —— 原型 `.acct.is-current::before`。
          ⚠️ 条件必须与徽章**同为** `isCurrent`，否则会出现「有徽章却无竖条」的矛盾态
          （2026-10-26 复刻时发现 Qoder 卡此前只有徽章、没有竖条）。 */}
      {isCurrent ? (
        <span
          aria-hidden="true"
          data-current-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-primary"
        />
      ) : null}

      {/* header：勾选 + 头像 32 + 昵称/身份 + 「当前登录」—— 与 WB / Trae 卡**逐件同构**
          （原型的 `.acct-top` 四件套；徽章是行尾独立件，不是昵称那一行里的小尾巴）。 */}
      <header className="flex items-center gap-2.5">
        <div className="relative z-10 flex w-full min-w-0 items-center gap-2.5">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.(account)}
            disabled={!onToggleSelect}
            aria-label={t("qoder.page.accounts.card.selectAria", { name })}
            className="size-[17px]"
          />
          <div
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[12.5px] font-[640]",
              AVATAR_TEXT_CLASS,
              avatarTone(name),
            )}
          >
            {accountInitials(name)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] font-semibold" title={name}>
              {name}
            </h3>
            {/* 无备注也**保留这一行**（空占位）——否则名称会在头像旁垂直居中、上下跳动。 */}
            <p className="truncate text-[11px] text-muted-foreground" title={remark ?? undefined}>
              {remark || "\u00A0"}
            </p>
          </div>
          {currentLoginBadge}
        </div>
      </header>

      {/* chips：状态槽（恒一枚） + 归属异常（正交）。
          ★ 2026-10-26：「当前登录」已上移到昵称行右侧 —— chips 行只放**状态**与**归属异常**，
          与 WB（已签到 / 任务 / 旅行）和 Trae（已签到）同一条纪律。
          ★ 2026-10-28（用户要求）：来源徽章移除 —— 详情抽屉的信息区已列出「来源」。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-[5px]">
        <QoderStatusChips
          account={account}
          checkinToday={checkinToday}
          onOpenTab={onOpenTab ? (tab) => onOpenTab(account, tab) : undefined}
        />
        <QoderForeignBadge account={account} />
      </div>

      {/* body：指标行（积分 · 临期 · 优先）+ 凭据块（令牌种类 · 掩码）。
          ★ 2026-10-26（复刻 WB）：指标行改成 WB 的形态 —— `积分 <b>558</b>/700 · 临期`，
          间距 9px、`·` 分隔、允许换行、`items-center`。此前是 `558 / 700`（斜杠两侧带空格、
          无千分位）且用 `items-baseline` + 12px 间距，与 WB 那一行不是同一个东西。
          ★ 2026-10-27：临期补进本行（用户要求「像 WB 一样显示到期时间与到期积分数」）：
          WB / Trae 的临期也在这条指标行里，措辞共用 `nextExpiryLabel`；3 天内 `text-warning`。
          ★ 2026-10-28（用户要求）：**套餐移出指标行** —— 它与「积分」是同一份额度快照的
          两个属性，卡片上占一整段却不可操作；套餐名仍见详情抽屉的积分包行（`DetailPack.name`）。
          ★ 并且**始终渲染**：无额度快照时显示 `积分 —`（与 WB 的「取不到就显示 —，不闪不藏」
          同一条纪律）。此前整行 `null`，卡片会突然少一行，高度随之跳动。
          ★ 2026-10-28（对齐 WB / Trae 的交互口径）：两段数字都是**真按钮**（`data-no-account-open`
          + `cursor-pointer` + 悬停降透明 + 无障碍名），`积分 —` 那一支也可点；临期补上逐批明细
          浮层（`expiryTooltipLines`）；tip 文案不再各自域内一份，改走共享的 `creditMetricTip`。 */}
      <section className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1 text-[11.5px] text-muted-foreground">
          {creditTip ? (
            <Tooltip>
              <TooltipTrigger asChild>{creditsTrigger(creditLine)}</TooltipTrigger>
              <TooltipContent side="top">
                <div className="whitespace-nowrap tabular-nums">{creditTip}</div>
              </TooltipContent>
            </Tooltip>
          ) : (
            creditsTrigger(creditLine)
          )}
          {(expiringNote || foreverNote) && (
            <>
              <span aria-hidden className="select-none text-muted-foreground/50">
                ·
              </span>
              {expiringNote ?? foreverNote}
            </>
          )}
          {priorityNote && (
            <>
              <span aria-hidden className="select-none text-muted-foreground/50">
                ·
              </span>
              {priorityNote}
            </>
          )}
        </div>
        {/* ★ 2026-10-27（T02 完成后与 WB / Trae 同批）：指标行下面单起一行给出**凭据到期**
            —— `expiresAt` 已由 core 的 `normalize_expiry_ms` 归一成 Unix 毫秒（无效 ⇒ null），
            因此可如实渲染；单元格复用 `CredentialExpiryMeta`（同一份日期格式与缺值分支）。
            `showRefreshToken={false}` 与 Trae 同理由：Qoder 只有 `hasRefreshToken`，
            没有刷新令牌的到期时间 —— 用「有」冒充「到期日」会答非所问。
            额度到期是**另一个**字段（`credits.expiresAt`，已在上方指标行），两者不要混用。 */}
        <CredentialExpiryMeta
          account={{ expiresAt: account.expiresAt }}
          showRefreshToken={false}
          className="text-[11.5px]"
        />
        {/* ★ 2026-10-28（用户要求）：凭据摘要（令牌种类）与访问令牌掩码**不再显示在卡上**
            —— 它们属于「这个号的凭据长什么样」，详情抽屉的「凭据」页签已在讲同一件事。 */}
      </section>

      {/* footer：原型 `.acct-actions`（程序位行 + 更多菜单）。
          程序位行只在**拿到程序位状态**时渲染 —— 没数据时不摆一排「未检测到」的灰胶囊。 */}
      <footer className="flex items-center gap-1.5 border-t border-border pt-2.5">
        {programs && programs.length > 0 ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-1">
            {programs.map((program) => {
              const active = program.currentUid === account.uid;
              /* 三态：当前（✓） / 可切换（可点） / 未就绪（禁用 + 原因 tooltip）。
                 ★ 客户端在跑时**不可切换** —— 后端会拒绝（进程守卫），界面提前置灰并说明，
                 而不是让用户点了才失败。
                 短名与 WB / Trae 页脚同一口径；完整展示名留在 tooltip / 无障碍名里。 */
              const ready = program.state === "ready" && !program.running;
              const short = programShortLabel(t, program);
              const hint = program.running
                ? t("qoder.page.accounts.program.runningHint")
                : stateLabel(t, program.state);
              const title = `${program.label} · ${hint}`;
              /* 当前态不是按钮，而是与 WB / Trae 共用的只读胶囊（`ProgramSlotChip`）。
                 tip 与两平台同句（「{程序位} 当前账号」）：胶囊上只有短名「桌面」，
                 只补全名读不出「这一位此刻登的就是这个号」。 */
              if (active) {
                const currentOf = t("qoder.page.accounts.program.currentOf", { label: program.label });
                return (
                  <ProgramSlotChip key={program.id} aria-label={currentOf} title={currentOf}>
                    {short}
                  </ProgramSlotChip>
                );
              }
              const button = (
                <button
                  type="button"
                  disabled={!ready || !onSwitch}
                  aria-label={title}
                  onClick={() => onSwitch?.(program)}
                  /* 与 WB / Trae 的 `.prog` 同一份几何（`PROGRAM_SLOT_BUTTON_CLASS`）；
                     未就绪时改虚线框（「没数据」不伪装成「装了但不可点」）。 */
                  className={cn(
                    PROGRAM_SLOT_BUTTON_CLASS,
                    "transition-colors",
                    ready && onSwitch
                      ? "hover:border-border-strong hover:text-foreground"
                      : PROGRAM_SLOT_UNAVAILABLE_CLASS,
                  )}
                >
                  {short}
                </button>
              );
              /* ★ 2026-10-28：原生 `title` → Radix `Tooltip`（与 WB / Trae 的页脚程序位同一形态）。
                 ⚠️ 外层 `span` 是**必须**的：浏览器不给 `disabled` 按钮派发指针事件，
                 直接把按钮当 trigger 会让「未就绪的原因」这句 tip 在最需要它的时候不出现
                 （Trae 页脚同一处理）。`key` 也要挂到这一层，否则 map 出来的兄弟节点没有 key。 */
              return (
                <Tooltip key={program.id}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{button}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{title}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ) : null}
        <div className="grow" />
        {menu ?? inlineMenu}
      </footer>
    </article>
    </TooltipProvider>
  );
}
