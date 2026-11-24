//! 旧版「会话监听」残留 hook 的一次性清理。
//!
//! 该功能已整体删除，但**已升级用户的客户端配置文件里可能还留着**旧版写入的
//! `"...AccSwitch.exe" hook --source <src>`。若不清理，客户端每次工具调用都会把本程序
//! 拉起来（且设置页入口已删，用户无法自行卸载）。
//!
//! 判据与旧安装面保持一致：命令同时含「本应用可执行文件名」+ ` hook` + `--source`
//! （旧名 `BuddySwitch` / `buddy-switch` 也要认，否则改名前的残留永远清不掉）。
//! 只在**确实存在我们的条目**时才写盘；客户端正在运行时 `patch_settings` 会拒绝，
//! 留到下次启动再试（幂等）。

use serde_json::{json, Map, Value};

use super::client_settings;

/// 旧版安装面覆盖的槽位（WorkBuddy 两区域 + Claude Code + CodeBuddy + Trae 两区域）。
const LEGACY_SLOTS: &[&str] = &[
    "workbuddy-cn",
    "workbuddy-global",
    "claude",
    "codebuddy",
    "trae-hooks-cn",
    "trae-hooks-global",
];

/// 这条命令是不是旧版工具写入的 hook。
fn is_legacy_hook(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    (lower.contains("accswitch") || lower.contains("buddyswitch") || lower.contains("buddy-switch"))
        && lower.contains(" hook")
        && lower.contains("--source")
}

fn command_of(item: &Value) -> &str {
    item.get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// 从一份客户端配置里剔掉旧版 hook。
///
/// 返回 `None` 表示**没有可剔的**（调用方据此跳过写盘）。
/// 兼容两种真实形态：分组 `{matcher, hooks:[...]}`（可能混装别人的 hook）
/// 与裸 handler `{type:"command", command, ...}`；剔空的分组 / 事件 / `hooks` 键一并移除。
fn strip_legacy_hooks(values: &Value) -> Option<Value> {
    let mut doc = values.as_object()?.clone();
    let hooks = doc.get("hooks")?.as_object()?.clone();

    let mut changed = false;
    let mut next: Map<String, Value> = Map::new();
    for (event, groups) in hooks {
        let Some(groups) = groups.as_array().cloned() else {
            next.insert(event, groups);
            continue;
        };
        let mut kept: Vec<Value> = Vec::new();
        for group in groups {
            match group {
                Value::Object(ref map) if map.get("hooks").is_some_and(Value::is_array) => {
                    let inner = map["hooks"].as_array().cloned().unwrap_or_default();
                    let before = inner.len();
                    let survivors: Vec<Value> = inner
                        .into_iter()
                        .filter(|item| !is_legacy_hook(command_of(item)))
                        .collect();
                    if survivors.len() != before {
                        changed = true;
                    }
                    // 过滤后为空的分组必须整组丢掉（空分组会被客户端当成匹配但无 handler）。
                    if !survivors.is_empty() {
                        let mut group = map.clone();
                        group.insert("hooks".to_string(), Value::Array(survivors));
                        kept.push(Value::Object(group));
                    }
                }
                Value::Object(ref map) => {
                    if is_legacy_hook(
                        map.get("command")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ) {
                        changed = true;
                    } else {
                        kept.push(group.clone());
                    }
                }
                other => kept.push(other.clone()),
            }
        }
        if !kept.is_empty() {
            next.insert(event, Value::Array(kept));
        }
    }

    if !changed {
        return None;
    }
    if next.is_empty() {
        doc.remove("hooks");
    } else {
        doc.insert("hooks".to_string(), Value::Object(next));
    }
    Some(Value::Object(doc))
}

/// 遍历旧版安装面，清掉残留 hook；无残留 / 客户端运行中 / 文件不存在时静默跳过。
pub fn cleanup_installed() {
    for slot in LEGACY_SLOTS {
        let Ok(current) = client_settings::read_settings(slot) else {
            continue;
        };
        let Some(values) = current.get("values").filter(|value| !value.is_null()) else {
            continue;
        };
        let Some(stripped) = strip_legacy_hooks(values) else {
            continue;
        };
        // 旧卸载逻辑的约定：一条不剩时显式写成空对象（不留下有歧义的缺键）。
        let hooks = stripped.get("hooks").cloned().unwrap_or_else(|| json!({}));
        let _ = client_settings::patch_settings(slot, &json!({ "hooks": hooks }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: &str = "\"C:\\Program Files\\AccSwitch\\AccSwitch.exe\" hook --source workbuddy";

    #[test]
    fn strips_our_hooks_and_keeps_foreign() {
        let existing = json!({
            "theme": "dark",
            "hooks": {
                "UserPromptSubmit": [
                    { "hooks": [{ "type": "command", "command": "codegraph.cmd prompt-hook" }] }
                ],
                "Stop": [
                    { "hooks": [{ "type": "command", "command": OURS }] },
                    { "type": "command", "command": "other-tool hook --source x" }
                ]
            }
        });

        let stripped = strip_legacy_hooks(&existing).expect("应识别出旧版 hook");
        assert_eq!(stripped["theme"], json!("dark"));
        assert_eq!(
            stripped["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"],
            json!("codegraph.cmd prompt-hook"),
            "别人的 hook 必须逐字保留"
        );
        assert_eq!(
            stripped["hooks"]["Stop"][0]["type"],
            json!("command"),
            "同事件里的裸 handler 形态也要保留（它的命令不是我们的）"
        );
        assert!(
            !stripped.to_string().contains("--source workbuddy"),
            "我们的条目必须被剔除"
        );
    }

    #[test]
    fn removes_empty_event_and_hooks_key() {
        let existing =
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": OURS }] }] } });
        let stripped = strip_legacy_hooks(&existing).expect("应识别出旧版 hook");
        assert!(
            stripped.get("hooks").is_none(),
            "剔空后不能留下空对象 / 空数组：{stripped}"
        );
    }

    #[test]
    fn returns_none_when_nothing_of_ours() {
        let foreign = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "x --source y" }] }] } });
        assert!(strip_legacy_hooks(&foreign).is_none(), "无残留时不应写盘");
        assert!(
            strip_legacy_hooks(&json!({})).is_none(),
            "无 hooks 键时不应写盘"
        );
    }
}
