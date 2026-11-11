# 接口约定：Trae / Qoder 的「按账号 · 今日」只读重取

**日期**：2026-10-18（最后更新 2026-11-11：补 §12.9 冷启动 / 切换账号页耗时整改）
**提出方**：账号页（`AccountsPage` / `TraeAccountsPage` / `QoderAccountsPage`）
**状态**：**已实现**（2026-10-18；`get_trae_account_token_today` / `get_trae_checkin_status_map` /
`qoder_checkin_status_map` 三条命令 + 两端接线 + 抽屉指标块）。§12 为 2026-11-10 追加的
WorkBuddy 前端策略补充，已落地；§12.9 为 2026-11-11 的冷启动 / 切换账号页耗时整改，已落地。
**影响面**：卡片「更多」菜单与详情抽屉指标块的刷新项（此前两平台各只有「积分 / 凭据状态」）

> **实现期对本文的两处修订**（实现与初稿不一致的地方，以本文为准）：
>
> 1. **`accountIds` 是逗号分隔串**，不是 `string[]`：`httpCall` 的 `queryString` 对数组
>    只会产出 `String(["a","b"])`，桌面端却天然拿到 `Vec<String>` ⇒ 两端形状分叉。
>    统一收一个串（后端 `parse_id_list` / `split_id_list`），前端传 `ids.join(",")`。
> 2. **Trae 的 `clientSource: "unavailable"`**：Trae 没有可解析的客户端会话落盘
>    （对话历史在 IDE 私有存储里），`clientIn/clientOut` 恒为 0 只为**形状同构**，
>    UI 必须把那一档渲染成「不可得」而不是真实 `0`。

---

## 1. 为什么需要新接口（而不是复用现有的）

卡片「更多」的刷新组为 `积分` / `签到状态` / `凭据状态`（+ WB·CN 的 `任务`）；
`今日 Token` 自 2026-10-26 起不再是菜单项；★ 2026-10-29 起抽屉概览的同名行也已移除 ⇒
账号页不再展示 / 刷新它，今天用量只看用量统计页（接口本身保留）。
WorkBuddy 全部可刷；**Trae / Qoder 曾缺「这个账号、今天」这一粒度的只读数据**，因此补了下面两条命令。

现有的三个批量接口都**不能**直接当单账号今日口径用：

| 现有命令 | 现状口径 | 为什么不够 |
|:--|:--|:--|
| `get_trae_token_statistics`（`GET /api/trae/token-stats`） | 区域批量，`rangeDays` 时间窗 | 是「区间合计」，不是「今天、这个账号」；卡片上也没有对应读数可更新 |
| `get_trae_checkin_status`（`GET /api/trae/checkin/status`） | 区域批量，**最近一次签到运行**的 `results` | `summaryIsToday` 为假时是旧结果；且没有逐账号的「今天签没签」布尔 |
| `qoder_checkin_status`（`GET /api/qoder/checkin/status`） | 区域批量 | 同上，且 Qoder 的签到是**写操作**（`qoder_checkin_claim`），读侧只有列表快照 |

> 结论：需要两条**按账号、今日口径、只读**的命令。字段名**照抄 WorkBuddy 的同类命令**
> （`get_account_token_today` / `get_checkin_status_map`），前端三平台就能共用同一套渲染。

---

## 2. 两条命令

### 2.1 今日 Token（按账号）

| 项 | 值 |
|:--|:--|
| 命令名 | `get_trae_account_token_today` / `get_qoder_account_token_today` |
| HTTP | `GET /api/trae/account/token-today`、`GET /api/qoder/account/token-today` |
| 参数 | `scope`（`trae-cn` / `trae-global` / `qoder-cn` / `qoder-global`，**fail-closed**）、`force?: bool`（缺省 `false`） |
| 返回 | `AccountTokenTodayResponse`（**与 WB 同构**，见 `src/lib/types.ts:85`） |

```ts
interface AccountTokenTodayResponse {
  date: string;                 // 本地日期键 "YYYY-MM-DD"
  accounts: { uid: string; clientIn: number; clientOut: number;
              gatewayIn: number; gatewayOut: number }[];   // 缺席 = 今日无记录/未知
  unknownClient: { in: number; out: number };
  gatewayTruncated: boolean;    // 网关日志今日部分可能被裁 ⇒ 只是下界
}
```

**语义边界（必须遵守，前端会照此渲染）**

1. **缺席 ≠ 0**：`accounts` 里没有这个 uid ⇒ 前端显示「—」。真实 `0` 必须显式给 `0`。
2. `force=false` 时后端可按 TTL 走缓存（与 WB 一致，避免每次进页面全量重扫）；用户点刷新传 `true`。
3. `gatewayTruncated=true` ⇒ 前端渲染成 `≥N`（不是精确值）。

### 2.2 签到状态（按账号）

| 项 | 值 |
|:--|:--|
| 命令名 | `get_trae_checkin_status_map` / `get_qoder_checkin_status_map` |
| HTTP | `GET /api/trae/checkin/status-map`、`GET /api/qoder/checkin/status-map` |
| 参数 | `scope`、`accountIds`（**逗号分隔**的 uid 串，批量，最多 50 个；空串直接返回 `{}`） |
| 返回 | `Record<uid, CheckinStatusEntry>`（**与 WB 同构**，见 `src/lib/api.ts:1457`） |

**语义边界**

1. **未知不进 map**（不要用 `false` 表示「不知道」）—— 前端对缺失项显示「—」。
2. **读失败 ≠ 未签到**：读失败回 `{ ok: false, todayCheckedIn: false, error: "…" }`，
   前端据 `ok` 区分「没签到」与「读不到」；`ok: true` 时 `todayCheckedIn` 才是事实。
3. 只读：绝不能在这里顺带触发签到（Qoder 的签到是一次写操作，走 `qoder_checkin_claim`）。
4. 若上游能给签到积分（`dailyCredit` / `streakDays` / `checkinDates`），**原样透传** ——
   抽屉的「签到」页已经在用这些字段（`CheckinStatusEntry` 的注释写了来源）。

---

## 3. 后端实现要点

1. **数据来源**
   - Trae Token：**只有网关日志**（`api_gateway_logs.json`）—— Trae 没有可解析的客户端会话落盘
     （见 `trae::token_stats` 模块头）⇒ `clientSource: "unavailable"`；
     Qoder Token：**不实现**（见 §5「明确不做」）。
2. **时区**：`date` 必须是**本地日期键**，与签到日志 / 积分统计事件同口径（WB 已如此）。
3. **裁剪标志**：网关日志按滚动窗口保留，今天的部分可能已被裁 ⇒ 必须回 `gatewayTruncated`。
   判据取「文件已到 `logKeep` 上限」（保守：只在真的可能被裁时报警）。
4. **性能**：批量签到状态一次调用返回全部账号（前端**禁止**逐账号循环调，见 `AccountsPage.tsx:143` 的注释）；
   单账号刷新时前端传长度为 1 的列表即可，不新增「单账号」变体。
   后端并发上限 4（串行问 50 个账号要十几秒，全并发又会把 50 个请求一次性打到上游）。
5. **幂等**：两条命令都是只读，可安全重试；不要因为 `force=true` 触发任何写操作。
   `force` 在 Trae 侧**恒等**（读的是本地文件，无 TTL 缓存）—— 参数仅为契约保留。
6. **进页面时不要全量拉签到状态**（那要逐账号打上游）。账号视图自带的 `checkedToday`
   （本地台账）足够画初值；用户点「刷新签到状态」才去问上游，那一次是真值。
   ★ 2026-10-29：Qoder 侧补齐同一契约 —— `account_view` 下发 `lastCheckin` /
   `lastCheckinToday`（本地盖章及其是否今天），上游读数缺席或读取失败时前端用它画
   「今日已签 · 按本地台账」，重开页面不再回落成「—」。

---

## 4. 前端接线（已落地）

| 文件 | 改动 |
|:--|:--|
| `src/lib/api.ts` | `ROUTES` 加 3 条（`get_trae_account_token_today` / `get_trae_checkin_status_map` / `qoder_checkin_status_map`）、`call()` 封装、`DEMO_READ_COMMANDS` 登记 |
| `src/lib/types.ts` | `AccountTokenTodayResponse` 加 `clientSource`（边界 5） |
| `src/pages/TraeAccountsPage.tsx` | `TRAE_REFRESH_KINDS` 加 `"tokens"` / `"checkin"`；`onRefreshPart` 两条分支接新命令；抽屉指标块从 3 块 → **4 块**（多一块「今日 Token」，副文本写明「仅经本网关的调用」）。★ 2026-10-29：上述 `tokens` 菜单项早已撤（2026-10-26），同日抽屉概览的 Token 行与页面取数一并移除 ⇒ `TRAE_REFRESH_KINDS` 现为 `credits / checkin / credential` |
| `src/pages/QoderAccountsPage.tsx` | `QODER_REFRESH_KINDS` 加 `"checkin"`（**不加** `tokens`）；抽屉签到块接上「读不到 / 本区域未开放」两档 |
| `scripts/check-api-contract.cjs` | 三条命令登记进 `SCOPE_PARAMETERIZED`（防「参数化只做一半」） |

> ⚠️ `check:api` 是**硬门禁**：`ROUTES` / `call` / 后端 `server` 三张表任缺一条都会红 ——
> 本次三处（前端 / server / invoke）在同一次提交里补齐。

---

## 5. 明确不做

- **Qoder 的「今日 Token」**：Qoder 的计量单位是 **credits**，不是 token；`qoder_usage` 返回的是逐日 credits。
  除非上游提供 token 级用量，否则这条命令**不实现**，前端菜单里 Qoder 也不出现该项
  （摆一个点了只重读缓存的菜单项比不摆更坏）。
- **不新增「单账号」变体**：批量接口传 1 个 id 即可，避免两套口径。
- **不在读接口里顺手写缓存文件**：刷新是「重读」，不是「续期」；续期走 `trae_refresh_jwt` / `qoder_refresh_account`。

---

## 6. 验收（前端会加这两条断言）

1. **缺席 ≠ 0**：mock 里让某账号不出现在 `accounts` ⇒ 卡片与抽屉显示「—」，不是 `0`。
2. **签到未知 ≠ 未签到**：`status-map` 缺该 uid ⇒ 显示「—」；只有 `todayCheckedIn: false` 才显示「未签到」。

> 两条都对应本仓已有的老问题（`AccountTokenTodayResponse` 的注释里写了四类边界），
> 新接口照抄形状即可自动满足。

---

## 7. Qoder 积分刷新（2026-10-27 补充）

Qoder 卡片菜单的「刷新积分」与页头「一键刷新」都走现有 `qoder_credits`
（`GET /api/qoder/credits`），逐账号检查返回行的 `ok`；不得调用 `qoder_refresh_account`，
后者会续期并回写凭据，是独立的写操作。页头同时只读重取 `qoder_checkin_status_map`
与账号元数据，三层都失败才报整体失败，任一层成功而另一层失败则报部分失败。

`status-map` 请求 fulfilled 只代表拿到响应，不代表所有账号都读取成功：任一返回条目
`ok:false` 都属于部分失败；单账号刷新也必须检查目标条目，不能在「读不到」时显示成功。

---

## 8. 刷新顺序与失败信号（2026-10-27 补充）

### 8.1 Trae 一键刷新：快照必须后读

- 积分（`trae_refresh_credits`，不传 `userId`）与签到状态（`get_trae_checkin_status_map`）
  **可以并行**；但账号快照（`getTraeAccounts` + `getTraeCredits` + …）必须在积分请求
  **结束之后**再取。此前三项 `allSettled` 并行 ⇒ 快照先回来、积分后落盘，刷新结束仍显示旧值。
- 积分请求失败也要回读快照：成功的那批账号已经落盘，不能因为另一批失败就不显示。
- `trae_refresh_credits` 的批量作用域在既有 `refreshed` 之外增加 `total` / `failed` /
  `failures[{ userId, error }]`；单账号作用域没有这三个字段（单账号失败直接 `Err`）。
  页头的失败 / 部分失败提示必须带上**首个失败原因**（`failures[0].error`）：只说「刷新失败」
  时用户看不出下一步该做什么（凭据失效场景要重新登录）。
- 页面按 **积分 / 签到 / 快照** 三层分别判定：三层全成功 → `success`，三层全失败 → `error`，
  其余 → `warning`。快照读取失败必须计入 —— 否则错误提示旁仍会亮「已刷新 N 个账号」。
- 单账号积分刷新（卡片菜单 / 专用按钮）落盘后同样重取页面快照；快照读取失败时本轮不算成功
  （刷新状态管理层不会亮「已更新」）。
- 缓存层 `refreshWithResult()` 返回 `{ ok, superseded, error }`。同键强制刷新并发时，
  先发结果若被后发请求取代（`superseded: true`），调用方**既不报成功也不亮「已更新」**；
  一键刷新把它计入「部分失败」，不把过期结论说成已刷新。
- 缓存 **key 与 loader 必须成对**：loader 按 key 存档，调用时用闭包里的键反查。
  只有一个 `loaderRef` 时，「国内版发起、完成前切到国际版」会让旧键读到国际版 loader，
  把国际版账号写进国内版缓存。

### 8.2 Trae 逐包明细的单一口径

账号视图（`list_account_views_for`）只带聚合积分，逐包明细在积分总览的 `packages[uid]`。
前端一律走 `traeCreditPackages(account, credits.packages)`：卡片、表格、详情抽屉共用这一份
合并结果，不得各自读 `account.creditPackages`（生产上该字段恒缺）。

抽屉的自动补拉按 `scope:userId` 去重（区域 × 账号），判据用合并结果：
`null` = 尚未查询（补拉一次），`[]` = 已查询但没有积分包（不再请求）。

签到成功写入的是**更新的事实**：`markCheckinMapChecked` 必须替换旧的 `ok:false`（查询失败）
条目，而不只是改 `ok` 条目 —— 否则抽屉优先读到过期失败，历史显示成功、今日签到仍显示「读不到」。
替换后 `source` 标 `"ledger"`，失败条目没有可信统计字段，未知统计保持为空。

### 8.3 WorkBuddy 旅行：成功状态 + 失败账号

`api.queryTravelStatuses` 返回 `{ statuses, failedIds }`；`getTravelStatusMap` 保留为
「失败即忽略」的容错包装，供后台轮询使用。页面口径：

- **单账号**刷新：目标不在 `statuses` 里 ⇒ 抛错（不亮「已更新」）；
- **批量 / 一键**刷新：只更新成功项、失败项保留旧值，并提示失败数量；
- `label` 为「无 Buddy / 未旅行」等**正常业务态**仍算读取成功。

### 8.4 凭据失效：HTTP 401 与业务码 1001（2026-11-01 补充）

上游对失效会话有两种表现：`HTTP 401`，或 `HTTP 200 + 业务码 1001`（`not able to authenticate you`）。

- **两者都算凭据失效**：`classify_error` 均映射 `SessionDead`（永久冷却）。1001 此前落到
  `BusinessError`（300s），失效凭据会被反复重试并持续触发风控。
- **不得落进正常解析路径**：401 时用量接口返回的 `user_entitlement_pack_list` 是**空数组**
  （不是缺键），继续解析会把「认证失败」写成「剩余 0 积分」并覆盖缓存。积分刷新遇到
  401/1001 直接 `Err`（HTTP 通道报 400「凭据已失效，请重新登录该账号」）。
- **失败必须落持久状态**：单账号 / 批量积分刷新遇到 401/1001 都写 `SessionDead` 冷却
  （永久，`until = 9_999_999_999`），账号卡与表格随即显示「需重新登录」徽章、
  卡片副行给出失败原因，页头「需处理」计数也把它算进去。只弹一次 toast 不够 ——
  提示关掉后页面看起来一切正常，用户无从判断账号已经不可用。
  JWT 本身未到期不影响这条判定：`jwtStatus` 仍是 `ok`，但凭据已被上游吊销。
- **失效凭据不能自愈**：`refresh token is invalid`（业务码 20101/040012）时只能走 OAuth
  重新登录；「从本机导入」只替换 JWT、保留旧 refresh token，不足以恢复。
- **重新登录必须清冷却**：`SessionDead` 的冷却到永久，OAuth 登录 / 本机导入 / JWT 换新成功后
  都要调 `clear_cooldown_for`，否则该账号在签到计划里会被永久跳过。

### 8.5 一键刷新冷却：完整作用域键

冷却表键是完整 L1 作用域（`wb-cn` / `trae-global` …），不是裸 `region`。切换区域时
按钮重新读取该作用域的绝对截止时间；倒计时按 `deadline - Date.now()` 计算（后台节流不累积偏差）；
请求完成后只回写**发起请求时**的作用域，且只有当前仍停在该区域时才更新按钮状态。

---

## 9. 2026-10-27 补充：Qoder 积分按账号筛选

`qoder_credits`（`GET /api/qoder/credits`）新增**可选** `accountIds`：

| 通道 | 入参形状 | 语义 |
|:--|:--|:--|
| Tauri `qoder_credits` | `accountIds?: string[]` | 缺省 = 全区域 |
| HTTP `/api/qoder/credits` | `accountIds=a,b`（逗号串，同 `parse_id_list`） | 同上 |

- **过滤发生在 core 发送上游请求之前**（`qoder::credits::region_view(region, uids)`）：
  单账号刷新只打该账号的额度与套餐，不再「顺手刷全区域」。
- **显式空集合不退化为全量**：`Some([])` 表示没有目标账号 ⇒ 零上游请求、零行。
  未知 uid 同样不产生请求，调用方按「缺条目 = 未取得数据」处理（不覆盖旧值）。
- 前端 `api.qoderCredits(scope, accountIds?)`：`undefined` = 全区域；`[]` = 空。
  单账号刷新传 `[uid]`，勾选刷新传勾选集合，页头一键才省略参数。

---

## 10. 2026-10-28 批量签到可取消（Trae）

| 通道 | 入参 | 说明 |
|:--|:--|:--|
| Tauri `trae_checkin` | `options.taskId?: string` | 本批任务 id |
| HTTP `POST /api/trae/checkin` | `{ options: { taskId } }` | 同上 |
| Tauri `trae_checkin_cancel` | `taskId: string` | 请求取消 |
| HTTP `POST /api/trae/checkin/cancel` | `{ taskId: string }` | 同上 |

语义（**协作式**，与 `mapWithConcurrency` 的 `signal` 同一条规则）：

- 只拦**尚未开始**的账号；在途请求一定跑完并计入报告。
- 取消后 `report.results` 只含已执行账号 ⇒ 前端按
  `total - results.length` 报「N 个未处理」，重试名单 = 失败 + 未处理。
- 取消标记在任务结束时清理（同 id 复用不残留）。
- 桌面端进度经 `trae-checkin-progress`（`start` / `account` / `cancelled` / `done`）；
  webui 没有事件通道，进度停在 0/N 直到结束 —— 这是通道能力差异，不编造中间进度。

### 10.1 2026-10-28 复审整改（进度隔离 / 未处理口径）

- **事件携带 `taskId` + `variant`**：页面只消费「本区域 + 当前任务」的事件
  （`payload.taskId` 必须等于当前批次 id；`variant` 按区域前缀比对 —— `global*` = 国际线，
  其余 = 国内线）。切区后旧任务收尾、或新旧任务重叠，不再污染新批次进度。
- **「未处理」只算计划内未执行**：报告新增 `unprocessed` / `unprocessedIds` / `cancelled`。
  被策略跳过（已签到 / 凭据过期 / 冷却中）的账号**不在其中**，正常完成的一批不会出现未处理项。
- **取消不能报成功**：前端判定顺序为「仍有未处理 ⇒ warning（已取消，N 个未处理）」
  →「全部失败 ⇒ error」→「成功」；重试名单 = 失败 + 未处理。

---

## 11. 2026-10-29 补充：Qoder 抽屉打开时补齐签到明细

**问题**：区域签到快照（`qoder_checkin_status`）读取失败 / 缺该账号时，卡片顶部按本地台账
显示「已签到 · 按本地台账」，但抽屉「签到」页签的「签到天数 / 累计积分」只能写「—」，
必须手动点 ⟳（逐账号 `qoder_checkin_status_map`）才会有数字。

**口径**（与 WB「打开抽屉就查一次该账号签到状态」、Trae「打开抽屉就取该账号签到记录」对齐）：

- 抽屉打开后、区域快照**已尝试过**（成功 / 失败都算）时，若该账号的上游读数缺席
  （无条目 / `ok:false` / 仅本地台账），补发**一次**只读 `qoder_checkin_status_map([uid])`；
- 按 uid **每个页面会话只补一次**（失败不重试、不写 map，避免把「暂时读不到」固化成结论）；
- 成功则并入 `checkinMap`（优先级高于区域快照），顶部「按本地台账」副行随之上游化；
- 页面加载仍**不**逐账号拉取 —— 自动补取只发生在用户打开某个账号抽屉时，一次一个账号。

**共享抽屉的文案**：已签到但「今日获得」未知（上游只回状态 / 台账兜底）时，签到页签的
「今日签到」格写「已签到」，不再写「—」—— 与上方指标块同一结论，且不伪造 `+0`。

---

## 12. 2026-11-10 补充：账号页加载 / 一键刷新的提速与如实反馈

> **归属说明**：本文主体是「Trae / Qoder 的接口约定」，§12 记的是 **WorkBuddy 前端的
> 展示与刷新策略**（缓存占位、单航班、TTL、按层判定）。两者不同源，暂借此文同处一页
> 是因为它们由同一轮改动引入；后续拆分时按 `docs/README.md` 的分区规则另立页面，
> 拆完回填本行的链接。读 §12 时请按「前端策略」而非「后端契约」理解。

### 12.1 WorkBuddy 积分首屏用**上次成功读数**占位

- 进程重启后 `creditMap` 是空的，积分必须等上游回来才有数字（每账号 3 路请求）。
- `src/lib/credit-cache.ts` 在每次**成功**读数后把它写进 `localStorage`
  （按作用域分家，只存 `ok:true`，7 天过期，上限 500 条）。
- 账号页用 `displayCreditMap = 缓存 ⊕ creditMap` **仅做展示**；排序 / 优先级 /
  `attentionOf` 仍读实时 `creditMap`，避免用旧数据重排列表或误报状态。
- 缓存不是真值来源：后台刷新回来立即覆盖；失败结果**不落盘**。
- **占位必须自报年龄**（2026-11-10 复审整改）：缓存最长 7 天，而 `nextExpiryLabel` /
  `creditMetricTip` 会把旧批次渲染成「明天到期」「最近到期」这类**当前态结论**。
  ⇒ `readCreditCache` 返回值带 `at`，卡片 / 表格「积分」列 / 抽屉积分格统一走
  `creditCacheNote(at, t)` 渲染「上次读数 · N 分钟前」。没有时间标注的占位比留空更误导。
- **有读数时 loading 不得顶掉内容**（同轮整改）：旧顺序是
  `creditLoading ? 转圈 : !credit ? 等待 : …`，而页面挂载的 `ensureCredits` 会把
  每个账号的 `creditLoadingMap` 置 `true` ⇒ 缓存占位永远被转圈盖住，§12.1 的目标落空。
  现在判定顺序改为「先看有没有读数」，刷新中只在下方补一行小字。

### 12.2 积分刷新：单航班 + 失败重试窗口 + 状态清理

- 同账号同区域的积分请求**复用在途 Promise**（`creditInflight: Map<id, Promise>`）：
  手动刷新、进页面 / 窗口重新可见的 TTL 触发、抽屉的单账号刷新同时发生也只打一轮。
- `ok:false` 不再永久视为「已缓存」：记录 `creditAttemptAt`，60 秒后的
  `ensureCredits` / 重新进页面会再试一次；成功前不写展示缓存。
- `loadCredits` 用 `try/finally` 清理 `creditLoadingMap` 与 `refreshingCredits`：
  意外异常不能再留下「永远转圈 + 后续不再请求」的残留态。

### 12.3 一键刷新按**层**判定（WorkBuddy）

`quickRefreshAll` 现在汇总四层：积分（`failed/ok`）、旅行（`failedIds`）、成长任务、
账号库快照（`reconcileAccounts`）。

- 全成功 → `success`；四层全失败 → `error`（带首个积分失败原因）；
- 其余 → `warning`，描述逐项写清「N 个积分读取失败 / N 个旅行状态失败 / 任务失败 /
  凭据状态失败」；
- **不得**在积分全部失败时仍报「一键刷新完成」—— 这正是「点了刷新但卡片还是『—』」
  的观感来源。

### 12.4 被动请求的并发上限与稳定依赖

- `getCheckinStatusMap` / `queryTravelStatuses` 的桌面端逐账号分支改用
  `mapWithConcurrency(..., { concurrency: 4 })`；无上限 `Promise.all` 会在页面打开时
  把 N 个账号的请求一次性拍给上游，触发限流后整体更慢。
- 账号页的签到 / 旅行 / 成长 / 积分 effect 依赖**账号 id 串**而不是 `accounts` 数组：
  `reconcileAccounts` 每次都换新数组，依赖数组会让这些被动请求在每次刷新回读后重放一轮。
- `fetchAllRegions` 增加区域级在途去重：同一区域的并发挂载复用同一轮。

### 12.5 批量积分刷新：有界并发、顺序合并不变

- **Trae**：`refresh_all_remaining_for` 的**取数**改为最多 4 个账号并发（`JoinSet`），
  **合并 / 解冻 / 失败清单仍按账号原始顺序**执行 ⇒ 输出顺序与串行版逐条一致，
  只缩短 N 个串行 RTT 的等待。任务异常退出（panic）的账号计入失败，不静默丢弃。
- **WorkBuddy 网关**：后台余额刷新的取数改为 3 路并发（`buffer_unordered`），
  写回仍是每个结果一次短暂写锁；`refresh_pool_and_refresh_with_agree` 与
  「不持锁跨 fetch」两条护栏继续生效。

### 12.6 界面积分自动刷新：取消 30 分钟定时器，改 TTL 触发

- **不再**在 App 层常驻 30 分钟静默刷新（它会在任何页面、任何时间打一轮上游，用户看不见）。
- `useCreditAutoRefresh` 只在以下时机检查：
  1. 进入 WorkBuddy 账号页（含区域切换）；
  2. 窗口重新可见（`visibilitychange` / Tauri `main-window-visible`）；
  3. 窗口重新获得焦点。
- 判定口径：只处理**当前可见区域**（与 `useScope` 同一套优先级）；
  `creditFullRefreshedAt` 距今 ≥ **15 分钟**或从未全量刷新 ⇒ `refreshCredits(force)`；
  否则 `ensureCredits`（只补从未取到 / 上次失败的条目）。
- **两个时刻必须分开**（2026-11-10 复审整改）：`creditRefreshedAt` 是「任意一轮请求」
  的诊断事实（`ensureCredits` 也写），**不能**当 TTL 判据 —— 只要有一个长期失败的账号，
  60 秒一次的重试就会不断把它推后，窗口永远判定为「还新鲜」，判据形同虚设。
  TTL 只读 `creditFullRefreshedAt`，且该值仅在「`force` 且本轮目标覆盖该区域全部账号」时写入。
- 页面挂载时的 `ensureCredits` 仍然保留，两路并发由积分单航班去重。
- **后端**网关余额循环与 Trae 积分循环不在此列：它们服务选号权重与自动解冻，不能取消。

### 12.7 Qoder 快照缓存（`enrichmentCache`）：占位可以，契约不能改

`QoderAccountsPage` 用一个模块级 `Map<scope, QoderEnrichmentSnapshot>` 记住上次会话
读到的「额度 / 签到 / 程序位」，用于页面重进时的初值占位。**占位范围有硬边界**：

- **只**作为 `credits` / `checkinRows` / `programs` / `checkinUnavailable` 的初值；
- **不得**决定 `checkinLoaded`。它的契约是「**本轮区域快照已尝试过**（成功 / 失败都算）」，
  见 §11：抽屉的按需补取要等这一拍落地。若用「缓存里有条目」代替它，
  缓存快照恰好缺某账号的签到行时，抽屉会立刻补发 `qoder_checkin_status_map([uid])`，
  与在途的区域快照并发多打一轮上游。
- 缓存快照是**同一时刻**的三份数据（`loadEnrichment` 批内写入），不要单独替换其中一份。

> 复审记录：本项曾在 2026-11-10 首版实现里被改坏（`useState(() => cachedEnrichment !== undefined)`），
> 同轮整改已恢复为 `useState(false)`，并由 `check-scope-registry` 加断言钉住。

### 12.8 积分统计页的取数（取消全局静默刷新的连带影响）

`CreditStatsPage` 的「到期分布 / 临期积分 / 资源明细」读的是 store 里的 `creditMap`，
而该页只调 `fetchAllRegions()`——**那只拉状态与账号，不发任何积分请求**。
取消 App 层 30 分钟静默刷新（§12.6）后，从不进账号页的用户会看到空分布。

修复口径：

- 页面按区域补一次 `ensureCredits`（只补未取到 / 上次失败的条目），依赖**账号 id 串**
  而不是账号数组（`reconcileAccounts` 每次换新数组，依赖数组会重放）；
- **不阻塞**主路径：统计与图表先渲染，积分回来后由 store 触发一次重算；
- 合并 CN 与 Global 两个区域的 `creditMap`（`creditByAccount`）——只读 CN 表会让
  `region === "all"` 时的国际版账号恒显示「—」。

### 12.9 2026-11-11：冷启动与切换账号页的耗时整改

> 整改前实测（Windows，已发布构建）：WorkBuddy 首开「当前登录」~5s；Trae 页面 0.64s
> 出结构、1.8s 补齐程序位 / 当前登录；Qoder 页面 0.38s 出结构、4.4s 补齐积分 / 签到 /
> 程序位。整改后同机冷启动：WorkBuddy「当前登录」~3.0s；Trae ~1.5s；Qoder 积分
> ~0.4s 先落地、程序位 / 当前登录 ~1.7s。
>
> ⚠️ WorkBuddy 剩余的 ~3s 经复测**不是**插件探测造成的：把插件探测延后后
> （PowerShell 从挂载 25ms 挪到 ~2.6s），状态时间仍是 ~3.0s。剩余开销主要在
> WebView2 冷启动（进程启动 ~1.1s）与首次进程快照（`tasklist`，负载下 1.5s 级）。
> 下一个真正的杠杆是把展示用进程快照换成 Win32 原生枚举，而不是继续挪探测。
> 三页的病根不同，分别处理如下。

**(1) WorkBuddy：`get_status` 的应用路径探测本来是热路径**

- `build_app_status` / server `api_status` 对 `workbuddy_app_path_for` 的调用从**两次**
  降为**一次**（`appPath` 与 `installed` 复用同一个 `PathBuf`）。
- `windows_workbuddy_exe_path_for` 的顺序改为「磁盘缓存（校验文件存在）→ 运行进程 →
  注册表 → 盘符候选」。此前「运行进程探测」在最前，每次状态查询都会 spawn 一个
  PowerShell（实测 ~1s）。
- 增加**进程内 TTL**：命中路径 60 秒（命中时校验文件存在，且**在锁外** stat，避免两个
  区域串在同一把全局锁上）；「没找到」5 分钟。未安装的区域（常见：国内用户没装国际版）
  此前每 60 秒轮询都要跑进程 + 注册表两次 PowerShell。
- **负缓存期仍跑「便宜层」**（`WINDOWS_EXE_CHEAP_PROBE_INTERVAL` = 10 秒节流）：只查
  环境变量默认目录与各盘符常见目录（纯 `is_file`，不 spawn 进程、不读注册表）。
  没有这一层时，运行期间新装的客户端会一直显示「未安装」——而卡片上的「重新检测」
  按钮与轮询走的是**同一条命令**，用户没有任何自救手段。跑空时只推进节流时间戳、
  **不刷新结论时刻**，否则轮询会把负缓存无限续期。装在非默认目录（便携副本）的客户端
  仍受 5 分钟窗口约束，这是本层的已知边界。
- 启动前发现算出的路径不存在时**作废进程内结论**（`invalidate_windows_exe_cache`），
  让用户下一次点「启动 / 重新检测」真正重探，而不是在同一个死路径上报满整个 TTL。
- 前端 `useWorkbuddyStatusRefresh` 对**焦点 / 可见性事件**触发的刷新加 **10 秒最小
  间隔**；60 秒定时轮询与首次激活走**无闸门**的 `refreshStatus`，闸门只装在事件包装
  `refreshStatusOnEvent` 里（挂在 `refreshStatus` 内会把定时轮询一起吞掉）。时间戳用
  `performance.now()`（单调）而非 `Date.now()`，初值 `-Infinity`（`performance.now()`
  从页面加载起算，初值为 0 会吞掉首屏那次真实刷新）。
- 账号页挂载时的 CLI / IDE / 插件探测**延后 1.2 秒**（`LOCAL_PROBE_DEFER_MS`），
  把 4–6 个 PowerShell 从首屏前移到页面就绪后；它们只服务卡片上的辅助芯片。
  ⚠️ 复测表明这**不改变**「当前登录」的 ~3.0s（它们不在关键路径上），保留它是为了
  消除首屏前的进程风暴，而不是当作状态提速手段。

**(2) Trae：展示路径不再用实时 tasklist**

- `profile::overview_for` 的 `clientRunning` 改读共享进程快照
  （`is_running_for_display`，1 秒 TTL）。实时 `is_running_for` 只留给
  「写前守卫 / 结束进程」等需要真实时刻的路径。
- 账号页 `loadSnapshot` 只取**当前区域**程序位的登录态（本页 `programsFor` 本来就按
  区域过滤）；顶栏作用域菜单需要的两区登录名仍由 `useScopeStatus` 负责。
- `loadTraeVariantStatuses` 加**在途单航班**（只合并并发，不做 TTL 缓存），
  避免 App 的 `useTraeVariantRunning` 与页面同拍各探一次。

**(3) Qoder：分层落地 + 签到状态有界并发**

- 账号页 `loadEnrichment` 改为**每层落地**：程序位（本机探测，毫秒级）、积分、签到
  各自返回就 setState；模块级 `enrichmentCache` 仍在三路都结束后**整批**写
  （§12.7 的「同一时刻三份数据」不变）。
- `checkinLoaded` 在**签到层**成功 / 失败时即置位（契约仍是「本轮区域快照已尝试过」），
  不再等积分。
- `qoder::checkin::status_for` 的逐账号上游查询改为**有界并发**（4，与
  `status_map_for` 同上限）；输出仍按账号库原序。**写操作** `run_cycle_for` 仍保持
  逐账号串行（风控）。

**(4) Win32 原生进程枚举（2026-11-11 追加）**

- 展示快照 / 实时枚举 / 写前守卫 / 运行路径探测全部改走 ToolHelp
  （`CreateToolhelp32Snapshot` + `Process32FirstW/NextW`），不再 spawn `tasklist`
  或 PowerShell 取进程表。按映像名取完整路径用
  `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW`。
- 实测（本机 437 进程，独占 spike）：`tasklist /FO CSV /NH` **516–574ms** →
  原生 **~9ms**（约 60 倍）；对 34 个匹配进程取完整路径 **~9ms**（旧 PowerShell
  路径探测 ~0.9–1.1s）。
- 预期收益：WorkBuddy 首开 ~3.0s → ~2.4s（剩余主要是 WebView2 冷启动 ~1.1s）；
  Trae 页面 ~1.5s → ~1.0s；CodeBuddy / JetBrains / VS Code 插件探测不再每枚映像名
  起一个 `tasklist`。
- 边界：ToolHelp 不含 Idle（PID 0）；受保护进程取路径会拒绝访问（只对匹配的
  WorkBuddy/CodeBuddy 映像取路径，失败回退磁盘缓存 / 注册表）；**注册表探测仍是
  PowerShell**（非默认安装目录的兜底，不在热路径）。

**护栏**（改这几处先看它们）：

- `npm run check:scope` 的「冷启动提速（spec §12.9）」一条钉住：负缓存期的便宜层不得
  调用会 spawn PowerShell 的两条探测、跑空不得续期、启动失败必须作废结论、Trae 单航班
  必须清理、闸门不得挪进 `refreshStatus`、账号页探测必须接在延时常量上。
  已做变异验证（把闸门移进 `refreshStatus` ⇒ 变红）。
- `crates/buddy-switch-core/src/modules/process.rs` 的 `windows_exe_cache_tests`（4 例）
  钉住：命中必须回验文件、负缓存 5 分钟过期、便宜探测只推进节流时间戳、作废后必须重探；
  `win_proc_tests`（2 例）钉住原生快照必须包含当前进程、当前 PID 的路径必须可读。
- `check:scope` 的「Win32 原生进程枚举」一条钉住：全量枚举不得回到 `tasklist`、
  运行路径探测不得回到 `ps_output`、写前守卫必须走实时枚举。已做变异验证
  （把 `enumerate_windows_process_rows` 改回 `tasklist` ⇒ 变红）。

**明确未做**：Qoder 的最近成功快照**不**做跨重启持久化。它需要像 WorkBuddy 的
`displayCreditMap` 那样，把「展示用缓存」与「排序 / 优先级用的实时值」分开，并在
卡片 / 表格 / 抽屉三处标注「上次读数 · N 分钟前」；本轮先保证本地层先显示、
上游层各自落地。
