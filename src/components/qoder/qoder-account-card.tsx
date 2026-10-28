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
 * | header | 头像 + 昵称 + 身份 + 「当前登录」徽章 | 同形（「当前登录」= 任一程序位 `currentUid` 命中本账号） |
 * | chips | 状态（+ WB 的任务、旅行） | 状态槽（凭据可用 / 凭据未识别 / 无可用凭据）+ 归属异常 + 来源徽章 |
 * | body | 指标行（积分 · 临期）+ 凭据到期行 + 凭据明细 | 指标行（积分 · 临期 · 套餐）+ 凭据到期 + 凭据摘要 + 访问令牌掩码 |
 * | footer | 程序位行 + 更多菜单 | 同形（程序位状态**未取到时不渲染整行**，不摆一排灰胶囊） |
 *
 * ⚠️ 2026-10-26：上表按**实现**重写。原表写「chips 含使用中 N 工具 / 临期 / 优先」
 * 「body 没有积分数据源」「footer 仅更多菜单」，三项都与代码不符 —— 注释漂移比没有注释更坏。
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
import { Check, Ellipsis, FolderTree, Info, StickyNote, Trash2 } from "lucide-react";

import {
  AVATAR_TEXT_CLASS,
  CredentialExpiryMeta,
  accountInitials,
  avatarTone,
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
  /** 可点标签统一包一层 `button`：整卡可点开详情，标签必须自己能拦下冒泡。 */
  const wrap = (badge: ReactNode, tab: DrawerTab | null) =>
    onOpenTab && tab ? (
      <button
        type="button"
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          onOpenTab(tab);
        }}
      >
        {badge}
      </button>
    ) : (
      badge
    );
  if (!account.hasCredential) {
    return wrap(
      <Badge variant="destructive" className={CHIP_CLASS}>
        {t("qoder.page.accounts.chip.noCredential")}
      </Badge>,
      "credential",
    );
  }
  if (account.credential.unrecognized) {
    return wrap(
      <Badge variant="warning" className={CHIP_CLASS}>
        {t("qoder.page.accounts.chip.unrecognized")}
      </Badge>,
      "credential",
    );
  }
  /* ★ 2026-10-26（与 WB / Trae 同批）：签到两态**共用 `CheckinIcon`**，状态由文字与底色
     （success / warning）区分。此前 Qoder 的这两枚是纯文字 —— 同一件事在三张卡上
     两种画法，正是「语义图标一个概念一枚」要防的漂移。凭据两态仍不加图标（文案已自明）。 */
  if (checkinToday === true) {
    return wrap(
      <Badge variant="success" className={CHIP_CLASS}>
        <CheckinIcon /> {t("qoder.page.accounts.chip.checkedIn")}
      </Badge>,
      "checkin",
    );
  }
  if (checkinToday === false) {
    return wrap(
      <Badge variant="warning" className={CHIP_CLASS}>
        <CheckinIcon /> {t("qoder.page.accounts.chip.notCheckedIn")}
      </Badge>,
      "checkin",
    );
  }
  return (
    <Badge variant="success" className={CHIP_CLASS}>
      {t("qoder.page.accounts.chip.ok")}
    </Badge>
  );
}

/** 「归属异常」徽章（与状态槽**正交**的独立一枚；正常时不渲染）。 */
export function QoderForeignBadge({ account }: { account: QoderAccountView }) {
  const t = useT();
  if (!account.domainMismatch) return null;
  return (
    <Badge variant="warning" className={CHIP_CLASS} title={t("qoder.page.accounts.chip.foreignTip")}>
      {t("qoder.page.accounts.chip.foreign")}
    </Badge>
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

export interface QoderCardCredits {
  remaining: number;
  total: number;
  /** 当前套餐/额度的到期时刻（Unix **毫秒**，`qoder_credits` 的 `expiresAt`）；缺值 ⇒ 不渲染临期。 */
  expiresAt?: number | null;
  plan?: string | null;
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
   * 单项刷新（积分 / 今日 Token / 签到状态 / 凭据状态）。
   * 传了 ⇒ 菜单出现「刷新」分组（四项各自独立）；不传 ⇒ 菜单与原来一致。
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
  const uid = displayText(account.uid);
  const identity = uid ? `UID · ${uid}` : "—";
  const sourceLabel = qoderSourceLabel(t, account.source);
  const credentialSummary = displayText(account.credentialSummary);
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
            <p className="truncate text-[11px] text-muted-foreground" title={identity}>
              {identity}
            </p>
          </div>
          {currentLoginBadge}
        </div>
      </header>

      {/* chips：状态槽（恒一枚） + 归属异常（正交） + 来源徽章。
          ★ 2026-10-26：「当前登录」已上移到昵称行右侧 —— chips 行只放**状态**与**归属异常**，
          与 WB（已签到 / 任务 / 旅行）和 Trae（已签到）同一条纪律。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-[5px]">
        <QoderStatusChips
          account={account}
          checkinToday={checkinToday}
          onOpenTab={onOpenTab ? (tab) => onOpenTab(account, tab) : undefined}
        />
        <QoderForeignBadge account={account} />
        {sourceLabel ? (
          <Badge variant="secondary" className={cn(CHIP_CLASS, "text-muted-foreground")}>
            {sourceLabel}
          </Badge>
        ) : null}
      </div>

      {/* body：指标行（积分 · 临期 · 套餐）+ 凭据块（令牌种类 · 掩码）。
          ★ 2026-10-26（复刻 WB）：指标行改成 WB 的形态 —— `积分 <b>558</b>/700 · 临期 · 套餐`，
          间距 9px、`·` 分隔、允许换行、`items-center`。此前是 `558 / 700`（斜杠两侧带空格、
          无千分位）且用 `items-baseline` + 12px 间距，与 WB 那一行不是同一个东西。
          ★ 2026-10-27：临期补进本行（用户要求「像 WB 一样显示到期时间与到期积分数」）：
          WB / Trae 的临期也在这条指标行里，措辞共用 `nextExpiryLabel`；3 天内 `text-warning`。
          ★ 并且**始终渲染**：无额度快照时显示 `积分 —`（与 WB 的「取不到就显示 —，不闪不藏」
          同一条纪律）。此前整行 `null`，卡片会突然少一行，高度随之跳动。 */}
      <section className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1 text-[11.5px] text-muted-foreground">
          {credits ? (
            /* `剩余/总额` 斜杠两侧不自明，「已用」是二者之差 ⇒ 补 tooltip（与 WB 的
               `creditMetricTip` 同口径，各自域内一份文案）。 */
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  /* ★ R10：积分指标直达抽屉「积分」页签；`stopPropagation` 防止同时打开概览。 */
                  className={onOpenTab ? "cursor-pointer" : undefined}
                  onClick={
                    onOpenTab
                      ? (event) => {
                          event.stopPropagation();
                          onOpenTab(account, "credits");
                        }
                      : undefined
                  }
                >
                  {t("qoder.page.accounts.metric.credits")}{" "}
                  <b className="font-semibold tabular-nums text-foreground">
                    {formatCredits(credits.remaining)}
                  </b>
                  /{formatCredits(credits.total)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="whitespace-nowrap tabular-nums">
                {t("qoder.page.accounts.metric.creditsTip", {
                  remaining: formatCredits(credits.remaining),
                  total: formatCredits(credits.total),
                  used: formatCredits(Math.max(0, credits.total - credits.remaining)),
                })}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span>
              {t("qoder.page.accounts.metric.credits")}{" "}
              <b className="font-semibold tabular-nums text-foreground">—</b>
            </span>
          )}
          {expiringLabel ? (
            <>
              <span aria-hidden className="select-none text-muted-foreground/50">
                ·
              </span>
              <span className={cn("tabular-nums", expiryUrgent ? "text-warning" : "text-muted-foreground")}>
                {expiringLabel}
              </span>
            </>
          ) : null}
          {credits?.plan ? (
            <>
              <span aria-hidden className="select-none text-muted-foreground/50">
                ·
              </span>
              <span>
                {t("qoder.page.accounts.metric.plan")}{" "}
                <b className="font-semibold text-foreground">{credits.plan}</b>
              </span>
            </>
          ) : null}
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
        {/* 凭据块：摘要（令牌**种类**）+ 访问令牌掩码。两行同属「这个号的凭据长什么样」，
            内部 4px 紧排；与上方各行之间用 section 的 10px（与 WB「指标行 → 凭据行」同一节奏）。 */}
        {credentialSummary || account.accessTokenMasked ? (
          <div className="flex min-w-0 flex-col gap-1">
            {credentialSummary ? (
              <div className="truncate text-[11.5px] text-muted-foreground" title={credentialSummary}>
                {credentialSummary}
              </div>
            ) : null}
            {account.accessTokenMasked ? (
              <div className="truncate font-mono text-[11px] text-muted-foreground" title={account.accessTokenMasked}>
                {account.accessTokenMasked}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* footer：原型 `.acct-actions`（程序位行 + 更多菜单）。
          程序位行只在**拿到程序位状态**时渲染 —— 没数据时不摆一排「未检测到」的灰胶囊。 */}
      <footer className="flex items-center gap-1.5 border-t border-border pt-2.5">
        {programs && programs.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {programs.map((program) => {
              const active = program.currentUid === account.uid;
              /* 三态：当前（✓） / 可切换（可点） / 未就绪（禁用 + 原因 tooltip）。
                 ★ 客户端在跑时**不可切换** —— 后端会拒绝（进程守卫），界面提前置灰并说明，
                 而不是让用户点了才失败。 */
              const ready = program.state === "ready" && !program.running;
              const title = program.running
                ? t("qoder.page.accounts.program.runningHint")
                : stateLabel(t, program.state);
              /* ★ 2026-10-26（复刻 WB）：**当前态不是按钮，是一枚状态角标**
                 —— WB 的 `ProductCurrentState` 就是这个形态（`role="status"` + ✓ + 短名 +
                 `border-primary/40 bg-primary/18 text-primary font-semibold`，26px / 圆角 8px）。
                 此前这里渲染的是一枚 `disabled` 的按钮：没有 ✓、文字用 `text-foreground`、
                 高度只有 ~20px —— 三张卡片的页脚因此看起来不是同一套控件。 */
              if (active) {
                return (
                  <span
                    key={program.id}
                    role="status"
                    aria-label={program.label}
                    title={program.label}
                    className="inline-flex h-[26px] items-center justify-center gap-1 rounded-[8px] border border-primary/40 bg-primary/18 px-2 text-[11px] font-semibold text-primary"
                  >
                    <Check className="size-3" strokeWidth={2.25} />
                    <span>{program.label}</span>
                  </span>
                );
              }
              return (
                <button
                  key={program.id}
                  type="button"
                  disabled={!ready || !onSwitch}
                  title={title}
                  onClick={() => onSwitch?.(program)}
                  /* 与 WB 的 `.prog` 同一 footprint：26px 高、圆角 8px、`px-2`、11px、字重 400。
                     未就绪时改虚线框（「没数据」不伪装成「装了但不可点」）。 */
                  className={cn(
                    "inline-flex h-[26px] items-center justify-center gap-1 rounded-[8px] border bg-transparent px-2 text-[11px] font-normal transition-colors",
                    ready && onSwitch
                      ? "border-border text-muted-foreground hover:border-border-strong hover:text-foreground"
                      : "border-dashed border-border text-muted-foreground/60",
                  )}
                >
                  {program.label}
                </button>
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
