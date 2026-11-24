# Qoder 平台 — 事实梳理与建模决策

> 用途：把「Qoder 作为第三个平台接进 AccSwitch」需要的事实与决策固定下来，
> 作为原型评审与后续实现改造的依据。
> 状态：**原型已落地，项目代码未动**（等确认）。
> 边界：本文只写**事实**与**本仓的决策**；不写任何外部参考实现的出处。

---

## 1. 这个平台是什么

阿里出品的 AI 编程 IDE，产品名 **Qoder**，走**双区域**：

| | 国内版 | 国际版 |
|:---|:---|:---|
| 官网 | `qoder.com.cn` | `qoder.com` |
| 开放接口基址 | `https://openapi.qoder.com.cn` | `https://openapi.qoder.sh` |
| 推理网关 | `https://gateway.qoder.com.cn` | `https://api1.qoder.sh`（另有 api2 / api3 故障切换） |
| OAuth 客户端 id | `1c5e33e1-…-acaa81274a5c` | `e883ade2-…-f92ceff5fdcb` |
| 回调 | `qoder-work-cn://` | `qoder://aicoding.aicoding-agent/login-success` |
| CLI 本地目录 | `~/.qoder-cn/` | `~/.qoder/` |
| 桌面 App 目录 | `%APPDATA%\com.qodercn.app.stable\` | `%APPDATA%\com.qoder.app.stable\` |

**结论：双区域是「一个平台内的两个 realm」，不是两个平台。**
⇒ 在本仓建模为**一个 `Product` + 两个 `Scope`**（`qoder-cn` / `qoder-global`），
与 WorkBuddy / Trae 的区域处理方式一致。

---

## 2. 账号模型

一个 Qoder 账号的关键字段（用于推导卡片与抽屉要展示什么）：

| 字段 | 含义 | 备注 |
|:---|:---|:---|
| `uid` | 账号唯一 id | 由上游 `user_id` 给出；无 uid 时按来源生成兜底 id |
| `nickname` | 昵称 | |
| `domain` / `realm` | 归属域名 / 区域 | `cn` 或 `intl` |
| `accessToken` | 访问令牌 | 前缀 `dt-`（设备流）或 `jt-`（jobToken） |
| `refreshToken` | 刷新令牌 | 前缀 `drt-` / `jrt-`，按前缀决定走哪个刷新端点 |
| `personalToken` | PAT（长期兜底） | 前缀 **`pt-`** |
| `expiresAt` | 过期时刻 | ★ 2026-10-27：落盘值可能是秒（本机导入原样抄上游）或毫秒（刷新/OAuth 写入）；**所有读取方统一走 `qoder::account::normalize_expiry_ms`**，下发给前端的 `account_view.expiresAt` 恒为 Unix 毫秒或 `null` |
| `source` | 来源 | `oauth` / `pat` / `desktop-app`（本机导入） |
| `credits` / `plan` | 额度快照 / 套餐名 | |
| `lastCheckin` | 最近签到 | ★ 2026-10-29：本工具签到成功时写入本地盖章（`YYYY-MM-DD HH:MM:SS`），`account_view` 同时下发 `lastCheckin` / `lastCheckinToday`（盖章是否今天）—— 仅作前端签到状态的**初值**（与 Trae 的 `checkedToday` 同口径），真值仍以上游 `claimStatus` 为准 |
| `userType` | 用户类型 | 默认 `personal_professional_trial` |
| `organizationId` / `organizationName` | 组织 | |

**令牌家族（前缀语义）**：`pt-`（PAT，长期）→ 交换得到 `jt-`/`jrt-`；
设备流登录得到 `dt-`/`drt-`。刷新按前缀路由：`drt-` 走 deviceToken 刷新、
`jrt-` 走 jobToken 刷新、都失败则回落 PAT。
⇒ 与本仓既有「凭据类」处理同构：**刷新看 `refresh_token`，可用性看 `access_token`**。

★ 2026-11-16：签到 / 额度等请求在 access token 缺失、临近过期或上游返回 401/403 时
会**自动续期并重试一次**（`qoder::refresh::ensure_access_for` + 请求内重试）。
只有确实无法续期（无刷新令牌 / 无 PAT / 刷新被拒）时，才提示用户重新登录或重新导入。

---

## 3. 凭据存储形态（官方两处）

| 来源 | 路径 | 加密 |
|:---|:---|:---|
| **桌面 App** | `%APPDATA%\com.qoder[.cn].app.stable\auth.v1.dat` | Chromium `v10` 布局 + **AES-256-GCM**；密钥来自同目录 `Local State` 的 `os_crypt.encrypted_key`，剥 `DPAPI` 前缀后经 **DPAPI** 解出 32 字节 AES key |
| **Qoder CLI** | `~/.qoder[.cn]/.auth/user[.{profile}]` | **AES-128-CBC**，`key = iv = machine_id 前 16 字符`；兼容以 `{` 开头的明文形态 |

桌面 App 的明文 schema：
`{ schemaVersion, token(dt-), refreshToken(drt-), expiresAt, user:{ id, name, email } }`。

⚠️ **两类都要支持，且要分开报「未检测到」与「读不出」**（同本仓既有的空态二分纪律）。

### 3.1 macOS 与 Windows 是**两套**密钥来源（issue #81，2026-09-23 真机取证）

| | Windows | macOS |
|:--|:--|:--|
| 桌面 userData 目录 | `%APPDATA%\com.qoder[.cn].app.stable\` | `~/Library/Application Support/com.qoder[.cn].app.stable\`（**叶子名与 Windows 逐字相同** ⇒ `dirs::config_dir()` 直接可用，无需按平台分叉） |
| 主密钥来源 | 同目录 `Local State` 的 `os_crypt.encrypted_key`（DPAPI 解出） | **登录钥匙串**：macOS 的 `Local State` 实测只有 `{"uninstall_metrics":…}`，**没有 `os_crypt`** |
| 钥匙串条目 | — | 国内版 `svce="Qoder CN App Safe Storage"` / `acct="Qoder CN App Key"`；国际版 `svce="Qoder Safe Storage"` / `acct="Qoder Key"`（`security dump-keychain` 实测） |
| blob 算法 | `v10` + 12B 随机 nonce + AES-256-GCM | `v10` + AES-128-CBC，key = `PBKDF2-HMAC-SHA1(口令, salt="saltysalt", iter=1003, len=16)`，**IV 固定 16×0x20 不写进文件**，PKCS7 |
| CLI 凭据 | `~/.qoder[.cn]/.auth/user`（加密或明文） | 同左；实测 `~/.qoder-cn/.auth/` **只有 `machine_id`、没有 `user`** ⇒ CN 的 CLI 不落盘凭据，登录态由桌面端注入 |

★ **服务名按区域不同**（国内版 Electron 应用名是 `Qoder CN App`，国际版是 `Qoder`）⇒
收进 `region::RealmSpec.macos_keychain_service` 表字段，读写两侧（`profile` 导入 /
`switch` 切换）同表取值。曾经两侧都硬编码国际版的 `"Qoder Safe Storage"`，国内版在
macOS 上永远查不到钥匙串条目 ⇒ 解密失败 ⇒ 「桌面端检测不到 / 切换不了账号」（issue #81）。

> 读钥匙串会触发系统授权弹窗（一次性，用户点「始终允许」后不再打扰）；
> `security` 调用必须带超时（本仓 `vscode_cn_inject` 已按 10s 上限执行）。

---

## 4. 能力清单

| 能力 | 有 | 说明 |
|:---|:---:|:---|
| 每日签到领积分 | ✅ | 走**活动平台**：`GET /sash/api/v1/me/campaigns` → 筛 `CLAIM_BENEFIT` + `CLAIMABLE` → 逐个 `POST …/{id}/claim`，累加 Credits；已领 ⇒ 幂等「今日已领」。旧 `/sash/daily-check-in` 只在**整区没有活动平台**（404/405/410）时兜底。三档语义不变：**没有积分类活动 ⇒ 未开放（`ok:false` + `disabled`）**，不谎报成功。★ 2026-11-19 真机复验（国内版 3 账号）：上游对部分账号**不下发**每日积分活动（列表只剩「首次订阅福利」这类 `VIEW_DETAILS`，`claimable:false`），此时本仓**无项可领**，界面按「不可签到」呈现（2026-11-24 起，此前误画成「今日未签」）并引导去官方客户端核对 —— 见 §4 下方「签到的两种 `NONE`」 |
| 积分 / 额度查询 | ✅ | quota/usage + 套餐快照；顶层 `expiresAt`（Unix **毫秒**，SDK References 口径）驱动卡片 / 抽屉的「X 积分 … 到期」。⚠️ 上游用 **9999-12-31**（`≥ 253402214400000` ms）当「不过期」哨兵：`parse_quota` 把它归成 `expiresForever`（`expires_at = None`），界面统一写「长期有效」，**不**把哨兵渲染成日期（2026-10-29 用户报障） |
| Pro 福利包 | ❌ | **未实现**：`PATH_PRO_CLAIM` 只有常量定义、零调用点（issue #58 第 1 阶段一并落地） |
| OAuth 设备授权 | ✅ | **PKCE S256**；两区 URL 参数不同（国内带 `redirect_uri`，国际不带） |
| PAT 导入 | ✅ | 前缀 `pt-`，导入后自动交换 jobToken |
| API 网关 | ✅ | OpenAI 兼容（Chat Completions / Responses）+ **Anthropic 兼容**（`/v1/messages`） |
| 定时调度 | ✅ | `ScheduleTask::{QoderCheckin, QoderKeepalive}`：逐账号**顺序**执行（并发会踩风控）。判据与 Trae 两条同源 —— 签到默认**关**（替用户去领东西，opt-in），保活默认**开**（维持用户交出来的 `refresh_token`）；入口在 Qoder 设置页「计划任务」 |
| 会话复制 | ❌ | **不实现** —— 会话复制依赖客户端自身的会话存储与云端归属，当前只有 WorkBuddy 桌面具备 |
| 自动旅行 | ❌ | WorkBuddy 独有 |

⇒ 原型里的 `capabilities` = `["checkin", "credits", "oauth", "gateway"]`。

**刷新性能（2026-11-16）**：活动列表有 20 秒进程内缓存（只读路径命中、领取绕过、
领取后失效）；单账号额度与套餐并行查询；首屏额度用跨重启展示缓存占位（2026-11-17 起
**不再**标注「上次读数 · N 分钟前」，与 WB 同口径：逐卡时间戳与页头同步重复）。
缓存不参与排序 / 优先级。

**签到的两种 `NONE`（2026-11-19，用户报障「一键刷新一直显示签到刷新中」）**：

状态行里 `status = "NONE"` 有两个原因，**界面必须分开画**（后端以 `stale` /
`campaignMissing` 两个布尔透出，`status` 取值不变）：

| 原因 | 字段 | 含义 | 界面 |
|:--|:--|:--|:--|
| 列表落后于时钟 | `stale: true` | 该切新一轮了，上游还是上一轮 | 「签到刷新中」（再刷**可能**变） |
| 上游没下发签到活动 | `campaignMissing: true` | 200 正常答复，列表里没有积分类活动 | 「不可签到」（再刷也**不会**变） |

- 真机取证（2026-11-19 10:35，国内版）：3 个账号里 2 个的活动列表只有
  「首次订阅福利」（`VIEW_DETAILS` + 金额 0 + `CLAIMED`），`claimable:false`；
  带原生机器头（`runtime-info`）与不带，结果一致 ⇒ **不是**缺机器头，也不是
  「还没刷新完」。第 3 个账号同一时刻能看到 `CLAIMABLE` 的「每天领 100 Credits」
  （`startAt` = 当天 10:00）⇒ 服务端**按账号**做定向，这部分不可控
  （2026-11-20 归因：缺入口的那个账号已过试用期，属「试用期外不再发放积分」一档，见下节）。
- 因此 `campaignMissing` 时本仓**无项可领**：卡片徽章 / 抽屉写「不可签到」（2026-11-24
  用户要求 —— 官方客户端没有入口，画成「今日未签」会让用户反复点签到）；界面单账号入口
  禁用，批量 / 一键**前端直接跳过**（不发 claim），计入「不可签到」（结果条
  「以下账号不可签到：…」，原因一句「官方未下发签到活动…」），不谎报成功。
- 若**本仓**当天已领过（本地台账盖章），同一份空列表不得把「刚签成功」读回「未签」——
  `checkinEntryOf` 会在这一档用台账补正布尔值并标 `source: "ledger"`。

**判据同源（2026-11-19，用户报障「一键签到显示成功，刷新又显示未签」）**：

「这个账号今天有没有签到活动」**只有一个判据** —— `campaign::is_checkin_item`
（积分类 `benefit.kind` **且** `classify != View`）/ `has_checkin_activity`。
三处必须同源：窗口推导（`window_from_items`）、状态行（`campaign_entry` 的
`campaignMissing`）、领取路径（`checkin_for` 的 `ok`）。

- 领取路径曾单独写「只看 `is_credit_kind`」⇒ 「首次订阅福利」（`VIEW_DETAILS` + 0 元）
  被当成签到活动，一份**无可领项**的答复被判成 `ok:true`：toast 弹「已签到 N 个账号」、
  `lastCheckin` 没盖章，刷新后卡片如实写「今日未签」。真机取证：3 个账号一键签到后
  只有 1 个落章（`accounts.cn.json` 的 `lastCheckin`），另两个即此形态。
- 上游**领完会撤掉活动** ⇒ 重复点签到拿到的空列表与「未下发」不可区分，唯一例外是
  本地台账：`ledger_says_checked_in(has_benefit=false, stamped_today=true)` 回
  `ok:true` + `ledgerAlready:true`（`normalize_campaign_claim` 映射成旧契约的
  `already:true` ⇒ toast 说「今日已签到」，不说「签到成功」）。没盖章时仍走 `disabled`。

**「客户端里没有签到入口」= 列表里没有该条目，不能据此推断封号（2026-11-19 15:58 对照取证）**：

同一时刻、**同一套请求头**（含 `cosy-clienttype/version`，**不带** `cosy-machine*`）
分别拉三个国内版账号的 `/sash/api/v1/me/campaigns`：

| 账号 | `showCampaign` | `campaigns` 条目 |
|:--|:--|:--|
| qiuyongjun | `true` | 仅 `act-20261020-008`「首次订阅福利」（`VIEW_DETAILS` / `CLAIMED`） |
| nick7663489616 | `true` | 同上 |
| nick9550841228 | `true` | `act-20261116-166`「每天领 100 Credits」（`CLAIM_BENEFIT` / `CLAIMED`，`startAt` = 当天 10:00）+ 上条 |

结论（可直接引用）：

- **不是**请求头 / 解析 / 封禁问题：`showCampaign: true`、`campaignUrl` 正常
  （`gateway.qoder.com.cn/growth-page/activity-iframe`），同一套头对第 3 个账号能拿到条目
  ⇒ 差异在**账号维度**，由服务端决定发不发那一条。
- 客户端「签到入口」就是成长页 iframe 内嵌的这份列表 ⇒ 列表里没有该条目，客户端自然没有入口。
  「没有入口」与「账号被封」是两件事，前者不能推出后者。
- 当时把差异归因为「同机多号共享每轮一次额度」（官方桌面端一台机器只登一个账号）——
  **该归因已于 2026-11-20 被真机实测证伪**，设备的数量不构成限制，见下节。
  正确的解释是账号侧资格差异：`campaigns` 发不发那一条由服务端按账号决定。
- 界面（2026-11-19）：这一档不再只写「今日未签」。卡片 / 表格徽章的 tooltip、抽屉签到区、
  批量签到结果条三处都补原因。理由：只有一枚「未签」时用户会反复点签到 —— 既拿不到，
  又持续命中同一条规则。
- 界面（2026-11-24，用户要求）：徽章本身改画**「不可签到」**（`QoderCheckinDisplay =
  unavailable`，上游 `active === false` 档），不再写「今日未签」；抽屉概览 / 签到页签
  同步这一档，签到按钮禁用并显示「不可签到」。账号级判据顺序：`notStarted` →
  `checked` → `refreshing` → `unavailable` → `unchecked`（`stale` 的列表 `active`
  也是 `false`，必须先判成「刷新中」）。
- 文案（2026-11-24 同日用户反馈）：旧版原因句太长（展开设备数 / 规则生效时间），
  统一改成**一句结论 + 一句去处**：「官方未下发签到活动（如账号已过试用期），重试无效；
  可到官方客户端查看。」徽章 tooltip 更短（不写「再刷新也不会变」）；结果条标题直接用
  「以下账号不可签到：…」。
- 界面（2026-11-24，区域级补齐）：旧通道 404/405/410 时状态行带 `unavailable: true`
  （缺行时用页面布尔兜底）—— 同样画**「不可签到」**（卡片 / 表格 / 菜单 / 抽屉），
  不再落回「凭据可用」或「签到状态读取失败」；没有可签账号时「一键签到」随之禁用。
  判据因此是两级：行 `unavailable` 优先于 `ok:false`，账号级 `active === false` 在
  窗口/已签/刷新中之后。
- 批量（2026-11-24）：`campaignMissing` / 整区未开放的账号**前端直接跳过**（不发 claim），
  计入「不可签到」；`active === false` 但仍有活动（名额锁定 / 待领）的一档保留尝试 ——
  晚些可能恢复。回执原因只有 disabled **全部**是 `campaignMissing` 时才用资格解释，
  混档（含 legacy DISABLED / 区域未开放）改用通用句。

**纠正：设备不构成限制，发放按账号（2026-11-20 用户真机实测）**：

同一台设备、同一天，Qoder 客户端先后登录三个国内版账号：

| 账号 | 客户端成长页入口 | 本仓「一键签到」 |
|:--|:--|:--|
| A | **有** | **成功**（领到） |
| B | **有** | **成功**（领到） |
| C | 无 | `campaignMissing`（卡片「不可签到」；批量回执「不可签到」） |

⇒ 三条结论（可直接引用）：

1. **同设备同日可签多个账号**：一台设备、一轮窗口内领到 2 份 ⇒
   「一台设备只放行一个账号」「同机多号共享每轮一次额度」**均不成立**。本仓批量签到的
   行为也印证这点：逐账号都真实发了领取请求，第二份**没有**被上游拦成
   `SAME_PERSON_ALREADY_CLAIMED`。
2. **唯一判据是上游有没有下发那一条活动**（`campaign::is_checkin_item`）：下发 ⇒ 客户端
   有入口、本仓能领；没下发 ⇒ 两边都没有。设备数、机器指纹、登录先后都解释不了这个差异。
3. **缺失的原因在账号侧**：用户观察，**2026-11-19 起 Qoder 调整积分规则 —— 试用期外的
   账号不再发放积分**；C 正属这一档。⇒ 2026-11-19 那两次对照（3 个账号只有 1 个有入口、
   换设备仍无入口）的合理归因是**账号资格差异**，不是「被当作后续账号排除」的跨设备标记。

⚠️ 未证实 / 不要写进用户文案：
- 试用期状态对应上游哪个字段（`userType` / 套餐有效期 / 组织？）尚未确认。若能读到，
  界面可在「未下发」旁给出更准的原因；当前只能写「本轮没有下发」。
- 规则的生效时间与适用范围（是否只国内版、是否波及其他福利活动）以官方公告为准；
  本文只记录用户实测到的时点。

操作含义（替换 2026-11-19 的三条）：
- 批量签到会**跳过**已知无入口的账号（`campaignMissing` / 整区未开放），直接计入
  「不可签到」；其余照实跑。**不要**为「省额度」限制同机账号数、也**不要**为此换设备
  或分机器签。
- 缺入口先看账号资格（试用 / 套餐是否仍有效），再去官方客户端成长页核对；
  换设备、换网络、反复点签到都不会让它出现。
- 仍然成立的一条：`already`（今日已签）与「本轮真领到」必须分开计数 —— 与设备规则无关，
  是回执口径问题（见下节）。

**批量回执的口径（2026-11-19 同日修复）**：批量签到的「成功 N」**只算本轮真领到**；
`already`（今日已签，可能在另一台设备 / 更早领过）单独成「今日已签 M」徽标与描述。
混算会让「两台机器各签一个」被读成「同一台机器签上两个」—— 2026-11-19 正是这种读法
把归因带偏到「设备限额」上，2026-11-20 才被实测纠正（见上节）。
见 `CheckinResultBar.alreadyCount` 与 `runCheckin` 的 `roundOk` / `roundAlready` 分家。

---

## 5. 模型清单（三层优先级）

1. **动态接口**（官方此刻为准）> 2. **本机官方客户端目录缓存** > 3. **双区官方快照文件**。

- 清单**以动态源返回的集合为准**：静态快照独有的条目**不外塞**。
- 官方 `enable = false` 的条目**不过滤**，但要附**官方原文的禁用原因**。
- 模型条目可用的属性：官方模型名（客户端唯一需要填的值）、上游 key、别名、
  本地化名、上下文多窗口（如 200K 默认 / 400K / 1M）、思考档位
  （low/medium/high/xhigh/max + 默认标注 + 可关闭）、**峰谷价**
  （谷时时段 22:00–08:00）、`is_free` / `is_new`。

**双区独占**（区域独占模型必须路由到归属出口，错配要拦）：

| | 独占 |
|:---|:---|
| 国内版 | `q37fmodel`、`gm51model` 一类 |
| 国际版 | `ultimate`、`performance`、`efficient`、`smodel`、`cmodel` 一类 |

⇒ 与本仓「**授权页两轴**（域按区域 / 钥匙按产品线）」同源：Key 出口与模型区域
不匹配时必须给**通俗 400**，不能把上游的晦涩拒流原样透出去。

---

## 6. 设备指纹

以账号自身 uid **稳定派生**专属机器标识（machineId / machineToken / machineType /
sessionId）。目的：同一账号长期固定在同一台「虚拟物理设备」上，**多账号之间天然隔离**，
避免被按机器身份关联风控。

⚠️ 派生值是**兜底**：官方桌面端拉活动前会调自带风控桥取**真机器身份**；
用派生假值时活动列表会**静默少条目**（设备定向活动直接不出现）。
⇒ 实现时「真值优先、派生兜底」并**在状态里标注用了哪种**，不要静默降级。

---

## 7. 网关与 API Key

- 多 API Key 并行；**每个 Key 可绑定独立出口**（国内版 / 国际版 / 跟随全局）。
- 面板密码与 API Key **完全独立**（密码以 PBKDF2-SHA256 摘要保存，不存明文）。
- Key 出口与模型区域不匹配 ⇒ 通俗 400。

⇒ 与本仓既有网关三态动作（吊销 / 恢复 / 删除）**同形**，可直接复用既有 UI 与命令。

### 7.1 推理端点必须带 `?Encode=1`（真机取证 2026-10-17）

`agent_chat_generation` 的请求体是 `cosy::qoder_encode` 过的**自定义 base64**；上游只按
URL query `Encode=1` 决定「先解码再按 JSON 解析」还是「直接按 JSON 解析」。

带编码体打**裸路径**时上游**不发 4xx**：它先回 `HTTP 200`，再在流里补三行**非信封错误帧**
（`event:error` / Jackson `JsonParseException` 堆栈 / `{"success":false,"msgCode":500}`），
客户端侧表现为「空回答 + 0 token」，网关日志表现为「200 / 0 token / error:null」。

⇒ 两处纪律（issue #46 的修复即此二条）：

1. **签名路径与发送路径分开**：`PATH_CHAT_SSE`（签名，无 query）/
   `PATH_CHAT_SSE_ENCODED`（发送，带 `Encode=1`），与 `PATH_MODELS_SIGN` /
   `PATH_MODELS_ENCODED` 同一约定；
2. **非信封错误帧不得 Skip**：`api::unwrap_non_envelope_error` 按保守白名单判成
   `ChatFrame::UpstreamError`（只认 `event:error` / `success:false` / 非 0 且非 2xx 的
   `code`·`msgCode` / 非空 `error` / Java 异常转储），正常 delta 与 `event:finish`
   一类计时元数据仍 Skip。

### 7.2 流式链上的**泄漏回声守卫**（issue #46 的 A 项，2026-10-18）

文本模式下历史里的工具调用会被序列化成 `<LEAK_MARKER>` + JSON 数组塞进正文，模型很可能
**原样回声**。非流式 `sse::aggregate` 末尾用 `api::parse_leaked_tool_calls` 还原，而
**流式中继是逐帧透传的** ⇒ 泄漏文本直接打到客户端界面。

⇒ 三条纪律（`sse::LeakGuardStream`）：

1. **接入点固定在 `QoderOpenAiStream` 之内、`UsageTapStream` 之外**：
   - 不改 `QoderOpenAiStream::new` 的签名（8 处调用点零改动）；
   - `aggregate` 内部自建流、**不经过**本层 ⇒ 结构上不可能被还原两次
     （两次会各生成一组随机 id 的 `tool_calls`，客户端会把同一组工具**执行两遍**）。
2. **判错一律 fail-open**：标记写一半 / 超过 64 KiB / 不是合法回声 ⇒ 原样透传。
   唯一例外是**剥正文**：`Recovering` 且上游已给结构化 `tool_calls` 时**不合成第二组**，
   但**仍必须剥掉回声正文** —— 「不双发」与「不泄漏」是两件事，合成不了就整帧放行
   等于把标记原样还给用户。
3. **合成形状对齐 Anthropic 侧读法**（*实现时读 `anthropic::push_tool_call` 发现的协议约束，非评审要求*）：`[anthropic::push_tool_call]` 读
   `delta.tool_calls[i].index` 且 `unwrap_or(0)` ⇒ 合成帧必须逐个带 `index`；
   `finish_reason` 必须落在上游 usage 帧**之前**，否则 Anthropic 侧补不出 usage。

> **评审指引（归属披露）**：`#46` 的 A/B/C/D 四项修复分处
> `5f6c52a`（A 守卫）/ `7fca77d`（B 白名单）/ `803c727`（C 用量页）/
> `de932d7`（D 签到后端与共用组件）。⚠️ **D 的页面层主体**
> （`runCheckin` 的三档分流 + `skippedNames` 透传，改 `QoderAccountsPage.tsx`）
> 与两条 i18n 词条落在并行会话的 `cdb54b2` —— 评审 D 时请连同该 commit 一起看，
> 不要只翻 `de932d7`。

---

## 8. 在本仓的建模决策

| 维度 | 决策 | 理由 |
|:---|:---|:---|
| 平台数 | **+1 个 `Product`**（`qoder`），不是两个 | 双区域是 realm，不是产品 |
| 作用域 | `qoder-cn` / `qoder-global` | 与 `wb-*` / `trae-*` 同构 |
| 程序位 | **2 个**：`Qoder 桌面版` / `Qoder CLI` | 对应官方**两处**凭据存储；程序位名**不含区域**（区域由作用域承担） |
| 能力 | `checkin` / `credits` / `oauth` / `gateway` | 无 sessionCopy / travel / autoRotate / snapshot / group |
| 图标 | 圆环 + 内环 + 右下短尾（几何「Q」） | 与 WB 菱形、Trae 三角同族但可区分 |
| 强调色 | `oklch(0.68 0.15 245)`（蓝） | 与 WB 绿、Trae 紫区分 |

### 待拍板 / 待核实

1. **CN 客户端的展示名**。官方国内版 UA 是 `QoderWork/1.1.64`、国际版是 `Qoder/1.1.64`；
   桌面 App 目录是 `com.qodercn.app.stable`。原型暂按既有惯例写作
   **`Qoder CN` / `Qoder`**（与 `Trae CN` / `Trae`、`WorkBuddy` / `WorkBuddy AI` 同构）。
   若确认国内版客户端正式名是 `QoderWork`，改名只动 `UNI_NS` 一处。
2. **程序位命名**：原型用 `Qoder 桌面版` / `Qoder CLI`。若官方另有正式名（如
   「Qoder IDE」），按官方名改。
3. **签到奖励数值**：按「每日领取 100 Credits」取 `checkinReward = 100`。
4. **是否要做「峰谷价 / 思考档位 / 多上下文窗口」的展示**：原型**未做**（模型表只有
   名称 / 协议 / 归属 / 上游状态 / 网关暴露五列，三平台同构）。要做的话是**三平台一起加**，
   不能只给 Qoder 加 —— 否则就是「同一件事两个做法」。

---

## 9. 原型落点（本次改动）

**拆分形态**（`docs/prototype/index.html` + `demo.css` / `demo-data.js` / `demo-app.js`，门禁跑的就是它）

- `demo-data.js`：`MARK.qoder`、`PLATFORMS.qoder`、`SCOPES["qoder-cn"|"qoder-global"]`、
  `USAGE[...]`、`GATEWAY[...]`、`PROXY.domains` 加 `qoder.com.cn`。
- `demo-app.js`：全局快捷键 `⌘1–4` 放宽到 `⌘1–9`（6 个作用域后 `⌘5`/`⌘6` 原本静默失效）。

**单文件形态**（`docs/prototype/buddy-switch-prototype.html`，双击即看）

- 与拆分形态同一批数据改动。
- 额外：**统一入口**的命名空间表（`UNI_NS` / `UNI_CATALOG` / 默认启用集 /
  Key 授权集 / 报错文案 / 页面提示）补上 `qoder-cn` / `qoder-global`
  —— 它们属于**派生层**（平台 × 区域），真实实现里由 `Scope::all()` 自动生成。

**顺带修掉的既有缺陷**：备份页每个作用域行**都没有名字**
（`BACKUP_SECTIONS` 取 `SCOPES[id].label`，而 `SCOPES` 条目只有 `platform` + `region`
⇒ `esc(undefined)` 归成空串，`aria-label` 也退化成「全选 」）。
修法：把「平台名 + 区域名」的拼装下沉到数据层的 `scopeDisplayName`，
`BACKUP_SECTIONS` 与 `demo-app.js` 的 `scopeLabel` 共用它。

---

## 10. 门禁与验证

| 验证器 | 覆盖 | 结果 |
|:---|:---|:---|
| `verify-demo.cjs` | 拆分形态契约 | **37 / 0** |
| `verify-behaviors.cjs` | 拆分形态行为 | **124 / 0** |
| `verify-qoder-prototype.cjs`（新增） | **单文件形态**（此前无任何自动化覆盖） | **13 / 0** |

被钉死的断言里，原先硬编码「4 个作用域」的四处已同步为 6
（作用域菜单项数、备份分区行数、全不勾选导出、合并口径逐日求和、days 末值表）。
**断言一律写死数字，不拿 `Object.keys(SCOPES).length` 对拍** —— 后者与被测物同源，恒真。

变异验证（注入缺陷 ⇒ 期望变红 ⇒ 还原核 sha256）：

- 拆分形态 4 组：days 末值脱钩 / 备份分区退回硬编码 4 个 / 区域标签错位 / 备份页名字退回空串 —— **全部命中且还原无残留**。
- 单文件形态 3 组：区域标签错位 / 统一入口漏命名空间 / 备份页名字退回空串 —— **全部命中且还原无残留**。

---

## 11. 后续项目代码改造的清单（**等确认后再动**）

1. `crates/buddy-switch-core`：新增 Qoder 模块（账号池、令牌刷新按前缀路由、
   双区常量、签到/额度、模型清单三层、指纹派生）。
2. 新增 `Product::Qoder` + `Scope::QoderCn/QoderGlobal`；`Scope::all()` 自动多出两个作用域
   ⇒ 统一网关命名空间**自动出现**。
3. `src/lib/platforms/registry.ts`：加 `qoder` 描述符 + `PlatformSlug`；
   `src/lib/scope.ts` 的 `SCOPES` 从 4 条变 6 条
   ⇒ **`scripts/check-scope-registry.cjs` 里写死的「4 个作用域」会变红，必须同步**。
4. 网关：Qoder 产品线（配置 / 密钥库 / 状态 / 路由 / OpenAI + Anthropic 双协议）。
5. 两处宿主（`buddy-switch-server/main.rs` + `src-tauri/lib.rs`）的命令注册 +
   `BackgroundTask` 登记（**两侧各一份表，新增周期性出口先 grep 两侧**）。
6. 前端：程序位、凭据导入方式（OAuth / PAT / 本机导入）、模型清单展示。
7. **命名空间护栏**：解析只做整段精确匹配；测试输入必须含「比基准长一截」的形状
   （如 `qoder-cn-x`），否则前缀实现与精确实现在现有输入集上等价、断言恒绿。

---

## 12. 网页端逐资源包明细（issue #111，上游 2026-10-27 落地；本仓 2026-11-11 移植）

**数据源**：`GET {website}/api/v2/me/usages/big_model_credits`。该接口只认浏览器登录后的
会话 Cookie；openapi 的设备令牌（`Bearer dt-…`）实测一律 401。因此逐包链路**不能**复用
`/api/v2/quota/usage` 的鉴权，必须单独走网页会话。

**链路**：

1. 桌面端打开独立登录窗（`src-tauri/src/qoder_web.rs`），载 `{website}/account/usage`；
2. 用户登录一次后，用 `Webview::cookies_for_url()` 收割 Cookie（关窗前 + 窗口存活时两处读取，
   都要求 async command + 独立线程，Windows 同步调用会死锁）；
3. Cookie 暂存进程内存 → `qoder_web_credit_packs_probe` 认领并校验 `user_id`（fail-closed：
   归属不符即丢弃）→ 成功后才写入 `web_session.{cn|global}.json`；
4. 渲染路径 `qoder_web_credit_packs` 只读已认领会话，解析 `quota_detail` 的逐包行
   （`expires_at` 毫秒/秒都归一，`0`/缺失 = 无到期）；
5. 会话缓存 7 天（`web_session::MAX_AGE_MS`），绑定 uid；Cookie 与账号库同防护等级
   （0600 + 原子写），**不导出、不进备份、不进日志、不进错误消息**；
6. 国际版按 IP 判地区，逐包取数支持按区域配置出站代理（`qoder/proxy.json`，
   `qoder_web_proxy_get/set`），代理只作用于逐包请求，登录窗走系统代理。

**降级**：拿不到逐包时**回落聚合额度行**，并在抽屉/浮层按结构化原因引导
（`no_session` / `session_expired` / `session_mismatch` / `upstream`）；headless 服务端返回
「仅桌面端可用」，**绝不返回空包列表**冒充「该账号没有资源包」。

**代码**：`qoder/web_usage.rs`（协议与解析）、`qoder/web_session.rs`（缓存）、
`qoder/web_proxy.rs`（按区域代理）、`src-tauri/qoder_web.rs`（登录窗与命令）、
`src/components/qoder/qoder-packs-popover.tsx`、`src/pages/QoderCreditsPage.tsx`。
