import type { Translate } from "@/lib/i18n";
import type { CreditExpiry } from "@/lib/types";

/**
 * WorkBuddy 积分的**上次成功读数**（只用于首屏占位，不参与任何业务判定）。
 *
 * ## 为什么需要它
 *
 * 积分来自上游，且每个账号要打 3 路接口。进程重启后内存里的 `creditMap` 是空的，
 * 卡片必须等上游回来才有数字 —— 账号一多，首屏就是几十秒的「等待积分查询」。
 * Trae 侧早有同类落盘缓存（`remaining_credits.json`）；本模块补上 WorkBuddy 侧
 * 的**显示层**缓存：页面先用上次读数渲染，同时在后台刷新，刷新结果覆盖占位值。
 *
 * ## 边界（不要在这里做业务判断）
 *
 * - **只存成功读数**（`ok:true`）；失败结果不落盘，避免把一次网络抖动固化成结论。
 * - 按作用域分家（`wb-cn` / `wb-global`），账号 id 不带区域命名空间，混存会串区。
 * - 超过 {@link MAX_AGE_MS} 的条目不再展示：过期读数比「—」更容易误导。
 * - 读写全部 best-effort：隐私模式 / 配额满 / 坏 JSON 一律当空缓存，绝不让页面报错。
 * - **写入时刻必须交出去**（{@link CachedCredit.at}）：展示层要如实标注「上次读数」，
 *   一个不能回答「这是什么时候的值」的占位比直接留空更误导 —— 到期文案
 *   （`nextExpiryLabel`）会把 7 天前的批次读成「明天到期」。
 */
const STORAGE_KEY = "accswitch:credit-cache:v1";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** 总条目上限：账号删改后旧键不会立刻消失，需要兜底淘汰。 */
const MAX_ENTRIES = 500;

/** 一条缓存读数：值 + **写入时刻**（ms）。 */
export interface CachedCredit {
  at: number;
  value: CreditExpiry;
}

type CacheStore = Record<string, Record<string, CachedCredit>>;

function readStore(): CacheStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as CacheStore;
  } catch {
    return {};
  }
}

function writeStore(store: CacheStore): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 配额满 / 隐私模式：缓存只是加速，失败不影响功能。 */
  }
}

/** 去掉过期条目，并裁剪到上限（丢掉最旧的）。 */
function prune(store: CacheStore, now: number): CacheStore {
  const flat: { scope: string; id: string; at: number; value: CreditExpiry }[] = [];
  for (const [scope, entries] of Object.entries(store)) {
    for (const [id, entry] of Object.entries(entries ?? {})) {
      if (!entry || typeof entry.at !== "number" || now - entry.at > MAX_AGE_MS) continue;
      if (!entry.value?.ok) continue;
      flat.push({ scope, id, at: entry.at, value: entry.value });
    }
  }
  flat.sort((a, b) => b.at - a.at);
  const next: CacheStore = {};
  for (const item of flat.slice(0, MAX_ENTRIES)) {
    (next[item.scope] ??= {})[item.id] = { at: item.at, value: item.value };
  }
  return next;
}

/**
 * 读取某作用域下、**当前仍存在**的账号上次成功读数。
 *
 * `accountIds` 是必需的：只返回还在列表里的账号，已删除账号的缓存不进入展示层。
 * 返回值带 `at`（写入时刻）：调用方**必须**在展示时如实标注「上次读数」，
 * 不能把它当作当前值直接呈现（见文件头最后一条边界）。
 */
export function readCreditCache(
  scope: string,
  accountIds: readonly string[],
): Record<string, CachedCredit> {
  if (accountIds.length === 0) return {};
  const store = readStore();
  const entries = store[scope];
  if (!entries) return {};
  const now = Date.now();
  const out: Record<string, CachedCredit> = {};
  for (const id of accountIds) {
    const entry = entries[id];
    if (!entry || typeof entry.at !== "number" || !entry.value?.ok) continue;
    if (now - entry.at > MAX_AGE_MS) continue;
    out[id] = { at: entry.at, value: entry.value };
  }
  return out;
}

/** 写入一条成功读数；失败读数会被忽略。 */
export function writeCreditCacheEntry(scope: string, accountId: string, value: CreditExpiry): void {
  if (!value.ok) return;
  const store = readStore();
  const now = Date.now();
  const next = prune(store, now);
  (next[scope] ??= {})[accountId] = { at: now, value };
  writeStore(next);
}

/**
 * 「3 分钟前 / 5 小时前 / 2 天前」—— 相对时间，**只有三个量级**。
 *
 * 复用 `shared.gateway.sourceBar.*` 的既有键：同一句中文在仓里只应有一份，
 * 三处（卡片 / 表格 / 抽屉）用的是同一个函数，口径不可能漂移。
 * 不足 1 分钟按「1 分钟前」写 —— 显示「0 分钟前」既怪又像是实时值。
 */
export function formatCreditCacheAge(at: number, t: Translate, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return t("shared.gateway.sourceBar.minutesAgo", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("shared.gateway.sourceBar.hoursAgo", { n: hours });
  return t("shared.gateway.sourceBar.daysAgo", { n: Math.round(hours / 24) });
}

/** 一处措辞，三处复用：`上次读数 · 12 分钟前`。 */
export function creditCacheNote(at: number, t: Translate, now = Date.now()): string {
  return t("wbAccounts.card.creditCacheAge", { age: formatCreditCacheAge(at, t, now) });
}
