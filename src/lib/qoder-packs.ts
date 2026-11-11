/**
 * Qoder 资源包（积分包）的展示口径 —— issue #111。
 *
 * 单独成文件而不是塞进页面：**状态判定与阈值**是会被两个地方用到的（抽屉列表、
 * 后续的卡片浮层），散落两处必然漂移（本仓已有太多这类教训）。
 */

import type { QoderCreditPack, QoderPacksUnavailableReason } from "@/lib/api";
import type { Translate } from "@/lib/i18n";

/**
 * 「临期」窗口：14 天。
 *
 * ★ 必须与后端 `trae::credits::EXPIRING_SOON_SECS`（14 天）**同值**：同一批数据在
 * 两个产品线给出不同的临期判定，用户会认为工具在乱报。后端那份是 `i64` 秒，
 * 这里是毫秒（前端时间戳统一毫秒）。
 */
export const EXPIRING_SOON_MS = 14 * 24 * 3600 * 1000;

/**
 * 逐包数据的**前端缓存有效期**：60 秒。
 *
 * 为什么需要 TTL：浮层打开即请求、卡片与抽屉都会触发 ⇒ 没有 TTL 的话，同一个账号
 * 会被点一次打一次上游（逐包接口要带会话 Cookie，打多了容易被判异常）。
 * 60s 是「够新鲜」与「别打扰上游」的折中；显式「刷新」按钮走 `force`，不受它限制。
 */
export const PACKS_TTL_MS = 60_000;

/** 包级状态（**行内差异**，不往卡片上挂徽章 —— 卡片是固定版式）。 */
export type QoderPackState = "expired" | "expiring" | "normal" | "zero";

/**
 * 判一个包的状态。
 *
 * `zero`：`limit <= 0` —— 真机上 `plan_quota` 那一条就是这种（套餐额度单独计量），
 * 它的「剩余 0/0」不是「用完了」，所以不能标红。
 */
export function packState(pack: QoderCreditPack, now: number): QoderPackState {
  if (pack.expiresAtMs !== undefined && pack.expiresAtMs <= now) return "expired";
  if (pack.limit <= 0) return "zero";
  if (
    pack.expiresAtMs !== undefined &&
    pack.expiresAtMs - now <= EXPIRING_SOON_MS
  ) {
    return "expiring";
  }
  return "normal";
}

/**
 * 资源包列表的**可见性与顺序**（卡片浮层 / 详情抽屉共用）。
 *
 * - **没有可用额度的包不显示**：`remaining <= 0`（用完）或**已过期**（即使还有剩余）
 *   都剔除。过期包已经不能再用，继续占位只会让「最近到期」排在最前的是一批
 *   不可用的条目；用户真正要看的是现在还能用的包。
 * - **按到期时刻由近到远**：最近到期的排最前；缺到期时刻（长期有效）的排最后。
 *
 * 抽成共享函数而不是两处各写一遍 `map`：顺序/过滤规则一旦分叉，同一账号在浮层
 * 与抽屉里会给出两种列表（本仓已有同类漂移的教训）。
 *
 * `now` 可注入，便于单测/门禁固定时间；生产调用直接用当前时刻。
 */
export function visibleQoderPacks(
  packs: readonly QoderCreditPack[],
  now: number = Date.now(),
): QoderCreditPack[] {
  const expiryOf = (pack: QoderCreditPack): number | null =>
    typeof pack.expiresAtMs === "number" && pack.expiresAtMs > 0 ? pack.expiresAtMs : null;

  return packs
    .filter((pack) => {
      if (pack.remaining <= 0) return false;
      const expiry = expiryOf(pack);
      // `null` = 无到期时刻（长期有效）；有到期时刻且已过 ⇒ 不可用，不保留。
      return expiry === null || expiry > now;
    })
    .sort((left, right) => {
      const leftExpiry = expiryOf(left);
      const rightExpiry = expiryOf(right);
      if (leftExpiry !== null && rightExpiry !== null) return leftExpiry - rightExpiry;
      if (leftExpiry !== null) return -1;
      if (rightExpiry !== null) return 1;
      // 两者都无到期时刻：保持后端原序（现代 JS 的 sort 是稳定排序）。
      return 0;
    });
}

/** 上游 `source` 取值 → 本地化标签。未知取值兜底成「资源包」，**不显示原始枚举串**。 */
export function packSourceLabel(
  t: Translate,
  source: string | undefined,
): string {
  switch (source) {
    case "PLAN":
      return t("qoder.page.accounts.web.sourcePlan");
    case "RESOURCE_PACKAGE_SOURCE_BONUS":
      return t("qoder.page.accounts.web.sourceBonus");
    case "RESOURCE_PACKAGE_SOURCE_DEDICATED":
    case "DEDICATED":
      return t("qoder.page.accounts.web.sourceDedicated");
    default:
      // 上游可能新增取值：给通用名，别把 `SOME_NEW_ENUM` 直接怼到用户脸上。
      return t("qoder.page.accounts.web.sourceOther");
  }
}

/**
 * 「拿不到逐包」的原因 → 统一的说明与下一步动作。
 *
 * ★ 浮层与详情抽屉**共用这一份**：两边各写一套时，已经出现过「未登录却显示
 * 『已登录，读取逐包明细』」的文案漂移。`action` 只表达**该引导用户做什么**：
 * - `login`：没有会话 / 会话过期 / 登错账号 ⇒ 先登录网页端；
 * - `read`：上游抖动 / 未知 ⇒ 用已有会话再读一次。
 */
export interface PackUnavailableCopy {
  title: string;
  hint: string;
  action: "login" | "read";
}

export function packUnavailableCopy(
  t: Translate,
  reason: QoderPacksUnavailableReason | undefined,
): PackUnavailableCopy {
  switch (reason) {
    case "no_session":
      return {
        title: t("qoder.page.accounts.web.state.noSession"),
        hint: t("qoder.page.accounts.web.state.noSessionHint"),
        action: "login",
      };
    case "session_expired":
      return {
        title: t("qoder.page.accounts.web.state.expired"),
        hint: t("qoder.page.accounts.web.state.expiredHint"),
        action: "login",
      };
    case "session_mismatch":
      return {
        title: t("qoder.page.accounts.web.state.mismatch"),
        hint: t("qoder.page.accounts.web.state.mismatchHint"),
        action: "login",
      };
    case "upstream":
      return {
        title: t("qoder.page.accounts.web.state.upstream"),
        hint: t("qoder.page.accounts.web.state.upstreamHint"),
        action: "read",
      };
    default:
      return {
        title: t("qoder.page.accounts.web.state.unknown"),
        hint: t("qoder.page.accounts.web.state.unknownHint"),
        action: "read",
      };
  }
}
