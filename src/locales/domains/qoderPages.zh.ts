/**
 * 文案域：**Qoder 产品线 · 页面**（中文，键的权威之一）。
 *
 * 归属文件：
 * `src/pages/QoderAccountsPage.tsx`、`src/pages/QoderPendingPage.tsx`、
 * `src/pages/QoderUsagePage.tsx`
 *
 * ⚠️ 命名空间用 `qoder`（与 `trae` 同款：页面与组件共用一个前缀、靠二级段区分），
 * 键前缀：`qoder.page.`
 */
export const zh = {
  "qoder.page.accounts.title": "账号",
  // ⚠️ 页头副标题走 `shared` 域的 `pageHead.accounts` / `pageHead.accounts.pending`
  //    （「{scope} · {n} 个账号 · {m} 个需处理」）—— 与 WB / Trae 同一公式，不另立门户。

  "qoder.page.accounts.sectionAria": "Qoder 账号列表（{count} 个账号）",
  "qoder.page.accounts.loadFailed": "账号列表加载失败",
  "qoder.page.accounts.recheck": "重新检测",

  "qoder.page.accounts.empty.title": "这个区域还没有 Qoder 账号",
  "qoder.page.accounts.empty.description":
    "可以从本机已登录的 Qoder 客户端导入，或粘贴一个 PAT。",
  "qoder.page.accounts.empty.action": "添加账号",
  "qoder.page.accounts.empty.sources": "本机来源",

  "qoder.page.accounts.import.description":
    "只读探测桌面版与 CLI 的登录态。不会修改客户端里的任何文件。",
  "qoder.page.accounts.import.result": "新增 {imported} 个，更新 {updated} 个",
  "qoder.page.accounts.import.none": "两处来源都没有可导入的账号",
  "qoder.page.accounts.addDrawer.notInstalled":
    "两处本机来源都未检测到。可以先用官方客户端登录后导入，或直接粘贴 PAT。",

  "qoder.page.accounts.source.desktop": "Qoder 桌面版",
  "qoder.page.accounts.source.cli": "Qoder CLI",
  "qoder.page.accounts.source.missing": "未检测到",
  "qoder.page.accounts.source.unreadable": "读不出来",
  "qoder.page.accounts.source.empty": "里面没有账号",
  "qoder.page.accounts.source.ready": "可导入",

  "qoder.page.accounts.pat.title": "粘贴 PAT",
  "qoder.page.accounts.pat.description":
    "个人访问令牌（以 pt- 开头）。适合没有装客户端、或客户端登录态读不出来的情况。",
  "qoder.page.accounts.pat.placeholder": "pt-…",
  "qoder.page.accounts.pat.action": "导入",
  "qoder.page.accounts.pat.invalid": "前缀不对：PAT 应以 pt- 开头",
  "qoder.page.accounts.pat.cancel": "取消",

  // ---- 卡片 / 表格 / 工具栏（原型 `accountCard` / `tableView` / `viewAccounts` 的槽位） ----
  "qoder.page.accounts.chip.ok": "凭据可用",
  "qoder.page.accounts.chip.noCredential": "无可用凭据",
  "qoder.page.accounts.chip.unrecognized": "凭据未识别",
  "qoder.page.accounts.chip.foreign": "归属异常",
  "qoder.page.accounts.chip.foreignTip": "这条账号的归属域名不属于当前区域（可能被错误导入）",

  /* ★ 2026-10-28（口径对齐）：与 WB / Trae 卡片**同名同义** —— 此前这里写「更多操作」
     「{name} 的更多操作」「选择 {name}」，读屏在三张卡上会念出第三种说法。 */
  "qoder.page.accounts.card.manageAria": "管理账号 {name}",
  "qoder.page.accounts.card.moreActions": "更多账号操作",
  "qoder.page.accounts.card.viewDetail": "查看详情",
  "qoder.page.accounts.card.editRemark": "编辑备注",
  "qoder.page.accounts.card.deleteAccount": "删除账号",
  "qoder.page.accounts.card.selectAria": "选择账号 {name}",

  "qoder.page.accounts.toolbar.sort.priority": "积分优先级",
  "qoder.page.accounts.toolbar.sort.name": "名称",
  "qoder.page.accounts.toolbar.sort.expiry": "凭据到期",
  "qoder.page.accounts.toolbar.group.none": "不分组",
  "qoder.page.accounts.toolbar.group.status": "按状态",
  "qoder.page.accounts.toolbar.statusBucket.normal": "正常",
  "qoder.page.accounts.toolbar.statusBucket.noCredential": "无可用凭据",
  "qoder.page.accounts.toolbar.statusBucket.unrecognized": "凭据未识别",
  "qoder.page.accounts.quickRefreshDone": "已刷新 {n} 个账号：积分 · 签到状态 · 凭证状态",
  "qoder.page.accounts.quickRefreshPartial": "已刷新 {n} 个账号，部分数据未更新",
  "qoder.page.accounts.quickRefreshFail": "刷新失败",

  "qoder.page.accounts.table.account": "账号",
  "qoder.page.accounts.table.status": "状态",
  // ★ 2026-10-27（T05）：`expiresAt` 已由 core 归一成 Unix 毫秒 ⇒ 列表补「凭据」列
  //   （与 WB / Trae 同列名；无值显示「—」）。
  "qoder.page.accounts.table.credential": "凭据",
  // ★ 2026-10-28（用户要求）：补「程序位」列 —— 与 WB / Trae 同名同义。
  "qoder.page.accounts.table.programs": "程序位",
  // ★ 2026-10-28（用户要求）：删除「来源」「备注」两列 —— 来源留在详情抽屉，
  //   备注并入「账号」列的身份行。

  // ---- 详情抽屉（原型 `drawerAccount`：账号信息 + 备注**在抽屉里**编辑） ----
  // ★ 2026-10-29：抽屉副标题改由共享 `shared.drawer.subtitleUid` 生成（只显示 UID）
  //   ⇒ `qoder.page.accounts.drawer.subtitle` 已删除。
  "qoder.page.accounts.drawer.info": "账号信息",
  // ★ 2026-10-27（用户要求「参考 WorkBuddy，去掉概览里重复的凭据信息」）：
  //   概览不再重复凭据摘要 / 掩码令牌（「凭据」页签更完整）。
  // ★ 2026-10-29：概览重新加入 UID 行（用户要求「概览要能看到 uid」——
  //   头部副标题虽已带 UID，但概览是账号信息的正式去处）。
  "qoder.page.accounts.drawer.domain": "域名",
  "qoder.page.accounts.drawer.source": "来源",
  "qoder.page.accounts.drawer.addedAt": "添加时间",
  "qoder.page.accounts.drawer.updatedAt": "最近更新",
  "qoder.page.accounts.drawer.credential": "凭据",
  "qoder.page.accounts.drawer.accessToken": "访问令牌",
  // ★ 2026-10-26：凭据页签的明细行（此前页签里只有按钮、没有内容）。
  "qoder.page.accounts.drawer.refreshToken": "刷新令牌",
  "qoder.page.accounts.drawer.personalToken": "个人令牌",
  "qoder.page.accounts.drawer.present": "有",
  "qoder.page.accounts.drawer.absent": "无",
  // ★ 2026-10-27（T02 时间契约落地后）：`expiresAt` 已在 core 归一成 Unix 毫秒 ⇒ 可以如实展示。
  "qoder.page.accounts.drawer.expiresAt": "凭据到期",

  // ---- 删除（**软删除**：进回收站可恢复 ⇒ 文案如实说「可恢复」，别再写「永久删除」） ----
  "qoder.page.accounts.removed": "已删除 {name}",
  "qoder.page.accounts.domainMismatch": "归属不属于当前区域",
  "qoder.page.accounts.delete.title": "删除账号",
  "qoder.page.accounts.delete.desc": "确定删除「{name}」？删除后会进入回收站，可以恢复。",
  "qoder.page.accounts.delete.batchTitle": "批量删除账号",
  "qoder.page.accounts.delete.batchDesc": "确定删除选中的 {n} 个账号？删除后会进入回收站，可以恢复。",
  "qoder.page.accounts.delete.confirm": "删除",
  "qoder.page.accounts.delete.cancel": "取消",
  "qoder.page.accounts.delete.done": "已删除 {n} 个账号",
  "qoder.page.accounts.delete.partial": "已删除 {ok} 个，{fail} 个失败",

  "qoder.page.accounts.remark.saved": "备注已保存",
  "qoder.page.accounts.remark.missing": "这条账号已不在库里 —— 备注未保存",

  // 来源 id 是**后端数据**（`qoder::account::SOURCE_*`）；表外取值原样显示。
  "qoder.page.accounts.origin.pat": "PAT 导入",
  "qoder.page.accounts.origin.desktopApp": "桌面版导入",
  "qoder.page.accounts.origin.cli": "CLI 导入",
  "qoder.page.accounts.origin.oauth": "设备码登录",

  // ── 程序位 / 切换 / 昵称 / 分组（2026-10-15 补齐）──
  "qoder.page.accounts.program.desktop": "Qoder 桌面版",
  "qoder.page.accounts.program.cli": "Qoder CLI",
  // ★ 2026-10-28（用户要求）：页脚程序位与 WB / Trae 一致只放短名；完整名留在 tooltip。
  "qoder.page.accounts.program.desktopShort": "桌面",
  "qoder.page.accounts.program.cliShort": "CLI",
  "qoder.page.accounts.program.current": "当前登录",
  /* ★ 2026-10-28（口径对齐）：当前程序位胶囊的 tip —— 与 WB 的
     `wbAccounts.card.currentPlugin`（「{client} 当前账号」）、Trae 的
     `trae.comp.card.currentOf` 同义；此前 Qoder 只给程序位全名，读不出「这是当前登录的号」。 */
  "qoder.page.accounts.program.currentOf": "{label} 当前账号",
  "qoder.page.accounts.program.switchTo": "切换到此账号",
  "qoder.page.accounts.program.running": "客户端正在运行",
  "qoder.page.accounts.program.runningHint": "请先退出该客户端再切换 —— 否则它退出时会把内存里的登录态写回，覆盖这次切换。",
  "qoder.page.accounts.program.missing": "未检测到",
  "qoder.page.accounts.program.unreadable": "读不出来",
  "qoder.page.accounts.program.empty": "未登录",
  "qoder.page.accounts.switch.title": "切换账号",
  "qoder.page.accounts.switch.desc":
    "把「{name}」的凭据写入 {program} 的登录态。原登录态会先备份，写入后校验失败会自动还原。",
  "qoder.page.accounts.switch.confirm": "切换",
  "qoder.page.accounts.switch.cancel": "取消",
  "qoder.page.accounts.switch.done": "已切换到 {name}",
  "qoder.page.accounts.switch.backup": "原登录态已备份到 {path}",
  "qoder.page.accounts.group.label": "分组",
  "qoder.page.accounts.group.placeholder": "留空表示未分组",
  "qoder.page.accounts.group.saved": "分组已保存",
  "qoder.page.accounts.group.missing": "这条账号已不在库里 —— 分组未保存",
  "qoder.page.accounts.toolbar.group.group": "按自定义组",
  "qoder.page.accounts.toolbar.group.program": "按程序位",
  "qoder.page.accounts.toolbar.programBucket.none": "未登录任何程序位",
  "qoder.page.accounts.toolbar.groupBucket.ungrouped": "未分组",
  "qoder.page.accounts.card.setGroup": "设置分组",
  "qoder.page.accounts.refresh.batchPartial": "刷新成功 {ok} 个，失败 {fail} 个",

  // ── 用量（单位是 credits，不是 token）──
  "qoder.page.usage.title": "用量",
  "qoder.page.usage.subtitle": "{scope} · 近 {days} 天 · 单位 {unit}",
  "qoder.page.usage.unit.credits": "积分（credits）",
  "qoder.page.usage.sourceNote":
    "数据来自本机 Qoder 客户端的会话记录。Qoder 按 credits 计费，客户端记录的 token 计数恒为 0 —— 因此本视图统计的是 credits，不是 token。",
  "qoder.page.usage.totals.credits": "合计积分",
  "qoder.page.usage.totals.requests": "请求数",
  "qoder.page.usage.totals.sessions": "会话数",
  "qoder.page.usage.totals.models": "模型数",
  "qoder.page.usage.totals.sessionsCustomHint": "自定义区间不支持会话去重计数",
  "qoder.page.usage.trend": "每日积分",
  "qoder.page.usage.byModel": "按模型拆分",
  "qoder.page.usage.empty.title": "这段时间没有用量记录",
  "qoder.page.usage.empty.description": "本机客户端的会话记录里没有落在该窗口内的请求。",
  "qoder.page.usage.missing.title": "没有找到客户端会话记录",
  "qoder.page.usage.missing.description":
    "本机没有 Qoder 客户端的会话目录（{path}）—— 装好客户端并至少对话一次后这里会有数据。",
  "qoder.page.usage.loadFailed": "用量读取失败",
  "qoder.page.usage.recheck": "重新读取",
  "qoder.page.usage.window.label": "窗口",
  "qoder.page.usage.window.d7": "近 7 天",
  "qoder.page.usage.window.d30": "近 30 天",
  "qoder.page.usage.window.d90": "近 90 天",
  "qoder.page.usage.window.all": "全部",
  "qoder.page.usage.creditsValue": "{value} credits",
  "qoder.page.usage.caption": "合计 {total} credits · 单日峰值 {peak}",

  // ── OAuth 设备授权（2026-10-15 补齐：能力声明里早就有 oauth，此前是空头支票） ──
  "qoder.page.accounts.oauth.title": "设备码登录",
  "qoder.page.accounts.oauth.description":
    "在浏览器里完成 Qoder 授权，回到这里会自动采集账号（双区域的授权页不同，由当前作用域决定）。",
  "qoder.page.accounts.oauth.start": "开始登录",
  "qoder.page.accounts.oauth.starting": "正在发起…",
  "qoder.page.accounts.oauth.waiting": "等待浏览器完成授权…",
  "qoder.page.accounts.oauth.collected": "已采集账号：{name}",
  "qoder.page.accounts.oauth.failed": "登录失败",
  "qoder.page.accounts.oauth.close": "关闭",
  "qoder.page.accounts.oauth.entry": "设备码登录",
  "qoder.page.accounts.oauth.entryDesc": "用浏览器授权，适合本机还没装 Qoder 客户端的情况",

  // ── 回收站（软删除）──
  "qoder.page.accounts.trash.restored": "已恢复 {name}",
  "qoder.page.accounts.trash.undo": "撤销",

  // ── 签到 / 额度（后端早已就绪，此前无 UI 入口）──
  "qoder.page.accounts.chip.checkedIn": "今日已签",
  "qoder.page.accounts.chip.notCheckedIn": "今日未签",
  "qoder.page.accounts.chip.checkinUnavailable": "签到不可用",
  "qoder.page.accounts.metric.credits": "积分",
  // ★ 2026-10-26（复刻 WB）：`{remaining} / {total}` 已删除 —— 卡片与表格都改成分开渲染
  //   `<b>剩余</b>/总额`（千分位走 `formatCredits`），斜杠两侧不带空格，与 WB 的
  //   `积分 4,678.19/4,788` 逐字同形。
  // ★ 2026-10-28：本域的 `metric.creditsTip` 已删 —— 「剩余 · 总额 · 已用」改走 `account-card.tsx`
  //   导出的 `creditMetricTip`（WB 词条）：三平台同一句措辞，只可能有一份。
  // ★ 2026-10-28（用户要求）：`metric.plan` 词条已删 —— 卡片指标行不再显示套餐名，
  //   套餐名只在抽屉积分包行（`DetailPack.name` 直接用数据里的 `plan`，无需标签）。
  // ★ 2026-10-28（用户要求）：与 WB / Trae 同口径的「优先」标记（指标行末位纯文字）。
  "qoder.page.accounts.card.priority": "优先",
  "qoder.page.accounts.card.priorityTip": "建议优先使用",
  // ★ 2026-10-27：额度到期进抽屉积分包行（顶层 `expiresAt`，Unix 毫秒，Qoder SDK 口径）。
  "qoder.page.accounts.metric.used": "已用 {n}",
  "qoder.page.accounts.metric.expiresOn": "{date} 到期",
  // ★ 2026-10-29（用户报障）：上游用 9999-12-31 当「不过期」哨兵，此前被原样渲染成
  //   「9999-12-31 08:00 到期」。core 已把它归成 `expiresForever`，界面统一写这句。
  "qoder.page.accounts.metric.neverExpires": "长期有效",
  "qoder.page.accounts.metric.expired": "已到期",
  "qoder.page.accounts.credits.loading": "额度查询中…",
  "qoder.page.accounts.checkin.action": "签到",
  "qoder.page.accounts.checkin.already": "{name} 今日已签到",
  "qoder.page.accounts.checkin.done": "{name} 签到成功",
  "qoder.page.accounts.checkin.batchDone": "已签到 {n} 个账号",
  "qoder.page.accounts.checkin.batchPartial": "成功 {ok} 个，失败 {fail} 个",
  "qoder.page.accounts.checkin.resultOk": "签到成功 {n} 个",
  "qoder.page.accounts.checkin.resultFail": "签到失败 {n} 个",
  "qoder.page.accounts.refresh.done": "{name} 的令牌已刷新",
  "qoder.page.accounts.refresh.batchDone": "已刷新 {n} 个账号的令牌",
  "qoder.page.accounts.refresh.syncFailed": "续期已完成，界面同步失败",
  "qoder.page.accounts.refresh.syncFailedDesc": "令牌已换新，但账号列表回读失败。请重新读取，不要重复续期。",

  "qoder.page.accounts.toolbar.group.source": "按来源",
  "qoder.page.accounts.toolbar.group.checkin": "按签到",
  "qoder.page.accounts.toolbar.checkinBucket.checkedIn": "今日已签",
  "qoder.page.accounts.toolbar.checkinBucket.notCheckedIn": "今日未签",
  "qoder.page.accounts.toolbar.checkinBucket.unknown": "签到状态未知",

  "qoder.page.pending.title": "这个页面尚未接入 Qoder",
  "qoder.page.pending.description":
    "Qoder 的账号、用量、网关与设置已经可用；会话依赖客户端会话副本，尚未落地。",
  "qoder.page.pending.action": "去账号页",

  // ---- 设置 ----
  "qoder.page.settings.title": "设置",
  "qoder.page.settings.section.client": "客户端检测",
  "qoder.page.settings.client.description": "本机两处官方凭据存储的探测结果（只读，不落库）。",
  "qoder.page.settings.client.error": "探测失败：{error}",
  // ★ 计划任务（Qoder 的两类排程；排程是全局单份 `schedule_config.json`）
  "qoder.page.settings.schedule.checkinGroup": "自动签到",
  "qoder.page.settings.schedule.checkinEnable": "按排程自动签到",
  "qoder.page.settings.schedule.checkinDesc":
    "到点自动领取活动平台的积分奖励（默认关闭 —— 替你去领东西，需要你明确打开）。",
  "qoder.page.settings.schedule.checkinTimesLabel": "签到时点",
  "qoder.page.settings.schedule.checkinTimesDesc":
    "每天在这些时刻（本地时区）尝试一次；已有随机抖动，不会与官方风控撞在同一秒。",
  "qoder.page.settings.schedule.keepaliveGroup": "令牌保活",
  "qoder.page.settings.schedule.keepaliveEnable": "自动续期 refresh token",
  "qoder.page.settings.schedule.keepaliveDesc":
    "在令牌到期前 4 小时内续期（默认开启：refresh token 的唯一用途就是续期，它本来就是你在网页登录时交出来的）。",
  "qoder.page.settings.schedule.keepaliveTimesLabel": "保活时点",
  "qoder.page.settings.schedule.keepaliveTimesDesc": "每天在这些时刻检查一次是否临近到期。",
  "qoder.page.settings.schedule.saveFailed": "保存计划任务失败",
  "qoder.page.settings.filtered":
    "这里只列与当前客户端相关且有内容的分区；通用与备份已移到顶栏「应用设置」。签到 / 网关 / 权限诊断 / 日志等设置项会随对应功能落地后出现（不预先摆空壳）。",
} as const;
