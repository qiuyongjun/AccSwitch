/**
 * 「积分最近到期」的**唯一汇总口径** —— 账号卡片与列表那枚
 * `N 积分<今天|明天|MM-DD> HH:mm 到期` 用它。
 *
 * ## 口径（2026-10-23 重定）
 *
 * - `batches`：全部**未过期且仍有剩余**的批次，按到期时刻**升序** ⇒ `batches[0]` 是最急一批；
 * - 卡片只报 `batches[0]` 的金额与到期日，更远的批次进 tooltip。
 *
 * ## 为什么不再按后端的 7 天窗口过滤
 *
 * 此前只收 `expiringSoon === true`（后端 7 天）⇒ 12 天后到期的 3,000 积分在卡片上
 * **完全隐身**，用户无法比较「哪个号该先用」。卡片要回答的是「这个号现在要不要先用掉」，
 * 所以直接读 `expireAt`（每个积分包都有）把下一批摆出来；7 天窗口仍然只服务统计页的
 * `expiringSoonRemaining`，两者不再互相冒充。
 *
 * ## 为什么是「最急一批」而不是「窗口内合计」
 *
 * issue #44 的旧口径（金额 = 窗口内全部、天数 = 其中最晚）会把「今天 100 + 6 天后 300」
 * 说成「400 积分 6 天内过期」—— 既不是最急的，也不是可比的。逐批展示、只把最急一批
 * 放到卡面上，才对得上「先消耗会先过期的积分」这个决策。
 *
 * ⚠️ 缺 `expireAt` 的积分包一律跳过 —— 宁可少一批，不可编一个到期日。
 */

const DAY_MS = 86_400_000;

/** 紧迫阈值：3 天内到期才用警示色。只影响字色，不影响是否展示。 */
const EXPIRY_URGENT_MS = 3 * DAY_MS;

/** tooltip 最多逐批列出几行 —— 再多对决策没有增量信息，只会把浮层拉长。 */
export const EXPIRY_TIP_LIMIT = 5;

/** 一批到期：同一时刻到期的剩余积分之和。 */
export interface ExpiringBatch {
  /** 到期时刻（epoch 毫秒）。 */
  expireAt: number;
  /** 该批此刻的剩余积分之和。 */
  amount: number;
}

export interface ExpirySummary {
  /** 全部未来到期批次，按到期时刻**升序** ⇒ `batches[0]` 即最急一批。 */
  batches: ExpiringBatch[];
}

/** 汇总入参：WorkBuddy 的 `CreditResource` 与 Trae 的 `TraeCreditPackage` 都满足它。 */
export interface ExpiringItem {
  remaining: number;
  expireAt: number | null;
  /** 后端标记：已到期。 */
  expired?: boolean;
}

/**
 * 汇总未来到期批次。没有可展示的批次时返回 `null`（调用方据此**整条不渲染**，
 * 绝不写一个猜出来的到期日）。
 *
 * @param items 积分包 / 积分资源列表（可为 `null`）
 * @param options.now 判定基准时刻（毫秒），默认 `Date.now()`
 *   —— 一次渲染里多处汇总应传同一个值，否则同一张卡会出现两个「今天」。
 * @param options.unit 入参 `expireAt` 的单位。**两个平台不同，必须显式给**：
 *   WorkBuddy 的 `CreditResource.expireAt` 是**毫秒**（后端 `parse_timestamp_ms`），
 *   Trae 的 `TraeCreditPackage.expireAt` 是**秒**（后端直接透传上游 `expire_time`）。
 */
export function summarizeExpiry(
  items: readonly ExpiringItem[] | null | undefined,
  options: { now?: number; unit?: "ms" | "s" } = {},
): ExpirySummary | null {
  if (!items || items.length === 0) return null;
  const now = options.now ?? Date.now();
  const toMs = options.unit === "s" ? (value: number) => value * 1000 : (value: number) => value;

  /* 同一到期时刻合并成一批：上游可能把一次发放拆成多个包，逐包列会让 tooltip 变成流水账。 */
  const merged = new Map<number, number>();
  for (const item of items) {
    if (item.expired) continue;
    if (!Number.isFinite(item.remaining) || item.remaining <= 0) continue;
    if (typeof item.expireAt !== "number" || !Number.isFinite(item.expireAt)) continue;
    const expireAt = toMs(item.expireAt);
    if (!Number.isFinite(expireAt) || expireAt <= now) continue;
    merged.set(expireAt, (merged.get(expireAt) ?? 0) + item.remaining);
  }
  if (merged.size === 0) return null;

  const batches = [...merged.entries()]
    .map(([expireAt, amount]) => ({ expireAt, amount }))
    .sort((left, right) => left.expireAt - right.expireAt);
  return { batches };
}

/**
 * 到期日的**展示分类**：今天 / 明天 / 具体日期，外加当天的**时分**（本地时区）。
 *
 * ★ 2026-10-23：只给日期不够用 —— 「明天 00:00 到期」其实意味着**今天就得烧掉**，
 * 而「明天 20:00 到期」还能拖到明天白天。时分决定了要不要提前一天动手。
 */
export type ExpiryDay =
  | { kind: "today"; time: string }
  | { kind: "tomorrow"; time: string }
  | { kind: "date"; text: string; time: string };

function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `HH:mm`（本地时区，24 小时制）。 */
function clockText(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把到期时刻按**本地日历日**归类 —— 人按「今天 / 明天 / 几号几点」做计划，
 * 不按「还剩 N 小时」。`Math.round` 兜住夏令时（23/25 小时的那天）。
 */
export function expiryDay(expireAt: number, now: number = Date.now()): ExpiryDay {
  const days = Math.round((startOfDay(expireAt) - startOfDay(now)) / DAY_MS);
  const time = clockText(expireAt);
  if (days <= 0) return { kind: "today", time };
  if (days === 1) return { kind: "tomorrow", time };
  const date = new Date(expireAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return { kind: "date", text: sameYear ? monthDay : `${date.getFullYear()}-${monthDay}`, time };
}

/** 是否进入警示窗口（3 天内到期）。 */
export function isExpiryUrgent(expireAt: number, now: number = Date.now()): boolean {
  const remaining = expireAt - now;
  return remaining > 0 && remaining <= EXPIRY_URGENT_MS;
}
