import { AppMenu, ThemeMenu } from "@/components/shell/app-menu";
import { RunPill } from "@/components/shell/run-pill";
import { ScopeSelector } from "@/components/shell/scope-selector";
import { isMacOverlayTitleBar } from "@/lib/platform";
import type { Scope } from "@/lib/scope";
import type { ScopeStatusMap } from "@/lib/use-scope-status";
import { cn } from "@/lib/utils";

/**
 * **顶部应用栏** —— L1 作用域 + 全局动作（§2.1）。
 *
 * ## 三段式的第一段
 *
 * 骨架是「顶栏 + 侧栏 + 内容区」（原型 `index.html:11-79`）：
 * 顶栏承载**跨页恒定的全局上下文与动作** —— 当前作用域、运行态、主题、
 * 应用设置。侧栏只承载**目的地**（L2），内容区承载视图参数（L3）。
 * 把作用域留在侧栏（旧 `ScopeSwitch`）会让它随产品分区换血，正是本次要修掉的错位。
 *
 * ## 为什么没有刷新按钮（2026-11-16 移除）
 *
 * 顶栏 ⟳ 只能重读聚合快照 / `reconcileAccounts`——而快照本就有 60 秒可见时轮询、
 * 账号页的「一键刷新」又是它的真子集，且在其他页面点了它页面内容不变、只弹
 * 「已刷新」toast（观感在说谎）。两个刷新并存让用户不知道用哪个 ⇒ 刷新语义收敛到
 * 账号页三作用域（单账号 / 批量 / 一键，见 `docs/specs/PLAN.md` §3.8），
 * 命令面板的「刷新当前作用域」保留为兜底入口。
 *
 * ## 为什么没有搜索按钮（2026-11-16 移除）
 *
 * 顶栏搜索框只是 ⌘K 命令面板的入口之一，而面板里没有顶栏之外独有的高频动作，
 * 账号/页面跳转在侧栏都有一手入口 ⇒ 搜索框几乎不被使用。移除后命令面板
 * **保留**（⌘K / Ctrl+K 仍可唤起，含「刷新当前作用域」等动作），
 * 只是不再在顶栏给它常驻位置。
 *
 * ## macOS 红绿灯避让
 *
 * 窗口用 `titleBarStyle: "Overlay"` + `trafficLightPosition{x:16,y:30}` ⇒ 顶栏是
 * **标题栏本身**，左侧要为红绿灯留出 ≥76px。这是**真机才有**的约束：浏览器能看到
 * 覆盖率不足，但看不到红绿灯压住控件 —— 必须真机截图确认。
 *
 * ## 可拖拽
 *
 * `data-tauri-drag-region` 挂在本容器上（子按钮**不带**该属性 ⇒ 照常接收点击）。
 * 因此不再需要旧实现里那条覆盖顶部的固定 32px 拖拽条。
 */
export function TopBar({
  scope,
  statuses,
  shortcutBindings,
  onSelectScope,
}: {
  scope: Scope;
  statuses: ScopeStatusMap;
  shortcutBindings: ReadonlyMap<Scope, number>;
  onSelectScope: (next: Scope) => void;
}) {
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-card px-3.5",
        isMacOverlayTitleBar() && "pl-[76px]",
      )}
    >
      <ScopeSelector
        scope={scope}
        statuses={statuses}
        shortcutBindings={shortcutBindings}
        onSelect={onSelectScope}
      />
      <RunPill status={statuses[scope]} />

      <div className="flex-1" />

      <ThemeMenu />
      <AppMenu />
    </header>
  );
}
