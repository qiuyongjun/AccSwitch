import { CalendarCheck, Trophy, type LucideIcon } from "lucide-react";

/**
 * 语义图标注册表 —— **一个概念一枚图标**，跨入口、跨状态一律复用。
 *
 * ## 为什么需要这一层（2026-10-23 用户截图反馈）
 *
 * 同一个「签到」此前有四枚图标：页头「一键签到」`CalendarCheck`、批量条「批量签到」与
 * 卡片「已签到」`CircleCheck`、菜单「刷新签到状态」`Sparkles`、菜单「今日已签到」裸 `Check`；
 * 「成长任务」有三枚：页头「一键完成」`CheckCheck`、批量条与菜单「完成任务」`Trophy`、
 * 卡片「可自动 N」`Sparkles`。后果不是「不好看」，而是图标**不再传递信息**：
 *
 * - `Sparkles` 同时代表「刷新签到状态」与「成长任务自动完成」；
 * - `CircleCheck` 同时代表「已签到」「使用中 N 个工具」「客户端限流正常」。
 *
 * 用户在同一屏里看到同一概念的三种画法，会怀疑它们是不是三件不同的事。
 *
 * ## 规则（新增入口照此办理，不要再各挑一枚「看起来也行」的）
 *
 * 1. **图标只编码概念，不编码状态与作用域**：动作入口（一键 / 批量 / 单账号菜单）、
 *    状态徽章、刷新项，只要说的是同一个概念，就用同一枚图标；
 * 2. **状态差异交给文字与底色**：与 `account-card.tsx` 里徽章底色的既定口径同源
 *    （底色只回答「要不要动手」，做到哪一步由文案说明）；
 * 3. **一枚图标只服务一个概念**：`CircleCheck` 退回通用「正常」语义（工具数、限流正常），
 *    不再兼职签到；`Sparkles` 退回「AI / 生成」语义，不再兼职任务。
 *
 * ## 为什么是常量而不是各处各自 import
 *
 * 各文件直接 `import { CalendarCheck }` 一样能编译，但下一个人读到的只是「这里有枚日历」，
 * 不知道它是**约定**还是随手挑的 —— 漂移就是这样发生的。走常量后：换图标只改一行，
 * 且 `grep CheckinIcon` 能立刻枚举全部影响面。
 *
 * ⚠️ 这两个名字是**值**（Lucide 组件），可直接 `<CheckinIcon />`，也可当 `icon:` 字段
 * 传给以 `LucideIcon` 为类型的表（如 `account-menu-parts.tsx` 的刷新项）。
 *
 * ⚠️ **作用域**：本轮只落 WorkBuddy 侧（2026-10-23 用户定：先专注 WB 界面，Trae / Qoder
 * 后续同步）。Trae 卡片 chip 与 Qoder 状态 chip 仍是各自旧口径，别当成缺口顺手改 ——
 * 中间态清单见 `docs/specs/GROWTH-TASKS.md` §6「本轮作用域」。
 */
export const CheckinIcon: LucideIcon = CalendarCheck;

/** 成长任务（领取 / 一键完成 / 摘要徽章 / 任务页签）的统一图标。 */
export const GrowthTaskIcon: LucideIcon = Trophy;
