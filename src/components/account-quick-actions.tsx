import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n";

/**
 * 账号页页头的「一键动作」控件 —— **三平台共用**（2026-10-26 从 `AccountsPage` 抽出）。
 *
 * ## 为什么抽出来
 *
 * 同两枚按钮在三个账号页上长得一样、冷却口径一样、禁用原因的表达也一样。各写一份的
 * 下场在本仓已经出现过多次（`gateway-snippets` / 抽屉壳）：一处改了文案，另两处还是旧的。
 * 抽出来之后，「一键刷新有 30 秒冷却」「按钮被禁用时原因挂在 tooltip 上」这两条只存在一份。
 *
 * ## 与「批量条」的分工（PLAN §3.4 三作用域）
 *
 * - **一键**（本文件，页头）：作用于**全部**账号，只做安全 / 幂等 / 可重复执行的动作
 *   —— 只读刷新，或自动跳过已完成项的签到。**不做**删除 / 导出 / 续期。
 * - **批量**（`AccountBatchBar`，勾选后浮现）：用户显式选择后才跑，允许写操作与破坏性操作。
 * - **单账号**（卡片菜单 / 详情抽屉）：需要上下文才能判断的动作。
 */

/**
 * 一枚一键动作按钮。
 *
 * ⚠️ 禁用态的**原因**必须由外层 `span` 承接：`Button` 禁用时带 `pointer-events-none`，
 * 挂在按钮自身的 `title` 悬停永远不触发（与 `account-toolbar` 的表格视图禁用提示同一做法）。
 */
export function QuickActionButton({
  icon,
  label,
  busy,
  disabled,
  disabledReason,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  const button = (
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick}>
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {label}
    </Button>
  );
  if (!disabled || !disabledReason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

/** 一键刷新的冷却（从**上一轮结束**开始算，避免连点重复打上游）。 */
const QUICK_REFRESH_COOLDOWN_MS = 30_000;

/**
 * 每个作用域**各自的**冷却截止时刻。
 *
 * 模块级而不是组件内 state：用户切到别的页面再回来时，冷却不能「满血复活」——
 * 那等于给了「切页即可绕过限流」的后门。
 *
 * 键是**作用域字符串**（`wb-cn` / `trae-cn` / `qoder-global`…）：三个平台的冷却互不干扰，
 * 也不会因为 `Region` 与 `Scope` 的类型差异各写一份表。
 */
const quickRefreshCooldownUntil: Record<string, number> = {};

/**
 * 该作用域是否仍在冷却中。
 *
 * 动作函数自己也要查一次（见各页的 `quickRefreshAll`）：按钮的 `disabled` 只是**界面约束**，
 * 快捷键 / 代码调用仍能绕过它 —— 冷却必须落在数据层，否则「切页 + 命令面板」就是两条后门。
 *
 * ⚠️ 键必须是**完整作用域**（`wb-cn` / `trae-global`…）。此前 WB 页传的是裸
 * `region`，与 Trae / Qoder 的完整 scope 不同键 ⇒ 同一个页面的冷却表被拆成两套口径。
 */
export function quickRefreshCoolingDown(cooldownKey: string): boolean {
  return Date.now() < (quickRefreshCooldownUntil[cooldownKey] ?? 0);
}

/** 让某作用域进入冷却（动作内部提前返回时，按钮与调用点用同一条规则）。 */
export function startQuickRefreshCooldown(cooldownKey: string): void {
  quickRefreshCooldownUntil[cooldownKey] = Date.now() + QUICK_REFRESH_COOLDOWN_MS;
}

/**
 * 一键刷新按钮（带冷却倒计时）。
 *
 * `onRefresh` 返回 `false` = 这一轮**什么都没做**（比如没有账号）⇒ 不进冷却；
 * 抛错也进冷却 —— 失败也可能已经打过上游请求。
 *
 * ## ★ 2026-10-27：冷却按**完整作用域**键控（用户报障「切区后冷却被继承 / 丢失」）
 *
 * 三个约束，缺一条就会串区：
 * 1. 键是 `scope`（`wb-cn` / `trae-global`…），切换区域时按钮要**重新读取**
 *    该作用域自己的截止时刻，而不是沿用另一个区域的倒计时；
 * 2. 倒计时按**绝对截止时间**与 `Date.now()` 计算，后台计时器被浏览器节流后不会累积偏差；
 * 3. 请求完成后的冷却只写回**发起请求时的那个作用域**（`requestScope`），
 *    且只有当前仍停在同一个区域时才更新按钮状态 —— 否则「在 A 区发起、切到 B 区后返回」
 *    会让 A 的截止时间盖掉 B 的按钮。
 */
export function QuickRefreshAction({
  scope,
  disabled,
  disabledReason,
  busy,
  onRefresh,
}: {
  /** 冷却的作用域键（完整 L1 作用域，一区一条冷却）。 */
  scope: string;
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onRefresh: () => Promise<boolean>;
}) {
  const t = useT();
  /** 最新作用域：请求完成时要判断「用户是否还停在这个区域」。 */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** 当前按钮对应作用域的绝对冷却截止时刻（0 = 不在冷却）。 */
  const [deadline, setDeadline] = useState(() => quickRefreshCooldownUntil[scope] ?? 0);
  /** 只用于驱动倒计时刷新，不参与任何持久状态。 */
  const [now, setNow] = useState(() => Date.now());

  /* 切作用域 ⇒ 立刻换成**该作用域自己的**截止时刻（不是重置为 0）。 */
  useEffect(() => {
    setNow(Date.now());
    setDeadline(quickRefreshCooldownUntil[scope] ?? 0);
  }, [scope]);

  /* 倒计时按绝对时间算：每 tick 重新求值，累积误差不会随计时器延迟放大。 */
  useEffect(() => {
    if (deadline <= 0) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) setDeadline(0);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline]);

  const remainingMs = deadline - now;
  const cooldownLeft = remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  const coolingDown = cooldownLeft > 0;

  const startCooldown = (requestScope: string) => {
    const until = Date.now() + QUICK_REFRESH_COOLDOWN_MS;
    quickRefreshCooldownUntil[requestScope] = until;
    /* ⚠️ 只更新**仍是同一区域**的按钮状态：切区后旧请求不得覆盖当前按钮。 */
    if (scopeRef.current === requestScope) {
      setNow(Date.now());
      setDeadline(until);
    }
  };

  return (
    <QuickActionButton
      icon={<RefreshCw />}
      label={
        coolingDown
          ? t("shared.toolbar.quickRefreshCountdown", { n: cooldownLeft })
          : t("shared.toolbar.quickRefresh")
      }
      busy={busy}
      disabled={disabled || coolingDown}
      disabledReason={
        coolingDown ? t("shared.toolbar.quickRefreshCooldown", { n: cooldownLeft }) : disabledReason
      }
      onClick={() => {
        if (coolingDown) return;
        /* 捕获**发起请求时**的作用域：完成后只回写它。 */
        const requestScope = scopeRef.current;
        void onRefresh()
          .then((ran) => {
            if (ran) startCooldown(requestScope);
          })
          .catch(() => {
            /* 失败也可能已经打过上游请求，同样进入冷却。 */
            startCooldown(requestScope);
          });
      }}
    />
  );
}
