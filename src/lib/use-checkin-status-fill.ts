import { useEffect, useRef } from "react";

import type { CheckinStatusEntry } from "@/lib/api";

/**
 * 单批账号数上限（与后端各平台的 `STATUS_MAP_MAX_ACCOUNTS` 一致）。
 *
 * 后端对超出部分**静默截断**（不报错），所以「一次传 80 个」会有一半账号拿不到
 * 读数且没有任何提示 —— 切片只能由调用方做。
 */
export const CHECKIN_STATUS_BATCH_SIZE = 50;

export interface CheckinStatusFillOptions {
  /** 是否允许发起请求（账号未就绪 / 该区域未开放签到时为 `false`）。 */
  enabled: boolean;
  /** 参与补取的账号 id；顺序无关。 */
  ids: readonly string[];
  /**
   * 作用域标识（区域 / 本地日期）。
   *
   * 变化即视为**新的一轮**：同一账号在新作用域下允许再补一次
   * （跨日、切区域后不能沿用上一轮「已尝试」的记账）。
   */
  scopeKey?: string;
  /** 该账号是否仍需要补取（通常 = 「还没有可信的上游读数」）。 */
  needsFetch: (id: string) => boolean;
  /** 批量只读取数；本 hook 已按 {@link CHECKIN_STATUS_BATCH_SIZE} 切片，调用方直接透传即可。 */
  fetchMap: (ids: string[]) => Promise<Record<string, CheckinStatusEntry>>;
  /**
   * 合并读数。**只包含 `ok:true` 的条目** —— 读失败不当成「今天没签」的事实。
   */
  onEntries: (entries: Record<string, CheckinStatusEntry>) => void;
  /** 逐条验收：返回 false 的条目被丢弃（用于「响应已被更新的写入取代」）。 */
  accept?: (id: string, entry: CheckinStatusEntry) => boolean;
  /** 一批请求开始（用于在途记账，避免同一账号被抽屉 / 首屏各打一轮）。 */
  onFetchStart?: (ids: string[]) => void;
  /** 一批请求结束（成功 / 失败都会调用）。 */
  onFetchSettled?: (ids: string[]) => void;
  /** 组件已卸载等「结果已过期」场景返回 true，用于丢弃响应。 */
  isStale?: () => boolean;
}

/**
 * 打开账号页时**只读**补齐逐账号签到状态（`*_checkin_status_map`）。
 *
 * ## 为什么不放在进页面时无条件全量拉
 *
 * 这是逐账号的上游查询（N 个账号 = N 次请求）。补齐只发生在「页面挂载 + 账号就绪」
 * 这一刻，且每个账号在每个作用域内**最多一次**：失败不重试、不打扰，用户仍可手点
 * 「刷新签到状态」。这样三端（Trae / WorkBuddy / Qoder）的取数节奏完全一致。
 *
 * ## 失败为什么不能当「未签到」
 *
 * 后台补齐是尽力而为：网络 / 上游限流随时可能失败。把失败写成 `false` 会让界面把
 * 「不知道」画成「今日未签到」—— 正是本 hook 要消除的那类误报。因此只有
 * `ok:true` 的条目会被合并；`ok:false` 由显式刷新（用户动作）负责呈现原因。
 */
export function useCheckinStatusFill(options: CheckinStatusFillOptions): void {
  /* 回调 / ids 每次渲染都是新身份，放进 effect 依赖会让它每帧重跑；
     效果只由「账号集合变化 / 开关变化 / 作用域变化」驱动，其余读最新一次渲染的值。 */
  const latest = useRef(options);
  latest.current = options;
  /** 本挂载内已尝试过的 `作用域:id`。先记账再发请求 ⇒ 重渲染不会变成重试风暴。 */
  const attempted = useRef<Set<string>>(new Set());
  const idsKey = options.ids.join(",");

  useEffect(() => {
    const current = latest.current;
    if (!current.enabled) return;
    const scope = current.scopeKey ?? "";
    const pending = current.ids.filter(
      (id) => !attempted.current.has(`${scope}:${id}`) && current.needsFetch(id),
    );
    if (pending.length === 0) return;
    for (const id of pending) attempted.current.add(`${scope}:${id}`);

    for (let start = 0; start < pending.length; start += CHECKIN_STATUS_BATCH_SIZE) {
      const batch = pending.slice(start, start + CHECKIN_STATUS_BATCH_SIZE);
      current.onFetchStart?.(batch);
      void current
        .fetchMap(batch)
        .then((map) => {
          if (current.isStale?.()) return;
          const accepted: Record<string, CheckinStatusEntry> = {};
          for (const [id, entry] of Object.entries(map)) {
            if (!entry?.ok) continue;
            if (current.accept && !current.accept(id, entry)) continue;
            accepted[id] = entry;
          }
          if (Object.keys(accepted).length > 0) current.onEntries(accepted);
        })
        .catch(() => {
          /* 后台补齐失败静默：界面保持「未知」，用户仍可手点刷新。 */
        })
        .finally(() => current.onFetchSettled?.(batch));
    }
    // 只认「账号集合 / 开关 / 作用域」三种变化；其余（回调身份）走 `latest`。
  }, [idsKey, options.enabled, options.scopeKey]);
}
