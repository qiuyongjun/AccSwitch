import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { DemoAction } from "@/components/demo-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  growthTasksAuto,
  growthTasksClaim,
  growthTasksList,
  type GrowthTaskItem,
  type GrowthTaskRunResult,
  type GrowthTasksView,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { GrowthTaskIcon } from "@/lib/semantic-icons";
import { cn } from "@/lib/utils";

/**
 * 成长任务中心面板（账号详情抽屉的「任务」页签）。
 *
 * ## 为什么是一个自包含组件（而不是像抽屉其它区块那样由调用方注入数据）
 *
 * 其它区块的数据（积分 / 签到 / 快照）由页面**批量**拉取，因为它们要参与列表页的排序、
 * 筛选与卡片展示；成长任务只在**打开抽屉、切到这个页签时**才有意义 ——
 * 让账号页为每个账号预先拉一遍任务列表，等于把「用户可能永远不看」的请求变成常态开销。
 *
 * 因此这里自己取数：`open → 挂载 → 拉一次 → 卸载`。代价是页签切换会重新拉取
 * （`Tabs` 但 `forceMount` 关掉时内容会卸载），这对「手动触发的运维动作」是合适的 ——
 * 用户点开就是要看**此刻**的进度。
 *
 * ## 三个必须显式表达的状态
 *
 * 1. **进行中**：`growth_tasks_auto` 内部要轮询上游异步计分，最坏几十秒。按钮必须
 *    转圈 + 禁用，否则用户会反复点 —— 后端虽有同账号互斥闸，但「点了没反应」更糟。
 * 2. **部分成功**：`results[]` 里 `failed` 与 `progressed` 混在一起是常态（不同任务的
 *    上游判据宽严不一）。逐条如实呈现，**不折叠成一个「成功」**。
 * 3. **不可自动**：只有 `autoable` 的任务才出「执行」按钮；其余只展示进度 ——
 *    画一个点了什么都不会发生的按钮，比不放按钮坏得多。
 */
export interface GrowthTasksPanelProps {
  /** 作用域（本面板只服务 `wb-cn`，调用方已保证）。 */
  scope: string;
  /** 账号 id（账号库里的 `id`，不是 uid）。 */
  accountId: string;
  /**
   * 跑完一次动作后的通知（用于刷新**这张卡**的提示标签）。
   *
   * 没有它的话，用户领完奖励关掉抽屉，列表卡片上还挂着「可领 1」——
   * 一个「刚领完还说可领」的标签，比没有标签更让人不信任。
   */
  onChanged?: () => void;
  /**
   * 账号显示名：手动刷新成功的回执带上它（「QYJ：任务列表已刷新」），
   * 与其它三项 `onRefreshPart` 回执同款排版（2026-10-23 用户要求）。
   * 缺省时退回不带名字的单行文案。
   */
  accountName?: string;
}

export function GrowthTasksPanel({ scope, accountId, onChanged, accountName }: GrowthTasksPanelProps) {
  const t = useT();
  const [view, setView] = useState<GrowthTasksView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<GrowthTaskRunResult[] | null>(null);

  /**
   * 拉取任务列表。
   *
   * @param announce 仅**手动点击刷新按钮**时为 true ⇒ 成功后弹「已刷新」回执。
   *   挂载时的首次拉取、`runAuto` / `claimOne` 收尾的自动 reload 都走默认 false：
   *   前者是「打开页签」，弹回执是噪音；后者各自动作已自带 toast，
   *   再叠一条「已刷新」会把真正要看的「领了什么」挤下去。
   *   失败回执**不分场景**都弹 —— 失败恰恰最需要被看见。
   */
  const reload = useCallback(async (announce = false) => {
    setLoading(true);
    try {
      const next = await growthTasksList(scope, accountId);
      setView(next);
      if (!next.ok) {
        toast.error(t("shared.growthTasks.loadFailed", { message: next.message ?? "" }));
      } else if (announce) {
        const done = t("shared.growthTasks.refreshDone");
        toast.success(accountName ? `${accountName}${t("shared.punct.colon")}${done}` : done);
      }
    } catch (error) {
      setView({ ok: false, tasks: [], message: String((error as Error)?.message ?? error) });
      toast.error(t("shared.growthTasks.loadFailed", { message: String((error as Error)?.message ?? error) }));
    } finally {
      setLoading(false);
    }
  }, [accountId, scope, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * ★ 2026-10-23：**「领取全部」与「一键完成」合并成一个按钮**。
   *
   * 旧面板上有两个总控按钮（`领取全部` / `一键完成`），用户要自己判断该点哪个：
   * 「已达标未领」的点领取，「还能刷进度」的点一键完成 —— 而后者本来就会领奖
   * （后端 `run_auto_for` 对 `claimable` 的任务直接领）。两个按钮的**交集**占绝大多数，
   * 留给用户的只是「我该点哪个」的额外决策。
   *
   * 合并后的语义（与后端一致，2026-10-23 起 `run_auto_for` 末尾也会收掉
   * `ACTIONS` 之外的可领任务）：
   *
   * ```
   * 一键完成 = 能领的全领 + 能点亮的全点亮
   * ```
   *
   * 仍是**一个后端命令**（`growth_tasks_auto`），不在前端编排两次请求 ——
   * 两次请求之间的失败会让「领了一半」这种中间态没人负责。
   */
  async function runAuto() {
    if (busy) return;
    setBusy("auto");
    setResults(null);
    try {
      const report = await growthTasksAuto(scope, accountId);
      if (!report.ok) {
        toast.error(report.message ?? t("shared.growthTasks.autoNone"));
      } else {
        setResults(report.results);
        const claimed = report.claimed ?? 0;
        const credit = report.credit ?? 0;
        if (claimed > 0) {
          toast.success(t("shared.growthTasks.autoDone", { n: claimed, credit }));
        } else if ((report.results ?? []).some((item) => item.status === "progressed")) {
          // 点亮了但还没达标：不是「什么都没做」，说清楚比一句「没有可完成的」有用。
          toast.info(t("shared.growthTasks.progressedOnly"));
        } else {
          toast.info(t("shared.growthTasks.autoNone"));
        }
      }
    } catch (error) {
      toast.error(String((error as Error)?.message ?? error));
    } finally {
      // 先刷新、再解 busy：反过来的话刷新窗口内按钮已重新可点，会直接触发第二轮请求。
      try {
        await reload();
      } finally {
        setBusy(null);
      }
      // 通知外部刷新**这张卡**的提示标签（列表页据此更新「可领 N」）。
      onChanged?.();
    }
  }

  async function claimOne(code: string) {
    if (busy) return;
    setBusy(code);
    try {
      const result = await growthTasksClaim(scope, accountId, code);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(String((error as Error)?.message ?? error));
    } finally {
      // 先刷新、再解 busy：反过来的话刷新窗口内按钮已重新可点，会直接触发第二轮请求。
      try {
        await reload();
      } finally {
        setBusy(null);
      }
      // 通知外部刷新**这张卡**的提示标签（列表页据此更新「可领 N」）。
      onChanged?.();
    }
  }

  if (loading && !view) {
    return (
      <div className="space-y-2 pt-1">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const tasks = view?.tasks ?? [];
  if (tasks.length === 0) {
    // 空列表与加载失败都**必须留刷新入口**：否则用户只能关掉抽屉再重开，
    // 而失败态恰恰是最需要重试的那一种。
    return (
      <div className="flex items-start justify-between gap-2 pt-2">
        <p className="text-xs text-muted-foreground">
          {view?.ok === false && view.message
            ? t("shared.growthTasks.loadFailed", { message: view.message })
            : t("shared.growthTasks.empty")}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2"
          disabled={loading}
          onClick={() => void reload(true)}
          aria-label={t("shared.growthTasks.refresh")}
        >
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-1">
      {/* 汇总 + **一个**总控动作。放在列表上方是刻意的：用户点开页签的第一诉求
          通常是「有没有能领的」，不是「第 7 个任务的描述是什么」。
          ★ 2026-10-23：原先这里是「领取全部」+「一键完成」两枚按钮，用户要自己判断点哪个；
          现在合成一枚（语义见 `runAuto` 注释）：可领或可自动，任一为真即可点。 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] text-muted-foreground">
          {t("shared.growthTasks.summary", {
            claimable: view?.claimable ?? 0,
            claimed: view?.claimed ?? 0,
            autoable: view?.autoable ?? 0,
          })}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={busy !== null}
            onClick={() => void reload(true)}
            aria-label={t("shared.growthTasks.refresh")}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
          <DemoAction>
            <Button
              size="sm"
              className="h-7 px-2.5"
              disabled={
                busy !== null || ((view?.claimable ?? 0) === 0 && (view?.autoable ?? 0) === 0)
              }
              onClick={() => void runAuto()}
            >
              {busy === "auto" ? <Loader2 className="animate-spin" /> : <GrowthTaskIcon />}
              {busy === "auto" ? t("shared.growthTasks.running") : t("shared.growthTasks.auto")}
            </Button>
          </DemoAction>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("shared.growthTasks.autoHint")}
      </p>

      <ul className="space-y-1.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.taskCode}
            task={task}
            busy={busy === task.taskCode}
            disabled={busy !== null}
            onClaim={() => void claimOne(task.taskCode)}
          />
        ))}
      </ul>

      {results && results.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">
            {t("shared.growthTasks.resultTitle")}
          </h3>
          <ul className="space-y-1">
            {results.map((result) => (
              <li
                key={`${result.taskCode}-${result.status}`}
                className="flex items-start gap-1.5 text-[11.5px] leading-relaxed"
              >
                <ResultIcon status={result.status} />
                <span className="min-w-0 flex-1">
                  <span className="text-foreground/80">{result.title}</span>
                  <span className="text-muted-foreground"> · {result.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TaskRow({
  task,
  busy,
  disabled,
  onClaim,
}: {
  task: GrowthTaskItem;
  busy: boolean;
  disabled: boolean;
  onClaim: () => void;
}) {
  const t = useT();
  const reward =
    task.energy > 0
      ? t("shared.growthTasks.reward", { credit: task.credit, energy: task.energy })
      : t("shared.growthTasks.rewardCredit", { credit: task.credit });

  return (
    <li className="rounded-lg border border-border/70 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-medium text-foreground/90" title={task.title}>
            {task.title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-mono tabular-nums">{task.progress}</span>
            <span aria-hidden>·</span>
            <span className="text-success/90">{reward}</span>
          </div>
          {task.autoable && task.actionDesc && (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
              {task.actionDesc}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.claimed ? (
            <Badge variant="success">{t("shared.growthTasks.claimed")}</Badge>
          ) : task.locked ? (
            <Badge variant="secondary">{t("shared.growthTasks.locked")}</Badge>
          ) : task.claimable ? (
            <DemoAction>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={disabled} onClick={onClaim}>
                {busy ? <Loader2 className="animate-spin" /> : <GrowthTaskIcon />}
                {t("shared.growthTasks.claim")}
              </Button>
            </DemoAction>
          ) : task.autoable ? (
            /* 刻意用**说明性**徽标而不是「执行」：本工具只提供账号级「一键完成」，
               没有单任务执行入口（单任务点亮需要独立的命令面 + 独立的前端状态）。
               写成「执行」会让用户去点一个点不动的徽标 —— 伪交互比没有更坏。 */
            <Badge variant="secondary">{t("shared.growthTasks.autoable")}</Badge>
          ) : (
            <Badge variant="secondary">{t("shared.growthTasks.manualOnly")}</Badge>
          )}
        </div>
      </div>
    </li>
  );
}

function ResultIcon({ status }: { status: GrowthTaskRunResult["status"] }) {
  if (status === "claimed") return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />;
  if (status === "failed") return <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
  return <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", status === "progressed" ? "bg-warning" : "bg-muted-foreground/50")} />;
}
