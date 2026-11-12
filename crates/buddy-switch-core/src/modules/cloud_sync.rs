//! 账号云同步（WebDAV，手动上传 / 下载）。
//!
//! ## 边界（刻意收窄）
//!
//! - **只同步账号与凭据**：遍历六个作用域的 `accounts` 分区；配置 / 网关 / appSettings 一概不碰
//!   （不同机器的端口、路径、代理差异很大，混进来只会制造冲突）；
//! - **手动触发**：设置页两个按钮，不做后台自动同步（用户选择「手动」而非「自动」）；
//! - **云端只存密文**：AES-256-GCM，密钥由「同步密码」经 PBKDF2-HMAC-SHA256 派生；
//!   WebDAV 密码只用于 HTTP Basic 认证，不上云；
//! - **下载语义**：同 uid 覆盖、缺失新增，写盘前强制快照（复用 D18）—— 失败分区可重试。
//!
//! ## 身份键
//!
//! 合并走 `backup_sections::merge_accounts`（唯一实现），它按 `uid` 匹配。Trae 的持久化记录
//! 用非常规大写 `UserID` 且没有 `uid`，因此上传前要为它补一个仅用于合并的 `uid` 字段 ——
//! 回写时 `RawAccount` 反序列化会忽略未知键，不会污染账号库。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use crate::modules::backup;
use crate::modules::backup_sections::section_by_id;
use crate::modules::export_import::ConflictPolicy;
use crate::modules::product::{Product, Scope};
use crate::modules::{config, net, trae};

/// 同步文件格式标识。与备份 envelope 的 `kind` 刻意分开：同步文件只能由本功能消费。
pub const SYNC_KIND: &str = "accswitch-sync";
/// 当前同步文件契约版本。
pub const SYNC_FORMAT_VERSION: u32 = 1;
/// 云端文件名（仅用于文案提示，实际上传路径由用户填写）。
pub const SYNC_FILE_NAME: &str = "accswitch-sync.enc";

const MAGIC: &[u8] = b"ACCSW-SYNC\x01";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// PBKDF2 迭代次数：兼顾离线暴力破解成本与桌面端解密耗时。
const PBKDF2_ITERATIONS: u32 = 120_000;
/// 云端文件上限：账号库远小于这个体积，超出即视为异常来件。
const MAX_PAYLOAD_BYTES: usize = 10 * 1024 * 1024;

/// 落盘的 WebDAV / 同步配置（含密码，仅本机）。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncConfigFile {
    #[serde(default)]
    url: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    sync_password: String,
    #[serde(default)]
    last_upload_at: Option<i64>,
    #[serde(default)]
    last_download_at: Option<i64>,
}

/// 配置文件路径（不参与备份导出：里面有 WebDAV 密码）。
fn sync_config_file() -> PathBuf {
    config::store_dir().join("sync_config.json")
}

/// 读取配置；缺失 / 损坏按空配置处理（前端会显示「未配置」，不会崩）。
fn load_config_file() -> SyncConfigFile {
    std::fs::read_to_string(sync_config_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// 给前端的配置视图：**绝不回传密码**，只说明是否已保存。
pub fn config_view() -> Value {
    let cfg = load_config_file();
    json!({
        "url": cfg.url,
        "username": cfg.username,
        "hasPassword": !cfg.password.is_empty(),
        "hasSyncPassword": !cfg.sync_password.is_empty(),
        "lastUploadAt": cfg.last_upload_at,
        "lastDownloadAt": cfg.last_download_at,
    })
}

/// 保存配置：密码字段留空表示**沿用已保存的值**（前端不回显密码）。
pub fn save_config(input: &Value) -> Result<Value, String> {
    let mut cfg = load_config_file();
    if let Some(url) = input.get("url").and_then(Value::as_str) {
        cfg.url = url.trim().to_string();
    }
    if let Some(username) = input.get("username").and_then(Value::as_str) {
        cfg.username = username.trim().to_string();
    }
    for (key, target) in [
        ("password", &mut cfg.password),
        ("syncPassword", &mut cfg.sync_password),
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            if !value.is_empty() {
                *target = value.to_string();
            }
        }
    }
    if !cfg.url.is_empty() {
        validate_url(&cfg.url)?;
    }

    config::ensure_private_dir(&config::store_dir())
        .map_err(|error| format!("创建配置目录失败：{error}"))?;
    let text = serde_json::to_string_pretty(&cfg)
        .map_err(|error| format!("序列化同步配置失败：{error}"))?;
    config::atomic_write(&sync_config_file(), &text)
        .map_err(|error| format!("保存同步配置失败：{error}"))?;
    Ok(config_view())
}

/// 把配置补齐到可执行同步的状态，并返回它。
fn require_ready_config() -> Result<SyncConfigFile, String> {
    let cfg = load_config_file();
    if cfg.url.is_empty() {
        return Err("请先填写 WebDAV 地址".to_string());
    }
    if cfg.username.is_empty() {
        return Err("请先填写 WebDAV 账号".to_string());
    }
    if cfg.password.is_empty() {
        return Err("请先填写 WebDAV 应用密码".to_string());
    }
    if cfg.sync_password.is_empty() {
        return Err("请先设置同步密码（用于加密云端文件）".to_string());
    }
    validate_url(&cfg.url)?;
    Ok(cfg)
}

fn validate_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "WebDAV 地址不是合法 URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("WebDAV 地址需以 http:// 或 https:// 开头".to_string());
    }
    Ok(())
}

/// 记录最近一次成功上传 / 下载时间；失败不影响已完成的传输。
fn touch_timestamp(field: &str, millis: i64) {
    let mut cfg = load_config_file();
    match field {
        "lastUploadAt" => cfg.last_upload_at = Some(millis),
        "lastDownloadAt" => cfg.last_download_at = Some(millis),
        _ => return,
    }
    if let Ok(text) = serde_json::to_string_pretty(&cfg) {
        let _ = config::atomic_write(&sync_config_file(), &text);
    }
}

// ---------------------------------------------------------------------------
// 加密信封：MAGIC | salt(16) | nonce(12) | ciphertext+tag
// ---------------------------------------------------------------------------

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    key
}

fn seal(plain: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let key = derive_key(password, &salt, PBKDF2_ITERATIONS);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "初始化加密器失败".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|_| "加密同步数据失败".to_string())?;

    let mut out = Vec::with_capacity(MAGIC.len() + SALT_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn open(sealed: &[u8], password: &str) -> Result<Vec<u8>, String> {
    let header_len = MAGIC.len() + SALT_LEN + NONCE_LEN;
    if sealed.len() <= header_len {
        return Err("同步文件不完整，请重新上传".to_string());
    }
    if !sealed.starts_with(MAGIC) {
        return Err("不是本应用的同步文件（或格式版本不兼容）".to_string());
    }
    let salt = &sealed[MAGIC.len()..MAGIC.len() + SALT_LEN];
    let nonce = &sealed[MAGIC.len() + SALT_LEN..header_len];
    let ciphertext = &sealed[header_len..];

    let key = derive_key(password, salt, PBKDF2_ITERATIONS);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "初始化解密器失败".to_string())?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "同步密码不正确，或云端文件已损坏".to_string())
}

// ---------------------------------------------------------------------------
// 负载：六个作用域的 accounts 分区
// ---------------------------------------------------------------------------

/// 为 Trae 记录补上 `uid`（仅用于合并；`RawAccount` 回写时会忽略该键）。
fn annotate_identity(scope: Scope, item: &mut Value) {
    if scope.product() != Product::Trae || item.get("uid").is_some() {
        return;
    }
    if let Ok(raw) = serde_json::from_value::<trae::account::RawAccount>(item.clone()) {
        let uid = trae::account::resolve_user_id(&raw);
        if !uid.is_empty() {
            item["uid"] = json!(uid);
        }
    }
}

/// 标注身份并丢弃无法确定 `uid` 的记录；返回丢弃条数。
///
/// 上传与下载两侧都用它：`uid` 是合并的唯一键，缺它既无法被对方匹配、也无法参与覆盖，
/// 留着只会在账号库里制造重复。注意本地合并结果**不经过**它（本地缺 uid 也必须保留，
/// 丢一条就是删账号）。
fn normalize_incoming(scope: Scope, value: &mut Value) -> usize {
    let Some(items) = value.as_array_mut() else {
        return 0;
    };
    let before = items.len();
    items.retain_mut(|item| {
        annotate_identity(scope, item);
        item.get("uid")
            .and_then(Value::as_str)
            .is_some_and(|uid| !uid.is_empty())
    });
    before - items.len()
}

/// 组装账号同步负载；返回（负载, 账号数, 无法确定身份的跳过数）。
fn build_payload() -> Result<(Value, usize, usize), String> {
    let spec = section_by_id("accounts").ok_or("账号分区未注册")?;
    let mut scopes = Map::new();
    let mut total = 0usize;
    let mut skipped = 0usize;

    for scope in Scope::all() {
        let mut value = (spec.read)(scope)?;
        skipped += normalize_incoming(scope, &mut value);
        if let Some(items) = value.as_array() {
            total += items.len();
        }
        scopes.insert(scope.as_str().to_string(), json!({ "accounts": value }));
    }

    let payload = json!({
        "kind": SYNC_KIND,
        "formatVersion": SYNC_FORMAT_VERSION,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "scopes": Value::Object(scopes),
    });
    Ok((payload, total, skipped))
}

/// 校验同步负载的格式标识与版本（fail-closed：不尽力解析未知版本）。
fn payload_scopes(payload: &Value) -> Result<&Map<String, Value>, String> {
    match payload.get("kind").and_then(Value::as_str) {
        Some(SYNC_KIND) => {}
        Some(other) => return Err(format!("不是本应用的同步文件（kind = {other}）")),
        None => return Err("同步文件缺少 kind 字段".to_string()),
    }
    let version = payload
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "同步文件缺少 formatVersion 字段".to_string())?;
    if version > u64::from(SYNC_FORMAT_VERSION) {
        return Err(format!(
            "同步文件版本为 {version}，高于本应用支持的 {SYNC_FORMAT_VERSION}；请先升级应用"
        ));
    }
    payload
        .get("scopes")
        .and_then(Value::as_object)
        .ok_or_else(|| "同步文件缺少 scopes 字段".to_string())
}

// ---------------------------------------------------------------------------
// 上传 / 下载
// ---------------------------------------------------------------------------

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .user_agent("AccSwitch-CloudSync/1")
            .build()
            .expect("failed to build reqwest client")
    })
}

fn status_hint(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => {
            "认证失败：请检查 WebDAV 账号与应用密码（坚果云需使用网页端生成的「应用密码」）"
        }
        404 => "云端地址不存在",
        409 => "目标目录不存在：请先在坚果云中创建该目录，再填写完整文件地址",
        507 => "云端存储空间不足",
        _ => "WebDAV 请求失败",
    }
}

/// 上传：读六个作用域的账号 → 加密 → PUT 到用户填写的 WebDAV 地址。
pub async fn upload() -> Result<Value, String> {
    let cfg = require_ready_config()?;
    let (payload, accounts, skipped) = build_payload()?;
    let plain =
        serde_json::to_vec(&payload).map_err(|error| format!("序列化同步数据失败：{error}"))?;
    let sealed = seal(&plain, &cfg.sync_password)?;
    let bytes = sealed.len();

    let response = http_client()
        .put(&cfg.url)
        .basic_auth(&cfg.username, Some(&cfg.password))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(sealed)
        .send()
        .await
        .map_err(|error| format!("上传失败：{}", net::describe_transport_error(&error)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body: String = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("{}（HTTP {status}）{snippet}", status_hint(status)));
    }

    let stamp = chrono::Utc::now().timestamp_millis();
    touch_timestamp("lastUploadAt", stamp);
    Ok(json!({
        "uploadedAt": stamp,
        "bytes": bytes,
        "accounts": accounts,
        "skipped": skipped,
    }))
}

/// 下载：GET → 解密 → 校验 → 按 uid 覆盖合并（写盘前强制快照）。
pub async fn download() -> Result<Value, String> {
    let cfg = require_ready_config()?;

    let response = http_client()
        .get(&cfg.url)
        .basic_auth(&cfg.username, Some(&cfg.password))
        .send()
        .await
        .map_err(|error| format!("下载失败：{}", net::describe_transport_error(&error)))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("云端还没有同步文件，请先在上传端点击「上传到云端」".to_string());
    }
    if !status.is_success() {
        let body: String = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(format!("{}（HTTP {status}）{snippet}", status_hint(status)));
    }

    let sealed = response.bytes().await.map_err(|error| {
        format!(
            "读取云端文件失败：{}",
            net::describe_transport_error(&error)
        )
    })?;
    if sealed.len() > MAX_PAYLOAD_BYTES {
        return Err("云端同步文件过大，已拒绝处理".to_string());
    }

    let plain = open(&sealed, &cfg.sync_password)?;
    let payload: Value =
        serde_json::from_slice(&plain).map_err(|_| "同步文件解密后不是合法 JSON".to_string())?;
    let summary = apply_payload(&payload)?;

    touch_timestamp("lastDownloadAt", chrono::Utc::now().timestamp_millis());
    Ok(summary)
}

/// 把云端负载合并进本地账号库。
///
/// 逐 scope 事务（与备份导入同粒度）：某个作用域失败不影响其他作用域，失败项可重试。
fn apply_payload(payload: &Value) -> Result<Value, String> {
    let scopes = payload_scopes(payload)?;
    let spec = section_by_id("accounts").ok_or("账号分区未注册")?;
    let snapshot_path = backup::snapshot_before_import()?;

    let mut per_scope: Vec<Value> = Vec::new();
    let mut retryable: Vec<String> = Vec::new();
    let mut failed = 0usize;

    for (scope_key, scope_value) in scopes {
        let scope = match Scope::parse(scope_key) {
            Ok(scope) => scope,
            Err(error) => {
                failed += 1;
                per_scope.push(json!({
                    "scope": scope_key,
                    "added": 0, "overwritten": 0, "skipped": 0, "conflicts": 0,
                    "error": error.message(),
                    "retryable": false,
                }));
                continue;
            }
        };
        let Some(incoming) = scope_value.get("accounts") else {
            continue;
        };

        let merged = (|| -> Result<_, String> {
            let mut local = (spec.read)(scope)?;
            // 本地记录也要标注身份：Trae 本地库只有 `UserID`，不补 `uid` 就永远匹配不上。
            // 缺 uid 的本地记录**不删除**，只是参与不了覆盖匹配。
            if let Some(items) = local.as_array_mut() {
                for item in items {
                    annotate_identity(scope, item);
                }
            }
            let mut incoming = incoming.clone();
            let dropped = normalize_incoming(scope, &mut incoming);
            let mut counts = (spec.merge)(&mut local, &incoming, ConflictPolicy::Overwrite);
            counts.skipped += dropped;
            (spec.write)(scope, &local)?;
            Ok(counts)
        })();

        match merged {
            Ok(counts) => per_scope.push(json!({
                "scope": scope_key,
                "added": counts.added,
                "overwritten": counts.overwritten,
                "skipped": counts.skipped,
                "conflicts": counts.conflicts,
                "retryable": false,
            })),
            Err(error) => {
                failed += 1;
                retryable.push(scope_key.clone());
                per_scope.push(json!({
                    "scope": scope_key,
                    "added": 0, "overwritten": 0, "skipped": 0, "conflicts": 0,
                    "error": error,
                    "retryable": true,
                }));
            }
        }
    }

    Ok(json!({
        "perScope": per_scope,
        "failed": failed,
        "retryable": retryable.len(),
        "retryableScopes": retryable,
        "snapshotPath": snapshot_path,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_and_wrong_password() {
        let plain = br#"{"hello":"world"}"#;
        let sealed = seal(plain, "correct horse").expect("加密应成功");
        assert_eq!(open(&sealed, "correct horse").expect("解密应成功"), plain);
        assert!(open(&sealed, "wrong password").is_err());
    }

    #[test]
    fn payload_rejects_unknown_kind_and_future_version() {
        assert!(payload_scopes(&json!({ "kind": "other", "formatVersion": 1 })).is_err());
        assert!(payload_scopes(&json!({
            "kind": SYNC_KIND,
            "formatVersion": SYNC_FORMAT_VERSION + 1,
            "scopes": {}
        }))
        .is_err());
        assert!(payload_scopes(&json!({
            "kind": SYNC_KIND,
            "formatVersion": SYNC_FORMAT_VERSION,
            "scopes": {}
        }))
        .is_ok());
    }

    #[test]
    fn trae_record_gets_uid_for_merging() {
        let mut item = json!({ "UserID": "u1", "jwt": "j", "name": "n" });
        annotate_identity(Scope::TraeCn, &mut item);
        assert_eq!(item["uid"], json!("u1"));
        // 写回时 RawAccount 会忽略该键：反序列化不报错。
        assert!(serde_json::from_value::<trae::account::RawAccount>(item).is_ok());
    }

    /// 本地 Trae 记录同样只有 `UserID`：两侧都标注后才能按 uid 覆盖而不是重复追加。
    #[test]
    fn trae_local_and_incoming_merge_without_duplicates() {
        let mut local = json!([{ "UserID": "u1", "jwt": "old" }]);
        let mut incoming = json!([{ "UserID": "u1", "jwt": "new" }]);
        annotate_identity(Scope::TraeCn, &mut local[0]);
        normalize_incoming(Scope::TraeCn, &mut incoming);

        let mut records = local.as_array().cloned().unwrap_or_default();
        let outcome = crate::modules::export_import::merge_import_record(
            &mut records,
            &incoming[0],
            ConflictPolicy::Overwrite,
            crate::modules::export_import::TokenPolicy::Allow,
        );
        assert_eq!(
            outcome,
            crate::modules::export_import::MergeOutcome::Overwritten
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["jwt"], json!("new"));
    }

    #[test]
    fn save_config_keeps_existing_secrets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let _guard = config::HomeOverrideGuard::set(dir.path());

        save_config(&json!({
            "url": "https://dav.jianguoyun.com/dav/AccSwitch/accswitch-sync.enc",
            "username": "me@example.com",
            "password": "app-pass",
            "syncPassword": "sync-pass"
        }))
        .expect("首次保存应成功");

        let view = save_config(&json!({
            "url": "https://dav.jianguoyun.com/dav/AccSwitch/accswitch-sync.enc",
            "username": "me@example.com",
            "password": "",
            "syncPassword": ""
        }))
        .expect("二次保存应成功");

        assert_eq!(view["hasPassword"], json!(true));
        assert_eq!(view["hasSyncPassword"], json!(true));
        assert_eq!(
            view["url"],
            json!("https://dav.jianguoyun.com/dav/AccSwitch/accswitch-sync.enc")
        );
    }
}
