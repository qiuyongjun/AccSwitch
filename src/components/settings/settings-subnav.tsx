/**
 * 设置页 **7 项子导航** —— 数据驱动。
 *
 * ## 为什么数据驱动
 *
 * 7 项的名字 / 图标 / 顺序只在这里声明一次，页面按 `active` 渲染对应分区。
 * 加一项 = 加一行（§4.2 同一思路），不需要在页面里再写一遍 `if`。
 *
 * ## 为什么没有「通用」与「备份与恢复」
 *
 * 这两项对所有客户端生效，不属于某个客户端的设置页；它们统一放在顶栏 ⚙
 * 「应用设置」抽屉里，点击打开弹框（`global-settings-dialogs.tsx`）。
 * 子导航只保留与当前客户端相关的分区，避免同一份全局设置在每个客户端页重复出现。
 *
 * ## 为什么不做成「可折叠 + 记住位置」
 *
 * 子导航回答的是「设置里有哪几类」，不是「我在哪一步」；URL 尾段才是位置真值
 * （PLAN §3.9 的层级表）。本组件只负责**切换视图**，把选中态交给调用方
 * （`active` / `onSelect`），不自持状态 —— 否则「页面刷新后回到第一项」这类
 * 问题会在两个地方各修一遍。
 *
 * ## ★ 一份表，两个产品线共用
 *
 * 原型只有一个 `viewSettings`（`buddy-switch-prototype.html:3230`），靠
 * `r.cap && p.capabilities.includes(r.cap)` 做平台差异 ⇒ **子导航表本身没有平台分支**。
 * 本仓照此办理：WorkBuddy 设置页与 Trae 设置页**接同一个 `SETTINGS_SUBNAV`**，
 * 各自渲染自己的内容（§3.9 归位表：Trae 的 10 组已全部落进这 7 项；
 * 其中通用与备份属于全局设置，见 `global-settings-dialogs.tsx`）。
 * 若某天真出现「无处安放」的项，再按 D12 走平台专属子项，而不是在这里写 `if`。
 */

import { SideSubnav, type SideSubnavItem } from "@/components/shell/side-subnav";
import { useT } from "@/lib/i18n";

/** 7 个设置分区的标识。 */
export type SettingsSubnavId =
  | "account"
  | "checkin"
  | "gateway"
  | "schedule"
  | "client"
  | "diagnostics"
  | "logs";

export type SettingsSubnavItem = SideSubnavItem<SettingsSubnavId>;

/** 唯一的一份子导航表（顺序即展示顺序）。 */
export const SETTINGS_SUBNAV: readonly SettingsSubnavItem[] = [
  { id: "account", labelKey: "settings.subnav.account" },
  { id: "checkin", labelKey: "settings.subnav.checkin" },
  { id: "gateway", labelKey: "settings.subnav.gateway" },
  { id: "schedule", labelKey: "settings.subnav.schedule" },
  { id: "client", labelKey: "settings.subnav.client" },
  { id: "diagnostics", labelKey: "settings.subnav.diagnostics" },
  { id: "logs", labelKey: "settings.subnav.logs" },
];

/** 从 URL 段解析设置分区（非法值 fail-closed 回第一项，不把任意串塞进 state）。 */
export function parseSettingsSubnav(raw: string | null): SettingsSubnavId {
  return SETTINGS_SUBNAV.some((item) => item.id === raw)
    ? (raw as SettingsSubnavId)
    : SETTINGS_SUBNAV[0].id;
}

interface Props {
  active: SettingsSubnavId;
  onSelect: (id: SettingsSubnavId) => void;
  /** 覆盖表（默认用 `SETTINGS_SUBNAV`）；Trae 设置页若复用可传自己的表。 */
  items?: readonly SettingsSubnavItem[];
  className?: string;
}

/**
 * 设置子导航（版式由 `SideSubnav` 统一提供，这里只钉住自己的**表**与**无障碍名**）。
 */
export function SettingsSubnav({ active, onSelect, items = SETTINGS_SUBNAV, className }: Props) {
  const t = useT();
  return (
    <SideSubnav
      active={active}
      items={items}
      onSelect={onSelect}
      ariaLabel={t("settings.subnav.aria")}
      className={className}
    />
  );
}
