/**
 * 账号「需要注意」的**唯一判定**（页头计数 / 状态分桶 / 排序提示共用）。
 *
 * ## 为什么抽成独立模块
 *
 * 此前页头「{m} 个需处理」只数 `needsRelogin`（`AccountsPage` 里一行 `filter`），
 * 而工具栏「按状态」分桶认三种异常（需重新登录 / 凭据已过期 / 今日未签到）。
 * 两者口径不同 ⇒ 会出现「0 个需处理」而列表里躺着「凭据已过期」分组这种自相矛盾的画面。
 *
 * 抽出来之后，两端调同一份实现，「需处理」与分桶**不可能**再漂移。
 *
 * ## 两档语义（不要合并）
 *
 * - `attentionOf` = **列表分桶**用：三类异常各归其桶，用于「我该看哪个」。
 * - `needsManualAttention` = **页头计数**用：只算**用户必须人工介入**的凭据类问题。
 *
 * 签到与成长任务**故意不计入页头**：它们有一键按钮（`quickCheckinAll` /
 * `quickCompleteAll`），机器能自己做完的事不该变成页头上一个永远不归零的数字。
 * 凭据过期 / 需重新登录则必须由人重新登录，无法自动修复 —— 这才是「需处理」。
 */

/** 分桶用的异常类别；`null` = 正常。 */
export type AttentionKind = "needsRelogin" | "expired" | "notCheckedIn";

/** 判定所需的账号字段（只取判定用的，避免依赖 `AccountMeta` 全量）。 */
export interface AttentionInput {
  needsRelogin?: boolean;
  /** 凭据到期时间戳（毫秒）；`null` / `undefined` = 长期有效。 */
  expiresAt?: number | null;
}

/**
 * 分桶判定。优先级即返回值顺序：需重新登录 > 凭据已过期 > 今日未签到。
 *
 * `todayCheckedIn` 为 `undefined` = **状态未知**（还没查回来）⇒ 不判为未签到。
 * 把「不知道」当「未签到」会让一屏账号在首查回来前集体闪进「今日未签到」桶。
 */
export function attentionOf(
  account: AttentionInput,
  todayCheckedIn: boolean | undefined,
  now: number,
): AttentionKind | null {
  if (account.needsRelogin) return "needsRelogin";
  if (typeof account.expiresAt === "number" && account.expiresAt < now) return "expired";
  if (todayCheckedIn === false) return "notCheckedIn";
  return null;
}

/**
 * 页头「需处理」判定：**只算凭据类**（需重新登录 / 已过期）。
 *
 * 与 {@link attentionOf} 的关系：这里是它的子集，去掉「今日未签到」这一档。
 * 两个函数同源，改判定时只改这一处。
 */
export function needsManualAttention(account: AttentionInput, now: number): boolean {
  const kind = attentionOf(account, undefined, now);
  return kind === "needsRelogin" || kind === "expired";
}
