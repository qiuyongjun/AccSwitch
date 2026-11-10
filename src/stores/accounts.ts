import { create } from "zustand";
import * as api from "@/lib/api";
import { mapWithConcurrency } from "@/lib/concurrency";
import { writeCreditCacheEntry } from "@/lib/credit-cache";
import { scopeOf } from "@/lib/scope";
import type { AccountMeta, AppStatus, CreditExpiry, Region } from "@/lib/types";

/** 单个 region 的账号/状态/积分切片。CN 的切片与既有顶层字段同形，便于兼容既有调用方。 */
export interface RegionSlice {
  accounts: AccountMeta[];
  status: AppStatus | null;
  loading: boolean;
  error: string | null;
  creditMap: Record<string, CreditExpiry>;
  creditLoadingMap: Record<string, boolean>;
  refreshingCredits: boolean;
}

/**
 * 一轮积分刷新的结果汇总。
 *
 * 页面需要它来**如实**提示「刷新完成 / 部分失败 / 全部失败」：
 * 此前 `refreshCredits` 只回 `void`，一键刷新即使全部积分都读失败也照样报成功。
 */
export interface CreditRefreshResult {
  /** 本轮实际发起（或复用在途）的账号数。 */
  total: number;
  ok: number;
  failed: number;
  failures: { accountId: string; error: string | null }[];
}

function emptyCreditResult(): CreditRefreshResult {
  return { total: 0, ok: 0, failed: 0, failures: [] };
}

function emptySlice(): RegionSlice {
  return {
    accounts: [],
    status: null,
    loading: false,
    error: null,
    creditMap: {},
    creditLoadingMap: {},
    refreshingCredits: false,
  };
}

/** In-flight credit fetches per region, shared so a remount does not start a second round. */
const creditInflight: Record<Region, Map<string, Promise<CreditExpiry>>> = {
  cn: new Map(),
  global: new Map(),
};
/** 上次发起积分请求的时刻（含失败）：失败条目要按窗口自动重试，不能永久钉死。 */
const creditAttemptAt: Record<Region, Map<string, number>> = {
  cn: new Map(),
  global: new Map(),
};
const statusInflight: Partial<Record<Region, Promise<AppStatus>>> = {};
/** 区域级账号/状态读取的在途 Promise：同一区域的重复挂载复用同一轮。 */
const regionInflight: Partial<Record<Region, Promise<void>>> = {};

function fetchStatus(region: Region): Promise<AppStatus> {
  const existing = statusInflight[region];
  if (existing) return existing;
  const promise = api.getStatus(region).finally(() => {
    statusInflight[region] = undefined;
  });
  statusInflight[region] = promise;
  return promise;
}

async function fetchCreditExpiry(id: string, region: Region): Promise<CreditExpiry> {
  try {
    return await api.getCreditExpiry(id, region);
  } catch (e) {
    return { ok: false, error: api.asError(e) };
  }
}

/** 从整体 state 取出某 region 的切片；CN 复用顶层字段，Global 读 `global`。 */
export function selectRegionSlice(state: AccountsState, region: Region): RegionSlice {
  if (region === "global") return state.global;
  return {
    accounts: state.accounts,
    status: state.status,
    loading: state.loading,
    error: state.error,
    creditMap: state.creditMap,
    creditLoadingMap: state.creditLoadingMap,
    refreshingCredits: state.refreshingCredits,
  };
}

/** 生成 zustand set 所需的局部状态：CN 直接写入顶层，Global 合并到 `global`。 */
function regionPatch(
  state: AccountsState,
  region: Region,
  patch: Partial<RegionSlice>,
): Partial<AccountsState> {
  if (region === "cn") return patch as Partial<AccountsState>;
  return { global: { ...state.global, ...patch } };
}

interface AccountsState {
  // —— CN（保持既有语义，兼容 App/Settings/统计页/钩子等既有调用方） ——
  accounts: AccountMeta[];
  status: AppStatus | null;
  loading: boolean;
  error: string | null;
  creditMap: Record<string, CreditExpiry>;
  creditLoadingMap: Record<string, boolean>;
  refreshingCredits: boolean;
  /**
   * 各区域**最近一次真正发起**积分请求的时刻（ms）——诊断用的「上游最近被打过」。
   *
   * ⚠️ **不要**拿它判断新鲜度：`ensureCredits`（只补未取到 / 上次失败的条目）也写这里，
   * 一个长期失败的账号会让它每 60 秒推后一次，TTL 判据就此恒假。判据读
   * {@link creditFullRefreshedAt}。
   */
  creditRefreshedAt: Record<Region, number>;
  /**
   * 各区域**最近一次覆盖全区的强制刷新**时刻（ms）—— 界面积分 TTL 的唯一判据。
   *
   * 只在「`force` 且本轮目标覆盖该区域全部账号」时写入；部分账号的补取、
   * 单账号刷新都不算（见 `loadCredits` 末尾）。
   */
  creditFullRefreshedAt: Record<Region, number>;
  // —— 国际版 ——
  global: RegionSlice;

  /** 拉取 CN 状态 + 账号（兼容既有语义）。 */
  fetchAll: () => Promise<void>;
  /** 同时拉取 CN 与 Global 的状态 + 账号。 */
  fetchAllRegions: () => Promise<void>;
  /** 仅刷新 CN 状态（兼容既有轮询钩子）。 */
  refreshStatus: (signal?: AbortSignal) => Promise<void>;
  /** 仅刷新指定 region 状态。 */
  refreshRegionStatus: (region: Region, signal?: AbortSignal) => Promise<void>;
  /**
   * 同时刷新 CN 与 Global 的状态。
   *
   * 后台轮询必须走这个入口：`status.current` 决定卡片上的「当前账号」标记，
   * 只轮询 CN 会让国际版的状态停留在首屏快照上——切换国际账号后标记不会跟着走。
   */
  refreshAllStatus: (signal?: AbortSignal) => Promise<void>;
  deleteAccount: (id: string, region?: Region) => Promise<void>;
  /** Fetch credits only for ids not already cached（失败项按窗口自动重试）。 */
  ensureCredits: (accountIds: string[], region?: Region) => Promise<CreditRefreshResult>;
  /** Force-refresh credits. `silent` skips toolbar/card loading flicker (timer). */
  refreshCredits: (
    accountIds: string[],
    opts?: { silent?: boolean; region?: Region },
  ) => Promise<CreditRefreshResult>;
  importLocal: (region?: Region) => Promise<AccountMeta>;
  reconcileAccounts: (region?: Region) => Promise<void>;
}

/**
 * 本地账号先入库，客户端探测在后台完成，避免慢探测阻塞列表首屏。
 *
 * 同区域在途时复用同一轮：账号页每次挂载都会调 `fetchAllRegions`，
 * 不去重时「快速来回切页」会叠出多轮全量读取（每轮都含一次进程探测）。
 */
function loadRegion(region: Region): Promise<void> {
  const existing = regionInflight[region];
  if (existing) return existing;

  const run = (async () => {
    useAccountsStore.setState((s) => regionPatch(s, region, { loading: true, error: null }));
    const results = await Promise.allSettled([
      fetchStatus(region).then((status) => {
        useAccountsStore.setState((s) => regionPatch(s, region, { status }));
      }),
      api.getAccounts(region).then(({ accounts }) => {
        useAccountsStore.setState((s) => regionPatch(s, region, { accounts }));
      }),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    useAccountsStore.setState((s) => regionPatch(s, region, {
      loading: false,
      error: failure?.status === "rejected" ? api.asError(failure.reason) : null,
    }));
  })();

  const tracked = run.finally(() => {
    if (regionInflight[region] === tracked) delete regionInflight[region];
  });
  regionInflight[region] = tracked;
  return tracked;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  ...emptySlice(),
  creditRefreshedAt: { cn: 0, global: 0 },
  creditFullRefreshedAt: { cn: 0, global: 0 },
  global: emptySlice(),

  async fetchAll() {
    await loadRegion("cn");
  },

  async fetchAllRegions() {
    await Promise.all([loadRegion("cn"), loadRegion("global")]);
  },

  async refreshStatus(signal) {
    try {
      const status = await fetchStatus("cn");
      if (!signal?.aborted) set({ status });
    } catch {
      // 后台探测失败时保留最后一次成功状态，下一轮轮询继续尝试。
    }
  },

  async refreshRegionStatus(region, signal) {
    try {
      const status = await fetchStatus(region);
      if (!signal?.aborted) set((s) => regionPatch(s, region, { status }));
    } catch {
      // 保留最后一次成功状态。
    }
  },

  async refreshAllStatus(signal) {
    // 两个 region 各自独立：一个失败不影响另一个（`refreshRegionStatus` 内部已吞掉错误）。
    await Promise.all([
      get().refreshStatus(signal),
      get().refreshRegionStatus("global", signal),
    ]);
  },

  async deleteAccount(id, region = "cn") {
    await api.deleteAccount(id, region);
    creditInflight[region].delete(id);
    creditAttemptAt[region].delete(id);
    set((s) => {
      const slice = selectRegionSlice(s, region);
      const nextCredits = { ...slice.creditMap };
      const nextLoading = { ...slice.creditLoadingMap };
      delete nextCredits[id];
      delete nextLoading[id];
      return regionPatch(s, region, {
        accounts: slice.accounts.filter((a) => a.id !== id),
        creditMap: nextCredits,
        creditLoadingMap: nextLoading,
      });
    });
  },

  async ensureCredits(accountIds, region = "cn") {
    return loadCredits(accountIds, false, false, region);
  },

  async refreshCredits(accountIds, opts) {
    return loadCredits(accountIds, true, opts?.silent === true, opts?.region ?? "cn");
  },

  async importLocal(region = "cn") {
    const res = await api.importLocal(region);
    await get().reconcileAccounts(region);
    return res.account;
  },

  async reconcileAccounts(region = "cn") {
    const { accounts } = await api.getAccounts(region);
    set((s) => regionPatch(s, region, { accounts }));
  },
}));

/** 积分查询的上游并发上限：单账号一次查询会打 3 路资源接口，全并发会对同 IP 形成突发流量。 */
const CREDIT_FETCH_CONCURRENCY = 3;
/** 每个 worker 两次请求之间的间隔，进一步削峰（仅影响多账号批量刷新）。 */
const CREDIT_FETCH_GAP_MS = 120;
/**
 * 失败条目的自动重试窗口（ms）。
 *
 * 一次网络抖动写入 `ok:false` 后，原先的实现会把它当成「已有缓存」，
 * 重新进页面 / 切区域都不再请求 —— 卡片就一直停在「读取失败」。
 * 60 秒足够让瞬时故障恢复，又不会让失败账号变成请求风暴。
 */
const CREDIT_FAILURE_RETRY_MS = 60_000;

/**
 * 同一账号同一时刻只允许一个积分请求。
 *
 * 复用在途请求而不是再发一次：手动刷新、30 分钟自动刷新、页面挂载三处都可能同时
 * 触发同一个账号；并发发两次只会白打上游，还会让后返回的旧结果覆盖新结果。
 */
function fetchCreditOnce(id: string, region: Region): Promise<CreditExpiry> {
  const existing = creditInflight[region].get(id);
  if (existing) return existing;
  creditAttemptAt[region].set(id, Date.now());
  const promise = fetchCreditExpiry(id, region).finally(() => {
    creditInflight[region].delete(id);
  });
  creditInflight[region].set(id, promise);
  return promise;
}

async function loadCredits(
  accountIds: string[],
  force: boolean,
  silent: boolean,
  region: Region,
): Promise<CreditRefreshResult> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return emptyCreditResult();

  const state = useAccountsStore.getState();
  const slice = selectRegionSlice(state, region);
  const now = Date.now();
  const toFetch = ids.filter((id) => {
    /* 在途请求一并「加入」本轮：拿到的就是同一个结果，不再发第二次。 */
    if (creditInflight[region].has(id)) return true;
    if (force) return true;
    const entry = slice.creditMap[id];
    if (entry === undefined) return true;
    if (entry.ok) return false;
    return now - (creditAttemptAt[region].get(id) ?? 0) >= CREDIT_FAILURE_RETRY_MS;
  });
  if (toFetch.length === 0) return emptyCreditResult();

  if (!silent) {
    useAccountsStore.setState((s) => {
      const cur = selectRegionSlice(s, region);
      const creditLoadingMap = { ...cur.creditLoadingMap };
      for (const id of toFetch) creditLoadingMap[id] = true;
      return regionPatch(s, region, {
        creditLoadingMap,
        refreshingCredits: force ? true : cur.refreshingCredits,
      });
    });
  }

  /* 走 `lib/concurrency.ts` 的固定 worker 池（**本仓唯一的批量并发口径**，与账号页的
     批量签到 / 续期 / 成长任务同一份实现）：批量刷新时把「N 账号 × 3 路请求」的瞬间
     并发压到 3 路，单账号刷新仍是一次请求，行为不变。
     ⚠️ 不要在这里再手写一份 cursor + gapMs 的循环 —— 2026-10-23 之前就是那样，两份
     实现一旦要一起改（比如加中止或改间隔）必然漏一边。 */
  const cacheScope = scopeOf("workbuddy", region);
  let results: (CreditExpiry | undefined)[] = [];
  let unexpectedError: string | null = null;
  try {
    results = await mapWithConcurrency(
      toFetch,
      async (id) => {
        const result = await fetchCreditOnce(id, region);
        useAccountsStore.setState((s) => {
          const cur = selectRegionSlice(s, region);
          return regionPatch(s, region, {
            creditMap: { ...cur.creditMap, [id]: result },
            creditLoadingMap: silent ? cur.creditLoadingMap : { ...cur.creditLoadingMap, [id]: false },
          });
        });
        /* 只落成功读数：失败结果不写缓存，否则重启后又会把「读取失败」当成上次读数。 */
        if (result.ok && !api.isDemoMode()) writeCreditCacheEntry(cacheScope, id, result);
        return result;
      },
      { concurrency: CREDIT_FETCH_CONCURRENCY, gapMs: CREDIT_FETCH_GAP_MS },
    );
  } catch (error) {
    /* worker 本应自行吞错；走到这里说明是意外异常 —— 仍然要清干净状态，不能让卡片永远转圈。 */
    unexpectedError = api.asError(error);
  } finally {
    useAccountsStore.setState((s) => {
      const cur = selectRegionSlice(s, region);
      const creditLoadingMap = { ...cur.creditLoadingMap };
      for (const id of toFetch) creditLoadingMap[id] = false;
      return regionPatch(s, region, {
        creditLoadingMap,
        refreshingCredits: silent ? cur.refreshingCredits : force ? false : cur.refreshingCredits,
      });
    });
  }

  const failures = toFetch
    .map((accountId, index) => ({ accountId, result: results[index] }))
    .filter(({ result }) => result?.ok !== true)
    .map(({ accountId, result }) => ({
      accountId,
      error: result?.error ?? unexpectedError,
    }));
  const ok = results.filter((result) => result?.ok === true).length;

  /*
   * 两个时刻分开记，**TTL 判据只读后者**（`lib/use-credit-auto-refresh.ts`）：
   *
   * - `creditRefreshedAt`：任意一轮请求都写（含 `ensureCredits` 只补 1 个失败账号）——
   *   它回答的是「上游最近什么时候被打过」，供诊断。
   * - `creditFullRefreshedAt`：只有**覆盖本区全部账号的 force 刷新**才写。
   *
   * 为什么必须分开：旧实现用单值 + 无条件写入，只要存在一个长期失败的账号，
   * 60 秒一次的重试就会不断把时间戳推后，§12.6 的「距上次 ≥15 分钟 ⇒ 强制全量刷新」
   * 永远不成立 —— 一个看起来在工作、实际上恒假的判据。
   */
  const stampedAt = Date.now();
  const coversRegion =
    force && slice.accounts.length > 0 && toFetch.length >= slice.accounts.length;
  useAccountsStore.setState((s) => ({
    creditRefreshedAt: { ...s.creditRefreshedAt, [region]: stampedAt },
    creditFullRefreshedAt: coversRegion
      ? { ...s.creditFullRefreshedAt, [region]: stampedAt }
      : s.creditFullRefreshedAt,
  }));

  return {
    total: toFetch.length,
    ok,
    failed: toFetch.length - ok,
    failures,
  };
}
