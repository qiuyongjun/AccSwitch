//! 成长任务中心（`activity/growth/tasks`）—— 任务列表 / 报名 / 事件链点亮 / 领奖。
//!
//! 对照参考实现 `workbuddy2api-panel` 的 `internal/upstream/tasks.go` +
//! `internal/upstream/desktop.go` + `internal/panel/autotask.go`。
//!
//! ## 核心事实（决定了本模块的形状）
//!
//! 1. **进度不靠「完成任务」，靠行为事件上报**。上游 `/v2/report` 收 `eventCode` 数组，
//!    服务端按事件**加进度**；`accept` 只是报名，不产生进度。
//! 2. **不同任务认不同客户端指纹**，这是最容易踩的坑：
//!    - **CLI / 计分上报**：`www.codebuddy.cn`（走 [`billing_base`]，不带平台头）；
//!    - **桌面端**：`copilot.tencent.com` + `User-Agent: WorkBuddy/5.5.6 …` +
//!      `extName: workbuddy-desktop` 事件族（[`desktop_fingerprint`]）；
//!    - **Web 端**：`www.workbuddy.cn` + `x-client-platform: web` 的浏览器形状事件。
//!    用错指纹的事件**上游照收 200，但静默不计数** —— 表现为「上报成功但进度不动」。
//! 3. **上报 200 ≠ 计分**，且计分是**异步**的（实测 5–8 秒才刷新进度）。因此「点亮 →
//!    回读 → 领奖」必须带轮询（[`CLAIM_POLL_GAP`] / [`CLAIM_POLL_ATTEMPTS`]）。
//! 4. **领奖端点是 Web 域**：`POST www.workbuddy.cn/activity/growth/tasks/<code>/claim`
//!    （任务码在**路径**里、无 body、带 `x-client-platform: web`）。chat 域的
//!    `/activity/growth/tasks/<code>/claim` 只对小程序口径任务成立。
//! 5. **企业上下文要分两类拦**：真企业版个人成长接口一律 403；企业切换会话读得到，
//!    但行为事件上报 200 后被**静默丢弃**。见 [`ensure_not_enterprise`] 与
//!    [`ensure_personal_session`]。
//!
//! ## 本模块的范围（刻意收窄）
//!
//! 只实现**纯事件上报即可点亮**的任务（零对话消耗、零真实资源）：
//! `chat_5` / `first_buddy` / `RichMeow_Chat` / `Buddy_App(_QQ)` / `automation_1` /
//! `Library_read` / `template_5` / `playbook_prompt` / `create_canvas` / `Hp_Appearance`。
//!
//! **不做**：`expert_5` / `Expert_team_use_3` / `Expert_lighthouse` / `skill_1` /
//! `Model_chat_GLM5.2`（都需要真实 chat 并从中抓服务端 `requestId`，会消耗额度）；
//! `Expert_Philanthropy`（需真实捐款回执，无法绕过）；
//! `black_cat` / `school` 系列（已分别由 [`crate::modules::cat`] /
//! [`crate::modules::school`] 独立实现，不要在此重复）。
//!
//! ## 幂等
//!
//! 每个动作执行前先回读任务状态：`claimed` / 进度已达标一律跳过。行为事件按天幂等，
//! 重复点不会重复扣资源 —— 但**仍不应无脑重放**（多余往返 + 日志噪声），故保留前置判定。

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::modules::account::{account_display_name, load_accounts_for};
use crate::modules::activity::build_report_event;
use crate::modules::config::{authed_json_request_for, load_checkin_config, now_ms};
use crate::modules::refresh::ensure_fresh_token_for;
use crate::modules::region::{region_spec, Region};

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const TASKS_PATH: &str = "/v2/activity/growth/tasks";
const ACCEPT_PATH: &str = "/v2/activity/growth/tasks/accept";
const AGREEMENT_PATH: &str = "/activity/growth/buddy/agreement";
const FIRST_BUDDY_PATH: &str = "/activity/growth/buddy/first";
const APPEARANCE_SET_PATH: &str = "/v2/user-asset/appearance/set";
const REPORT_PATH: &str = "/v2/report";

/// 桌面客户端 UA（WorkBuddy 5.5.6 内嵌 CLI 2.137.1）。桌面指纹事件的判据之一。
const DESKTOP_UA: &str = "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1";
/// Web 域事件的浏览器 UA（服务端按 web 形状校验）。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
/// CN 的 Web 域（领奖 / Web 形状上报）。**不在** [`RegionSpec`] 里 —— 它只服务成长中心，
/// 与 chat / billing 两个基线域并列但用途单一，故收在模块内，不下沉到 region 表。
const WEB_BASE: &str = "https://www.workbuddy.cn";

/// `Buddy_App_QQ` 的判据应用（企鹅教师助手）。同一组事件也满足 `Buddy_App`「进入任一应用」。
const BUDDY_APP_ID: &str = "cb_y5Dy46tPQGGWtueMxXbe";
const BUDDY_APP_NAME: &str = "企鹅教师助手";
/// `Hp_Appearance` 的判据主题（和平精英·激战金秋）。
const HP_THEME_KEY: &str = "theme-tkmwj7";

/// 同一账号内两次上报之间的间隔（给上游事件处理留时间，参考实现实测口径 1050ms）。
pub const REPORT_GAP: Duration = Duration::from_millis(1050);
/// 点亮后回读进度的轮询间隔。上游计分异步，实测 5–8 秒落定。
pub const CLAIM_POLL_GAP: Duration = Duration::from_millis(2500);
/// 回读轮询次数（总预算 ≈ 7.5 秒 + 首次立即回读）。
pub const CLAIM_POLL_ATTEMPTS: u32 = 4;
/// 连续领奖之间的间隔。领奖本身不产生事件、不产生进度，只需避免瞬时并发。
const CLAIM_GAP: Duration = Duration::from_millis(400);
/// 报名之后、首条行为事件之前的间隔：报名若不先落库，事件可能被算在「未报名」的任务上。
const ACCEPT_SETTLE: Duration = Duration::from_millis(800);

// ---------------------------------------------------------------------------
// 纯函数：设备标识与事件载荷
// ---------------------------------------------------------------------------

/// 由 uid 稳定派生一个 36 位 hex 设备标识（`machineId` / `sessionId` 复用）。
///
/// 幂等是刻意的：同一账号每次上报都必须是**同一台设备**，否则上游把每轮事件当成
/// 新设备的行为，既不真实也更容易被判异常。
pub fn derive_device_id(uid: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{salt}:{uid}").as_bytes());
    let digest = hasher.finalize();
    digest[..18]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 桌面端公共指纹（注入每个事件，同名业务字段优先）。
///
/// 字段值对齐抓包样本：`ideName/ideType = WorkBuddy`、`extName = workbuddy-desktop`、
/// 固定版本号与构建信息。这些不是装饰 —— 服务端就是靠它们区分「桌面端真实行为」。
pub fn desktop_fingerprint(uid: &str, nickname: &str, at_ms: i64) -> Value {
    json!({
        "timezone": "Asia/Shanghai",
        "reportDelay": 2000,
        "userId": uid,
        "username": nickname,
        "userNickname": nickname,
        "product": "SaaS",
        "releaseDate": 1_789_036_585_355i64,
        "commit": "5f9692923c93033111c51ad7b003eb80204a9b75",
        "ideName": "WorkBuddy",
        "ideType": "WorkBuddy",
        "ideVersion": "5.5.6",
        "machineId": derive_device_id(uid, "machine"),
        "sessionId": derive_device_id(uid, "session"),
        "extName": "workbuddy-desktop",
        "extVersion": "5.5.6",
        "os": "win32",
        "arch": "x64",
        "osVersion": "10.0.26220",
        "cpuCores": 20,
        "memorySize": 24,
        "timestamp": at_ms,
        "presentAt": at_ms,
    })
}

/// 构造一次「桌面端成功对话」的完整事件链（6 事件）。
///
/// 顺序与 JOIN 关系都不能改：`agent_task_created` 起头，`chat_message_response`
/// 带 `isSuccessful: true` 作为**成功回执**（服务端对 RichMeow_Chat 明确校验这一条），
/// `chat_request_response` 收尾。中间三条用同一个 `requestId` 串起来。
pub fn build_desktop_chat_sequence(
    conversation_id: &str,
    request_id: &str,
    message_id: &str,
    model_id: &str,
    model_name: &str,
    at_ms: i64,
) -> Vec<Value> {
    let assistant_message = format!("{message_id}-assistant");
    vec![
        json!({
            "eventCode": "agent_task_created",
            "source": "LOCAL", "name": "working", "task_target": "local", "mode": "craft",
            "requestModelId": model_id, "requestModelName": model_name,
            "has_repo": false, "repo_type": "none", "workspace_type": "empty",
            "has_connector": false, "connector_types": [],
            "has_mention": false, "mention_types": [],
            "has_template": false, "action": "", "template_name": "",
            "has_expert": false, "expert_id": "", "expert_name": "", "expert_industry_id": "",
            "has_skill": false, "skill_names": [],
            "conversationId": conversation_id, "messageId": message_id,
            "buddyId": "", "buddyName": "",
        }),
        json!({
            "eventCode": "chat_message_send",
            "messageId": assistant_message, "historyCount": 0,
            "isContextTruncated": false, "currentStepCount": 1,
            "traceId": request_id, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
        }),
        json!({
            "eventCode": "chat_request_send",
            "inputLength": 24, "isPlan": false, "isAutoExecuteTerminal": false,
            "isAutoModify": false, "codebaseEnable": false, "maxToken": 0,
            "maxSteps": 500, "temperature": 0, "maxRetries": 0,
            "mentionContexts": [], "knowledgeId": [], "knowledgeName": [],
            "codebaseId": "", "mentionContextCount": 0, "command": "",
            "recommendId": "", "skillId": "", "skillCount": 0, "totalCount": 0,
            "traceId": request_id, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
            "codebuddy.session_id": conversation_id,
            "codebuddy.conversation_request_id": request_id,
        }),
        json!({
            "eventCode": "chat_message_response",
            "messageId": assistant_message, "responseModelId": model_id,
            "inputToken": 120, "outputToken": 80, "totalToken": 200,
            "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
            "isSuccessful": true, "messageErrorCode": "", "finishReason": "stop",
            "firstTokenAt": at_ms, "traceId": request_id,
            "conversationId": conversation_id,
            "rootRequestId": request_id, "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
            "codebuddy.session_id": conversation_id,
            "codebuddy.conversation_request_id": request_id,
        }),
        json!({
            "eventCode": "chat_message_status",
            "messageId": assistant_message, "messageErrorCode": "0",
            "traceId": request_id, "rootRequestId": request_id,
            "parentConversationId": conversation_id,
            "agentName": "cli", "agentType": "main",
        }),
        json!({
            "eventCode": "chat_request_response",
            "mode": "craft", "toolCallCount": 0,
            "inputToken": 120, "outputToken": 80, "totalToken": 200,
            "cachedTokens": 0, "cachedWriteTokens": 0, "cachedMissTokens": 0,
            "isSuccessful": true, "messageErrorCode": "", "finishReason": "stop",
            "rootRequestId": request_id, "parentConversationId": conversation_id,
        }),
    ]
}

/// 「进入 Buddy 应用」五连事件（`Buddy_App` 与 `Buddy_App_QQ` 共用）。
///
/// `discover → show → enter_click → auth_confirm → bindaccount_skip`：服务端判据是
/// 这条链的**完整度**，不校验真实授权（`bindaccount_skip_click` 就是「跳过绑定」，
/// 真实用户走这条路也是合法终态）。
pub fn build_buddy_app_sequence(buddy_id: &str, buddy_name: &str) -> Vec<Value> {
    let base = || {
        json!({
            "mode": "LOCAL",
            "buddyId": buddy_id, "buddyName": buddy_name,
        })
    };
    let with = |code: &str, extra: Value| {
        let mut event = base();
        event["eventCode"] = json!(code);
        if let (Some(target), Some(source)) = (event.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        event
    };
    vec![
        with("buddyapp_discover_click", json!({})),
        with(
            "buddyapp_show",
            json!({"elementId": buddy_id, "elementName": buddy_name, "position": 2}),
        ),
        with(
            "buddyapp_enter_click",
            json!({
                "elementId": buddy_id, "elementName": buddy_name,
                "position": 2, "isFirstPage": "1",
            }),
        ),
        with(
            "buddyapp_auth_confirm_click",
            json!({"elementId": buddy_id, "elementName": buddy_name}),
        ),
        with(
            "buddyapp_bindaccount_skip_click",
            json!({"elementId": buddy_id, "elementName": buddy_name}),
        ),
    ]
}

/// 「定时任务创建成功」事件（`automation_1` 判据）。不校验真实任务是否落地。
pub fn build_automation_create_event(name: &str) -> Value {
    json!({
        "eventCode": "automated_task_create_suc", "name": name,
        "source": "manually", "modelId": "fast-model", "modelIsThinking": true,
        "connectorCount": 0, "skills": "", "skillCount": 0,
        "scheduleType": "once", "mode": "LOCAL",
    })
}

/// 「使用模板创建任务」事件组（`template_5` 计数口径）：一条完整 chat 链 +
/// `agent_task_created_with_template` + `template_used`。
///
/// `template_id` 由模板真实 id 决定，但服务端**不校验**该 id 是否存在于市场 ——
/// 判据是「模板创建任务」这个行为组合本身。
pub fn build_template_use_sequence(
    conversation_id: &str,
    request_id: &str,
    template_id: &str,
    template_name: &str,
    at_ms: i64,
) -> Vec<Value> {
    let mut events = build_desktop_chat_sequence(
        conversation_id,
        request_id,
        &format!("msg-{template_id}"),
        "fast-model",
        "fast-model",
        at_ms,
    );
    mark_template_origin(&mut events, template_name);
    events.push(json!({
        "eventCode": "agent_task_created_with_template", "mode": "working",
        "isCustomModel": false,
        "id": template_id, "name": template_name, "requestId": request_id,
    }));
    events.push(json!({
        "eventCode": "template_used", "template_id": template_id, "task_mode": "working",
    }));
    events
}

/// 把「这条对话是选模板发起的」写进 `agent_task_created`。
///
/// 判据是「选模板 → 发送 → 发起对话计 1 次」，而通用对话链把 `has_template` 固定成
/// `false`、`template_name` 留空。同一组事件里出现「对话没带模板 / 又有 template_used」
/// 这种自相矛盾的载荷，服务端只会取更保守的那个结论 —— 于是整组不计分（实测：进度不动）。
fn mark_template_origin(events: &mut [Value], template_name: &str) {
    let Some(first) = events.first_mut() else {
        return;
    };
    first["has_template"] = json!(true);
    first["action"] = json!("template");
    first["template_name"] = json!(template_name);
}

/// 「灵感案例做同款」事件组（`playbook_prompt` 判据）：chat 链 + 三次点击/发送。
///
/// 关键点在 `playbook_prompt_send`（Dialog 里**真的发出 Prompt**）——
/// 卡片曝光与 CTA 点击单独上报都不计数。
pub fn build_playbook_prompt_sequence(
    conversation_id: &str,
    request_id: &str,
    case_id: &str,
    case_name: &str,
    at_ms: i64,
) -> Vec<Value> {
    let mut events = build_desktop_chat_sequence(
        conversation_id,
        request_id,
        "msg-pb",
        "fast-model",
        "fast-model",
        at_ms,
    );
    // 两个点击事件共享同一份「案例」载荷（id/name/type/分类），只有 eventCode
    // 与 JOIN 字段不同。用 `merge_fingerprint` 做「载荷打底 + 事件覆盖」，
    // 避免手写两遍五个同名字段（写漏一个就是判据不完整）。
    let case_payload = json!({
        "id": case_id, "name": case_name, "type": "document",
        "categoryId": "", "categoryName": "",
    });
    events.push(json!({
        "eventCode": "web_element_click", "pageName": "playbook_detail",
        "elementId": "playbook_ctaClick", "elementName": case_name, "source": "discover",
    }));
    events.push(merge_fingerprint(
        &case_payload,
        &json!({"eventCode": "playbook_cta_click", "source": "discover", "position": 0}),
    ));
    events.push(merge_fingerprint(
        &case_payload,
        &json!({
            "eventCode": "playbook_prompt_send",
            "conversationId": conversation_id, "requestId": request_id,
        }),
    ));
    events
}

/// 「设计创意画布」事件组（`create_canvas` 判据，+300 分）。
pub fn build_design_canvas_sequence(
    conversation_id: &str,
    request_id: &str,
    at_ms: i64,
) -> Vec<Value> {
    let mut events = build_desktop_chat_sequence(
        conversation_id,
        request_id,
        "msg-canvas",
        "fast-model",
        "fast-model",
        at_ms,
    );
    let tail = request_id
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    events.push(json!({
        "eventCode": "wbx_design_canvas_task_create", "conversationId": conversation_id,
        "requestId": request_id, "source": "summon_keyword",
        "cost": 12000, "isSuccessful": true,
    }));
    events.push(json!({
        "eventCode": "wbx_design_canvas_open", "conversationId": conversation_id,
        "requestId": request_id, "id": format!("ardot-file-{tail}"),
        "source": "summon_keyword", "type": "page", "cost": 13000, "isSuccessful": true,
    }));
    events
}

/// 「皮肤生效」事件（`Hp_Appearance` 判据）。
///
/// 判据是**在主题生效状态下离开设置页**时上报的 `appearance_skin_apply`，
/// 不是 `/appearance/set` 调用本身 —— 后者只留痕，单独调不计分。
pub fn build_appearance_apply_event(theme_key: &str) -> Value {
    json!({
        "eventCode": "appearance_skin_apply", "action": "apply", "source": "settings_close",
        "id": theme_key, "vipLevel": 0, "series": "", "type": "unknown",
    })
}

/// Web 形状的页面点击事件（`Library_read` 判据）。
///
/// 与桌面指纹**互不通用**：web 域事件是浏览器形状（`os: Win32` / `machineId` /
/// `userAgent`），发到 chat 域不计数，反之亦然。
pub fn build_web_click_event(
    uid: &str,
    nickname: &str,
    event_code: &str,
    page_url: &str,
    element_id: &str,
    element_name: &str,
    at_ms: i64,
) -> Value {
    json!({
        "eventCode": event_code,
        "timestamp": at_ms,
        "reportDelay": 0,
        "pageURL": page_url,
        "elementId": element_id,
        "elementName": element_name,
        "os": "Win32", "arch": "", "osVersion": "10.0",
        "userAgent": BROWSER_UA,
        "machineId": derive_device_id(uid, "webmachine"),
        "userId": uid,
        "userNickname": nickname,
    })
}

/// 把公共指纹注入业务事件：**业务字段优先**（可覆盖 `machineId` 等做真实设备对齐）。
pub fn merge_fingerprint(fingerprint: &Value, event: &Value) -> Value {
    let mut merged = fingerprint.as_object().cloned().unwrap_or_default();
    if let Some(source) = event.as_object() {
        for (key, value) in source {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

// ---------------------------------------------------------------------------
// 任务模型
// ---------------------------------------------------------------------------

/// 单个成长任务的对外视图（字段名与上游对齐，多余字段不透出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrowthTask {
    pub task_code: String,
    pub title: String,
    pub description: String,
    /// 奖励积分（上游 `reward_credit`）。
    pub credit: i64,
    /// 奖励能量（上游 `reward_energy`）。
    pub energy: i64,
    /// 目标次数；`0` 也是有效值（部分一次性任务不带 target）。
    pub target: i64,
    /// 当前进度。
    pub current: i64,
    pub accept_status: String,
    pub locked: bool,
    pub claimed: bool,
    pub claimable: bool,
}

impl GrowthTask {
    /// 进度文本：`3/5` 或「已达标」。
    pub fn progress_text(&self) -> String {
        if self.target <= 0 {
            return if self.claimed {
                "已领取".to_string()
            } else {
                "—".to_string()
            };
        }
        format!("{}/{}", self.current.min(self.target), self.target)
    }
}

/// 解析任务列表响应 `data.tasks[]`。
///
/// 宽松解析是刻意的：`progress` 在不同任务形态下是**嵌套对象** `{current,target}`，
/// 也可能根本没有（进度平铺在 `current`/`target`）。两种形状都要吃下，
/// 否则会有一半任务进度恒为 0（表现为「明明完成了却不可领」）。
pub fn parse_tasks(resp: &Value) -> Vec<GrowthTask> {
    let tasks = resp
        .pointer("/data/tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    tasks
        .into_iter()
        .filter_map(|task| {
            let task_code = task.get("task_code").and_then(Value::as_str)?.to_string();
            let mut current = task.get("current").and_then(Value::as_i64).unwrap_or(0);
            let mut target = task.get("target").and_then(Value::as_i64).unwrap_or(0);
            if let Some(progress) = task.get("progress").filter(|v| !v.is_null()) {
                let nested_current = progress.get("current").and_then(Value::as_i64);
                let nested_target = progress.get("target").and_then(Value::as_i64);
                if nested_target.unwrap_or(0) > 0 || nested_current.unwrap_or(0) > 0 {
                    current = nested_current.unwrap_or(current);
                    target = nested_target.unwrap_or(target);
                }
            }
            let accept_status = task
                .get("accept_status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let claimed = accept_status == "claimed";
            let claimable = !claimed && target > 0 && current >= target;
            Some(GrowthTask {
                task_code,
                title: task
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                description: task
                    .get("description")
                    .or_else(|| task.get("task_desc"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                credit: task
                    .get("reward_credit")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                energy: task
                    .get("reward_energy")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                target,
                current,
                accept_status,
                locked: task.get("locked").and_then(Value::as_bool).unwrap_or(false),
                claimed,
                claimable,
            })
        })
        .collect()
}

/// 领奖结果：`already_claimed` 时 `credit/energy` 为 0（幂等，不算失败）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClaimOutcome {
    pub credit: i64,
    pub energy: i64,
    pub already_claimed: bool,
}

/// 解析领奖响应 `data`：`{"already_claimed":bool,"credit":n,"energy":n}`。
pub fn parse_claim(resp: &Value) -> ClaimOutcome {
    let data = resp.get("data").unwrap_or(resp);
    ClaimOutcome {
        credit: data.get("credit").and_then(Value::as_i64).unwrap_or(0),
        energy: data.get("energy").and_then(Value::as_i64).unwrap_or(0),
        already_claimed: data
            .get("already_claimed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

/// 成功判据：HTTP 2xx 且业务 `code` 为 0 或缺失。
pub fn is_ok(status: u16, resp: &Value) -> bool {
    (200..300).contains(&status)
        && matches!(
            resp.get("code").and_then(Value::as_i64),
            Some(0) | Some(200) | None
        )
}

// ---------------------------------------------------------------------------
// 动作注册表
// ---------------------------------------------------------------------------

/// 一个可自动化的任务动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAction {
    Chat5,
    FirstBuddy,
    RichMeow,
    BuddyApp,
    AutomationCreate,
    LibraryRead,
    TemplateUse,
    PlaybookPrompt,
    CreateCanvas,
    Appearance,
}

/// 动作条目：任务码 + 动作 + 面板文案。**顺序即执行顺序**（`first_buddy` 依赖前置活跃上报）。
pub struct ActionSpec {
    pub code: &'static str,
    pub action: TaskAction,
    pub desc: &'static str,
}

/// 已实现的动作表（唯一事实来源：`action_for` 与面板文案都读它）。
pub const ACTIONS: &[ActionSpec] = &[
    ActionSpec {
        code: "chat_5",
        action: TaskAction::Chat5,
        desc: "补报 5 条对话活跃事件（按差额）",
    },
    ActionSpec {
        code: "first_buddy",
        action: TaskAction::FirstBuddy,
        desc: "前置上报 → 同意协议 → 领取首只 Buddy（+300 分）",
    },
    ActionSpec {
        code: "RichMeow_Chat",
        action: TaskAction::RichMeow,
        desc: "桌面端完整对话事件链（6 事件，含成功回执）",
    },
    ActionSpec {
        code: "Buddy_App",
        action: TaskAction::BuddyApp,
        desc: "进入 Buddy 应用五连事件",
    },
    ActionSpec {
        code: "Buddy_App_QQ",
        action: TaskAction::BuddyApp,
        desc: "进入企鹅教师助手五连事件（与 Buddy_App 同一组）",
    },
    ActionSpec {
        code: "automation_1",
        action: TaskAction::AutomationCreate,
        desc: "定时任务创建成功事件",
    },
    ActionSpec {
        code: "Library_read",
        action: TaskAction::LibraryRead,
        desc: "资料库介绍阅读点击（Web 域）",
    },
    ActionSpec {
        code: "template_5",
        action: TaskAction::TemplateUse,
        desc: "使用 5 个模板创建任务事件组",
    },
    ActionSpec {
        code: "playbook_prompt",
        action: TaskAction::PlaybookPrompt,
        desc: "灵感案例「做同款」发送 Prompt",
    },
    ActionSpec {
        code: "create_canvas",
        action: TaskAction::CreateCanvas,
        desc: "设计创意画布创建事件组（+300 分）",
    },
    ActionSpec {
        code: "Hp_Appearance",
        action: TaskAction::Appearance,
        // ⚠️ 上游只提供 `appearance/set`，没有可读的「当前主题」接口 —— 读到不到原值也就
        // 无法还原，所以副作用必须写在用户看得见的地方（面板就渲染这行 `desc`）。
        desc: "切换到「激战金秋」主题 + 生效事件（不会还原你原来的主题）",
    },
];

/// 查任务码对应的动作；无则 `None`（表示本模块不接管）。
pub fn action_for(code: &str) -> Option<&'static ActionSpec> {
    let code = code.trim();
    ACTIONS.iter().find(|spec| spec.code == code)
}

/// 该任务码是否由本模块自动化。
pub fn is_autoable(code: &str) -> bool {
    action_for(code).is_some()
}

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

/// growth 域请求头（成长中心页面形状）。任务列表 / 报名都按这个口径。
fn growth_extra(region: Region) -> HashMap<String, String> {
    let base = region_spec(region).billing_base;
    let mut headers = HashMap::new();
    headers.insert("x-client-platform".to_string(), "web".to_string());
    headers.insert("origin".to_string(), base.to_string());
    headers.insert(
        "referer".to_string(),
        format!("{base}/profile/growth-center"),
    );
    headers
}

/// 桌面指纹上报的请求头（UA / 域名 / 产品三者共同构成桌面判据）。
fn desktop_extra(region: Region, uid: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    headers.insert(
        "Accept".to_string(),
        "application/json, text/plain, */*".to_string(),
    );
    headers.insert(
        "Content-Type".to_string(),
        "application/json;charset=UTF-8".to_string(),
    );
    headers.insert("User-Agent".to_string(), DESKTOP_UA.to_string());
    headers.insert(
        "X-Domain".to_string(),
        region_spec(region).chat_base.to_string(),
    );
    headers.insert("X-Product".to_string(), "SaaS".to_string());
    headers.insert(
        "X-Request-ID".to_string(),
        format!(
            "{}{}",
            derive_device_id(uid, "req"),
            now_ms().rem_euclid(1_000_000)
        ),
    );
    headers
}

/// Web 形状上报的请求头（`x-client-platform: web` + 浏览器 UA + Origin/Referer）。
fn web_extra(page_url: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    headers.insert("Accept".to_string(), "application/json".to_string());
    headers.insert("x-client-platform".to_string(), "web".to_string());
    headers.insert("Origin".to_string(), WEB_BASE.to_string());
    headers.insert("Referer".to_string(), page_url.to_string());
    headers.insert("User-Agent".to_string(), BROWSER_UA.to_string());
    headers
}

async fn chat_json(
    region: Region,
    path: &str,
    method: &str,
    body: Option<Value>,
    account: &Value,
) -> (u16, Value) {
    let url = format!("{}{path}", region_spec(region).chat_base);
    authed_json_request_for(region, &url, method, body, account, &growth_extra(region)).await
}

async fn billing_json(
    region: Region,
    path: &str,
    method: &str,
    body: Option<Value>,
    account: &Value,
) -> (u16, Value) {
    let url = format!("{}{path}", region_spec(region).billing_base);
    authed_json_request_for(region, &url, method, body, account, &HashMap::new()).await
}

/// 以桌面指纹向 `copilot.tencent.com/v2/report` 上报一批事件。
async fn post_desktop_events(region: Region, account: &Value, events: &[Value]) -> (u16, Value) {
    if events.is_empty() {
        return (400, json!({"message": "no events"}));
    }
    let uid = account.get("uid").and_then(Value::as_str).unwrap_or("");
    let nickname = account_display_name(account);
    let at_ms = now_ms();
    let fingerprint = desktop_fingerprint(uid, &nickname, at_ms);
    let body: Vec<Value> = events
        .iter()
        .map(|event| merge_fingerprint(&fingerprint, event))
        .collect();
    let url = format!("{}{REPORT_PATH}", region_spec(region).chat_base);
    authed_json_request_for(
        region,
        &url,
        "POST",
        Some(Value::Array(body)),
        account,
        &desktop_extra(region, uid),
    )
    .await
}

/// 以 Web 形状向 `www.workbuddy.cn/v2/report` 上报单个事件。
async fn post_web_event(region: Region, account: &Value, event: Value) -> (u16, Value) {
    let page_url = event
        .get("pageURL")
        .and_then(Value::as_str)
        .unwrap_or(WEB_BASE)
        .to_string();
    let url = format!("{WEB_BASE}{REPORT_PATH}");
    authed_json_request_for(
        region,
        &url,
        "POST",
        Some(Value::Array(vec![event])),
        account,
        &web_extra(&page_url),
    )
    .await
}

/// 补报 `count` 条 `chat_request_send`（CLI / 计分口径，走 billing 域）。
///
/// 返回成功条数。之所以逐条发而不是一次发 N 条：上游按请求批处理，一次多发在
/// 部分账号上只算 1 次（实测），逐条才与「真实对话 N 次」等价。
async fn report_chat_activity(region: Region, account: &Value, count: i64) -> i64 {
    if count <= 0 {
        return 0;
    }
    let uid = account.get("uid").and_then(Value::as_str).unwrap_or("");
    let mut done = 0;
    for index in 0..count {
        let conversation_id = format!("bs-tasks-{}-{index}", now_ms());
        let event = build_report_event(&conversation_id, &conversation_id, uid, now_ms());
        let (status, resp) =
            billing_json(region, REPORT_PATH, "POST", Some(json!([event])), account).await;
        if !is_ok(status, &resp) {
            break;
        }
        done += 1;
        if index + 1 < count {
            tokio::time::sleep(REPORT_GAP).await;
        }
    }
    done
}

// ---------------------------------------------------------------------------
// 对外操作
// ---------------------------------------------------------------------------

/// 本模块只服务 CN。国际版（`workbuddy.ai`）没有这套成长体系，早失败比静默空列表好。
fn ensure_supported(region: Region) -> Result<(), String> {
    match region {
        Region::Cn => Ok(()),
        Region::Global => Err("国际版暂无成长任务体系".to_string()),
    }
}

/// 企业版账号无个人成长体系（上游对 `growth system is only available for personal users`
/// 直接 403）。早失败比打一串 403 好，也避免卡片挂一张没有意义的标签。
const ENTERPRISE_NO_GROWTH: &str = "企业版账号没有个人成长任务体系（上游仅对个人用户开放）";

/// 企业切换会话：**读端点照常、行为事件静默丢弃**（上报 200 但不计分）。
/// 执行动作必须拒绝，否则每轮都白跑（参考实现 `Auth.IsEnterpriseSession` 的口径）。
const ENTERPRISE_SWITCH_NO_SCORE: &str = "该账号是企业切换会话：行为事件会被上游静默丢弃（上报 200 但不计分），请在浏览器退出企业空间后重新登录";

/// 账号的企业 ID（两种键名都认；空白按缺失处理）。
fn enterprise_id(account: &Value) -> Option<&str> {
    ["enterpriseId", "enterprise_id"].iter().find_map(|key| {
        account
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

/// 解 JWT payload 的 `token_source` 是否为 `enterprise_switch`。
///
/// 非 JWT / 解不出 / 信封凭据一律按「无此声明」处理（fail-open）—— 老 token 与
/// 非标准签发不该被误判成企业会话。JWT 标准是 base64url 无填充，兼容带填充形态。
fn is_enterprise_switch_token(token: &str) -> bool {
    use base64::Engine as _;
    let Some(payload) = token.split('.').nth(1) else {
        return false;
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload));
    let Ok(bytes) = decoded else {
        return false;
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|payload| {
            payload
                .get("token_source")
                .and_then(Value::as_str)
                .map(|source| source == "enterprise_switch")
        })
        .unwrap_or(false)
}

/// 当前凭据是否签发自企业切换会话（JWT `token_source=enterprise_switch`）。
fn is_enterprise_switch_session(account: &Value) -> bool {
    account
        .get("access_token")
        .and_then(Value::as_str)
        .is_some_and(is_enterprise_switch_token)
}

/// 真企业版闸门：列表 / 领奖这类读或只读奖励动作也一并拒绝（上游一律 403）。
///
/// 企业切换会话**放行**：任务列表读得到，已达标的手工任务也能正常领奖。
fn ensure_not_enterprise(account: &Value) -> Result<(), String> {
    if enterprise_id(account).is_some() {
        return Err(ENTERPRISE_NO_GROWTH.to_string());
    }
    Ok(())
}

/// 执行类动作闸门（报名 / 发行为事件）：真企业版与企业切换会话都拒绝。
///
/// 报名本身不产生进度，但缺了报名后续事件可能不计分；对企业切换会话放行报名只会
/// 留下「已报名未上报」的半程态，不如在入口一次说清。
fn ensure_personal_session(account: &Value) -> Result<(), String> {
    ensure_not_enterprise(account)?;
    if is_enterprise_switch_session(account) {
        return Err(ENTERPRISE_SWITCH_NO_SCORE.to_string());
    }
    Ok(())
}

/// 拉取任务列表（含 `autoable` 标记，前端据此决定是否显示「执行」按钮）。
///
/// 返回值是**面向前端的 JSON**：桌面端与 webui 共用同一形状，避免两侧各写一份映射。
pub async fn list_tasks_for(region: Region, account: &Value) -> Value {
    if let Err(message) = ensure_supported(region) {
        return json!({"ok": false, "message": message, "tasks": []});
    }
    if let Err(message) = ensure_not_enterprise(account) {
        return json!({"ok": false, "message": message, "tasks": []});
    }
    let account = ensure_fresh_token_for(region, account.clone(), &load_checkin_config()).await;
    let tasks = match fetch_tasks(region, &account).await {
        Ok(tasks) => tasks,
        Err(message) => {
            return json!({"ok": false, "message": message, "tasks": []});
        }
    };
    let views: Vec<Value> = tasks
        .iter()
        .map(|task| {
            json!({
                "taskCode": task.task_code,
                "title": if task.title.is_empty() { task.task_code.clone() } else { task.title.clone() },
                "description": task.description,
                "credit": task.credit,
                "energy": task.energy,
                "target": task.target,
                "current": task.current,
                "progress": task.progress_text(),
                "acceptStatus": task.accept_status,
                "locked": task.locked,
                "claimed": task.claimed,
                "claimable": task.claimable,
                "autoable": is_autoable(&task.task_code),
                "actionDesc": action_for(&task.task_code).map(|spec| spec.desc).unwrap_or(""),
            })
        })
        .collect();
    let claimable = tasks.iter().filter(|task| task.claimable).count();
    let claimed = tasks.iter().filter(|task| task.claimed).count();
    let autoable = tasks
        .iter()
        .filter(|task| is_autoable(&task.task_code) && !task.claimed && !task.locked)
        .count();
    json!({
        "ok": true,
        "tasks": views,
        "total": tasks.len(),
        "claimable": claimable,
        "claimed": claimed,
        "autoable": autoable,
        "account": account_display_name(&account),
    })
}

/// 拉一次任务列表并解析成结构体。**唯一**的取数内核 —— 列表视图与卡片摘要都走它，
/// 避免「两处各写一遍请求 + 解析」后口径漂移（摘要说可领 1、点进去却没得领）。
async fn fetch_tasks(region: Region, account: &Value) -> Result<Vec<GrowthTask>, String> {
    let (status, resp) = chat_json(region, TASKS_PATH, "GET", None, account).await;
    if !is_ok(status, &resp) {
        return Err(error_message(&resp));
    }
    Ok(parse_tasks(&resp))
}

/// 取响应里的可读文案（`message` / `msg`），空则给出状态占位。
fn error_message(resp: &Value) -> String {
    resp.get("message")
        .or_else(|| resp.get("msg"))
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or("上游返回异常")
        .to_string()
}

/// 报名（`not_accepted → accepted`）。幂等：已报名时上游返回成功或业务提示，均不当致命错误。
pub async fn accept_tasks_for(region: Region, account: &Value, codes: &[String]) -> Value {
    if let Err(message) = ensure_supported(region) {
        return json!({"ok": false, "message": message});
    }
    if let Err(message) = ensure_personal_session(account) {
        return json!({"ok": false, "message": message});
    }
    if codes.is_empty() {
        return json!({"ok": true, "message": "无可报名任务"});
    }
    let account = ensure_fresh_token_for(region, account.clone(), &load_checkin_config()).await;
    let (status, resp) = chat_json(
        region,
        ACCEPT_PATH,
        "POST",
        Some(json!({ "task_codes": codes })),
        &account,
    )
    .await;
    json!({
        "ok": is_ok(status, &resp),
        "status": status,
        "message": if is_ok(status, &resp) { format!("已报名 {} 个任务", codes.len()) } else { error_message(&resp) },
    })
}

/// 校验任务码并返回去除首尾空白后的切片。
///
/// 任务码会**直接拼进 URL 路径**（`/activity/growth/tasks/<code>/claim`），不校验就等于
/// 允许调用方指定任意路径 —— webui 支持 `--host 0.0.0.0` 部署，带的是用户自己的 Bearer。
/// 上游真实任务码含点号（如 `Model_chat_GLM5.2`），故白名单必须放行 `.`。
fn validate_task_code(code: &str) -> Result<&str, String> {
    let code = code.trim();
    let valid = !code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if valid {
        Ok(code)
    } else {
        Err(format!("任务码非法：{code}"))
    }
}

/// 领取单个任务奖励。
///
/// **Web 域优先**：成长中心的真实领奖请求打 `www.workbuddy.cn`（任务码在路径、无 body）。
/// chat 域的同一个路径只对小程序口径任务成立 —— 故 404/405 时回落 chat 域兜底，
/// 但 400（`task not completed` / 已领）**不**回落：那是业务结论，不是路由错。
pub async fn claim_task_for(
    region: Region,
    account: &Value,
    code: &str,
) -> (bool, ClaimOutcome, String) {
    if let Err(message) = ensure_supported(region) {
        return (false, ClaimOutcome::default(), message);
    }
    if let Err(message) = ensure_not_enterprise(account) {
        return (false, ClaimOutcome::default(), message);
    }
    let code = match validate_task_code(code) {
        Ok(code) => code,
        Err(message) => return (false, ClaimOutcome::default(), message),
    };
    // 与 `list` / `accept` / `auto` / `claim_all` 保持一致：进入动作前主动刷一次 token。
    // 401 兜底能救，但那是多一次往返，且 web→chat 回落时会再撞一次。
    let account = ensure_fresh_token_for(region, account.clone(), &load_checkin_config()).await;
    let path = format!("/activity/growth/tasks/{code}/claim");
    let web_url = format!("{WEB_BASE}{path}");
    let page = format!("{WEB_BASE}/profile/growth-center");
    let (status, resp) =
        authed_json_request_for(region, &web_url, "POST", None, &account, &web_extra(&page)).await;
    if status == 404 || status == 405 {
        let (chat_status, chat_resp) = chat_json(region, &path, "POST", None, &account).await;
        if is_ok(chat_status, &chat_resp) {
            return (true, parse_claim(&chat_resp), String::new());
        }
        return (false, ClaimOutcome::default(), error_message(&chat_resp));
    }
    if !is_ok(status, &resp) {
        return (false, ClaimOutcome::default(), error_message(&resp));
    }
    let outcome = parse_claim(&resp);
    let message = if outcome.already_claimed {
        "已领取过".to_string()
    } else {
        format!("+{} 积分 +{} 能量", outcome.credit, outcome.energy)
    };
    (true, outcome, message)
}

// ---------------------------------------------------------------------------
// 动作执行
// ---------------------------------------------------------------------------

/// 选出本轮要发的模板区间：从**已计过数的位置之后**取，最多补 `need` 个。
///
/// 上游按「不同模板」累计次数，重发已计过数的模板不会加进度 —— 所以起点必须是
/// `current`，不能是 0（曾经的 `take(count)` 就卡在这里：差额 1 时永远重发第 1 个）。
fn template_window(current: i64, need: i64, total: usize) -> (usize, usize) {
    let start = (current.max(0) as usize).min(total.saturating_sub(1));
    let count = need.clamp(1, (total - start) as i64) as usize;
    (start, count)
}

/// 执行一个动作。成功返回可展示的说明；失败返回 `Err(原因)`。
///
/// `need` 仅对累计型任务（`chat_5` / `template_5`）有意义：调用方按回读的任务目标算差额，
/// 避免「每次点都补满 5 条」。`current` 是当前进度，只有 `template_5` 用它决定**从第几个
/// 模板开始发** —— 上游按不同模板计数，重发已计过数的模板等于空转。
pub async fn run_action_for(
    region: Region,
    account: &Value,
    spec: &ActionSpec,
    need: i64,
    current: i64,
) -> Result<String, String> {
    let uid = account
        .get("uid")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let nickname = account_display_name(account);
    let at_ms = now_ms();
    match spec.action {
        TaskAction::Chat5 => {
            let count = need.max(1);
            let done = report_chat_activity(region, account, count).await;
            if done <= 0 {
                return Err("对话活跃上报失败（上游未接受事件）".to_string());
            }
            Ok(format!("已补报 {done} 条对话活跃事件"))
        }
        TaskAction::FirstBuddy => {
            report_chat_activity(region, account, 1).await;
            tokio::time::sleep(REPORT_GAP).await;
            let (status, resp) =
                billing_json(region, AGREEMENT_PATH, "POST", Some(json!({})), account).await;
            if !is_ok(status, &resp) {
                return Err(format!("同意协议失败：{}", error_message(&resp)));
            }
            let (status, resp) =
                billing_json(region, FIRST_BUDDY_PATH, "POST", Some(json!({})), account).await;
            if !is_ok(status, &resp) {
                // 领养门槛（当日活跃）刚上报、上游可能还没算完。这里**不猜**上游文案：
                // 一律按失败上抛并附上「稍后再点一次」的行动指引 —— 把「未完成」伪装成
                // 成功会让用户以为拿到了 300 分，比报错坏得多。
                return Err(format!(
                    "领取 Buddy 未通过（上游：{}）；前置活跃已上报，稍后再点一次可重试",
                    error_message(&resp)
                ));
            }
            Ok("已领取首只 Buddy（+300 积分 +8 能量）".to_string())
        }
        TaskAction::RichMeow => {
            let conversation = format!("bs-rm-{at_ms}");
            let request = format!("bs-rm-req-{at_ms}");
            let events = build_desktop_chat_sequence(
                &conversation,
                &request,
                &format!("bs-rm-msg-{at_ms}"),
                "fast-model",
                "fast-model",
                at_ms,
            );
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("桌面事件链上报失败：{}", error_message(&resp)));
            }
            Ok("已上报桌面端完整对话事件链（6 事件）".to_string())
        }
        TaskAction::BuddyApp => {
            let events = build_buddy_app_sequence(BUDDY_APP_ID, BUDDY_APP_NAME);
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("Buddy 应用事件上报失败：{}", error_message(&resp)));
            }
            Ok("已上报进入应用五连事件（覆盖 Buddy_App 与 Buddy_App_QQ）".to_string())
        }
        TaskAction::AutomationCreate => {
            let events = vec![build_automation_create_event("Buddy Switch 自动化")];
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("定时任务事件上报失败：{}", error_message(&resp)));
            }
            Ok("已上报定时任务创建成功事件".to_string())
        }
        TaskAction::LibraryRead => {
            let event = build_web_click_event(
                &uid,
                &nickname,
                "web_element_click",
                "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm",
                "library_doc_intro_click",
                "WorkBuddy资料库介绍",
                at_ms,
            );
            let (status, resp) = post_web_event(region, account, event).await;
            if !is_ok(status, &resp) {
                return Err(format!("资料库事件上报失败：{}", error_message(&resp)));
            }
            Ok("已上报资料库介绍阅读事件".to_string())
        }
        TaskAction::TemplateUse => {
            let templates = [
                ("tpl-deep-research", "深度研究"),
                ("tpl-weekly-report", "周报生成"),
                ("tpl-competitor", "竞品分析"),
                ("tpl-campaign", "活动策划"),
                ("tpl-code-review", "代码评审"),
            ];
            // 按差额决定发几组，且**从已计过数的位置之后取**（见 [`template_window`]）。
            let (start, count) = template_window(current, need, templates.len());
            let mut sent = 0;
            for (template_id, template_name) in templates[start..].iter().take(count) {
                let stamp = now_ms() + sent as i64;
                let conversation = format!("bs-tpl-{stamp}");
                let request = format!("bs-tpl-req-{stamp}");
                let events = build_template_use_sequence(
                    &conversation,
                    &request,
                    template_id,
                    template_name,
                    stamp,
                );
                // 注意：必须只发一次。`post_desktop_events(...).await.0` 与再次 `.await.1`
                // 会实打实发两轮请求（每轮 8 个事件），既刷进度也放大风控面。
                let (status, resp) = post_desktop_events(region, account, &events).await;
                if !is_ok(status, &resp) {
                    return Err(format!("第 {} 组模板事件上报失败", sent + 1));
                }
                sent += 1;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Ok(format!("已上报 {sent} 组模板使用事件"))
        }
        TaskAction::PlaybookPrompt => {
            let conversation = format!("bs-pb-{at_ms}");
            let request = format!("bs-pb-req-{at_ms}");
            let events = build_playbook_prompt_sequence(
                &conversation,
                &request,
                "pm-gtm-launch-plan",
                "新产品上市 GTM 发布计划一页纸",
                at_ms,
            );
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("灵感事件上报失败：{}", error_message(&resp)));
            }
            Ok("已上报 playbook_cta_click + playbook_prompt_send".to_string())
        }
        TaskAction::CreateCanvas => {
            let conversation = format!("bs-canvas-{at_ms}");
            let request = format!("bs-canvas-req-{at_ms}");
            let events = build_design_canvas_sequence(&conversation, &request, at_ms);
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("画布事件上报失败：{}", error_message(&resp)));
            }
            Ok("已上报 wbx_design_canvas_task_create/open".to_string())
        }
        TaskAction::Appearance => {
            let (status, resp) = chat_json(
                region,
                APPEARANCE_SET_PATH,
                "POST",
                Some(json!({"kind": "theme", "resource_key": HP_THEME_KEY})),
                account,
            )
            .await;
            if !is_ok(status, &resp) {
                return Err(format!("设置主题失败：{}", error_message(&resp)));
            }
            // 主题生效事件与 set 之间有真实间隔（客户端是「离开设置页」时上报）。
            tokio::time::sleep(Duration::from_millis(2000)).await;
            let events = vec![build_appearance_apply_event(HP_THEME_KEY)];
            let (status, resp) = post_desktop_events(region, account, &events).await;
            if !is_ok(status, &resp) {
                return Err(format!("皮肤生效事件上报失败：{}", error_message(&resp)));
            }
            // ⚠️ 这一步会**真实改掉账号的主题**，而上游只有 `appearance/set`、没有可读的
            // 「当前主题」接口 —— 读不到原值就还原不了。故不假装无副作用：结果文案明确
            // 告知「主题已被改掉且不会自动还原」，面板也在 `desc` 里提前写明。
            Ok("已切换到「激战金秋」主题并上报生效事件（原主题不会被自动还原）".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// 编排：点亮 → 回读 → 领奖
// ---------------------------------------------------------------------------

/// 回读单任务；未达标时在有界预算内轮询（上游计分异步）。
async fn task_by_code_waiting(region: Region, account: &Value, code: &str) -> Option<GrowthTask> {
    let mut last = fetch_task(region, account, code).await;
    if last
        .as_ref()
        .map(|task| task.claimable || task.claimed)
        .unwrap_or(false)
    {
        return last;
    }
    for _ in 1..CLAIM_POLL_ATTEMPTS {
        tokio::time::sleep(CLAIM_POLL_GAP).await;
        match fetch_task(region, account, code).await {
            // 轮询期查询失败不覆盖已拿到的结果（上游抖动不该让整步失败）。
            None => break,
            Some(task) => {
                let settled = task.claimable || task.claimed;
                last = Some(task);
                if settled {
                    break;
                }
            }
        }
    }
    last
}

async fn fetch_task(region: Region, account: &Value, code: &str) -> Option<GrowthTask> {
    let (status, resp) = chat_json(region, TASKS_PATH, "GET", None, account).await;
    if !is_ok(status, &resp) {
        return None;
    }
    parse_tasks(&resp)
        .into_iter()
        .find(|task| task.task_code == code)
}

/// 累计型任务的**目标次数**：上游偶尔不下发 `target`（返回 0），此时按任务码兜底。
///
/// 参考实现 `runChat5` 里就有这一句（`if target <= 0 { target = 5 }`），移植时漏掉了 ——
/// 后果不是报错，而是**静默少发**：`need = (0 - 0).max(0) = 0` ⇒ `need.max(1) = 1`，
/// 每点一次只涨 1 点进度，用户连点四五次才完成，看起来像「点了没反应」。
///
/// 兜底值**只给确知目标为 5 的累计任务**：拿 5 去套一次性任务（`target = 1`）会把差额
/// 算成 5，对 `Buddy_App` 这类动作没有意义，还会放大无谓的上报。
fn effective_target(task: &GrowthTask) -> i64 {
    if task.target > 0 {
        return task.target;
    }
    match task.task_code.as_str() {
        "chat_5" | "template_5" => 5,
        _ => 1,
    }
}

/// 单账号「一键完成」：报名 → 逐个点亮 → 回读 → 领奖 → **收尾领取剩余可领奖励**。
///
/// 最后一步覆盖 `ACTIONS` 之外的手工任务（本工具点亮不了，但奖励已达标）——
/// 「一键完成」必须一次做完，不能留一半给第二个按钮（见阶段 3 注释）。
///
/// 单个任务失败不阻断后续（一个动作踩空不该让整轮白跑）。
/// 返回面向前端的运行报告。耗时可达数十秒（含轮询），调用方应给出进行中状态。
pub async fn run_auto_for(region: Region, account: &Value) -> Value {
    if let Err(message) = ensure_supported(region) {
        return json!({"ok": false, "message": message, "results": []});
    }
    if let Err(message) = ensure_personal_session(account) {
        return json!({"ok": false, "message": message, "results": []});
    }
    let account = ensure_fresh_token_for(region, account.clone(), &load_checkin_config()).await;
    let display = account_display_name(&account);

    let Some(guard) = RunningGuard::acquire(&account) else {
        return json!({"ok": false, "message": "该账号正在执行中，请稍候", "results": []});
    };

    let (status, resp) = chat_json(region, TASKS_PATH, "GET", None, &account).await;
    if !is_ok(status, &resp) {
        drop(guard);
        return json!({
            "ok": false,
            "message": format!("拉取任务列表失败：{}", error_message(&resp)),
            "results": [],
        });
    }
    let tasks = parse_tasks(&resp);

    let mut results: Vec<Value> = Vec::new();

    // 阶段 0：批量报名尚未报名的任务。失败不阻断 —— 行为事件才是进度的唯一判据，
    // 但**不能让失败无声无息**：上游若要求先报名才计分，用户会看到「执行成功但进度不动」。
    let pending: Vec<String> = tasks
        .iter()
        .filter(|task| {
            !task.claimed
                && !task.locked
                && task.accept_status != "accepted"
                && task.accept_status != "completed"
        })
        .filter(|task| is_autoable(&task.task_code))
        .map(|task| task.task_code.clone())
        .collect();
    if !pending.is_empty() {
        let (status, resp) = chat_json(
            region,
            ACCEPT_PATH,
            "POST",
            Some(json!({ "task_codes": pending })),
            &account,
        )
        .await;
        if is_ok(status, &resp) {
            // 报名落库与首条事件之间留一点间隔，避免事件被算在「未报名」的任务上。
            tokio::time::sleep(ACCEPT_SETTLE).await;
        } else {
            results.push(run_result(
                "accept",
                "批量报名",
                "failed",
                format!("报名失败：{}（仍会尝试上报事件）", error_message(&resp)),
                0,
                0,
            ));
        }
    }

    // 同一组事件可能覆盖多个任务码（`Buddy_App` 与 `Buddy_App_QQ` 共用一组五连事件）。
    // 记住本轮已发过的动作：第二次只回读 + 领奖、不再重发 —— 重复事件不加进度，
    // 只会白白放大风控面。
    let mut fired: Vec<TaskAction> = Vec::new();

    for spec in ACTIONS {
        let Some(task) = tasks.iter().find(|task| task.task_code == spec.code) else {
            continue; // 该账号没下发这个任务（地区/版本差异），静默跳过
        };
        if task.claimed {
            results.push(run_result(
                spec.code,
                &task.title,
                "skipped",
                "已领取",
                0,
                0,
            ));
            continue;
        }
        if task.locked {
            results.push(run_result(
                spec.code,
                &task.title,
                "skipped",
                "任务未解锁",
                0,
                0,
            ));
            continue;
        }

        // 已达标但仍未领：不必再点亮，**直接领奖**。
        // 曾经这里只记一条「待领取」就跳过，结果用户点完「一键完成」还得再点「领取全部」。
        if task.claimable {
            results.push(claim_only(region, &account, spec.code, &task.title, "进度已达标").await);
            tokio::time::sleep(CLAIM_GAP).await;
            continue;
        }

        // 同一组事件在本轮已经发过：只回读 + 领奖，不重发。
        if fired.contains(&spec.action) {
            let message = "同一组事件已在本次执行中上报";
            // `None`：本轮没有为它发事件（`Buddy_App_QQ` 与 `Buddy_App` 共用同一组），
            // 所以**不判定**「未计入」—— 那个结论只对真的发过事件的任务成立。
            results.push(
                settle_after_action(region, &account, spec, &task.title, message, None).await,
            );
            tokio::time::sleep(CLAIM_GAP).await;
            continue;
        }

        let need = (effective_target(&task) - task.current).max(0);
        match run_action_for(region, &account, spec, need.max(1), task.current).await {
            Ok(message) => {
                fired.push(spec.action);
                // 回读：达标则立即领，未达标则记录进度（下次再点会按差额续跑）。
                results.push(
                    settle_after_action(
                        region,
                        &account,
                        spec,
                        &task.title,
                        &message,
                        Some(task.current),
                    )
                    .await,
                );
            }
            Err(message) => {
                results.push(run_result(spec.code, &task.title, "failed", message, 0, 0));
            }
        }
        tokio::time::sleep(REPORT_GAP).await;
    }

    // 阶段 3：收尾领奖 —— 把**不在 `ACTIONS` 里**但已达标未领的任务也一并收掉。
    //
    // 这些任务（`manual_only` 的手工任务）本工具点亮不了，但奖励是现成的。
    // 此前它们只能靠用户再点一次「领取全部」：函数名承诺「一键完成」，却留了一半事
    // 给第二个按钮（`docs/specs/GROWTH-TASKS.md` §「一键完成」那节记着同一件事）。
    // 2026-10-23 起 UI 把「领取全部」并进了「一键完成」，所以这里必须补齐，
    // 否则合并后的按钮在「只有手工任务可领」的账号上会看起来什么都没做。
    //
    // ⚠️ 用**本轮开头那次** `tasks` 快照判断：中途手工完成的任务不在快照里，
    // 与 `claim_all_for` 的快照语义一致，不做额外回读（多一轮 GET 只为一个边缘情形）。
    for task in &tasks {
        if !task.claimable || task.claimed {
            continue;
        }
        if ACTIONS.iter().any(|spec| spec.code == task.task_code) {
            continue; // 已在上面的循环里处理（达标必已被领取或记为失败）
        }
        results.push(claim_only(region, &account, &task.task_code, &task.title, "进度已达标").await);
        tokio::time::sleep(CLAIM_GAP).await;
    }

    drop(guard);
    let claimed = results
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) == Some("claimed"))
        .count();
    let credit: i64 = results
        .iter()
        .filter_map(|item| item.get("credit").and_then(Value::as_i64))
        .sum();
    let energy: i64 = results
        .iter()
        .filter_map(|item| item.get("energy").and_then(Value::as_i64))
        .sum();
    json!({
        "ok": true,
        "account": display,
        "results": results,
        "claimed": claimed,
        "credit": credit,
        "energy": energy,
    })
}

/// 直接领奖并汇总成一条结果（不点亮、不回读）。
///
/// `prefix` 是「为什么现在领」的说明，拼在领奖消息前面，例如「进度已达标 → 领奖 +100 积分」。
async fn claim_only(
    region: Region,
    account: &Value,
    code: &str,
    title: &str,
    prefix: &str,
) -> Value {
    let (ok, outcome, claim_message) = claim_task_for(region, account, code).await;
    // 「已被领过」不是本轮的战果：记成 `skipped`，否则汇总里的 `claimed` 会虚高。
    let (status, message) = if !ok {
        ("failed", format!("{prefix} → 领奖失败：{claim_message}"))
    } else if outcome.already_claimed {
        ("skipped", format!("{prefix} → 该奖励已被领取"))
    } else {
        ("claimed", format!("{prefix} → 领奖 {claim_message}"))
    };
    run_result(code, title, status, message, outcome.credit, outcome.energy)
}

/// 事件发完之后的一步：回读 → 达标则领 → 汇总成一条结果。
///
/// `message` 只影响文案（「刚发了事件」与「同组事件已发过」共用同一套判定）。
async fn settle_after_action(
    region: Region,
    account: &Value,
    spec: &ActionSpec,
    title: &str,
    message: &str,
    // `before_progress`：动作执行**前**的进度（`None` = 本轮没有为它发事件，
    // 故不判定「未计入」—— 那个结论只对真的发过事件的任务成立）。
    before_progress: Option<i64>,
) -> Value {
    match task_by_code_waiting(region, account, spec.code).await {
        Some(updated) if updated.claimed => {
            run_result(spec.code, title, "skipped", "他人已领取", 0, 0)
        }
        Some(updated) if updated.claimable => {
            claim_only(region, account, spec.code, title, message).await
        }
        // 进度**一点没动**：不是「慢」，是这批事件压根没被计入。必须说清楚 ——
        // 此前一律提示「上游计分较慢，稍后再点」，用户连点两轮看到的都是同一句话，
        // 只能猜是不是坏了（线上实测就是这么被误判成「点了没反应」的）。
        Some(updated) if matches!(before_progress, Some(before) if updated.current <= before) => {
            run_result(
                spec.code,
                title,
                "progressed",
                format!(
                    "{message}（进度仍为 {} —— 本轮事件未被计入，重复上报同一模板/事件通常不计数）",
                    updated.progress_text()
                ),
                0,
                0,
            )
        }
        Some(updated) => run_result(
            spec.code,
            title,
            "progressed",
            format!(
                "{message}（进度 {}，上游计分较慢，稍后再点一次可续跑）",
                updated.progress_text()
            ),
            0,
            0,
        ),
        None => run_result(
            spec.code,
            title,
            "progressed",
            format!("{message}（回读失败，稍后可再点一次）"),
            0,
            0,
        ),
    }
}

fn run_result(
    code: &str,
    title: &str,
    status: &str,
    message: impl Into<String>,
    credit: i64,
    energy: i64,
) -> Value {
    json!({
        "taskCode": code,
        "title": if title.is_empty() { code } else { title },
        "status": status,
        "message": message.into(),
        "credit": credit,
        "energy": energy,
    })
}

/// 只领不点亮：把当前所有「已达标未领取」的任务一次领完。
///
/// 与 [`run_auto_for`] 分开是刻意的 —— 点亮有副作用（发行为事件、调主题 API），
/// 领奖没有。用户只想收奖励时不该被迫再发一遍事件。
pub async fn claim_all_for(region: Region, account: &Value) -> Value {
    if let Err(message) = ensure_supported(region) {
        return json!({"ok": false, "message": message, "results": []});
    }
    // 企业切换会话放行：领奖不动行为事件，手工完成的任务仍可正常领取。
    if let Err(message) = ensure_not_enterprise(account) {
        return json!({"ok": false, "message": message, "results": []});
    }
    let account = ensure_fresh_token_for(region, account.clone(), &load_checkin_config()).await;
    let (status, resp) = chat_json(region, TASKS_PATH, "GET", None, &account).await;
    if !is_ok(status, &resp) {
        return json!({
            "ok": false,
            "message": format!("拉取任务列表失败：{}", error_message(&resp)),
            "results": [],
        });
    }
    let claimable: Vec<GrowthTask> = parse_tasks(&resp)
        .into_iter()
        .filter(|task| task.claimable)
        .collect();
    if claimable.is_empty() {
        return json!({"ok": true, "message": "没有可领取的奖励", "results": [], "credit": 0, "energy": 0});
    }
    let mut results = Vec::new();
    for task in &claimable {
        let (ok, outcome, message) = claim_task_for(region, &account, &task.task_code).await;
        results.push(run_result(
            &task.task_code,
            &task.title,
            if ok { "claimed" } else { "failed" },
            message,
            outcome.credit,
            outcome.energy,
        ));
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let credit: i64 = results
        .iter()
        .filter_map(|item| item.get("credit").and_then(Value::as_i64))
        .sum();
    let energy: i64 = results
        .iter()
        .filter_map(|item| item.get("energy").and_then(Value::as_i64))
        .sum();
    json!({"ok": true, "results": results, "credit": credit, "energy": energy})
}

/// 全账号批量执行（账号间串行 + 固定间隔，避免同 IP 高频触发风控）。
pub async fn run_auto_all() -> Value {
    let accounts = load_accounts_for(Region::Cn);
    if accounts.is_empty() {
        return json!({"ok": false, "message": "没有账号", "accounts": []});
    }
    let mut items = Vec::new();
    for account in &accounts {
        let report = run_auto_for(Region::Cn, account).await;
        items.push(json!({
            "account": account_display_name(account),
            "ok": report.get("ok").cloned().unwrap_or(Value::Bool(false)),
            "claimed": report.get("claimed").cloned().unwrap_or(json!(0)),
            "credit": report.get("credit").cloned().unwrap_or(json!(0)),
            "message": report.get("message").cloned().unwrap_or(Value::Null),
        }));
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    json!({"ok": true, "accounts": items})
}

// ---------------------------------------------------------------------------
// 卡片提示：任务摘要 + 全账号扫描（带落盘缓存）
// ---------------------------------------------------------------------------

/// 单账号的任务摘要 —— 账号卡片 / 表格上的提示标签读它。
///
/// **三个计数器互斥**（有优先级）：`claimable` > `autoable`。可领的任务**不再**同时算作
/// 「可自动」—— 否则一张卡会同时挂「可领 1」「可自动 1」，用户点进去只看到同一个任务，
/// 会以为标签在乱报。`claimed` / `total` 只用于「全领完了」的收敛判断。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaskSummary {
    pub total: i64,
    /// 进度达标、可直接领奖。
    pub claimable: i64,
    /// 本工具能自动点亮（未达标、未解锁不算）。
    pub autoable: i64,
    pub claimed: i64,
}

impl TaskSummary {
    /// 无需再做任何事（没有可领、也没有可自动）—— 卡片上不挂标签。
    pub fn is_idle(&self) -> bool {
        self.claimable == 0 && self.autoable == 0
    }

    pub fn to_json(self, ok: bool, message: Option<&str>) -> Value {
        json!({
            "ok": ok,
            "total": self.total,
            "claimable": self.claimable,
            "autoable": self.autoable,
            "claimed": self.claimed,
            "idle": ok && self.is_idle(),
            "message": message,
        })
    }
}

/// 汇总任务列表里的三类计数。`locked` 的任务既不进 `autoable` 也不进 `claimable`。
pub fn summarize(tasks: &[GrowthTask]) -> TaskSummary {
    let mut summary = TaskSummary {
        total: tasks.len() as i64,
        ..TaskSummary::default()
    };
    for task in tasks {
        if task.claimed {
            summary.claimed += 1;
            continue;
        }
        if task.locked {
            continue;
        }
        if task.claimable {
            summary.claimable += 1;
            continue;
        }
        if is_autoable(&task.task_code) {
            summary.autoable += 1;
        }
    }
    summary
}

/// 缓存新鲜期。
///
/// 取 10 分钟：成长任务**不是**分钟级变化的东西（每个账号基本只有一次），而一次全量扫描
/// 是「账号数 × 一次上游请求」，扫太勤只会白打上游。用户手动跑完任务后会**强制刷新**
/// 那一个账号（见 [`scan_for`] 的 `account` 参数），所以不存在「刚领完还挂着旧标签」。
const SUMMARY_TTL_MS: i64 = 10 * 60 * 1000;

/// 账号间扫描间隔（限速）。比签到慢一点：这里对每个号只打一次只读接口，
/// 没有「当日必须完成」的时效要求，宁可慢。
const SUMMARY_SCAN_GAP: Duration = Duration::from_millis(400);

/// 缓存的读 / 改写锁（扫描与单账号刷新可能并发）。
static SUMMARY_CACHE_LOCK: Mutex<()> = Mutex::new(());

fn load_summary_cache() -> Value {
    let file = crate::modules::config::growth_tasks_cache_file();
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| json!({"version": 1, "updatedAt": 0, "accounts": {}}))
}

fn save_summary_cache(cache: &Value) {
    let file = crate::modules::config::growth_tasks_cache_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        // 尽力而为：写失败只影响「下次还要再扫一遍」，绝不阻断扫描本身。
        let _ = std::fs::write(&file, text);
    }
}

fn cache_accounts(cache: &Value) -> Map<String, Value> {
    cache
        .get("accounts")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn account_cache_key(account: &Value) -> Option<String> {
    account
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

/// 扫一个账号：成功返回摘要，失败返回可读原因（**不**写 `ok:true` 的假摘要）。
async fn scan_one(region: Region, account: &Value) -> (bool, TaskSummary, Option<String>) {
    if let Err(message) = ensure_not_enterprise(account) {
        return (false, TaskSummary::default(), Some(message));
    }
    match fetch_tasks(region, account).await {
        Ok(tasks) => {
            let mut summary = summarize(&tasks);
            // 企业切换会话：列表读得到，但行为事件不计分 —— 计入「可自动」会让卡片
            // 与批量条把用户引向一次注定被拒的执行。可领计数保留（领奖仍可用）。
            if is_enterprise_switch_session(account) {
                summary.autoable = 0;
            }
            (true, summary, None)
        }
        Err(message) => (false, TaskSummary::default(), Some(message)),
    }
}

/// 扫描任务摘要。
///
/// - `account = None`：扫全部 CN 账号（账号间串行 + [`SUMMARY_SCAN_GAP`] 限速）；
/// - `account = Some(id)`：只扫这一个账号（跑完任务后用它**强制刷新单卡**，避免为了一张卡
///   重扫全部账号）；
/// - `force = false` 且缓存未过期 ⇒ **直接返回缓存，零上游请求**。
///
/// 返回值面向前端：`{ok, updatedAt, cached, accounts: {"<账号 id>": {ok, claimable, autoable, claimed, total, idle, message}}}`。
pub async fn scan_for(region: Region, account: Option<&str>, force: bool) -> Value {
    if let Err(message) = ensure_supported(region) {
        return json!({"ok": false, "message": message, "accounts": {}});
    }

    let accounts = load_accounts_for(region);
    let target: Vec<Value> = match account {
        Some(id) => accounts
            .into_iter()
            .filter(|item| account_cache_key(item).as_deref() == Some(id))
            .collect(),
        None => accounts,
    };
    if target.is_empty() {
        return json!({"ok": true, "cached": false, "updatedAt": now_ms(), "accounts": {}});
    }

    // 单账号查询天然是「针对这张卡」，缓存命中没有意义（调用方就是要最新值）。
    let single = account.is_some();
    if !force && !single {
        let cached = load_summary_cache();
        let updated_at = cached.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        if !cache_accounts(&cached).is_empty() && now_ms() - updated_at < SUMMARY_TTL_MS {
            return json!({
                "ok": true,
                "cached": true,
                "updatedAt": updated_at,
                "accounts": cache_accounts(&cached),
            });
        }
    }

    let mut fresh: Vec<(String, Value)> = Vec::new();
    for (index, item) in target.iter().enumerate() {
        let Some(key) = account_cache_key(item) else {
            continue;
        };
        let (ok, summary, message) = scan_one(region, item).await;
        fresh.push((key, summary.to_json(ok, message.as_deref())));
        if index + 1 < target.len() {
            tokio::time::sleep(SUMMARY_SCAN_GAP).await;
        }
    }

    // 读—改—写：只替换本次扫到的键，别把其它账号的旧结果一起冲掉
    // （单账号刷新时尤其重要 —— 否则一次刷新会把全表清空）。
    let merged = {
        let _guard = SUMMARY_CACHE_LOCK.lock().ok();
        let mut cache = load_summary_cache();
        let mut map = cache_accounts(&cache);
        for (key, value) in &fresh {
            map.insert(key.clone(), value.clone());
        }
        let updated_at = now_ms();
        cache["version"] = json!(1);
        cache["updatedAt"] = json!(updated_at);
        cache["accounts"] = Value::Object(map.clone());
        save_summary_cache(&cache);
        (map, updated_at)
    };

    let mut out = Map::new();
    for (key, value) in fresh {
        out.insert(key, value);
    }
    json!({
        "ok": true,
        "cached": false,
        "updatedAt": merged.1,
        "accounts": out,
    })
}

// ---------------------------------------------------------------------------
// 同账号并发的互斥闸
// ---------------------------------------------------------------------------

/// 同一账号不允许两轮「一键完成」并行：两轮会各自回读、各自领奖，
/// 既浪费往返也让进度判断互相干扰（第一轮的事件把第二轮的差额算乱）。
static RUNNING: Mutex<Option<Vec<String>>> = Mutex::new(None);

struct RunningGuard {
    key: String,
}

impl RunningGuard {
    fn acquire(account: &Value) -> Option<Self> {
        let key = account
            .get("uid")
            .and_then(Value::as_str)
            .or_else(|| account.get("email").and_then(Value::as_str))
            .unwrap_or("unknown")
            .to_string();
        let mut slot = RUNNING.lock().ok()?;
        let list = slot.get_or_insert_with(Vec::new);
        if list.iter().any(|item| item == &key) {
            return None;
        }
        list.push(key.clone());
        Some(Self { key })
    }
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = RUNNING.lock() {
            if let Some(list) = slot.as_mut() {
                list.retain(|item| item != &self.key);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_stable_and_36_hex() {
        let first = derive_device_id("u-123", "machine");
        let second = derive_device_id("u-123", "machine");
        assert_eq!(
            first, second,
            "同一 uid + salt 必须稳定（否则每轮上报都是新设备）"
        );
        assert_eq!(first.len(), 36);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(first, derive_device_id("u-123", "session"));
        assert_ne!(first, derive_device_id("u-456", "machine"));
    }

    #[test]
    fn desktop_chat_sequence_has_six_joined_events() {
        let events =
            build_desktop_chat_sequence("conv-1", "req-1", "msg-1", "fast-model", "fast-model", 1);
        assert_eq!(events.len(), 6);
        let codes: Vec<&str> = events
            .iter()
            .filter_map(|event| event.get("eventCode").and_then(Value::as_str))
            .collect();
        assert_eq!(
            codes,
            vec![
                "agent_task_created",
                "chat_message_send",
                "chat_request_send",
                "chat_message_response",
                "chat_message_status",
                "chat_request_response",
            ]
        );
        // 成功回执是 RichMeow 的硬判据，不能被改掉。
        assert_eq!(events[3]["isSuccessful"], json!(true));
        assert_eq!(events[3]["conversationId"], json!("conv-1"));
        // 三个 JOIN 字段必须都指向同一 requestId。
        assert_eq!(events[2]["rootRequestId"], json!("req-1"));
        assert_eq!(events[3]["rootRequestId"], json!("req-1"));
        assert_eq!(events[5]["rootRequestId"], json!("req-1"));
    }

    #[test]
    fn buddy_app_sequence_is_five_ordered_events() {
        let events = build_buddy_app_sequence(BUDDY_APP_ID, BUDDY_APP_NAME);
        assert_eq!(events.len(), 5);
        let codes: Vec<&str> = events
            .iter()
            .filter_map(|event| event.get("eventCode").and_then(Value::as_str))
            .collect();
        assert_eq!(
            codes,
            vec![
                "buddyapp_discover_click",
                "buddyapp_show",
                "buddyapp_enter_click",
                "buddyapp_auth_confirm_click",
                "buddyapp_bindaccount_skip_click",
            ]
        );
        assert!(events
            .iter()
            .all(|event| event.get("buddyId").and_then(Value::as_str) == Some(BUDDY_APP_ID)));
    }

    #[test]
    fn template_sequence_appends_two_marker_events() {
        let events = build_template_use_sequence("c", "r", "tpl-1", "深度研究", 1);
        assert_eq!(events.len(), 8);
        assert_eq!(
            events[6]["eventCode"],
            json!("agent_task_created_with_template")
        );
        assert_eq!(events[6]["id"], json!("tpl-1"));
        assert_eq!(events[7]["eventCode"], json!("template_used"));
        assert_eq!(events[7]["template_id"], json!("tpl-1"));
    }

    #[test]
    fn template_sequence_marks_conversation_as_template_origin() {
        let events = build_template_use_sequence("c", "r", "tpl-1", "深度研究", 1);
        // `agent_task_created` 必须自报「用模板发起」——通用对话链把它写成 false，
        // 那样同一组事件里就同时存在「没用模板」与 `template_used`，自相矛盾。
        assert_eq!(events[0]["eventCode"], json!("agent_task_created"));
        assert_eq!(events[0]["has_template"], json!(true));
        assert_eq!(events[0]["template_name"], json!("深度研究"));
        assert_eq!(events[0]["action"], json!("template"));
    }

    #[test]
    fn template_batch_skips_already_counted_slots() {
        // 差额为 1 时不得从第 0 个重发：上游按**不同模板**累计，重发同一个不会加进度
        // （线上实测：进度卡在 4/5，每次都提示「已上报 1 组」，改成从 current 起取后当场 5/5）。
        assert_eq!(template_window(4, 1, 5), (4, 1), "4/5 时只补第 5 个");
        assert_eq!(template_window(0, 5, 5), (0, 5), "零进度时补满 5 个");
        assert_eq!(template_window(2, 9, 5), (2, 3), "差额超过剩余数时截断");
        assert_eq!(template_window(9, 1, 5), (4, 1), "越界一律收敛到最后一个");
    }

    #[test]
    fn cumulative_target_falls_back_when_upstream_omits_it() {
        let mut task = GrowthTask {
            task_code: "template_5".to_string(),
            title: String::new(),
            description: String::new(),
            credit: 100,
            energy: 5,
            target: 0,
            current: 1,
            accept_status: "accepted".to_string(),
            locked: false,
            claimed: false,
            claimable: false,
        };
        // 上游没给 target：必须兜成 5，否则 need 会被 `.max(1)` 压成 1，
        // 每轮只补一个模板 ⇒ 用户要连点四次（线上实测症状）。
        assert_eq!(effective_target(&task), 5);
        assert_eq!((effective_target(&task) - task.current).max(0), 4);
        assert_eq!(template_window(1, 4, 5), (1, 4), "零进度兜底后应补第 2–5 个");

        // 上游给了目标就以它为准 —— 不能把 target=3 的任务硬拉成 5。
        task.task_code = "chat_5".to_string();
        task.target = 3;
        assert_eq!(effective_target(&task), 3);

        // 非累计型任务不套 5：一次性任务的差额恒为 1。
        task.task_code = "RichMeow_Chat".to_string();
        task.target = 0;
        assert_eq!(effective_target(&task), 1);
    }

    fn sample_task(code: &str, current: i64, target: i64, accept: &str, locked: bool) -> GrowthTask {
        let claimed = accept == "claimed";
        GrowthTask {
            task_code: code.to_string(),
            title: code.to_string(),
            description: String::new(),
            credit: 100,
            energy: 0,
            target,
            current,
            accept_status: accept.to_string(),
            locked,
            claimed,
            claimable: !claimed && target > 0 && current >= target,
        }
    }

    #[test]
    fn summary_counts_claimable_and_autoable_without_double_counting() {
        let tasks = vec![
            // 可领：只进 claimable，**不**同时进 autoable（否则同一张卡挂两个标签、
            // 点进去只看到同一个任务）。
            sample_task("chat_5", 5, 5, "accepted", false),
            // 已领取：只进 claimed。
            sample_task("first_buddy", 1, 1, "claimed", false),
            // 未解锁：两个都不进（点了也没用）。
            sample_task("create_canvas", 0, 1, "", true),
            // 进行中的自动任务。
            sample_task("RichMeow_Chat", 0, 1, "accepted", false),
            // 不可自动的任务：只贡献 total。
            sample_task("expert_5", 2, 5, "accepted", false),
        ];
        let summary = summarize(&tasks);
        assert_eq!(summary.total, 5);
        assert_eq!(summary.claimable, 1);
        assert_eq!(summary.autoable, 1);
        assert_eq!(summary.claimed, 1);
        assert!(!summary.is_idle());

        // 全部领完 / 只剩不可自动的任务 ⇒ 卡片上不挂标签。
        let idle = vec![
            sample_task("first_buddy", 1, 1, "claimed", false),
            sample_task("expert_5", 2, 5, "accepted", false),
        ];
        assert!(summarize(&idle).is_idle(), "没有可领也没有可自动时不得挂标签");
    }

    #[test]
    fn canvas_id_uses_request_tail() {
        let events = build_design_canvas_sequence("conv", "0123456789abcdef", 1);
        assert_eq!(events.len(), 8);
        // 与真实客户端一致：取 requestId 的**末 8 位**（不是前 8 位）。
        assert_eq!(events[7]["id"], json!("ardot-file-89abcdef"));
    }

    #[test]
    fn fingerprint_is_overridden_by_business_fields() {
        let fingerprint = desktop_fingerprint("uid-1", "nick", 100);
        let event = json!({"eventCode": "x", "machineId": "real-device"});
        let merged = merge_fingerprint(&fingerprint, &event);
        assert_eq!(merged["machineId"], json!("real-device"));
        assert_eq!(merged["eventCode"], json!("x"));
        assert_eq!(merged["extName"], json!("workbuddy-desktop"));
        assert_eq!(merged["userId"], json!("uid-1"));
    }

    #[test]
    fn parse_tasks_reads_nested_and_flat_progress() {
        let resp = json!({"data": {"tasks": [
            {
                "task_code": "RichMeow_Chat", "title": "桌面端对话1次",
                "reward_credit": 100, "reward_energy": 5,
                "accept_status": "accepted",
                "progress": {"current": 1, "target": 1}
            },
            {
                "task_code": "chat_5", "title": "对话 5 次",
                "reward_credit": 100,
                "accept_status": "accepted",
                "current": 3, "target": 5
            },
            {
                "task_code": "first_buddy", "title": "领养",
                "reward_credit": 300, "reward_energy": 8,
                "accept_status": "claimed", "current": 1, "target": 1
            }
        ]}});
        let tasks = parse_tasks(&resp);
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].current, 1);
        assert_eq!(tasks[0].target, 1);
        assert!(tasks[0].claimable, "嵌套 progress 达标应可领");
        assert!(!tasks[1].claimable);
        assert_eq!(tasks[1].progress_text(), "3/5");
        assert!(tasks[2].claimed);
        assert!(!tasks[2].claimable, "已领取不得重复标记为可领");
    }

    #[test]
    fn parse_tasks_skips_entries_without_code() {
        let resp = json!({"data": {"tasks": [{"title": "无码"}, {"task_code": "ok"}]}});
        let tasks = parse_tasks(&resp);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].task_code, "ok");
    }

    #[test]
    fn claimable_requires_reaching_target() {
        let resp = json!({"data": {"tasks": [
            {"task_code": "a", "current": 0, "target": 0},
            {"task_code": "b", "current": 0, "target": 1},
        ]}});
        let tasks = parse_tasks(&resp);
        assert!(!tasks[0].claimable, "target=0 不可领（既非达标也非计数型）");
        assert!(!tasks[1].claimable);
    }

    #[test]
    fn action_registry_is_order_stable_and_complete() {
        assert!(action_for("chat_5").is_some());
        assert!(action_for(" first_buddy ").is_some(), "允许前后空白");
        assert!(action_for("expert_5").is_none(), "专家类不在本模块范围");
        assert!(action_for("black_cat").is_none(), "夜猫子由 cat 模块负责");
        assert!(action_for("school_season").is_none());
        // 两个 Buddy_App 任务共用同一动作，但仍是两条独立表项。
        assert_eq!(
            action_for("Buddy_App").unwrap().action,
            TaskAction::BuddyApp
        );
        assert_eq!(
            action_for("Buddy_App_QQ").unwrap().action,
            TaskAction::BuddyApp
        );
        assert_eq!(ACTIONS.len(), 11);
    }

    #[test]
    fn claim_parse_handles_already_claimed() {
        let resp = json!({"code": 0, "data": {"already_claimed": true, "credit": 0, "energy": 0}});
        let outcome = parse_claim(&resp);
        assert!(outcome.already_claimed);
        assert_eq!(outcome.credit, 0);

        let flat = json!({"credit": 100, "energy": 5});
        assert_eq!(parse_claim(&flat).credit, 100);
    }

    #[test]
    fn is_ok_accepts_2xx_and_business_zero() {
        assert!(is_ok(200, &json!({"code": 0})));
        assert!(is_ok(200, &json!({})));
        assert!(is_ok(201, &json!({"code": 200})));
        assert!(!is_ok(400, &json!({"code": 0})), "HTTP 状态不 2xx 一律失败");
        assert!(!is_ok(200, &json!({"code": 40001})));
    }

    #[test]
    fn global_region_is_rejected() {
        assert!(ensure_supported(Region::Global).is_err());
        assert!(ensure_supported(Region::Cn).is_ok());
    }

    #[test]
    fn running_guard_blocks_same_account_only() {
        let account = json!({"uid": "guard-uid"});
        let other = json!({"uid": "guard-other"});
        let first = RunningGuard::acquire(&account).expect("首轮应拿到闸");
        assert!(RunningGuard::acquire(&account).is_none(), "同账号不得并发");
        assert!(RunningGuard::acquire(&other).is_some(), "不同账号互不影响");
        drop(first);
        assert!(
            RunningGuard::acquire(&account).is_some(),
            "释放后可再次进入"
        );
    }

    #[test]
    fn task_code_whitelist_blocks_path_injection() {
        // 上游真实任务码含点号（`Model_chat_GLM5.2`），白名单必须放行 `.`；
        // 其余路径/协议符号一律拒绝 —— 任务码是直接拼进 URL 路径的。
        assert_eq!(
            validate_task_code("Model_chat_GLM5.2").unwrap(),
            "Model_chat_GLM5.2"
        );
        assert_eq!(validate_task_code("  chat_5  ").unwrap(), "chat_5");
        for bad in [
            "", "   ", "../admin", "a/b", "a?x=1", "a#f", "a b", "a%b", "a\\b",
        ] {
            assert!(
                validate_task_code(bad).is_err(),
                "应拒绝非法任务码：{bad:?}"
            );
        }
        assert!(validate_task_code(&"a".repeat(65)).is_err(), "超长须拒绝");
    }

    /// 造一个 payload 带 `token_source` 的 JWT（签名段无所谓，本模块只解 payload）。
    fn jwt_with_token_source(source: &str) -> String {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"token_source":"{source}"}}"#));
        format!("eyJhbGciOiJub25lIn0.{payload}.sig")
    }

    #[test]
    fn enterprise_account_is_detected_by_id() {
        assert!(enterprise_id(&json!({"enterpriseId": "e-1"})).is_some());
        assert!(enterprise_id(&json!({"enterprise_id": "e-2"})).is_some());
        assert!(enterprise_id(&json!({"enterpriseId": "  "})).is_none());
        assert!(enterprise_id(&json!({})).is_none());
    }

    #[test]
    fn enterprise_switch_session_is_detected_from_jwt() {
        let switch = json!({"access_token": jwt_with_token_source("enterprise_switch")});
        assert!(is_enterprise_switch_session(&switch));

        let personal = json!({"access_token": jwt_with_token_source("personal")});
        assert!(!is_enterprise_switch_session(&personal));

        // 非 JWT / 信封凭据 / 解不出 payload 一律 fail-open：不把老 token 误判成企业会话。
        assert!(!is_enterprise_switch_session(
            &json!({"access_token": "opaque"})
        ));
        assert!(!is_enterprise_switch_session(
            &json!({"access_token": {"cipher": "..."}})
        ));
        assert!(!is_enterprise_switch_token("a.b"));
    }

    #[test]
    fn enterprise_gates_block_execution_but_allow_claims() {
        let enterprise = json!({
            "enterpriseId": "e-1",
            "access_token": jwt_with_token_source("personal"),
        });
        assert!(
            ensure_not_enterprise(&enterprise).is_err(),
            "真企业版读也拒绝"
        );
        assert!(ensure_personal_session(&enterprise).is_err());

        let switch = json!({"access_token": jwt_with_token_source("enterprise_switch")});
        assert!(
            ensure_not_enterprise(&switch).is_ok(),
            "企业切换会话列表可读、奖励可领"
        );
        assert!(
            ensure_personal_session(&switch).is_err(),
            "企业切换会话不得执行行为事件"
        );

        let personal = json!({"access_token": jwt_with_token_source("personal")});
        assert!(ensure_not_enterprise(&personal).is_ok());
        assert!(ensure_personal_session(&personal).is_ok());
    }
}
