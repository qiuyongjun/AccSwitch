# 成长任务中心（Growth Tasks）

> 状态：现行 · 2026-10-22 落地
>
> 代码：[`crates/buddy-switch-core/src/modules/growth_tasks.rs`](../../crates/buddy-switch-core/src/modules/growth_tasks.rs)
> UI：[`src/components/growth-tasks-panel.tsx`](../../src/components/growth-tasks-panel.tsx)（账号详情抽屉「任务」页签）

WorkBuddy 成长中心的「任务」不是靠「真的做一遍」，而是靠**客户端行为事件上报**点亮：
`POST /v2/report` 收一批 `eventCode`，服务端按事件加进度，达标后可领奖。

本模块把其中**纯事件即可点亮**的 11 个任务做成「一键完成」。它不写数据库、不改账号结构、
不产生本地状态 —— 唯一的产出是向上游发事件与领奖。

---

## 1. 三条必须记住的事实

| # | 事实 | 踩错的后果 |
|:--|:--|:--|
| 1 | **不同任务认不同客户端指纹** | 事件照收 200，但**静默不计数** ⇒「上报成功但进度不动」 |
| 2 | **上报 200 ≠ 计分**，且计分**异步**（实测 5–8 秒） | 一次性回读会误判「未达标」，从而跳过自动领奖 |
| 3 | **领奖端点在 Web 域** | 打 chat 域会一直 400 `task not completed`（路径本身不存在） |

`accept`（报名）**不产生进度**，只把任务状态改成 `accepted`。行为事件才是唯一判据。

---

## 2. 指纹矩阵（最容易错的一张表）

| 用途 | 域 | 关键头 / 载荷特征 |
|:--|:--|:--|
| 任务列表 / 报名 | `copilot.tencent.com` | `x-client-platform: web` + `Origin`/`Referer`（成长中心页） |
| **计分上报**（`chat_request_send`） | `www.codebuddy.cn` | 无平台头；`userId` 必填（缺失时上游 200 但丢弃） |
| **桌面端事件链** | `copilot.tencent.com` | `User-Agent: WorkBuddy/5.5.6 …` + `X-Product: SaaS` + 每个事件带 `extName: workbuddy-desktop` 指纹 |
| **Web 端页面事件** | `www.workbuddy.cn` | `x-client-platform: web` + 浏览器 UA + `os: Win32` / `machineId` |
| **领奖** | `www.workbuddy.cn` | 任务码在**路径**里、无 body、`x-client-platform: web`、`Referer: /profile/growth-center` |

`machineId` / `sessionId` 由 `sha256(salt + ":" + uid)` 派生 36 位 hex（`derive_device_id`）：
**同一账号必须每次都是同一台设备**，否则每轮事件都是「新设备行为」。

---

## 3. 已覆盖的任务与判据

动作注册表是唯一事实来源：[`ACTIONS`](../../crates/buddy-switch-core/src/modules/growth_tasks.rs)
（顺序即执行顺序）。

| 任务码 | 判据（上游认的事件） | 本模块做法 |
|:--|:--|:--|
| `chat_5` | 累计 5 条 `chat_request_send` | 按**差额**逐条补报（不是每次补满 5 条）；`target` 缺失按 5 兜底 |
| `first_buddy` | 前置活跃 + `buddy/agreement` + `buddy/first` | 上报一次 → 同意协议 → 领养 |
| `RichMeow_Chat` | 桌面对话事件链，需 `chat_message_response.isSuccessful=true` | 6 事件完整链（含成功回执） |
| `Buddy_App` | `buddyapp` 五连：discover→show→enter→auth_confirm→bind_skip | 用「企鹅教师助手」作载体 |
| `Buddy_App_QQ` | 同上，且应用必须是企鹅教师助手 | **同一组事件**同时满足两个任务 |
| `automation_1` | `automated_task_create_suc` | 单事件 |
| `Library_read` | Web 域 `web_element_click`（`library_doc_intro_click`） | 单事件（Web 指纹） |
| `template_5` | chat 链 + `agent_task_created_with_template` + `template_used` | 按差额发 1–5 组，且从第 `current` 个模板起取（不重发已计过数的） |
| `playbook_prompt` | chat 链 + `web_element_click` + `playbook_cta_click` + `playbook_prompt_send` | 一组事件 |
| `create_canvas` | `wbx_design_canvas_task_create` + `wbx_design_canvas_open` | 一组事件（+300 分） |
| `Hp_Appearance` | `appearance_skin_apply`（**不是** `appearance/set`） | 先调 set 留痕，再发生效事件；**会真实改掉账号主题且不还原**（上游无可读接口） |

### 刻意不做

| 任务 | 原因 |
|:--|:--|
| `expert_5` / `Expert_team_use_3` / `Expert_lighthouse` / `skill_1` / `Model_chat_GLM5.2` | 需**真实 chat** 并从 SSE 抓服务端 `requestId`，会消耗额度 |
| `Expert_Philanthropy` | 需真实捐款回执，无法绕过 |
| `black_cat` | 已由 [`cat.rs`](../../crates/buddy-switch-core/src/modules/cat.rs) 独立实现（夜间窗口判定 + 限额） |
| `school_season` / `Sequential_Tasks_*` | 小程序口径专属任务，已由 [`school.rs`](../../crates/buddy-switch-core/src/modules/school.rs) 覆盖 |
| Global（`www.workbuddy.ai`） | 国际版没有这套成长体系，`ensure_supported` 直接返回可读错误 |

---

## 4. 执行流

```
list_tasks ──► 批量 accept（未报名的 autoable 任务；失败写进 results，不静默）
                    │
                    ▼
        对每个动作（ACTIONS 顺序）
                    │
        claimed / locked ──► 跳过
                    │
        已在达标态 ──► 直接 claim（不点亮、不回读）
                    │
        同组事件本轮已发过 ──► 只回读 + 领奖（不重发）
                    │
              run_action（发事件）
                    │
        回读任务（未达标则轮询 4 次 × 2.5s）
                    │
        达标 ──► claim（Web 域；404/405 回落 chat 域）
```

设计取舍：

- **异步计分必须有轮询**。`task_by_code_waiting` 的预算是「首次立即 + 3 次间隔 2.5s」，
  总预算约 7.5 秒 —— 覆盖实测 5–8 秒的落定窗口，又不至于把命令拖成一分钟。
- **轮询期查询失败不覆盖已拿到的结果**：上游抖动不该让整步失败。
- **单项失败不阻断后续**：不同任务的判据宽严不一，一项踩空不该让整轮白跑。
- **已在达标态的任务当场就领**。曾经的写法是记一条「待领取」然后跳过，结果用户点完
  「一键完成」还得再点一次「领取全部」—— 函数名承诺的事必须一次做完。
  ★ 2026-10-23 起更进一步：`run_auto_for` 末尾多一步**收尾**，把**不在 `ACTIONS` 里**
  （本工具点亮不了的手工任务）但已达标未领的奖励也一并领掉 —— 前端已把「领取全部」
  并进「一键完成」（见下），后端若不补齐，合并后的按钮在「只有手工任务可领」的账号上
  会看起来什么都没做。`growth_tasks_claim_all` 命令与 HTTP 路由保留（CLI / 脚本仍可用），
  前端不再调用。
- **同组事件只发一次**（`fired`）：`Buddy_App` 与 `Buddy_App_QQ` 共用一组五连事件，
  而循环用的是**初始任务快照**，不记已发动作就会把同一批事件发两遍。重复事件不加进度，
  只白白放大风控面；第二个任务码改为只回读 + 领奖。
- **报名失败要显形**。`accept` 不产生进度，但「没报名」可能让后续事件不算分。
  失败写进 `results`（而不是 `let _ =` 丢弃），成功后留 800ms 再发首条事件。
- **任务码白名单**：任务码直接拼进 URL 路径，`claim_task_for` 只接受
  `[A-Za-z0-9_.-]{1,64}`（上游码含点号，如 `Model_chat_GLM5.2`）。webui 支持
  `--host 0.0.0.0` 部署，不校验等于让带用户 Bearer 的请求可以打任意路径。
- **主题副作用不假装**。`Hp_Appearance` 会改掉账号主题；上游只有 `appearance/set`、
  没有「读当前主题」的接口 —— 读不到原值就还原不了，故在 `ACTIONS.desc` 与结果文案里
  明示「不会还原」，不做静默副作用。**若上游日后提供读接口，应改为读→改→还原。**
- **同账号互斥**（`RunningGuard`）：两轮并行会各自回读、各自领奖，且第一轮的事件会
  把第二轮的差额算乱。
- **`claim_all` 与 `auto` 分开**：领奖无副作用，点亮有（发事件、调主题 API）。
  用户只想收奖励时不该被迫再发一遍事件。

---

## 5. 幂等

| 层 | 机制 |
|:--|:--|
| 任务级 | 执行前先回读：`claimed` / `locked` / 已达标一律跳过 |
| 差额级 | `chat_5` / `template_5` 按 `target - current` 决定发几条，不是每次发满；**`target` 缺失（上游返 0）时按 5 兜底**（`effective_target`） |
| 模板级 | `template_5` **从第 `current` 个模板开始取**（`template_window`），不从头重发 —— 见下方「踩过的坑」 |
| 上游级 | 领奖重复调用返回 `already_claimed`（`credit/energy = 0`），按正常态处理、不报错 |
| 行为级 | 行为事件按天幂等（上游侧），重复上报不重复扣资源 |

### 踩过的坑：`template_5` 卡在 4/5

现象：每次点「一键完成」都提示「已上报 1 组模板使用事件（进度 4/5…）」，进度永远不动。

原因有两处，都在载荷而不是链路：

1. **从头重发**。旧代码 `templates.iter().take(count)`，差额为 1 时永远取第 1 个模板；
   上游按**不同模板**累计，重发已计过数的那个不会加进度 → 每次都在空转。
   改为 `template_window(current, need, total)` 后当场 5/5 并领到 +100。
2. **载荷自相矛盾**。`agent_task_created` 被写死 `has_template: false` + `template_name: ""`，
   同一组里却又带 `template_used`。「这条对话是用模板发起的」是判据，两处说法不一，
   服务端只会取更保守的结论。现已由 `mark_template_origin` 补上
   `has_template: true` / `action: "template"` / `template_name`。
3. **漏了 `target` 兜底**。参考实现 `runChat5` 里有一句 `if target <= 0 { target = 5 }`，
   移植时没带过来。上游不下发 `target`（返回 0）时 `need = (0 - 0).max(0) = 0`，
   再被 `.max(1)` 压成 1 ⇒ 每点一次只涨 1 点进度，用户要连点四五次才完成。
   现由 `effective_target` 兜底（只对 `chat_5` / `template_5` 兜成 5，不套用一次性任务）。

> 教训：**发出去 200 只代表事件被收下，不代表被计分**。凡是「按次数累计」的任务，
> 都要先问一句「重发同一个实体上游还会不会加数」；凡是「按差额补」的实现，
> 都要问一句「差额算错时会不会**静默少发**」—— 静默少发比报错难查得多。
>
> 参考库在 `template_5` 上**没有**这两个坑：它每轮无条件发满 5 组、且 `chat_5` 自带
> `target` 兜底。上面 1、3 两条都是本仓为「省几次请求」自行引入的偏差，不是上游变化。

---

## 6. 卡片提示标签（四态）

每个账号的成长任务基本只有**一次**机会 —— 用户不可能记住「哪个号还没领」。所以摘要在
**账号卡片 / 表格**上就要能看见，而不是必须逐个点开抽屉才知道。

### 四态（2026-10-23 用户反馈后扩展）

| 摘要 | 渲染 | 强调 |
|:--|:--|:--|
| `claimable > 0` | 徽章「可领 N」 | **warning 底**（同「今日未签到」） |
| `autoable > 0` | 徽章「可自动 N」 | **warning 底**（同「今日未签到」） |
| `claimed < total` 且无可做项 | 徽章「已领 x/y」 | **success 底**（同「已签到」） |
| `claimed >= total` | 徽章「任务已完成」 | **success 底**（与上一态**同底**） |
| `ok:false` / 未扫到 / `total = 0` | **不渲染** | — |

扩展前一共有「可领 / 可自动」两种状态，其余一律整枚不渲染 ⇒ 卡上没有标签时，
「已完成」「没扫到」「该账号没有成长体系」三种情况无法区分（用户读不出答案）。
现在有 `ok` + `total` + `claimed` 兜底，只剩「失败 / 不支持」不渲染。

底色只分**两档**（2026-10-23 用户定稿）：底色回答「要不要动手」——
有事可做 ⇒ `warning`（与「今日未签到」同一提醒语义）；无需行动 ⇒ `success`（与「已签到」同形）。
两种非行动态**共用同一个底色**，只换文字（已领 13/16 / 任务已完成）——
若两态各用一种底色，会被读成两种不同的紧急度。
也不再为「可领 / 可自动」各配一种颜色：一屏四个相近色块反而分不清轻重，区别交给文字。

### 图标：一个概念一枚（2026-10-23 用户截图反馈后统一）

四态**共用** `GrowthTaskIcon`（`src/lib/semantic-icons.ts`，当前是 `Trophy`）——
「已签到」同理由 `CheckinIcon`（`CalendarCheck`）承载。此前四态用了
`Trophy`（可领）/ `Sparkles`（可自动）/ 裸 `Check`（已完成）/ 无图标（已领）四种画法，
加上「签到」在页头是 `CalendarCheck`、批量条与卡片是 `CircleCheck`、菜单是 `Sparkles` /
裸 `Check`，一屏里同一概念有三四种画法 ⇒ 图标不再提供信息，只提供噪声
（`Sparkles` 同时代表「刷新签到状态」与「任务自动完成」）。

规则三条：

1. **图标只编码概念**，不编码状态与作用域：动作入口（页头一键 / 批量条 / 单账号菜单）、
   状态徽章、下拉里的刷新项，只要说的是同一个概念就用同一枚图标；
2. **状态差异交给文字与底色**（与上面「底色只分两档」同一口径）；
3. **一枚图标只服务一个概念**：`CircleCheck` 退回「工具数 / 限流正常」这类通用「正常」语义，
   `Sparkles` 退回「AI / 生成」语义。

新增入口一律从 `semantic-icons.ts` 取图标，不要在各文件里 `import { Trophy }` ——
后者能编译，但下一个人分不清它是约定还是随手挑的，漂移就是这样发生的。

#### 本轮作用域：只落 WorkBuddy（2026-10-23 用户定稿）

用户当前只优化 WorkBuddy 的界面与交互，Trae / Qoder 后续同步，**这一轮不动它们的
平台专属代码**（`trae-account-card.tsx` 的状态 chip 与菜单、Qoder 的 `QoderStatusChips`
保持原样：`CircleCheck` / 纯文字）。

由此产生一个**已知的中间态**，别当成新缺口去「顺手修」：

| 面 | 归属 | 现状 |
|:--|:--|:--|
| 页头一键、批量条、单账号菜单、卡片/表格徽章、刷新组、成长任务面板 | WB（含 `account-workbench.tsx` / `account-batch-bar.tsx` / `account-menu-parts.tsx` 这些三平台共用壳） | 新口径 |
| Trae / Qoder 的批量条与刷新组 | 共用壳 | **跟着变成新图标**（同一个组件，不按平台分叉） |
| Trae 卡片 chip、Qoder 状态 chip | 各自平台文件 | 旧口径（`CircleCheck` / 纯文字） |

即：另两个平台暂时是「动作入口已换、状态 chip 未换」。同步时只需改各自的卡片组件，
共用壳不用再动。

### 点击标签 → 抽屉「任务」页签

标签可点（卡片与表格同一组件），直接打开详情抽屉并落在「任务」页签。
入口页签只对**本次打开**生效，**不写入**「上次停留页签」的记忆 ——
点标签去看任务 ≠ 把偏好改成「停在任务」（记忆只记用户在抽屉里主动切页签，见 issue #49）。

### 为什么是「一次批量扫描 + 落盘缓存」而不是每张卡各查一次

每张卡各查一次 = 打开账号页就打 **N 次**上游（20 个号就是 20 次），且每次进页面都打。
现在的形状：

| 环节 | 行为 |
|:--|:--|
| 页面挂载 | 一次 `growth_tasks_scan`（全量，账号间串行 + 400ms 限速） |
| 后端缓存 | `~/.buddy-switch/growth_tasks_cache.json`，TTL **10 分钟**；命中即**零上游请求** |
| 跑完任务 | 只 `force` 刷**那一个账号**（`accountId`），不重扫全表 |
| 取不到 | 该账号**不出现在结果里** ⇒ 不挂标签（绝不写「可领 0」） |

### 三个计数器互斥

`claimable > autoable`：可领的任务**不再**算作「可自动」。否则一张卡会同时挂
「可领 1」「可自动 1」，用户点进去只看到同一个任务，会以为标签在乱报。
`locked` 的任务两个都不进（点了也没用）。

### 抽屉任务页签：总控只有一个按钮（2026-10-23，2026-10-26 改名）

「任务」页签顶部原本有「领取全部」+「一键完成」两枚总控按钮，用户要自己判断点哪个。
现在合并成**一枚「完成任务」**（2026-10-26 用户要求改名：与卡片菜单、批量条同一动作同名，
「一键」只描述便利性、没说明它做什么）：

- **语义**：能领的全领 + 能点亮的全点亮（后端 `run_auto_for` 一次做完，前端不编排两次请求
  —— 两次请求之间的失败会让「领了一半」没人负责）；
- **可用性**：`可领 > 0` **或** `可自动 > 0` 即可点（任一为真）；
- **文案**：`autoHint` 明说「先领取已达标奖励，再逐任务上报行为事件」，不然用户仍会去找
  那个已经消失的按钮；
- 行内的单任务「领取」按钮保留 —— 它是**就地**领某一个任务的快捷路径，与总控不冲突。

### 卡片菜单的「完成任务」

卡片 / 表格行的「更多」菜单（`account-more-menu.tsx`）账号组里有一项「完成任务」，
走的是与抽屉「完成任务」**同一个** `growth_tasks_auto`，省掉「点开卡片 → 切到任务页签」
的路径。没有可领 / 可自动任务时该项**禁用**（不隐藏，用户能找到它在哪）；摘要还没扫到
（`growthHint` 缺失）时同样禁用，但原因文案是「稍后再试」—— 不把「不知道」当成「没有」。
国际版不注入该动作 ⇒ 菜单里不出现此项。

★ 2026-10-26（用户要求）：**全部任务完成**（`claimed ≥ total`）时，该项变成与
「今日已签到」同一形状的状态行 —— 绿色 `GrowthTaskIcon` + 中性文案，而不是一枚被
`opacity-50` 灰掉的禁用项；「只剩手工任务」不等于 100%，仍走普通禁用态。

★ 2026-10-26：结果判定与文案**收在一处**（`AccountsPage.completeTasksOnce` →
`CompleteTasksOutcome`），卡片菜单与批量共用同一份四态 `done / progressed / skipped / failed`。
在此之前菜单只看 `claimed`，把「行为事件已上报、奖励未达标」（`progressed`）报成
「本次没有可完成或可领取的任务」—— 与抽屉同一动作的说法相反。

### 批量条的「完成任务」

勾选账号后，批量条（`account-batch-bar.tsx`）出现「完成任务」，与单账号菜单的「完成任务」共用
扫描 / 筛选 / 执行 / 汇总（`completeTasksFor`），差别只在作用域：只对**勾选账号**执行，
没有可做任务的账号计入「跳过」，而不是照样打上游换回一串失败。国际版不注入该动作。

⚠️ 2026-10-26（用户要求）：页头「一键完成」已删除（成长任务低频，不值得占一枚页头按钮），
因此**「完成任务」现在只有两个作用域**：批量条（勾选）与单账号菜单 / 抽屉。

摘要可能落后于真实状态（后端缓存 TTL 10 分钟），所以「跳过」在**执行层**再判一次：
后端回读后确认无事可做（结果全是 `skipped`）的账号同样计入跳过 —— 不把「本来就已完成」
报成一次完成。`progressed` 单独计数（「已上报进度，奖励尚未达标」），既不并进「完成」
也不并进「跳过」。没有领到任何奖励时给 info toast；其中含 `progressed` 时说明用
「已上报进度…」而不是「没有可完成的任务」。

### 刷新组里的「刷新任务」（2026-10-23 引入，2026-10-26 统一）

**单账号菜单与批量条的下拉里都有这一项**，文案同为「刷新任务」，来自同一个组件
`components/account-menu-parts.tsx` 的 `RefreshTasksItem`（只由 **WB·CN** 注入；
国际版没有成长体系，不渲染该项）。

- 位置：刷新组**内部**、积分 / 签到 / 凭据之后，**无分隔线**。它和那三项一样是只读重扫
  （`growth_tasks_scan`），不是另一个动作族；把它放到分隔线下面会读成「写操作」。
- 它**不是** `AccountRefreshKind`：那个类型描述的是「重读某一层现成数据」的接口级语义，
  而它是「重扫上游任务摘要」。差异只在类型层面 —— 展示上两者同组。
- 2026-10-26 之前批量条叫「刷新成长任务状态」、单账号叫「刷新任务」，且分处不同分隔线两侧。
  用户要求两边同步后合并为一项，名称统一为「刷新任务」。

**扫描策略：对所选（或单个）账号逐个 `growth_tasks_scan(scope, { force: true, accountId })`。**

为什么不用一次全量扫描（一键刷新用的就是全量）：
- 全量扫描会把**它扫到的全部账号**摘要一起写回来，包括**没勾选**的那些 ⇒ 越界更新。
  用户会看到自己没动的卡片从「可领 1」变成「已领 2/2」，而他从没点过那张卡。
- 批量条的动作边界是「**所选**账号」（见 `docs/specs/PLAN.md` §3.4 的三方职责表），
  作用域越界比多打几次上游更糟。

失败口径：某账号拿不到摘要（非 CN / 上游 `ok:false` / 抛错）计入失败；
**全部失败**才报 error，部分成功仍算成功但把失败数写进描述 —— 不把「一半没刷到」报成已完成。

### 页头「一键签到」的可用性（2026-10-26 起只剩这一枚页面级动作）

页头一键动作（`AccountsPage.tsx`）按**账号状态**收口，点不动的按钮写明原因（悬停提示）：

| 按钮 | 禁用条件 | 未知状态怎么办 |
|:--|:--|:--|
| 一键签到 | 全部账号的今日签到都**已知为已签** | 保持可点（不把「不知道」当成「已签」） |
| 两枚共通 | 当前作用域**没有账号**；或另一项一键动作正在跑（含一键刷新） | — |

⚠️ 「一键完成」的按钮与 `growthKnownAll` / `growthActionable` 判据已于 2026-10-26 随按钮一并删除。
成长任务的执行入口改为：批量条「完成任务」、单账号菜单「完成任务」、抽屉「任务」页签。

页头的「未知」与卡片菜单口径不同：菜单只影响一张卡，页头动作本身能补扫，锁死会让用户没有出路。

### 刷新时机（缺一条就会出现「刚领完还说可领」）

1. 页面挂载 → 非强制扫描（多半命中缓存）；
2. 抽屉里跑完「完成任务 / 领取」→ 面板 `onChanged` → 抽屉 → 页面
   `refreshGrowthHint(accountId)`，只刷这一张；
3. 卡片菜单跑完「完成任务」→ 刷该卡的摘要 + 积分（领到的奖励直接落在积分上）；
4. 切换作用域 → `scope` 变化触发重扫（Global 直接跳过 —— 没有成长体系）；
5. 用户显式刷新：**一键刷新**走全量 `force` 扫描；**批量条与单账号菜单的「刷新任务」**走
   「所选（或单个）账号逐个 `force`」（见 §6）；卡片 / 表格的「刷新任务」只更新该卡片的
   「可领 / 可自动」标签，不执行任何任务；
   **抽屉里的两个 ⟳ —— 指标卡的「任务」卡与「任务」页签 —— 是同一个动作**
   （`AccountsPage.refreshGrowthAccount`，2026-10-26 统一）：一次点击**同时**
   走「本账号 `force` 重扫摘要」与「重拉任务列表」，两边共用一个忙态（同时转圈 /
   禁点）和一条回执。此前两处各刷一半（指标卡只重扫摘要、页签只重拉列表），
   同一个「刷新」在两处给出不同结果 —— 其中摘要重扫复用第 2 条的
   `refreshGrowthHint(accountId)`；页签入口把列表 `reload` 传给页面，页面**先等待摘要
   重扫，再等待列表重拉**，两路都成功才报成功。顺序不能反过来或并行：列表可能先于
   强制摘要扫描完成，从而把旧值重新画回来。指标卡入口没有已挂载列表，只重扫摘要。

---

## 7. 两宿主接线（刻意不去重）

| 层 | 桌面端 | webui |
|:--|:--|:--|
| 命令 / 路由 | `commands.rs::growth_tasks_*` | `api.rs::api_growth_tasks_*` |
| 路径 | Tauri `invoke` | `POST /api/growth-tasks/{list,accept,claim,claim-all,auto,scan}` |
| 参数 | `{scope, accountId, ...}` | 同形（JSON body） |
| 前端 | — | `src/lib/api.ts` 的 `growthTasks*` |

`resolve_growth_account`（两侧各一份）一次性做三件事：作用域收敛、取账号、区域闸门。
**写漏区域闸门**会在 Global 上打出一串无意义的 404。

演示站（`build:demo`）只登记了两个**只读**命令（`growth_tasks_list` / `growth_tasks_scan`），
四个写操作由 `DemoAction` 统一提示不可操作 —— 与其它「演示只读」命令同一条判据。

---

## 8. 上游端点清单（非公开逆向接口）

| 路径 | 方法 | 域 |
|:--|:--|:--|
| `/v2/activity/growth/tasks` | GET | chat |
| `/v2/activity/growth/tasks/accept` | POST `{task_codes:[...]}` | chat |
| `/activity/growth/tasks/{code}/claim` | POST（无 body） | **web**（404/405 回落 chat） |
| `/v2/report` | POST（事件数组） | chat（桌面指纹）/ billing（计分）/ web（页面行为） |
| `/activity/growth/buddy/agreement` | POST | billing |
| `/activity/growth/buddy/first` | POST | billing |
| `/v2/user-asset/appearance/set` | POST `{kind,resource_key}` | chat |

上游接口随时可能变更；**任何判据调整都应先改 `ACTIONS` 表与该模块的单测**，
再改实现 —— 单测里已经固化了「事件顺序、JOIN 字段、成功回执」这些不能漂的细节。
