import type { QoderCreditsRow } from "@/lib/api";
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
 * - **写入时刻仍要记**（{@link CachedCredit.at}）：它只是 {@link MAX_AGE_MS} 的过期判据，
 *   界面**不再**标注「上次读数 · N 分钟前」（切页 / 后台 / 一键刷新都会重取，标时间只剩噪声）。
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

/** Qoder 的额度缓存条目（与 WorkBuddy 同构，仅值类型不同）。 */
export interface CachedQoderCredit {
  at: number;
  value: QoderCreditsRow;
}

interface CachedValue<T> {
  at: number;
  value: T;
}

type GenericStore<T> = Record<string, Record<string, CachedValue<T>>>;
type CacheStore = GenericStore<CreditExpiry>;

function readStoreFrom<T>(key: string): GenericStore<T> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as GenericStore<T>;
  } catch {
    return {};
  }
}

function writeStoreTo<T>(key: string, store: GenericStore<T>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(store));
  } catch {
    /* 配额满 / 隐私模式：缓存只是加速，失败不影响功能。 */
  }
}

function readStore(): CacheStore {
  return readStoreFrom<CreditExpiry>(STORAGE_KEY);
}

function writeStore(store: CacheStore): void {
  writeStoreTo(STORAGE_KEY, store);
}

/** 去掉过期 / 失败条目，并裁剪到上限（丢掉最旧的）。 */
function pruneStore<T extends { ok?: boolean }>(
  store: GenericStore<T>,
  now: number,
): GenericStore<T> {
  const flat: { scope: string; id: string; at: number; value: T }[] = [];
  for (const [scope, entries] of Object.entries(store)) {
    for (const [id, entry] of Object.entries(entries ?? {})) {
      if (!entry || typeof entry.at !== "number" || now - entry.at > MAX_AGE_MS) continue;
      if (!entry.value?.ok) continue;
      flat.push({ scope, id, at: entry.at, value: entry.value });
    }
  }
  flat.sort((a, b) => b.at - a.at);
  const next: GenericStore<T> = {};
  for (const item of flat.slice(0, MAX_ENTRIES)) {
    (next[item.scope] ??= {})[item.id] = { at: item.at, value: item.value };
  }
  return next;
}

function prune(store: CacheStore, now: number): CacheStore {
  return pruneStore(store, now);
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

/* ------------------------------------------------------------------------- */
/* Qoder 额度缓存（首屏展示占位；排序 / 优先级仍读实时 `credits`）            */
/* ------------------------------------------------------------------------- */

const QODER_STORAGE_KEY = "accswitch:qoder-credit-cache:v1";

/**
 * 读取 Qoder 某作用域下的上次成功额度。
 *
 * 与 WorkBuddy 同一纪律：只返回 `ok:true` 且未过期的条目，且**必须**把 `at`
 * 交给展示层标注「上次读数 · N 分钟前」。Qoder 不把这份缓存用于排序 / 优先。
 */
export function readQoderCreditCache(
  scope: string,
  accountIds: readonly string[],
): Record<string, CachedQoderCredit> {
  if (accountIds.length === 0) return {};
  const store = readStoreFrom<QoderCreditsRow>(QODER_STORAGE_KEY);
  const entries = store[scope];
  if (!entries) return {};
  const now = Date.now();
  const out: Record<string, CachedQoderCredit> = {};
  for (const id of accountIds) {
    const entry = entries[id];
    if (!entry || typeof entry.at !== "number" || !entry.value?.ok) continue;
    if (now - entry.at > MAX_AGE_MS) continue;
    out[id] = { at: entry.at, value: entry.value };
  }
  return out;
}

/**
 * 缓存只保留展示需要的字段。
 *
 * ⚠️ 必须剔除 `raw`：后端会把完整 quota 响应塞在行里，账号多时它会把
 * localStorage 配额吃掉一大半，导致整个缓存写入失败（失败被吞 = 缓存静默失效）。
 */
function cacheableQoderCredit(value: QoderCreditsRow): QoderCreditsRow {
  return {
    uid: value.uid,
    name: value.name,
    ok: value.ok,
    remaining: value.remaining,
    used: value.used,
    total: value.total,
    isExceeded: value.isExceeded,
    expiresAt: value.expiresAt,
    expiresForever: value.expiresForever,
    plan: value.plan,
  };
}

/**
 * 批量写入 Qoder 成功额度：**一次**读、prune、写。
 *
 * 逐行调用会让 N 个账号做 N 次全量 JSON 解析 / 字符串化，账号多时反而卡主线程；
 * 刷新路径一次拿到的就是整批行，没有理由拆开写。
 */
export function writeQoderCreditCacheEntries(
  scope: string,
  rows: readonly QoderCreditsRow[],
): void {
  const successful = rows.filter((row) => row.ok);
  if (successful.length === 0) return;
  const store = pruneStore(readStoreFrom<QoderCreditsRow>(QODER_STORAGE_KEY), Date.now());
  const now = Date.now();
  const bucket = (store[scope] ??= {});
  for (const row of successful) {
    bucket[row.uid] = { at: now, value: cacheableQoderCredit(row) };
  }
  writeStoreTo(QODER_STORAGE_KEY, store);
}
