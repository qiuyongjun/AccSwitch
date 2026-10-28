import type { ComponentProps, ReactNode } from "react";
import type { DrawerTab } from "@/lib/drawer-tab-preference";
import { Check, CircleCheck, CircleSlash, Coins, Ellipsis, KeyRound, Loader2, RefreshCw, Save, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DemoAction } from "@/components/demo-action";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MenuGroupLabel, MenuHead, MenuNote, RefreshMenuGroup } from "@/components/account-menu-parts";
import type { AccountRefreshKind } from "@/lib/account-refresh";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AVATAR_TEXT_CLASS,
  CredentialExpiryMeta,
  accountInitials,
  avatarTone,
  expiryTooltipLines,
  nextExpiryLabel,
} from "@/components/account-card";
import { displayText } from "@/lib/display-text";
import { isExpiryUrgent, summarizeExpiry } from "@/lib/credit-expiry";
import { CheckinIcon } from "@/lib/semantic-icons";
import { useT, type Translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type {
  TraeAccount,
  TraeCreditPackage,
  TraeJwtStatus,
  TraeProgramId,
  TraeRegionId,
  TraeVariantId,
} from "@/lib/trae-types";

/* 与 WB 卡片同一处理：几何交给 `Badge` 基础样式（已逐值对齐原型 `.badge`），
   这里只抵消它的 1px 透明边框（原型 `.badge` 没有边框）。 */
const chipClass = "border-0 px-[7px] font-medium";

/** 剩余小时数 → 可读文案。 */
export function hoursText(hours: number | null, t: Translate): string {
  if (hours === null || !Number.isFinite(hours)) return t("trae.comp.card.hours.unknown");
  if (hours <= 0) return t("trae.comp.card.hours.expired");
  if (hours < 1) return t("trae.comp.card.hours.minutes", { count: Math.round(hours * 60) });
  if (hours < 48) return t("trae.comp.card.hours.hours", { count: hours.toFixed(1) });
  return t("trae.comp.card.hours.days", { count: Math.floor(hours / 24) });
}

/** Unix 秒 → `MM-DD HH:mm`。 */
export function shortTime(seconds: number | null): string {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 积分总量（`积分 X/Y` 里的 `Y`）—— 卡片与表格共用。
 *
 * ## 为什么分母只能来自 `creditPackages`（2026-10-27 修正）
 *
 * 上一版为了「让列表也显示分母」，曾拿 `account.credits` 当总量。那是**错的**：
 * `account.credits` 在后端是 `latest_credits`，取自 `credits_history` 里该账号
 * **最近一条每日余额快照**（`CreditRecord { date, credits, delta }`，见
 * `crates/buddy-switch-core/src/modules/trae/credits.rs:290`）—— 是「某一天的余额」，
 * 不是「额度容量」。于是屏幕上出现了 `2,521.07/100` 这种剩余大于总量的自相矛盾读数。
 *
 * 唯一真实的总量是逐包 `total` 之和（`user_entitlement_pack_list` 的每个包都有
 * 总量与剩余），而它**只有刷过积分才有**（`creditPackages === null` 表示还没查过）。
 *
 * ⇒ 没有明细就返回 `null`，调用方**只显示剩余、不写分母**。
 * 要分母就得让明细就位：抽屉打开时会自动拉一次（见 `TraeAccountsPage` 的
 * `autoCreditsFor`），列表侧靠「一键刷新 / 勾选后刷新积分」。
 */
export function traeCreditTotal(account: Pick<TraeAccount, "creditPackages">): number | null {
  const pkgs = account.creditPackages ?? [];
  if (pkgs.length === 0) return null;
  const sum = pkgs.reduce((acc, pkg) => acc + pkg.total, 0);
  return sum > 0 ? sum : null;
}

/**
 * 逐包明细的**唯一合并口径**：积分总览（`get_trae_credits` 的 `packages[uid]`）优先，
 * 回落账号快照自带的 `creditPackages`。
 *
 * ⚠️ 卡片侧一直这么合并，表格侧此前只读账号快照 ⇒ 同一账号在卡片上有
 * `剩余/总数` 与到期金额、在列表里只剩剩余与到期时刻（2026-10-27 用户报障）。
 * 两个视图都从这里取，明细来源不可能再分叉。
 */
export function traeCreditPackages(
  account: Pick<TraeAccount, "userId" | "creditPackages">,
  overviewPackages?: Record<string, TraeCreditPackage[]> | null,
): TraeCreditPackage[] | null {
  return overviewPackages?.[account.userId] ?? account.creditPackages ?? null;
}

/** JWT 状态 → Badge 变体与文案。 */
/**
 * JWT 到期时刻（**毫秒**）—— 单位换算的**唯一入口**。
 *
 * ⚠️ `TraeAccount.jwtExpTimestamp` 是 **Unix 秒**，不是毫秒：后端 `trae/jwt.rs:20` 的
 * 字段注释写着「`exp` 的 Unix 秒时间戳」，同文件的 `exp_hours` 也是 `(exp - now) / 3600`
 * 用秒算的。直接把它当毫秒传给 `formatDate` 会渲染成 **1970**。
 *
 * 抽成函数而不是就地 `* 1000`：卡片与表格两处都要换算，散着写迟早有一处漏。
 */
export function traeJwtExpiryMs(account: Pick<TraeAccount, "jwtExpTimestamp">): number | null {
  return account.jwtExpTimestamp == null ? null : account.jwtExpTimestamp * 1000;
}

export function jwtBadge(status: TraeJwtStatus, hours: number | null, t: Translate) {
  switch (status) {
    case "ok":
      return {
        variant: "secondary" as const,
        className: "",
        text: t("trae.comp.card.jwt.valid", { hours: hoursText(hours, t) }),
      };
    case "warn":
      return {
        variant: "secondary" as const,
        className: "bg-warning/15 text-warning",
        text: t("trae.comp.card.jwt.warn", { hours: hoursText(hours, t) }),
      };
    case "expired":
      return { variant: "destructive" as const, className: "", text: t("trae.comp.card.jwt.expired") };
    default:
      return { variant: "outline" as const, className: "", text: t("trae.comp.card.jwt.unparsable") };
  }
}

/** 冷却的 tooltip 文案（类型 · 解除时刻 · 原因）—— 卡片状态徽章与表格「冷却中」共用。 */
export function traeCooldownTip(account: TraeAccount, t: Translate): string {
  return account.cooldownType
    ? [
        account.cooldownType,
        account.cooldownUntil ? t("trae.comp.card.cooldown.until", { time: shortTime(account.cooldownUntil) }) : "",
        account.cooldownReason ?? "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
}

/**
 * 账号**状态徽章**（卡片 chips 行与表格「状态」列**同一份实现**，与 WB 的
 * `AccountStatusBadge` 同一角色）：
 *
 * ```
 * 凭据已过期 / 需重新登录(bad) → 今日未签到(warn) → 已签到(ok)   ＋  冷却中(warn)  ＋  有效 13 天
 * ```
 *
 * ★ 2026-10-27（用户报障「今日未签到，卡片和列表标签不一致」）：表格此前另写一份 ——
 * 未签到是 secondary 灰、无图标，卡片是 warning 琥珀 + `CheckinIcon` ⇒ 同一状态两种画法。
 * 现在两处都走这里；`checkedToday` 由调用方传**合并后**的值（上游 `checkinMap` 优先）。
 *
 * 冷却也收进来了（后端只在**未到期**时下发 `cooldownType`，见 `trae/account.rs` 的
 * `active_cooldown`）：此前只有表格画「冷却中」、卡片藏在签到徽章的 tooltip 里，
 * 两种视图对同一条账号摆出的标签集合不一样。tooltip 仍给类型 / 解除时刻 / 原因。
 */
export function TraeStatusChips({
  account,
  checkedToday,
  onOpenTab,
}: {
  account: TraeAccount;
  /** 页面侧合并后的签到态；不传 ⇒ 读账号快照。 */
  checkedToday?: boolean;
  /** 标签直达详情页签（R10）：签到 / 凭据 → 对应页签；冷却 → 凭据。 */
  onOpenTab?: (tab: DrawerTab) => void;
}) {
  const t = useT();
  /** 可点标签包一层 `button`：整卡可点开详情，标签必须自己能拦下冒泡。 */
  const wrap = (badge: ReactNode, tab: DrawerTab) =>
    onOpenTab ? (
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
  /* 已过期 / SessionDead 是**互斥的一枚**：凭据都坏了，「签没签到」是次要信息。
     签到两态共用 `CheckinIcon`（与 WB 的 `AccountStatusBadge` 同一枚）。 */
  const statusChip =
    account.jwtStatus === "expired" || account.cooldownType === "SessionDead" ? (
      <Badge variant="destructive" className={chipClass}>
        {account.cooldownType === "SessionDead"
          ? t("trae.comp.card.chip.needRelogin")
          : t("trae.comp.card.chip.expired")}
      </Badge>
    ) : !(checkedToday ?? account.checkedToday) ? (
      <Badge variant="warning" className={chipClass}>
        <CheckinIcon /> {t("trae.comp.card.chip.unchecked")}
      </Badge>
    ) : (
      <Badge variant="success" className={chipClass}>
        <CheckinIcon /> {t("trae.comp.card.chip.checked")}
      </Badge>
    );

  const coolingChip = account.cooldownType ? (
    <Badge variant="warning" className={chipClass} title={traeCooldownTip(account, t)}>
      {t("trae.comp.card.chip.cooling")}
    </Badge>
  ) : null;

  /* 凭据有效期（`有效 13 天` / `临期 5.2 小时`）——`expired` 由上面那枚表达，
     这里不再叠一枚「已过期」。 */
  const validity = jwtBadge(account.jwtStatus, account.jwtExpHours, t);
  const validityChip =
    account.jwtStatus === "expired" ? null : (
      <Badge variant={validity.variant} className={cn(chipClass, validity.className)}>
        {validity.text}
      </Badge>
    );

  return (
    <>
      {wrap(
        statusChip,
        account.jwtStatus === "expired" || account.cooldownType === "SessionDead" ? "credential" : "checkin",
      )}
      {coolingChip ? wrap(coolingChip, "credential") : null}
      {validityChip ? wrap(validityChip, "credential") : null}
    </>
  );
}

/**
 * 「该程序位此刻登录的就是这个账号」的只读角标 —— 卡片页脚与表格「程序位」列**同一份**。
 *
 * 样式出处：原型 `.prog.on`（`demo.css:332`）—— primary **18%** 底 + primary 40% 描边 +
 * primary 字 + **字重 600**；硬编码的 `inset 0 1px 0 rgba(255,255,255,.8)` 在深色下是
 * 一条刺眼白线，故不抄。
 */
export function TraeCurrentProgramChip({ className, children, ...props }: ComponentProps<"span">) {
  return (
    <span
      {...props}
      role="status"
      className={cn(
        /* `whitespace-nowrap`：表格列窄时「Trae CN」会被折成两行（实测 840px 窗口）；
           卡片里是短名不会暴露，但同一个组件两个场景都得站得住。 */
        "inline-flex h-[26px] shrink-0 items-center gap-1 whitespace-nowrap rounded-[8px] border border-primary/40 bg-primary/18 px-2 text-[11px] font-semibold text-primary",
        className,
      )}
    >
      <Check className="size-3" strokeWidth={2.25} />
      <span>{children}</span>
    </span>
  );
}

/** 数字 → 千分位字符串（`null` / 非有限值回落 `—`）。导出给账号页装配 `DetailPack` 复用，避免两处格式化漂移。 */
export function formatCredits(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

/**
 * 到期日**只到日**（`MM/DD`）—— 指标行专用。
 *
 * ⚠️ 只返回日期本身：指标行的标签已经写了「到期」，若值再带后缀就成了
 * 「到期 10/03 到期」。原型 `.acct-metrics` 的值也是**纯值**（标签在行内）。
 */
export function formatExpiryDate(seconds: number | null): string | null {
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/**
 * 一个「Trae 程序」维度：该账号可以在哪条 Trae 产品线上启用。
 *
 * ## 与 WorkBuddy 卡片的关系
 *
 * WorkBuddy 的账号卡片头部有一排**工具切换按钮**（WorkBuddy / CodeBuddy IDE /
 * CodeBuddy CLI）——同一个账号可以分别被设为这几个客户端各自的当前账号。
 * Trae 侧的对应物就是本类型：本机装着的每条 Trae 产品线（Trae Work / Trae CN）
 * 都是一枚按钮，账号可以分别在这两条线上启用。
 *
 * 两者是**同一个交互**，不是「Trae 抄 WorkBuddy 的外观」：用户学会
 * 「卡片右上角那排图标 = 把这个账号挂到哪个客户端上」之后，两个分区行为一致。
 */
export interface TraeProgram {
  /**
   * 程序位所属**区域**。
   *
   * ★ 跨区域常显后**必须**带上：`TraeProgramStatus.program` 只有 2 个取值
   * （`trae_work` / `trae_code`，不含区域），跨区域会重复；去重后又会丢失
   * 「该写哪个客户端」。`variant` 是切换目标（区域限定），`region` 用于**消歧与语义**。
   */
  region: TraeRegionId;
  /** 切换目标（区域限定，后端 `TraeProgramStatus.variant`）—— 真正喂给 `traeSwitchAccount` 的值。 */
  variant: TraeVariantId;
  /**
   * 程序位标识（`trae_work` / `trae_code`，**不含区域**）。
   *
   * ★ 2026-10-12：按钮上的**可见短名**（`Work` / `Code`，原型 `pg.short`）由它决定。
   * ⚠️ **不能**用 `variant` 或 `label` 猜：`trae_cn` / `trae_code` 这类历史值在
   * `variant.rs` 里**语义不唯一**（`TraeRegion × TraeProgram` 的朴素笛卡尔积命名），
   * `label` 又是展示名（`TraeWork` / `TraeCode` / `Trae` / `… AI`）—— 两者都会把 Code 判成 Work。
   */
  program: TraeProgramId;
  /** 展示名（`Trae Work` / `Trae CN`），取自后端 `variantLabel`。 */
  label: string;
  /** 本机是否检测到该程序（未检测到时按钮禁用，理由写进 tooltip）。 */
  installed: boolean;
  /**
   * 该程序位有没有**可读写的客户端数据目录**（后端 `writeDataDirExists`）。
   *
   * ## 为什么「装了」还不够（2026-09-29 报障）
   *
   * 装了 ≠ 用过。客户端**从未启动过**时，它的 userData 目录压根不存在
   * （本机实测：`D:\Programs\Trae CN\Trae CN.exe` 装着，`%APPDATA%\Trae CN` 没有）
   * ⇒ 既存不出快照、也恢复不进去，这个程序位上的「切换」**永远不可能成功**。
   *
   * 只按 `installed` 判定可用，会渲染出一枚**看着能点、点了必然失败**的按钮 ——
   * 用户看到的是「切换成功但什么都没发生」。有了本字段，按钮才能如实表达
   * 「现在切得过去吗」，并在 tooltip 里说清下一步该做什么。
   */
  hasDataDir: boolean;
  /** 该账号是否正是这个程序的当前账号（由该线登录态快照的 `currentAccount` 判定）。 */
  current: boolean;
}

interface Props {
  account: TraeAccount;
  /** 是否为**当前管理的这条产品线**的当前账号（头部高亮 + 幽灵 logo 用它）。 */
  current?: boolean;
  /**
   * 该账号可启用的 Trae 程序（**跨全部区域**，每个 `(region, program)` 一条）。
   *
   * 未传或为空时不渲染任何程序控件——这比渲染一枚「Trae」通用按钮诚实：
   * 后者在两条线并存时根本无法表达「点下去是挂到哪条线上」。
   */
  programs?: TraeProgram[];
  /** 当前正在执行的动作 key（`switch-<uid>@<变体>` / `save-<uid>` / …）。 */
  busy?: string | null;
  /** 任一账号正在切换中，用于阻止并发切换。 */
  switchBusy?: boolean;
  /** 演示模式等场景下禁用所有写操作。 */
  featuresDisabled?: boolean;
  /**
   * 把该账号挂到指定 Trae 程序上（会重启该程序）。
   *
   * ⚠️ 第三个参数是**该程序位自己的展示名**，调用方必须原样往上传，**不要**拿
   * `variant` 去反推名字：`trae_cn` 这个变体同时属于 `trae_code`（遗留）与 `trae`
   * （合并版，issue #20），反推会把合并版说成 `TraeCode`。
   * 后端下发的 `program.label` 才是唯一正确来源（本组件已按 `displayText` 归一）。
   */
  onSwitchTo?: (account: TraeAccount, variant: TraeVariantId, label: string) => void;
  /** 单账号签到。 */
  onCheckin?: (account: TraeAccount) => void;
  /**
   * 单账号**刷新积分**（issue #44）。
   *
   * 此前卡片只有一句「点右上角菜单『刷新积分』重试」，而菜单里根本没有这一项 ——
   * 用户唯一能刷新积分的路径是「全选 → 批量刷新 → 取消全选」，为看一眼某个账号的积分
   * 动整张列表。有了这个回调，卡片上（未查询到积分的那一行 + 「更多」菜单）都能一键刷新。
   */
  onRefreshCredits?: (account: TraeAccount) => void;

  /**
   * 单项刷新（积分 / 今日 Token / 签到状态 / 凭据状态）。
   * 不传 ⇒ 菜单保留原来的单项「刷新积分」（向后兼容）；传了 ⇒ 换成四项分组的「刷新」。
   */
  onRefreshPart?: (account: TraeAccount, kind: AccountRefreshKind) => void;
  /** 本账号正在进行中的刷新项。 */
  refreshingKinds?: readonly AccountRefreshKind[];
  /** 刚刚刷新成功（自行淡出）的项，菜单里显示「已更新」。 */
  doneKinds?: readonly AccountRefreshKind[];
  /**
   * 「今日是否已签到」的**局部覆盖**（页面侧刷新签到状态后立即生效）。
   *
   * ⚠️ 为什么不直接改 `account.checkedToday`：那属于账号列表的数据，刷新一个账号
   * 却重取整页会让「点一下刷新」变成整页闪烁；这里把最新事实单独交给卡片渲染。
   */
  checkedTodayOverride?: boolean;
  /* ★ 2026-10-26：`todayTokens` / `todayTokensTruncated` 已删 —— 卡片不再展示今日 Token
     （与 WorkBuddy 同口径：卡片只回答「这个号要不要先用掉」，用量归用量页与详情抽屉）。
     今日 Token 的正式去处是抽屉指标块（`TraeAccountsPage` 的 `tokensBlock`），那里的 ⟳
     仍走 `onRefreshPart(account, "tokens")`。数据本身仍在页面 state 里，只是不再有一份
     卡片渲染。 */
  /** 本平台真的能刷的项（见 `RefreshMenuGroup` 的注释）。 */
  refreshKinds?: readonly AccountRefreshKind[];
  onSaveLogin: (account: TraeAccount) => void;
  onRefreshJwt: (account: TraeAccount) => void;
  onClearCooldown: (account: TraeAccount) => void;
  onDelete: (account: TraeAccount) => void;
  /** 是否被勾选（批量操作）。 */
  selected?: boolean;
  onToggleSelect?: (account: TraeAccount) => void;
  /** 打开详情抽屉（抽屉状态由页面持有）。 */
  onOpenDetail?: (account: TraeAccount) => void;
  /** 标签 / 指标直达详情页签（R10）。 */
  onOpenTab?: (account: TraeAccount, tab: DrawerTab) => void;
  /**
   * 「更多」菜单节点（由**页面装配**）：卡片与表格消费同一份，卡片只负责摆到页脚。
   * 不传 ⇒ 退回卡片内的旧装配。
   */
  menu?: ReactNode;
}

/**
 * Trae 账号卡片。
 *
 * 结构与 WorkBuddy 的 `AccountCard` 一一对应（同样的 header/body/footer 三段、
 * 同样的「当前账号」角标与操作菜单），差异只在数据源：
 * Trae 的额度单位是积分、登录凭据是 JWT、切换动作是重启 Trae 客户端。
 *
 * ## P4 卡片瘦身
 *
 * 详情（备注编辑、账号明细）**已迁入共享抽屉**，页脚的「保存登录态 / 刷新 JWT」
 * 两枚按钮收回「更多」菜单（菜单本就有同名项，其说明挂在菜单项的 `title` 上）。
 * 卡片常规可点区只剩：**勾选框 / 程序位行 / 更多菜单**。
 *
 * ## 「挂到哪个程序上」= WorkBuddy 卡片的那排工具按钮
 *
 * WorkBuddy 卡片右上角是三枚工具按钮（WorkBuddy / CodeBuddy IDE / CodeBuddy CLI），
 * Trae 侧就是 {@link TraeProgram} 每枚按钮对应一条 Trae 产品线。**每条产品线各判各的
 * 「当前账号」**：同一个 Trae 账号完全可以同时是 Trae Work 的当前账号与 Trae CN 的
 * 非当前账号，因此每枚按钮必须独立取状态，不能由卡片的 `current` 一刀切。
 */
export function TraeAccountCard({
  account,
  current = false,
  programs = [],
  busy = null,
  switchBusy = false,
  featuresDisabled = false,
  onSwitchTo,
  onCheckin,
  onRefreshCredits,
  onRefreshPart,
  refreshingKinds,
  doneKinds,
  checkedTodayOverride,
  refreshKinds,
  onSaveLogin,
  onRefreshJwt,
  onClearCooldown,
  onDelete,
  selected = false,
  onToggleSelect,
  onOpenDetail,
  onOpenTab,
  menu,
}: Props) {
  const t = useT();
  const name = displayText(account.name) || `UID · ${account.userId}`;
  // 忙状态 key 带上变体（`switch-<uid>@<变体>`）：同一账号可能在切另一条线，
  // 只按 uid 判定会把「切 Trae CN 中」的转圈画到 Trae Work 的按钮上。
  const switchKeyPrefix = `switch-${account.userId}@`;
  const switchingVariant: TraeVariantId | null = busy?.startsWith(switchKeyPrefix)
    ? (busy.slice(switchKeyPrefix.length) as TraeVariantId)
    : null;
  const saving = busy === `save-${account.userId}`;
  const refreshingJwt = busy === `jwt-${account.userId}`;
  /** 单账号刷新积分中（issue #44）—— 两个入口（积分提示行 / 菜单项）共用这一个忙标记。 */
  const refreshingCredits = busy === `credits-${account.userId}`;
  const thawing = busy === `thaw-${account.userId}`;
  const checkingIn = busy === `checkin-${account.userId}`;
  const deleting = busy === `delete-${account.userId}`;
  const hasCredits = account.remainingCredits !== null;

  /**
   * 状态标签 —— **槽位与顺序照原型 `.acct-chips`**（`buddy-switch-prototype.html:2505-2508`）：
   *
   * ```
   * 状态 → X 积分 N 天后过期
   * ```
   *
   * 原型对**两个平台用同一个渲染器**，所以 Trae 卡片的标签形状与 WorkBuddy 完全一致。
   *
   * ★ 2026-10-26（与 WorkBuddy 同批）：`使用中 N 个工具` **已移除** —— 页脚程序位行
   * 直接显示哪些工具在亮，计数是重复信息。原型的槽位表里那一枚也因此不再渲染；
   * 判定「当前登录」仍走 `current`（与左侧竖条同源），与计数无关。
   *
   * ⚠️ 2026-10-12：此前这里挂的是 Trae 专有标签（JWT 有效期 / 冷却 · 时间戳 / 分组 /
   * 自动刷新）—— 5~6 枚、折成两三行，卡片 **243px**，而原型是 **170px**。
   * 信号没有丢，只是**换进原型规定的槽位**：
   *   · JWT 过期 / `SessionDead` 冷却 ⇒ 第 2 槽「状态」（凭据已过期 / 需重新登录）
   *   · 冷却的时间与原因 ⇒ 「冷却中」徽章的 tooltip（见 {@link TraeStatusChips}）
   *   · 分组 / 自动刷新 JWT ⇒ 详情抽屉（chips 行是原型的固定槽位，不塞多余标签）
   *
   * ★ 2026-10-27（用户要求两种视图标签一致）：**有效期重新回到 chips 行**，但只保留
   * 一枚（`有效 13 天` / `临期 5.2 小时`），文案与表格「状态」列共用 {@link jwtBadge}；
   * 已过期时不重复渲染 —— 第 2 槽此时已经是「凭据已过期」。
   *
   * ★ 2026-10-27（用户报障「今日未签到，卡片和列表标签不一致」）：渲染收进
   * {@link TraeStatusChips}，表格「状态」列读**同一份** —— 此前表格自写一份，
   * 未签到在列表里是灰色无图标、在卡片里是琥珀 + 日历勾。
   */
  const statusChips = (
    <TraeStatusChips
      account={account}
      checkedToday={checkedTodayOverride ?? account.checkedToday}
      onOpenTab={onOpenTab ? (tab) => onOpenTab(account, tab) : undefined}
    />
  );

  /**
   * 「140 积分明天到期」—— 与 WorkBuddy 卡片**同一份**汇总（`summarizeExpiry`）：
   * 只报最急一批的金额与到期日，逐批明细进 tooltip。
   *
   * ⚠️ Trae 的 `expireAt` 是**秒**（后端直接透传上游 `expire_time`），WorkBuddy 是毫秒 ——
   * 单位必须显式传给汇总函数，此前这里靠 `> 1e12` 猜单位，猜错一次就会整条徽章消失。
   *
   * 3 天内到期 = `warning`（要花掉的），更远 = `secondary`（仍在，只是不抢眼）——
   * 每个账号都摆出最近到期，用户才能横向比较「哪个号该先用」。
   */
  const expiryNow = Date.now();
  const expiry = summarizeExpiry(account.creditPackages, { unit: "s", now: expiryNow });
  const nextExpiry = expiry?.batches[0] ?? null;

  /* ★ 2026-10-26（复刻 WB）：**临期不再是 chips 行的一枚徽章**，改成指标行里的一段文字。
     理由与 WB 定稿同源：chips 行只放「账号状态」（已签到 / 需重登），到期是**关于积分的数据**，
     与积分数字连读才成句（「积分 2,521/3,050 · 21.07 积分 10-31 09:23 到期」）；
     做成贴纸会让它看起来像另一种状态，也更占宽度。
     渲染见下方 `metricsRow` 的 `expiringNote`。 */

  /**
   * 程序按钮的 tooltip：**先说清为什么不能点，再说点了会怎样**。
   *
   * 三种不可用/可用形态互斥，顺序即优先级：没装 → 装了但没数据目录 → 可切。
   * 「装了但没数据目录」这一支此前缺失，于是那种按钮被当成可切（报障来源）。
   */
  const switchTooltip = (program: TraeProgram) => {
    // 同 `programControl`：`program.label` 未归一（可能是对象），取不到时回落程序位标识。
    const label = displayText(program.label) || program.variant;
    return !program.installed
      ? t("trae.comp.card.switch.missing", { label })
      : program.hasDataDir
        ? t("trae.comp.card.switch.tip", { label })
        : t("trae.comp.card.switch.noDataDir", { label });
  };

  /**
   * 「保存登录态」是否可用：**该账号必须此刻正登录在某个程序上**。
   *
   * 语义上「保存登录态」＝「把客户端**此刻**的登录态存到这个账号名下」，
   * 因此唯一有效的目标就是「这个账号当前登录着的那个程序位」；一个都没有时
   * 后端保存守卫也会拒绝（本机实测会回「客户端当前登录的是另一个账号…」）。
   * 与其让用户点了再吃一句看不懂的拒绝，不如就地禁用并说明。
   */
  const canSaveLogin = programs.some((program) => program.current);

  /**
   * 单个程序的控件。
   *
   * 形态与 WorkBuddy 卡片逐一对齐：
   * - **当前账号** → 角标（不可点，`role="status"`），WorkBuddy 同位置同形态；
   * - **演示模式** → 包一层 `DemoAction`（控件保持可见可聚焦，点击只解释为什么不可用）；
   * - **其余** → 切换按钮，未安装 / 有并发切换 / 缺回调时禁用，理由写进 tooltip。
   *
   * ⚠️ 2026-10-10：原来的**跨区域**一支已删除 —— `programs` 现在只含**当前区域**的程序位
   * （见 `TraeAccountsPage::programsFor`），跨区域按钮永远不会出现，留着就是死代码。
   */
  function programControl(program: TraeProgram) {
    const busyHere = switchingVariant === program.variant;
    const key = `${program.region}:${program.variant}`;
    // `program.label` 来自后端（`TraeProgramStatus.variantLabel`），类型声明是 `string`
    // 但运行时可能是对象 ⇒ 直接当 React 子节点会卸载整棵树（白屏）。取不到时回落到
    // **程序位标识**（`variant`），不编造展示名。下面所有用到 label 的地方（子节点 /
    // `title` / `aria-label` 插值）统一走这一个归一值，避免漏网。
    const label = displayText(program.label) || program.variant;
    /* ★ 2026-10-12：按钮上的**可见文字**改固定短名（原型 `pg.short` = `Work` / `Code`）。
       `label`（`TraeWork` / `TraeCode`）仍用于 `title` / `aria-label` 与 tooltip。
       ★ 2026-10-13（issue #20）：合并版程序位 `trae` 的短名用 `Trae` —— 它与 `trae_code`
       候选名逐字相同（客户端复用了目录名），但**是两条不同的程序位**
       （各自变体 / 快照目录 / Key 归属），按钮上必须看得出点的是哪一枚。 */
    const short =
      program.program === "trae_code" ? "Code" : program.program === "trae" ? "Trae" : "Work";

    if (program.current) {
      return (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <TraeCurrentProgramChip aria-label={t("trae.comp.card.currentOf", { label })}>
              {short}
            </TraeCurrentProgramChip>
          </TooltipTrigger>
          <TooltipContent side="top">{t("trae.comp.card.currentOf", { label })}</TooltipContent>
        </Tooltip>
      );
    }

    const button = (
      <Button
        variant="outline"
        size="sm"
        className="h-[26px] gap-1 rounded-[8px] border-border bg-transparent px-2 text-[11px] !font-normal text-muted-foreground"
        disabled={featuresDisabled || switchBusy || !program.installed || !program.hasDataDir || !onSwitchTo}
        onClick={() => onSwitchTo?.(account, program.variant, label)}
        aria-label={busyHere ? t("trae.comp.card.switch.ariaBusy", { label }) : t("trae.comp.card.switch.aria", { label })}
        aria-busy={busyHere}
      >
        {busyHere ? <Loader2 className="size-3.5 animate-spin" /> : null}
        <span>{busyHere ? t("trae.comp.card.switch.busy") : short}</span>
      </Button>
    );

    return featuresDisabled ? (
      <DemoAction key={key}>{button}</DemoAction>
    ) : (
      <Tooltip key={key}>
        <TooltipTrigger asChild>
          <span className="inline-flex">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{switchTooltip(program)}</TooltipContent>
      </Tooltip>
    );
  }

  /**
   * 程序位行（**单一定义**，页脚程序位行）——与 WorkBuddy 的 `programRow` 同构。
   *
   * ⚠️ `w-full` + `flex-wrap` 与 WorkBuddy 逐字一致：程序位到 4 个（TraeWork / TraeCode ×
   * 两个区域）时不换行会溢出卡片；只加 `min-w-0` 又会让本行收缩到最小内容宽、槽位被压成多行。
   */
  const programRow = (
    <div className="flex w-full flex-wrap items-center gap-1">
      {programs.map(programControl)}
    </div>
  );

  /**
   * ★ 与 WorkBuddy 卡片**同一套结构**（原型 `.acct`，`buddy-switch-prototype.html:2497-2535`）：
   * 左侧当前竖条 → 头部（勾选 + 头像 + 昵称/「当前登录」徽章 + 身份行 + chips）→ 指标行 →
   * 正文（积分 + 到期包）→ 页脚程序位。
   *
   * ⚠️ 差异**只在数据**：Trae 的额度单位是积分、凭据是 JWT、身份行是 UID（Trae 没有邮箱）。
   * 结构与交互（整卡可点、当前登录两重信号、指标行、程序位页脚）必须逐项一致 ——
   * 这正是本次重构「用原型统一两个平台」的要求。
   */
  const identity = `UID · ${account.userId}`;

  /* 「当前登录」徽章**单独拆出来**、与昵称同一行（原型 `:2502`）。
     ⚠️ 不能塞进下面的 `statusChips` 行：那会把头部撑成三行（WorkBuddy 侧已踩过）。
     ★ 2026-10-26：改用 `variant="info"`，不再手写 `bg-primary/16 text-primary` ——
     那串正是 `info` 的定义（`ui/badge.tsx:51`），手写一份等于给三张卡片留了三个漂移点。 */
  const currentLoginBadge = current ? (
    <Badge variant="info" className={cn(chipClass, "shrink-0")}>
      {t("trae.comp.card.currentLogin")}
    </Badge>
  ) : null;

  /* 指标行（原型 `.acct-metrics` `:2510`）：与 WorkBuddy 同位置、同字号、同「标签 + 粗体值」形状。 */
  /**
   * ★ 指标行 —— **与 WorkBuddy 卡片逐项同形**（2026-10-26 复刻）：
   *
   * ```
   * 积分 2,521.07/3,050 · 21.07 积分 10-31 09:23 到期
   * ```
   *
   * 三条口径与 WB 完全一致（此前 Trae 侧自有一套，看起来像另一个产品）：
   *
   * 1. **只有两格**：`积分 x/y` + 临期。旧版还有「到期 10/31」（与临期重复）、
   *    「今日 Token」（WB 卡片已删：卡片只回答「要不要先用掉」）、「5 天前」
   *    （WB 的「最近使用」已按用户要求从卡片与抽屉一并移除）。三格都在别处有正式去处
   *    —— 到期批次与今日 Token 在详情抽屉，更新时间在抽屉的信息区。
   * 2. **项间用 `·` 分隔、间距 9px、允许换行**：两格都以数字开头，只靠间距会读成
   *    一串数字；窄卡不换行会被 `overflow-hidden` 直接裁掉。
   * 3. **临期用颜色分轻重而不是徽章**：3 天内 `text-warning`，更远 muted ——
   *    贴纸是状态（chips 行），文字是数据（本行）。临期文案走共享的
   *    `nextExpiryLabel`，三平台对「最急一批」的措辞只可能有一份。
   */
  /* 积分总量走共享的 `traeCreditTotal`（表格同一函数）。 */
  const creditTotal = traeCreditTotal(account);

  /* 临期（最急一批）：文案与 tooltip 都走 `account-card.tsx` 的共享实现 ——
     WB / Trae 的「90.19 积分 10-29 09:25 到期」必须逐字一致。 */
  const expiringLabel = nextExpiryLabel(expiry, t, expiryNow);
  const expiringTip = expiry ? expiryTooltipLines(expiry, t) : null;
  /**
   * ★ 2026-10-26（用户报障「没有显示临期标签」）：**没有包明细时也要给出到期时刻**。
   *
   * `creditPackages` 只有「单独刷过积分」才存在，而 `creditsExpireAt` 是账号列表**本来就带**的
   * 到期时刻。此前只认前者 ⇒ 没刷过积分的账号，卡片上整段临期直接消失，看起来像「这个号不会到期」。
   *
   * 兜底只报「何时到期」，**不编金额**：没有包明细就不知道到期的是多少积分。
   */
  const expiringNote = nextExpiry ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "tabular-nums",
            isExpiryUrgent(nextExpiry.expireAt, expiryNow) ? "text-warning" : "text-muted-foreground",
          )}
          aria-label={expiringLabel}
        >
          {expiringLabel}
        </span>
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
  ) : account.creditsExpireAt ? (
    <span
      className={cn(
        "tabular-nums",
        /* `creditsExpireAt` 是**秒**（后端透传上游 `expire_time`），判临期要换成毫秒。 */
        isExpiryUrgent(account.creditsExpireAt * 1000, expiryNow) ? "text-warning" : "text-muted-foreground",
      )}
      title={t("trae.comp.card.expiryOnTip")}
    >
      {t("trae.comp.card.expiryOn", { date: shortTime(account.creditsExpireAt) })}
    </span>
  ) : null;

  const metricsRow = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-[9px] gap-y-1 text-[11.5px] text-muted-foreground">
      <span>
        {t("trae.comp.card.metric.credits")}{" "}
        <b className="font-semibold tabular-nums text-foreground">{formatCredits(account.remainingCredits)}</b>
        {creditTotal === null ? "" : `/${formatCredits(creditTotal)}`}
      </span>
      {expiringNote && (
        <>
          <span aria-hidden className="select-none text-muted-foreground/50">
            ·
          </span>
          {expiringNote}
        </>
      )}
    </div>
  );

  /* 「更多」菜单（**单一定义**，页脚 `.acct-actions` 用它）——与 WorkBuddy 卡片同形：
     演示模式下包一层 `DemoAction`（控件保持可见可聚焦，点击只解释为什么不可用）。 */
  const inlineMenu = featuresDisabled ? (
    <DemoAction>
      <Button variant="ghost" size="sm" className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("trae.comp.card.manage.aria", { name })} title={t("trae.comp.card.manage.title")}>
        <Ellipsis className="size-4" />
      </Button>
    </DemoAction>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="!px-[10px] text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("trae.comp.card.manage.aria", { name })} title={t("trae.comp.card.manage.title")}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <MenuHead>{displayText(account.name) || account.userId}</MenuHead>
        {/* ★ 2026-10-27（用户要求）：菜单不再放「查看详情 / 编辑备注」——
            详情走**卡片本体点击**（下方 `onOpenDetail` 的整卡交互），
            备注在抽屉「备注」区编辑；菜单只留动作类条目。 */}
        {/* ★ 刷新组只放**只读**项（2026-10-26，与 WorkBuddy 同结构）：
            积分 / 签到状态 / 凭证状态。`tokens` 不在 `refreshKinds` 里 ⇒ 不渲染
            （Trae 卡片的「今日 Token」指标块自带刷新按钮，走同一个 `onRefreshPart`）。
            ★ issue #44 仍然成立：菜单里**真的**要有「刷新积分」，卡片上的提示才不是空口指路。 */}
        {onRefreshPart ? (
          <RefreshMenuGroup refreshingKinds={refreshingKinds} doneKinds={doneKinds} kinds={refreshKinds} onPick={(kind) => onRefreshPart(account, kind)} />
        ) : (
          <DropdownMenuItem
            disabled={featuresDisabled || refreshingCredits || !onRefreshCredits}
            onSelect={() => onRefreshCredits?.(account)}
            title={t("trae.comp.card.action.refreshCreditsTip")}
          >
            {refreshingCredits ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("trae.comp.card.menu.refreshCredits")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <MenuGroupLabel>{t("shared.cardMenu.accountGroup")}</MenuGroupLabel>
        {/* ★ 2026-10-26（与 WorkBuddy 同结构）：**写操作**一律在刷新菜单之外。
            「保存登录态」与「刷新 JWT」（用 `refresh_token` 续期）此前挂在刷新组**之前**
            且没有分组归属，读起来像「刷新的前置步骤」；它们实际是账号级写动作，
            与签到 / 解除冷却同类 ⇒ 一并收进「账号」组。 */}
        <DropdownMenuItem
          disabled={featuresDisabled || saving || !canSaveLogin}
          onSelect={() => onSaveLogin(account)}
          title={canSaveLogin ? t("trae.comp.card.action.saveTip") : t("trae.comp.card.action.saveNoLogin")}
        >
          <Save />{t("trae.comp.card.menu.save")}
        </DropdownMenuItem>
        {account.hasRefreshToken && (
          <DropdownMenuItem disabled={featuresDisabled || refreshingJwt} onSelect={() => onRefreshJwt(account)} title={t("trae.comp.card.action.refreshJwtTip")}>
            <KeyRound />{t("trae.comp.card.menu.refreshJwt")}
          </DropdownMenuItem>
        )}
        {/* 「手动签到」与 WorkBuddy 卡片菜单同位（刷新之后、删除之前）。
            只在今日未签到时出现：已签到的账号再点一次只会被跳过策略拦下，
            摆一个点不动的入口比不摆更差。 */}
        {!(checkedTodayOverride ?? account.checkedToday) && (
          <DropdownMenuItem disabled={featuresDisabled || checkingIn} onSelect={() => onCheckin?.(account)}>
            <CircleCheck />{t("trae.comp.card.menu.checkin")}
          </DropdownMenuItem>
        )}
        {account.cooldownType && (
          <DropdownMenuItem disabled={featuresDisabled || thawing} onSelect={() => onClearCooldown(account)}>
            <CircleSlash />{t("trae.comp.card.menu.thaw")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/5 focus:text-destructive"
          disabled={deleting}
          onSelect={() => onDelete(account)}
        >
          <Trash2 />{t("trae.comp.card.menu.delete")}
        </DropdownMenuItem>
              <MenuNote>{t("shared.cardMenu.note")}</MenuNote>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const checkbox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect?.(account)}
      disabled={!onToggleSelect}
      aria-label={t("trae.comp.card.selectAria", { name })}
      className="size-[18px]"
    />
  );

  return (
    <TooltipProvider>
      <article
        /* ★ 整卡可点开详情 —— 与 WorkBuddy 卡片**同一交互**（原型 `.acct` 是 `data-act="acct-open"`
           的整卡按钮区，`buddy-switch-prototype.html:2497`）。
           ⚠️ 内部控件（勾选框 / 程序位按钮 / 更多菜单）必须**不触发**开详情 ⇒ 用 `closest` 守卫。
           ⚠️ `role` 用 `article` 而非原型写的 `button`：卡内嵌着多个可交互控件，
           嵌套在 `button` 里是非法 ARIA；`article` + `tabIndex` + Enter/Space 是等价可达的正确写法。 */
        tabIndex={0}
        role="article"
        onClick={(e) => {
          if (!onOpenDetail) return;
          const target = e.target;
          if (target instanceof Element && target.closest("button, a, input, [role='checkbox'], [role='switch'], [data-no-account-open]")) {
            return;
          }
          onOpenDetail(account);
        }}
        onKeyDown={(e) => {
          if (!onOpenDetail || e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenDetail(account);
          }
        }}
        className={cn(
          /* ★ 原型 `.acct`（`buddy-switch-prototype.html:312-317`）：
             `display:flex; flex-direction:column; gap:10px; padding:13px 14px`
             ⇒ 卡片是「**四个块 + 统一 10px 间距**」，内边距在**根**上，各块不再自带 padding。
             与 WorkBuddy 卡片逐值一致（`rounded-lg` = `var(--radius)` = 12px）。 */
          "relative flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-lg border border-border bg-card px-3.5 py-[13px] shadow-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          /* 整卡可点 ⇒ 指针光标；否则文字上默认的 I 形光标会被读成「可编辑文本」。 */
          onOpenDetail && "cursor-pointer",
          selected && "border-ring bg-primary/[0.07]",
        )}
      >
      {/* ★ 原型 `.acct.is-current::before`（`buddy-switch-prototype.html:321-324`）：
          「当前账号」用**左侧 3px 竖条**表达 —— 与头部的「当前登录」徽章构成两重信号。
          条件必须与徽章**同为** `current`，否则会出现「有徽章却无竖条」的矛盾态。 */}
      {current ? (
        <span
          aria-hidden="true"
          data-current-bar="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-l-lg bg-primary"
        />
      ) : null}
        <header className="flex items-center gap-2.5">
          {/* ⚠️ `...` 菜单**不在这里** —— 原型把它放在 `.acct-actions` 里（程序位行右侧），
              见页脚 `{menu}`。
              ⚠️ 2026-10-12 按原型删掉了头部底色带（`bg-primary/5` / `bg-muted/30`）与幽灵水印：
              原型 `.acct-top` 是**透明的**，整张卡只有一个底色；底色带把它变成了一条「页眉」，
              还把卡片切成两半。 */}
          {/* 原型 `.acct-top`（`buddy-switch-prototype.html:2499-2503`）的四件套：
             `[勾选] [头像32] [.acct-id：昵称 + 身份] [当前登录徽章]`。
             ⚠️ 徽章是 `.acct-top` 的**直接子级**（行尾独立件），不是昵称那一行里的小尾巴；
             ⚠️ 状态标签**移出头部** —— 原型里 `.acct-chips` 是 `.acct-top` 的**兄弟块**。 */}
          <div className="relative z-10 flex w-full min-w-0 items-center gap-2.5">
            {checkbox}
            {/* 原型 `.avatar`（`demo.css:308-311`）：32px / 圆角 10px / `12.5px` / `640` / 近白字，
                首字取**前 2 位**（`initials()`）。与 WorkBuddy 卡片逐值一致。 */}
            <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px] text-[12.5px] font-[640]", AVATAR_TEXT_CLASS, avatarTone(name))}>
              {accountInitials(name)}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[13px] font-semibold" title={name}>{name}</h3>
              <p className="truncate text-[11px] text-muted-foreground" title={identity}>{identity}</p>
            </div>
            {currentLoginBadge}
          </div>
        </header>

        {/* ★ 原型 `.acct-chips`（`buddy-switch-prototype.html:341`）：`flex-wrap; gap:5px`，
            是 `.acct-top` 的**兄弟块**（卡片共 4 个块），不是塞在头像右侧的第三行。 */}
        <div className="flex min-w-0 flex-wrap items-center gap-[5px]">{statusChips}</div>

        {/* 原型 `.acct-metrics`（`buddy-switch-prototype.html:2510`）：徽章之下的一行小字，
            **始终渲染** —— 取不到的项显示「—」，不闪不藏。
            ⚠️ 2026-10-12 按原型删掉了「大数字行 + 近期到期逐包列表」：原型卡片只有 4 个块
            （`.acct-top` / `.acct-chips` / `.acct-metrics` / `.acct-actions`），逐包明细改由
            **详情抽屉**承载（`TraeAccountsPage` 装配时读 `creditPackages`）。
            ★ 2026-10-26（复刻 WB）：指标行与凭据行都是**根容器的直接子元素**（根 `gap-2.5`
            = 10px），不再塞进下面的 `<section>` —— 否则两行间距变成 section 自己的 0/6px，
            与 WB 卡片的节奏对不上。 */}
        {metricsRow}

        {/* ★ 2026-10-26（与 WorkBuddy 同批）：凭据不在卡片别处展示 ⇒ 指标行下面单起一行
            给出凭据到期。`showRefreshToken={false}` 是**诚实边界**：Trae 的账号模型只有
            `hasRefreshToken`（有没有），**没有刷新令牌的到期时间** —— 用「有」冒充「到期日」
            会造出一行看似完整、实则答非所问的信息。
            ⚠️ `jwtExpTimestamp` 是 **Unix 秒**（后端 `trae/jwt.rs:20`），换算走 `traeJwtExpiryMs`；
            JWT 不可解析时为 `null` ⇒ 落到「—」，不编时间。 */}
        <CredentialExpiryMeta
          account={{ expiresAt: traeJwtExpiryMs(account) }}
          showRefreshToken={false}
          className="text-[11.5px]"
        />

        <section className="flex min-w-0 flex-1 flex-col">
          {/* 冷却 / 未查询提示：与 WorkBuddy 的积分错误行同形（同一图标位、同一配色语义）。 */}
          {account.cooldownType ? (
            <div className="flex min-w-0 items-center gap-2 py-3 text-sm text-destructive">
              <Coins className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{account.cooldownReason || t("trae.comp.card.cooldown.fallback", { type: account.cooldownType })}</span>
            </div>
          ) : !hasCredits ? (
            /* ★ issue #44：这句提示原先写「点右上角菜单『刷新积分』重试」—— 而菜单里没有这一项。
               现在提示只说事实（尚未查询到积分），出口就地给一个真的能点的按钮：
               为看一眼某个账号的积分去「全选 → 批量刷新 → 取消全选」是没必要的绕路。 */
            <div className="flex min-w-0 items-center gap-2 py-3 text-sm text-muted-foreground">
              <Coins className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("trae.comp.card.credits.notQueried")}</span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                disabled={featuresDisabled || refreshingCredits || !onRefreshCredits}
                onClick={() => onRefreshCredits?.(account)}
                title={t("trae.comp.card.action.refreshCreditsTip")}
              >
                {refreshingCredits ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                {t("trae.comp.card.credits.refresh")}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 原型 `.acct-actions`（`demo.css:343` / `accountCard` :2515-2534）：
           `display:flex; align-items:center; gap:6px; padding-top:10px; border-top:1px solid var(--border)`
           ⇒ 页脚 = **程序位行（`flex:1`）+ 「更多」按钮**（菜单在**这里**，不是头部）。
           与 WorkBuddy 卡片页脚逐字同构。 */}
        <footer className="flex items-center gap-1.5 border-t border-border pt-2.5">
          {programRow}
          {menu ?? inlineMenu}
        </footer>
      </article>
    </TooltipProvider>
  );
}
