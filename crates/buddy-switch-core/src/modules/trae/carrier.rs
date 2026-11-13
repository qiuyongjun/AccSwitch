//! Trae 登录态**便携载体**：把一个账号的客户端登录态打包成单文件，搬到另一台电脑。
//!
//! ## 为什么需要它（与账号库导出的区别）
//!
//! 账号库导出（[`super::export_import`]）只带 `UserID` / `jwt` / `refresh_token`。
//! 那三样**不足以让客户端接受这个账号**，原因是客户端要的是「一组互相引用的键」：
//!
//! | 缺什么 | 后果 |
//! |:--|:--|
//! | `iCubeAuthInfo://icube-dc:<deviceId>` | 续期的 `DeviceProof` 签不出来 ⇒ 上游 `20405` |
//! | `cloudide` 里的 `account` 富对象 | `UserInfoManager` 校验 `storeRegion`/`userTag`/`migrateToSG` 失败 ⇒ 判缓存损坏 ⇒ **强制登出** |
//! | 与 `cloudide` 同源的 `state.vscdb` 缓存 | `_updateByOriginUserInfo` 的 `UserInfoNotMatchError` ⇒ 登出 |
//!
//! 这三样**都拿不到、也造不出**——只能从「那台已经登录过的机器」搬。
//! 2026-09-29 的事故正是试图用账号库凭据**合成**它们（`materialize_login_in_dir`，
//! 已整条删除，见 `docs/history/trae-login-materialize-probe-2026-09-29.md`）。
//!
//! ## 本模块的边界：**只搬运，不构造**
//!
//! - `storage` 段是 `storage.json` 里相关键的**密文原值**，一个字节都不改；
//! - `files` 段是 `state.vscdb` 系列的**原文**（base64）；
//! - 不解密、不重组、不补字段 ⇒ 不存在「构造出一个客户端不认的信封」这条失败路径。
//!
//! 落地方式是把载体写成一个**真实快照槽位**（`profiles_<variant>/<uid>/`），
//! 之后走既有的 [`super::profile::switch_account`] —— 不新增写入路径，
//! 也不新增「写客户端状态」的机制（切换本来就在写这些文件）。
//!
//! ## 明确**不搬**的文件（跨机搬运的边界）
//!
//! | 文件 | 为什么不搬 |
//! |:--|:--|
//! | `Local State` | `os_crypt.encrypted_key` 由源机 DPAPI 加密，目标机**解不开** |
//! | `Network/`（Cookie） | 同上（Chromium v10 → DPAPI），搬过去是一堆解不开的密文 |
//! | `machineid` / `aha/` | 机器指纹，搬过去等于冒充源机；目标机留自己的更安全 |
//! | `Partitions/`、`Local Storage/` | 站点数据/缓存，体积大；⚠️ 其中 `Local Storage/leveldb` 是 webview 侧 KV，是否影响登录态一致性**待 E4 验证**，见下 |
//!
//! 这些项不含 icube 凭据（`iCubeAuthInfo://*` 是 Trae 自研 `tc` 信封，不走 DPAPI，
//! 全在 `storage.json` 里），但**不等于「恢复时无残留」**：
//! [`super::profile::restore_from_slot_in_dir`] 遍历 [`super::profile::CORE_ENTRIES`]，
//! 对槽位里**缺失**的目录类条目是跳过（`copy_entry` 返回 `Ok(0)`），既不清也不覆盖。
//! 本载体只落会话库那几个文件，因此目标机上一账号的 `Local Storage/leveldb`、
//! `Network/`、`Session Storage/`、`Partitions/*` 会原样保留 —— 这与 `profile.rs`
//! 记录的「leveldb 与 storage.json / state.vscdb 不同源会导致切换后账号不变」相冲突。
//! ⚠️ **未决**：需真机验证 E4（导入后切换是否被登出 / 串号）才能决定是清除、
//! 空占位还是维持现状；**本次不改既有恢复流程**，风险登记在
//! `docs/specs/CLIENTLESS-AUTH-PLAN.md`。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::modules::trae::icube::{self, CLOUDIDE_KEY, ICUBE_DC_PREFIX};
use crate::modules::trae::paths;
use crate::modules::trae::platform;
use crate::modules::trae::profile;
use crate::modules::trae::variant::TraeVariant;

/// `iCubeAuthInfo://usertag`：`<uid> → region` 的整机共享表。
///
/// 必须随账号一起搬：它是 `account.userTag` 的旁证，缺了会让客户端把
/// `userTag` 重新按 `row` 处理，部分账号的权益档位会算错。
pub(crate) const USERTAG_KEY: &str = "iCubeAuthInfo://usertag";

/// 载体文件格式标识。改动载体结构时**必须**同时改这里，别让旧文件被新代码误读。
pub const CARRIER_FORMAT: &str = "accswitch.trae.carrier/1";

/// 参与搬运的 `state.vscdb` 系列（相对客户端 userData）。
///
/// 四个都要：主库缺了没有 userInfo 缓存（`UserInfoNotMatchError` 的根源），
/// `-wal`/`-shm` 缺了会在下次打开时**回放旧事务**把上一账号的页写回来
/// （与 [`super::profile::RESTORE_PURGE_RELATIVES`] 记录的是同一类坑，方向相反）。
const SESSION_DB_FILES: &[&str] = &[
    "User/globalStorage/state.vscdb",
    "User/globalStorage/state.vscdb.backup",
    "User/globalStorage/state.vscdb-wal",
    "User/globalStorage/state.vscdb-shm",
];

/// 单个会话库文件的体积上限（base64 解码后）与文件数上限。
///
/// `state.vscdb` 正常是 MB 量级；设 64 MiB 是为了让畸形/恶意载体**明确报错**，
/// 而不是在 base64 解码时才把内存打满。数量上限就是清单长度（一项一份）。
const MAX_CARRIER_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CARRIER_FILES: usize = SESSION_DB_FILES.len();

/// 校验载体里的相对路径，**只接受 [`SESSION_DB_FILES`] 白名单**。
///
/// 这是唯一允许进入写盘路径的外部字段。此前这里直接
/// `path.split('/').fold(slot, join)`：`PathBuf::join` 不规范化 `..`，Windows 上
/// 带盘符 / 反斜杠的段还会被当成新根 —— 一份外部载体就能写到槽位之外。
/// 前端 `detectCarrier` 明确只做识别、不做校验，所以这道闸必须在 Rust 侧，
/// 且 [`write_slot`] 写入前要再走一次（不是只信"解析时验过"）。
fn checked_carrier_path(path: &str) -> Result<&'static str, String> {
    if let Some(allowed) = SESSION_DB_FILES
        .iter()
        .copied()
        .find(|allowed| *allowed == path)
    {
        return Ok(allowed);
    }
    let reason = if path.is_empty() || Path::new(path).is_absolute() {
        "必须是清单内的相对路径"
    } else if path.contains('\\') || path.split('/').any(|part| part == "." || part == "..") {
        "含上跳片段或反斜杠"
    } else {
        "不在会话库清单内"
    };
    Err(format!("迁移包里的文件路径不合法（{reason}）: {path}"))
}

/// 按 base64 长度估算解码后体积是否超限（不分配、不解码）。
fn carrier_file_size_exceeds(base64_len: usize) -> bool {
    (base64_len as u64 / 4) * 3 + 3 > MAX_CARRIER_FILE_BYTES
}

/// 从 `storage.json` 的键集合里挑出该账号**当前使用**的 deviceId。
///
/// 优先取账号库已登记的 `device_bindings[uid]`（续期链真正使用的那个），
/// 否则退回字典序最后一个。仅凭"遍历时最后一个"会挑错设备：源机可能因
/// 重置过设备而留有多条 `icube-dc:*`，而 `device_id` 现在会被写进
/// [`register_account_if_missing`] 的绑定，挑错的代价是上游 `20405`。
fn pick_device_id(
    variant: TraeVariant,
    uid: &str,
    keys: &BTreeMap<String, String>,
) -> String {
    let present: Vec<&str> = keys
        .keys()
        .filter_map(|key| key.strip_prefix(ICUBE_DC_PREFIX))
        .filter(|id| !id.is_empty())
        .collect();
    let bound = super::account::load_accounts_for(variant)
        .device_bindings
        .get(uid)
        .cloned();
    if let Some(bound) = bound {
        if present.iter().any(|id| *id == bound.as_str()) {
            return bound;
        }
    }
    present.last().copied().unwrap_or_default().to_string()
}

/// 账号展示名的后缀：按**字符**取 uid 末 6 位。
///
/// `safe_slot_name` 允许非 ASCII uid，直接 `&uid[len-6..]` 按字节切会落在
/// UTF-8 字符中间而 panic（与 `store::mask` 用 `chars()` 是同一条纪律）。
fn account_name_suffix(uid: &str) -> String {
    uid.chars()
        .rev()
        .take(6)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// 载体里的一个文件（原文 base64）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CarrierFile {
    /// 相对客户端 userData 的路径（`/` 分隔）。
    pub path: String,
    /// 原文的 base64。
    pub base64: String,
}

/// 单文件载体。**只含凭据与它的配套缓存，不含任何机器指纹**。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Carrier {
    /// 格式标识，见 [`CARRIER_FORMAT`]。
    pub format: String,
    /// 产品线变体名（跨变体导入一律拒绝：SOLO 与 IDE 的 `ClientID`/端点是两把钥匙）。
    pub variant: String,
    /// 账号 uid。
    #[serde(rename = "userId")]
    pub user_id: String,
    /// `icube-dc` 键名内嵌的 deviceId（脱敏展示由调用方负责，落盘是原值：它就是键名的一部分）。
    #[serde(rename = "deviceId", default)]
    pub device_id: String,
    /// 采集时间（ISO-8601 本地时间）。
    #[serde(rename = "capturedAt")]
    pub captured_at: String,
    /// 来源客户端 userData 目录名（诊断用，如 `Trae CN`）。
    #[serde(rename = "sourceApp", default)]
    pub source_app: String,
    /// `storage.json` 里参与登录的键 → **密文原值**。
    #[serde(rename = "storageKeys")]
    pub storage_keys: BTreeMap<String, String>,
    /// `state.vscdb` 系列原文。
    #[serde(default)]
    pub files: Vec<CarrierFile>,
}

/// 采集结果摘要（供 UI 显示「导出了什么」，**不含任何凭据**）。
#[derive(Debug, Clone, Serialize)]
pub struct CaptureSummary {
    /// 账号 uid。
    #[serde(rename = "userId")]
    pub user_id: String,
    /// deviceId 的脱敏形态。
    #[serde(rename = "deviceIdMasked")]
    pub device_id_masked: String,
    /// 来源 userData 目录名。
    #[serde(rename = "sourceApp")]
    pub source_app: String,
    /// 搬运的 `storage.json` 键数。
    #[serde(rename = "keyCount")]
    pub key_count: usize,
    /// 搬运的文件数。
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// 载体文件字节数。
    pub bytes: u64,
    /// 是否带上会话库（缺了它，目标机若已登录别的账号会被判缓存不一致）。
    #[serde(rename = "hasSessionDb")]
    pub has_session_db: bool,
}

/// 落地结果。
#[derive(Debug, Clone, Serialize)]
pub struct MaterializeOutcome {
    /// 账号 uid。
    #[serde(rename = "userId")]
    pub user_id: String,
    /// 槽位目录（绝对路径）。
    pub slot: String,
    /// 是否**跳过**（槽位已存在，只增不改）。
    pub skipped: bool,
    /// 写入的文件数。
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// 写入字节数。
    pub bytes: u64,
}

/// 「这个账号现在能不能不登录就切过去」的判定。
#[derive(Debug, Clone, Serialize)]
pub struct Readiness {
    /// 账号 uid。
    #[serde(rename = "userId")]
    pub user_id: String,
    /// 判定：`snapshot`（有快照）/ `live_client`（客户端正登录着它）/
    /// `needs_carrier`（要从源机导载体）/ `unknown_account`（账号库里没有）。
    pub verdict: &'static str,
    /// 可直接显示的中文说明。
    pub reason: String,
    /// 是否已有快照槽位。
    #[serde(rename = "hasSnapshot")]
    pub has_snapshot: bool,
    /// 客户端此刻是否正登录着这个账号。
    #[serde(rename = "clientLoggedIn")]
    pub client_logged_in: bool,
    /// 能否**在这台机器上**采集载体（= 客户端里存的登录态就是这个账号）。
    #[serde(rename = "canCaptureHere")]
    pub can_capture_here: bool,
}

/// 把 `storage.json` 读成对象（**只读**，不写回）。
fn read_storage_object(dir: &Path) -> Result<Map<String, Value>, String> {
    let path = icube::storage_path_in_dir(dir);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 storage.json 失败: {e}"))?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "storage.json 不是 JSON 对象".to_string())
}

/// 在候选目录里找「客户端当前登录态属于 `uid`」的那个目录（只读）。
fn dir_logged_in_as(variant: TraeVariant, uid: &str) -> Option<PathBuf> {
    for dir in platform::data_dirs_by_activity_for(variant) {
        let Ok(info) = icube::cloudide_auth_info_from_dir(&dir, variant) else {
            continue;
        };
        if info.user_id.as_deref() == Some(uid) {
            return Some(dir);
        }
    }
    None
}

/// 采集：把 `uid` 在本机的登录态打包成载体。
///
/// ## 前置条件（两条，都必须满足，否则**明确失败**而不是产出半截载体）
///
/// 1. **客户端必须已关闭**：`state.vscdb` 是活的 SQLite，运行中复制会拿到
///    半写入的页（`-wal` 里的事务状态与主库不配套）—— 那样的载体到目标机
///    轻则丢 settings、重则打不开库；
/// 2. **客户端当前登录的必须就是这个账号**：本机的登录态只有一个，「采集 A」
///    而客户端登录着 B 时，唯一的诚实回答是「这台机器上没有 A 的登录态」。
///
/// 失败文案直接给用户看，所以写清「怎么办」而不是只写「不行」。
pub fn capture_for(variant: TraeVariant, user_id: &str) -> Result<(Carrier, CaptureSummary), String> {
    let uid = user_id.trim();
    if uid.is_empty() {
        return Err("账号 ID 不能为空".to_string());
    }
    if platform::is_running_for(variant) {
        return Err(
            "请先关闭 Trae 客户端再导出迁移包：运行中的 state.vscdb 正被写入，\
             复制到的数据库可能不完整"
                .to_string(),
        );
    }
    let dir = resolve_capture_dir(variant, uid)?;
    capture_from_dir(variant, uid, &dir)
}

/// 在候选目录里解析「该账号的登录态在哪」，失败文案指向「去那台机器导出」。
///
/// 单独成函数是为了可测：`capture_for` 的第一道门是「客户端已关闭」，
/// 那条判定读**真实进程表**，在开发者开着 Trae 的机器上必然失败 ——
/// 把它和「目录解析」分开，用例才能稳定地验后者。
fn resolve_capture_dir(variant: TraeVariant, uid: &str) -> Result<PathBuf, String> {
    dir_logged_in_as(variant, uid).ok_or_else(|| {
        format!(
            "这台机器的 Trae 客户端当前没有登录账号 {uid} —— \
             迁移包只能从「已经登录着该账号」的机器上导出。\
             请在那台机器上登录该账号后重试"
        )
    })
}

/// 从**指定目录**打包载体（不做进程与归属判定，调用方负责）。
fn capture_from_dir(
    variant: TraeVariant,
    uid: &str,
    dir: &Path,
) -> Result<(Carrier, CaptureSummary), String> {
    let object = read_storage_object(dir)?;
    let mut storage_keys: BTreeMap<String, String> = BTreeMap::new();
    for (key, value) in &object {
        if key == CLOUDIDE_KEY || key == USERTAG_KEY || key.starts_with(ICUBE_DC_PREFIX) {
            if let Some(text) = value.as_str() {
                storage_keys.insert(key.clone(), text.to_string());
            }
        }
    }
    // 设备身份从键名派生，优先与账号库已有绑定对齐（见 pick_device_id）。
    let device_id = pick_device_id(variant, uid, &storage_keys);
    if !storage_keys.contains_key(CLOUDIDE_KEY) {
        return Err(format!(
            "账号 {uid} 的登录态不完整：storage.json 里没有 {CLOUDIDE_KEY}。\
             请在该机器上重新登录一次后重试"
        ));
    }
    if device_id.is_empty() {
        return Err(format!(
            "账号 {uid} 缺少设备身份（{ICUBE_DC_PREFIX}<deviceId>）—— \
             没有它，目标机上的续期会被上游判 20405。请先在该机器上正常登录一次"
        ));
    }

    let mut files = Vec::new();
    for relative in SESSION_DB_FILES {
        let path = relative
            .split('/')
            .fold(dir.to_path_buf(), |acc, part| acc.join(part));
        let Ok(bytes) = std::fs::read(&path) else {
            // 不存在就跳过：`-wal`/`-shm` 在客户端正常退出后常常本来是空的。
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        files.push(CarrierFile {
            path: (*relative).to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        });
    }

    let carrier = Carrier {
        format: CARRIER_FORMAT.to_string(),
        variant: variant.as_str().to_string(),
        user_id: uid.to_string(),
        device_id: device_id.clone(),
        captured_at: crate::modules::trae::store::now_iso(),
        source_app: dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        storage_keys,
        files,
    };
    let bytes = serde_json::to_vec_pretty(&carrier)
        .map_err(|e| format!("序列化载体失败: {e}"))?
        .len() as u64;
    let summary = CaptureSummary {
        user_id: uid.to_string(),
        device_id_masked: crate::modules::trae::store::mask(&device_id),
        source_app: carrier.source_app.clone(),
        key_count: carrier.storage_keys.len(),
        file_count: carrier.files.len(),
        bytes,
        has_session_db: carrier
            .files
            .iter()
            .any(|file| file.path.ends_with("state.vscdb")),
    };
    Ok((carrier, summary))
}

/// 把载体写成文件（原子写，避免半个 JSON 落在用户手里）。
pub fn write_carrier(path: &Path, carrier: &Carrier) -> Result<(), String> {
    let text = serde_json::to_string_pretty(carrier).map_err(|e| format!("序列化载体失败: {e}"))?;
    crate::modules::trae::store::atomic_write_text(path, &text)
}

/// 从**文本**解析载体并做完整的**结构 + 安全校验**（不校验账号归属：
/// 那要读账号库，见 [`materialize_for`]）。
///
/// 刻意只提供文本形态：导入界面本来就只拿到文件**内容**（浏览器 `FileReader`
/// 没有路径），让后端只接受路径等于强迫前端再落一次盘。
///
/// ⚠️ 前端 `detectCarrier` 只做识别、不做校验，因此**所有不可信字段**都在这里收口：
/// `format` / `userId` / `storageKeys` 键白名单 / `deviceId` 与键名一致 /
/// `files[].path` 白名单 / 体积与数量上限。漏一项就等于把外部 JSON 直接交给写盘。
pub fn read_carrier_text(text: &str) -> Result<Carrier, String> {
    // 先看 `format` 再整体反序列化：否则「别的工具的 JSON」会被报成
    // `missing field capturedAt`，用户看到的是字段名而不是「这不是迁移包」。
    let raw: Value = serde_json::from_str(text).map_err(|e| format!("迁移包不是合法的 JSON：{e}"))?;
    let format = raw
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if format != CARRIER_FORMAT {
        return Err(format!(
            "迁移包格式不受支持（期望 {}，实际 {}）—— 请用同一版本的 AccSwitch 导出",
            CARRIER_FORMAT,
            if format.is_empty() { "缺失" } else { format }
        ));
    }
    let carrier: Carrier =
        serde_json::from_value(raw).map_err(|e| format!("迁移包结构不完整：{e}"))?;
    if carrier.user_id.trim().is_empty() {
        return Err("迁移包缺少账号 ID".to_string());
    }
    if !paths::safe_slot_name(carrier.user_id.trim()) {
        return Err(format!("迁移包里的账号 ID 非法: {}", carrier.user_id));
    }
    if carrier.variant.trim().is_empty() {
        return Err("迁移包缺少产品线标识".to_string());
    }
    if !carrier.storage_keys.contains_key(CLOUDIDE_KEY) {
        return Err(format!("迁移包缺少登录态（{CLOUDIDE_KEY}）"));
    }

    // ① storageKeys 键白名单：只许登录态三族键，避免往 storage.json 注入任意键。
    for key in carrier.storage_keys.keys() {
        if key != CLOUDIDE_KEY && key != USERTAG_KEY && !key.starts_with(ICUBE_DC_PREFIX) {
            return Err(format!("迁移包含有非登录态键：{key}"));
        }
    }
    // ② deviceId 必须能在键集合里对上：它会被写进 device_bindings[uid]，
    //    写错就是「续期时去找一台本机根本没有的设备」，上游回 20405 且不好纠正。
    let device_key = format!("{ICUBE_DC_PREFIX}{}", carrier.device_id);
    if carrier.device_id.is_empty() || !carrier.storage_keys.contains_key(&device_key) {
        return Err("迁移包里的设备身份与登录态键不一致，请重新导出".to_string());
    }
    // ③ files：数量、路径白名单、体积上限。
    if carrier.files.len() > MAX_CARRIER_FILES {
        return Err(format!(
            "迁移包里的文件数超过上限（{}）",
            MAX_CARRIER_FILES
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for file in &carrier.files {
        checked_carrier_path(&file.path)?;
        if !seen.insert(file.path.as_str()) {
            return Err(format!("迁移包里重复的文件：{}", file.path));
        }
        // 先按 base64 长度估算：真解出一个巨大的 Vec 再报错就晚了。
        if carrier_file_size_exceeds(file.base64.len()) {
            return Err(format!("迁移包里的 {} 超过体积上限", file.path));
        }
    }
    Ok(carrier)
}

/// 把载体落成一个**真实快照槽位**，供既有切换流程直接使用。
///
/// ## 为什么不直接写客户端
///
/// 直接写客户端意味着「多一条写用户真实登录态的路径」，而那条路上的每一条教训
/// （关客户端、清 WAL、备份当前态、复核对齐）都已经在
/// [`super::profile::switch_account`] 里。把载体变成槽位，等于**零新增写入路径**：
/// 载体只是「另一个来源的快照」，切换流程一个字都不用改。
///
/// ## 三条纪律（与 [`super::snapshot_migrate`] 一致）
///
/// 1. **只增不改**：目标槽位已存在时**跳过**，绝不覆盖 —— 槽位里那份可能更新；
/// 2. **可重复执行**：并集语义，重复导入不产生副作用；
/// 3. **失败立即回滚**：写了一半的槽位会被删掉，不留下一个「看起来有快照、
///    实际缺文件」的目录（那会让切换静默恢复到半份登录态）。
pub fn materialize_for(
    variant: TraeVariant,
    carrier: &Carrier,
) -> Result<MaterializeOutcome, String> {
    let uid = carrier.user_id.trim();
    if !paths::safe_slot_name(uid) {
        return Err(format!("迁移包里的账号 ID 非法: {uid}"));
    }
    // 跨变体一律拒绝：两条线的 ClientID/端点是两把钥匙，搬过去只会 20405。
    if carrier.variant != variant.as_str() {
        return Err(format!(
            "迁移包属于 {} 产品线，当前是 {} —— 请在同一产品线上导入",
            carrier.variant,
            variant.as_str()
        ));
    }
    let slot = paths::profile_dir_for(variant, uid)
        .ok_or_else(|| "无法定位登录态快照目录".to_string())?;
    if slot.is_dir() && std::fs::read_dir(&slot).map(|mut it| it.next().is_some()).unwrap_or(false) {
        return Ok(MaterializeOutcome {
            user_id: uid.to_string(),
            slot: slot.display().to_string(),
            skipped: true,
            file_count: 0,
            bytes: 0,
        });
    }

    // 先写到临时目录再整体改名：中途失败不会留下半份槽位。
    // ⚠️ 名字必须唯一：固定 `.import-{uid}` 时两个并发导入会互相
    // `remove_dir_all` 掉对方正在写的目录（`store::atomic_write_text` 早就
    // 为同一类并发事故把临时名改成带 uuid，这里不能重犯）。
    let staging = paths::profiles_dir_for(variant).join(format!(
        ".import-{uid}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    let result = write_slot(&staging, carrier);
    match result {
        Ok((file_count, bytes)) => {
            if slot.is_dir() {
                let _ = std::fs::remove_dir_all(&slot);
            }
            if let Some(parent) = slot.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建快照目录失败: {e}"))?;
            }
            std::fs::rename(&staging, &slot).map_err(|e| {
                let _ = std::fs::remove_dir_all(&staging);
                format!("落地快照槽位失败: {e}")
            })?;
            Ok(MaterializeOutcome {
                user_id: uid.to_string(),
                slot: slot.display().to_string(),
                skipped: false,
                file_count,
                bytes,
            })
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

/// 撤销**本次导入新建**的槽位（落地成功、但后续步骤失败时的补偿）。
///
/// 只删 `profile_dir_for` 算出来的那一个目录，uid 已在 [`materialize_for`]
/// 过了 `safe_slot_name`，不额外拼任何外部路径。调用方必须只在
/// `MaterializeOutcome.skipped == false` 时调用 —— 既有槽位绝不能删。
pub fn discard_slot_if_created(variant: TraeVariant, user_id: &str) {
    if let Some(slot) = paths::profile_dir_for(variant, user_id) {
        if slot.is_dir() {
            let _ = std::fs::remove_dir_all(&slot);
        }
    }
}

/// 把载体内容写进 `slot`，返回 `(文件数, 字节数)`。
fn write_slot(slot: &Path, carrier: &Carrier) -> Result<(usize, u64), String> {
    let global = slot.join("User").join("globalStorage");
    std::fs::create_dir_all(&global).map_err(|e| format!("创建目录失败: {e}"))?;

    // ① storage.json：只写载体带来的那些键。
    let storage = Value::Object(
        carrier
            .storage_keys
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    );
    let storage_text =
        serde_json::to_string_pretty(&storage).map_err(|e| format!("序列化 storage.json 失败: {e}"))?;
    std::fs::write(global.join("storage.json"), &storage_text)
        .map_err(|e| format!("写入 storage.json 失败: {e}"))?;

    // ② 会话库系列：原文还原。写入前**再走一次白名单** —— 纵深防御：
    //    `read_carrier_text` 已验过，但本函数也可能被其它调用方直接喂入 `Carrier`。
    let mut files = 1usize;
    let mut bytes = storage_text.len() as u64;
    for file in &carrier.files {
        let relative = checked_carrier_path(&file.path)?;
        let bytes_out = base64::engine::general_purpose::STANDARD
            .decode(&file.base64)
            .map_err(|e| format!("迁移包里的 {} 不是合法 base64: {e}", file.path))?;
        if bytes_out.len() as u64 > MAX_CARRIER_FILE_BYTES {
            return Err(format!("迁移包里的 {} 超过体积上限", file.path));
        }
        let target = relative
            .split('/')
            .fold(slot.to_path_buf(), |acc, part| acc.join(part));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::write(&target, &bytes_out)
            .map_err(|e| format!("写入 {} 失败: {e}", file.path))?;
        files += 1;
        bytes += bytes_out.len() as u64;
    }

    // ③ 来源标记：让「这份快照从哪来」在磁盘上可查（`.source` 是既有约定，不加新约定）。
    let marker = json!({
        "format": carrier.format,
        "capturedAt": carrier.captured_at,
        "sourceApp": carrier.source_app,
        "deviceIdMasked": crate::modules::trae::store::mask(&carrier.device_id),
    });
    std::fs::write(
        slot.join(".source"),
        serde_json::to_string_pretty(&marker).unwrap_or_default(),
    )
    .map_err(|e| format!("写入来源标记失败: {e}"))?;

    Ok((files, bytes))
}

/// 判定「这个账号现在能否不登录就切过去」（**纯读**，不写任何文件）。
///
/// 三种可行来源，优先级从高到低：
/// 1. 已有快照槽位 ⇒ 既有切换流程即可；
/// 2. 客户端此刻正登录着它 ⇒ 切换第 4 步会**自动补存**；
/// 3. 都没有 ⇒ 只能从源机导迁移包，或在该机器上登录一次。
pub fn readiness_for(variant: TraeVariant, user_id: &str) -> Result<Readiness, String> {
    let uid = user_id.trim();
    if uid.is_empty() {
        return Err("账号 ID 不能为空".to_string());
    }
    if !paths::safe_slot_name(uid) {
        return Err(format!("非法的账号 ID: {uid}"));
    }
    let known = super::account::entries_for(variant)
        .iter()
        .any(|(entry_uid, _)| entry_uid == uid);
    if !known {
        return Ok(Readiness {
            user_id: uid.to_string(),
            verdict: "unknown_account",
            reason: "账号库里没有这个账号".to_string(),
            has_snapshot: false,
            client_logged_in: false,
            can_capture_here: false,
        });
    }

    let has_snapshot = paths::profile_dir_for(variant, uid)
        .map(|dir| dir.is_dir())
        .unwrap_or(false);
    let client_logged_in = profile::client_login_uid_for(variant).as_deref() == Some(uid);
    // 归属判定要与 `capture_for` 同源：那个走 `dir_logged_in_as`（遍历候选目录），
    // 本函数若只看「最近活跃目录」，会出现 readiness 说不能采集、导出却能成功。
    // 注意 `canCaptureHere` 表达的是「这台机器上有没有它的登录态」，**不含**
    // 「客户端已关闭」—— 那是 `capture_for` 的第二道门，失败文案会明确提示。
    let can_capture_here = client_logged_in || dir_logged_in_as(variant, uid).is_some();

    let (verdict, reason) = if has_snapshot {
        (
            "snapshot",
            "本机已存有该账号的登录态快照，可直接切换".to_string(),
        )
    } else if client_logged_in {
        (
            "live_client",
            "Trae 客户端当前正登录着该账号，切换时会自动补存登录态".to_string(),
        )
    } else {
        (
            "needs_carrier",
            "本机没有该账号的登录态：可在登录过它的机器上导出「迁移包」后导入，\
             否则只能在本机重新登录一次"
                .to_string(),
        )
    };
    Ok(Readiness {
        user_id: uid.to_string(),
        verdict,
        reason,
        has_snapshot,
        client_logged_in,
        can_capture_here,
    })
}

/// 从载体密文里**读**出的账号凭据（不是构造出来的）。
///
/// ⚠️ **手写 `impl Debug`**：`token` / `refresh_token` 是活凭据，绝不能进
/// `Debug` 输出 —— 与 [`icube::DeviceCredential`] / [`icube::CloudideAuthInfo`]
/// 是同一条脱敏红线（`icube.rs` 模块头：一次 `dbg!` 就等于把凭据打进日志）。
#[derive(Clone)]
pub struct CarrierCredentials {
    pub token: String,
    pub refresh_token: String,
}

impl std::fmt::Debug for CarrierCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CarrierCredentials")
            .field("token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .finish()
    }
}

/// 解开 `cloudide` 信封并校验 uid 一致性（**纯计算，不写任何文件**）。
///
/// 单独抽出来是为了让导入流程把它放在**落地之前**：密文形态不对时，
/// 应该在磁盘上还什么都没有的时候就失败，而不是落地完再补偿回滚。
pub fn parse_credentials(carrier: &Carrier) -> Result<CarrierCredentials, String> {
    let uid = carrier.user_id.trim();
    let cipher = carrier
        .storage_keys
        .get(CLOUDIDE_KEY)
        .ok_or_else(|| "迁移包缺少登录态".to_string())?;
    let plain = icube::tc_decrypt(cipher, icube::TcMode::Aes)
        .map_err(|e| format!("无法解开迁移包里的登录态（{}），请重新导出", e.kind()))?;
    let value: Value =
        serde_json::from_str(&plain).map_err(|e| format!("迁移包里的登录态不是合法 JSON: {e}"))?;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "迁移包里的登录态没有 token".to_string())?
        .to_string();
    let parsed_uid = value.get("userId").and_then(Value::as_str).unwrap_or_default();
    // 防御：载体自报的 uid 与密文里的 uid 必须一致，否则落库会绑到错的账号上。
    if !parsed_uid.is_empty() && parsed_uid != uid {
        return Err(format!(
            "迁移包不一致：登记的是 {uid}，密文里是 {parsed_uid}。请重新导出"
        ));
    }
    let refresh_token = value
        .get("refreshToken")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(CarrierCredentials {
        token,
        refresh_token,
    })
}

/// 账号库里有这条记录时返回 `false`，没有则新建一条并返回 `true`。
///
/// ## 为什么必须做（不做则功能是半截的）
///
/// 切换本身只认 uid（`switch_account` 不查账号库），但**用户点不到它**：
/// 账号页的卡片来自账号库。只落快照不建记录，界面里就没有这个账号，
/// 于是「导入后直接可用」变成了「导入后还缺一步」。
///
/// ## 凭据从哪来
///
/// 从载体里那条 `cloudide` 密文解出 `token` / `refreshToken` —— 这是**读**，
/// 不是构造：解出来的就是客户端当初写进去的那几个值。解不出（信封形态变了）
/// 就明确失败，而不是塞一条没有凭据的空记录。
///
/// ## ★ 设备绑定必须一并写（`device_bindings[uid]`）
///
/// 续期链取设备凭证的唯一依据就是这条绑定（`account::resolve_refresh_secret`
/// → `device_secret_by_device_id`）。导入的登录态属于**源机的设备**，而目标机上
/// 该键此刻还在快照槽位里、尚未进客户端 —— 不写绑定，续期会「猜」成本机别的
/// 设备，上游回 20405。语义与既有 `bind_device` 一致：**只写不删**，
/// 已有绑定的记录不覆盖（那是本机自己的事实，不该被一份迁移包改写）。
/// 凭据由 [`parse_credentials`] 预先解出并传入：调用方应先跑那一步（纯计算），
/// 本函数只负责账号库写入（含设备绑定），避免「落地后才解不开密文」的半成功态。
pub fn register_account_if_missing(
    variant: TraeVariant,
    carrier: &Carrier,
    credentials: &CarrierCredentials,
) -> Result<bool, String> {
    let uid = carrier.user_id.trim();

    super::account::accounts_txn(variant, || {
        // 事务闭包是 `FnMut`（可能重跑），时间戳必须在**闭包内**取，不能在外部捕获。
        let now = crate::modules::trae::store::now_iso();
        let mut file = super::account::load_accounts_checked_for(variant)?;
        let mut changed = false;
        let exists = file
            .accounts
            .iter()
            .any(|account| super::account::resolve_user_id(account) == uid);
        if !exists {
            file.accounts.push(super::account::RawAccount {
                name: format!("账号{}", account_name_suffix(uid)),
                user_id: Some(uid.to_string()),
                jwt: crate::modules::trae::jwt::authorization_header(&credentials.token),
                refresh_token: if credentials.refresh_token.is_empty() {
                    None
                } else {
                    Some(credentials.refresh_token.clone())
                },
                added_at: Some(now.clone()),
                updated_at: Some(now),
                remark: None,
            });
            changed = true;
        }
        // 绑定只写不删：已有绑定一律保留（那是本机自己的事实，不该被迁移包改写）。
        if !carrier.device_id.is_empty() && !file.device_bindings.contains_key(uid) {
            file.device_bindings
                .insert(uid.to_string(), carrier.device_id.clone());
            changed = true;
        }
        // 返回值语义是「**新建了记录**」（UI 靠它决定要不要重拉列表）；
        // 补绑定不算新建 —— 绑定不产生卡片，列表内容并没有变。
        if changed {
            super::account::save_accounts_for(variant, &file)?;
        }
        Ok(!exists)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::trae::account::{self, AccountsFile, RawAccount};
    use crate::modules::trae::test_support::TempEnv;

    /// 注册入口的新签名要先做纯解析；测试里统一走这个薄壳。
    #[cfg(windows)]
    fn register(variant: TraeVariant, carrier: &Carrier) -> bool {
        let credentials = parse_credentials(carrier).unwrap();
        register_account_if_missing(variant, carrier, &credentials).unwrap()
    }

    /// 构造一份「结构合法」的载体 JSON，`patch` 用于逐项篡改字段（浅合并）。
    /// 不依赖真实密文 / APPDATA，因此**跨平台可跑** —— 安全校验必须有 CI 覆盖。
    fn carrier_json(patch: Value) -> String {
        let mut raw = json!({
            "format": CARRIER_FORMAT,
            "variant": TraeVariant::default().as_str(),
            "userId": "9000000000000001",
            "deviceId": "3563979885552250",
            "capturedAt": "2026-11-13T10:00:00",
            "sourceApp": "Trae CN",
            "storageKeys": {
                (CLOUDIDE_KEY): "cipher",
                (USERTAG_KEY): "tag",
                (format!("{ICUBE_DC_PREFIX}3563979885552250")): "device",
            },
            "files": [],
        });
        if let (Some(object), Some(overrides)) = (raw.as_object_mut(), patch.as_object()) {
            for (key, value) in overrides {
                object.insert(key.clone(), value.clone());
            }
        }
        raw.to_string()
    }

    /// 在临时 `APPDATA` 下铺一份「客户端登录着 `uid`」的 userData，返回 `(env, 该目录)`。
    #[cfg(windows)]
    fn seed_client(variant: TraeVariant, uid: &str) -> (TempEnv, PathBuf) {
        let env = TempEnv::empty();
        let name = platform::data_dir_names_for(variant)[0];
        let user_data = env.appdata().join(name);
        let global = user_data.join("User").join("globalStorage");
        std::fs::create_dir_all(&global).unwrap();
        let storage = json!({
            CLOUDIDE_KEY: icube::test_support::synthetic_cloudide_envelope(uid, 9_999_999_999i64),
            format!("{ICUBE_DC_PREFIX}3563979885552250"): icube::test_support::synthetic_device_envelope(),
            USERTAG_KEY: icube::test_support::synthetic_device_envelope(),
            // 无关键：必须**不**被搬进载体。
            "telemetry.machineId": "should-not-be-carried",
        });
        std::fs::write(
            global.join("storage.json"),
            serde_json::to_vec_pretty(&storage).unwrap(),
        )
        .unwrap();
        std::fs::write(global.join("state.vscdb"), b"fake-sqlite-bytes").unwrap();
        (env, user_data)
    }

    /// 写一条账号库记录（`readiness_for` 以账号库为准，不看磁盘上有没有同名目录）。
    #[cfg(windows)]
    fn seed_account(variant: TraeVariant, uid: &str) {
        let file = AccountsFile {
            accounts: vec![RawAccount {
                name: "迁移测试".to_string(),
                user_id: Some(uid.to_string()),
                jwt: "Cloud-IDE-JWT test".to_string(),
                refresh_token: None,
                added_at: None,
                updated_at: None,
                remark: None,
            }],
            device_bindings: Default::default(),
        };
        account::save_accounts_for(variant, &file).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn capture_keeps_only_icube_keys_and_session_db() {
        let variant = TraeVariant::default();
        let (_env, dir) = seed_client(variant, "9000000000000001");
        let (carrier, summary) = capture_from_dir(variant, "9000000000000001", &dir).unwrap();

        // 只搬 icube 相关三键：`telemetry.machineId` 之类的机器指纹一个都不带。
        assert_eq!(carrier.storage_keys.len(), 3);
        assert!(carrier.storage_keys.contains_key(CLOUDIDE_KEY));
        assert!(carrier.storage_keys.contains_key(USERTAG_KEY));
        assert_eq!(carrier.device_id, "3563979885552250");
        assert_eq!(summary.key_count, 3);
        assert!(
            !carrier.storage_keys.values().any(|v| v.contains("should-not-be-carried")),
            "机器指纹不得随账号搬走"
        );
        // 会话库必须在：缺了它，目标机若已登录别的账号会被判缓存不一致。
        assert!(summary.has_session_db);
        assert_eq!(carrier.files.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn capture_refuses_when_client_logged_in_as_another_account() {
        let variant = TraeVariant::default();
        let (_env, _dir) = seed_client(variant, "9000000000000001");
        let error = resolve_capture_dir(variant, "3604620555324748").unwrap_err();
        assert!(
            error.contains("没有登录账号"),
            "失败文案要指向「去那台机器导出」，实际: {error}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn materialize_creates_slot_and_is_idempotent() {
        let variant = TraeVariant::default();
        let (_env, dir) = seed_client(variant, "9000000000000001");
        let (carrier, _) = capture_from_dir(variant, "9000000000000001", &dir).unwrap();

        let first = materialize_for(variant, &carrier).unwrap();
        assert!(!first.skipped);
        assert!(Path::new(&first.slot)
            .join("User/globalStorage/storage.json")
            .is_file());
        assert!(Path::new(&first.slot)
            .join("User/globalStorage/state.vscdb")
            .is_file());

        // 只增不改：第二次必须跳过，且不清掉已有内容。
        let second = materialize_for(variant, &carrier).unwrap();
        assert!(second.skipped);
        assert_eq!(second.file_count, 0);
    }

    #[cfg(windows)]
    #[test]
    fn materialize_rejects_other_product_line() {
        let variant = TraeVariant::default();
        let (_env, dir) = seed_client(variant, "9000000000000001");
        let (mut carrier, _) = capture_from_dir(variant, "9000000000000001", &dir).unwrap();
        carrier.variant = "definitely_not_this_one".to_string();
        let error = materialize_for(variant, &carrier).unwrap_err();
        assert!(error.contains("产品线"), "实际: {error}");
    }

    #[cfg(windows)]
    #[test]
    fn readiness_reports_snapshot_only_for_known_accounts() {
        let variant = TraeVariant::default();
        let uid = "9000000000000001";
        let (_env, dir) = seed_client(variant, uid);
        let (carrier, _) = capture_from_dir(variant, uid, &dir).unwrap();

        // 账号库里没有它 ⇒ 即使磁盘上已经有同名目录，也不得报「可切」。
        materialize_for(variant, &carrier).unwrap();
        assert_eq!(readiness_for(variant, uid).unwrap().verdict, "unknown_account");

        seed_account(variant, uid);
        let ready = readiness_for(variant, uid).unwrap();
        assert_eq!(ready.verdict, "snapshot");
        assert!(ready.has_snapshot);
    }

    #[cfg(windows)]
    #[test]
    fn readiness_reports_live_client_when_logged_in() {
        // 客户端正登录着它但没有快照 ⇒ 切换第 4 步会自动补存，属「可切」。
        let variant = TraeVariant::default();
        let uid = "9000000000000001";
        let (_env, _dir) = seed_client(variant, uid);
        seed_account(variant, uid);
        let ready = readiness_for(variant, uid).unwrap();
        assert_eq!(ready.verdict, "live_client");
        assert!(ready.can_capture_here);
    }

    #[cfg(windows)]
    #[test]
    fn register_account_binds_device_and_is_idempotent() {
        let variant = TraeVariant::default();
        let uid = "9000000000000001";
        let (_env, dir) = seed_client(variant, uid);
        let (carrier, _) = capture_from_dir(variant, uid, &dir).unwrap();

        // ① 库里没有 ⇒ 新建 + 绑定设备。
        assert!(register(variant, &carrier));
        let stored = account::find_for(variant, uid).expect("应已建记录");
        // 凭据来自载体里的密文（读，不是构造）：token 与 refresh 都要落到库里。
        assert!(stored.jwt.starts_with("Cloud-IDE-JWT "), "实际: {}", stored.jwt);
        assert!(
            stored.refresh_token.as_deref().map(|t| !t.is_empty()).unwrap_or(false),
            "refresh_token 必须一并落库，否则网关侧用不了这个账号"
        );
        let bound = account::load_accounts_for(variant)
            .device_bindings
            .get(uid)
            .cloned()
            .unwrap_or_default();
        // ★ 续期链取设备凭证的唯一依据就是这条绑定；缺了它，换机后的续期会猜错设备。
        assert_eq!(bound, "3563979885552250", "导入时必须写设备绑定");

        // ② 再跑一次：既有记录与绑定都不得被改写（只写不删）。
        assert!(!register(variant, &carrier));
        let after = account::load_accounts_for(variant);
        assert_eq!(
            after.device_bindings.get(uid).map(String::as_str),
            Some("3563979885552250")
        );
        assert_eq!(after.accounts.len(), 1, "不得重复建记录");
    }

    #[cfg(windows)]
    #[test]
    fn register_account_fills_missing_binding_but_keeps_existing_one() {
        let variant = TraeVariant::default();
        let uid = "9000000000000001";
        let (_env, dir) = seed_client(variant, uid);
        let (carrier, _) = capture_from_dir(variant, uid, &dir).unwrap();

        // 先放一条**已有绑定**的记录：迁移包不得改写本机自己的事实。
        account::save_accounts_for(
            variant,
            &AccountsFile {
                accounts: vec![RawAccount {
                    name: "已有".to_string(),
                    user_id: Some(uid.to_string()),
                    jwt: "Cloud-IDE-JWT existing".to_string(),
                    refresh_token: None,
                    added_at: None,
                    updated_at: None,
                    remark: None,
                }],
                device_bindings: [(uid.to_string(), "9999999999999999".to_string())].into_iter().collect(),
            },
        )
        .unwrap();
        assert!(!register(variant, &carrier));
        let bound = account::load_accounts_for(variant)
            .device_bindings
            .get(uid)
            .cloned()
            .unwrap_or_default();
        assert_eq!(bound, "9999999999999999", "既有绑定不得被迁移包覆盖");
        // 既有记录的 JWT 也不得被改。
        assert_eq!(
            account::find_for(variant, uid).unwrap().jwt,
            "Cloud-IDE-JWT existing"
        );

        // 换成**没有绑定**的记录：这次要补上（否则续期会猜错设备）。
        account::save_accounts_for(
            variant,
            &AccountsFile {
                accounts: vec![RawAccount {
                    name: "无绑定".to_string(),
                    user_id: Some(uid.to_string()),
                    jwt: "Cloud-IDE-JWT existing".to_string(),
                    refresh_token: None,
                    added_at: None,
                    updated_at: None,
                    remark: None,
                }],
                device_bindings: Default::default(),
            },
        )
        .unwrap();
        assert!(!register(variant, &carrier));
        let bound = account::load_accounts_for(variant)
            .device_bindings
            .get(uid)
            .cloned()
            .unwrap_or_default();
        assert_eq!(bound, "3563979885552250", "缺绑定时必须补上");
    }

    #[test]
    fn read_carrier_rejects_foreign_format() {
        let error = read_carrier_text(
            r#"{"format":"other/9","variant":"trae_cn","userId":"1","storageKeys":{}}"#,
        )
        .unwrap_err();
        assert!(error.contains("格式不受支持"), "实际: {error}");
    }

    // ---- 安全校验（跨平台，Linux CI 也会跑）--------------------------------
    // 前端 detectCarrier 只识别不校验，这些用例就是 Rust 侧那道闸的回归护栏。

    #[test]
    fn read_carrier_accepts_valid_structure() {
        let text = carrier_json(json!({
            "files": [{ "path": "User/globalStorage/state.vscdb", "base64": "ZmFrZQ==" }],
        }));
        let carrier = read_carrier_text(&text).unwrap();
        assert_eq!(carrier.user_id, "9000000000000001");
        assert_eq!(carrier.files.len(), 1);
    }

    #[test]
    fn read_carrier_rejects_traversal_and_absolute_paths() {
        for path in [
            "../../pwned",
            "User/../../pwned",
            "C:/Windows/pwned",
            "User\\globalStorage\\..\\pwned",
            "User/globalStorage/state.vscdb/../pwned",
        ] {
            let text = carrier_json(json!({
                "files": [{ "path": path, "base64": "ZmFrZQ==" }],
            }));
            let error = read_carrier_text(&text).unwrap_err();
            assert!(
                error.contains("文件路径不合法"),
                "path={path} 实际: {error}"
            );
        }
    }

    #[test]
    fn read_carrier_rejects_foreign_storage_keys() {
        let mut raw: Value = serde_json::from_str(&carrier_json(json!({}))).unwrap();
        raw["storageKeys"]["iCubeNativeAppStartSetup"] = json!("true");
        let error = read_carrier_text(&raw.to_string()).unwrap_err();
        assert!(error.contains("非登录态键"), "实际: {error}");
    }

    #[test]
    fn read_carrier_rejects_mismatched_device_id() {
        let error = read_carrier_text(&carrier_json(json!({ "deviceId": "9999999999999999" })))
            .unwrap_err();
        assert!(error.contains("设备身份"), "实际: {error}");
    }

    #[test]
    fn carrier_limits_and_duplicate_files() {
        // 不真的构造 60+ MiB 的字符串：估算函数就是 read_carrier_text 走的那一处。
        assert!(carrier_file_size_exceeds(
            (MAX_CARRIER_FILE_BYTES as usize / 3) * 4 + 8
        ));
        assert!(!carrier_file_size_exceeds(8));

        let dup = carrier_json(json!({
            "files": [
                { "path": "User/globalStorage/state.vscdb", "base64": "ZmFrZQ==" },
                { "path": "User/globalStorage/state.vscdb", "base64": "ZmFrZQ==" },
            ],
        }));
        let error = read_carrier_text(&dup).unwrap_err();
        assert!(error.contains("重复的文件"), "实际: {error}");
    }

    #[test]
    fn write_slot_never_writes_outside_slot() {
        let base = std::env::temp_dir().join(format!(
            "accswitch-carrier-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let slot = base.join("slot");
        let outside = format!("accswitch-pwned-{}", uuid::Uuid::new_v4().simple());
        let mut carrier: Carrier = serde_json::from_str(&carrier_json(json!({}))).unwrap();
        carrier.files.push(CarrierFile {
            path: format!("../../{outside}"),
            base64: base64::engine::general_purpose::STANDARD.encode(b"pwned"),
        });
        let error = write_slot(&slot, &carrier).unwrap_err();
        assert!(error.contains("文件路径不合法"), "实际: {error}");
        assert!(
            !std::env::temp_dir().join(&outside).exists(),
            "任何情况下都不得写出槽位之外"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn account_name_suffix_handles_non_ascii_uid() {
        // 旧实现 `&uid[len-6..]` 在这个 uid 上会落在「中」的字节中间而 panic。
        assert_eq!(account_name_suffix("1234中abcd"), "4中abcd");
        assert_eq!(account_name_suffix("123"), "123");
        assert_eq!(account_name_suffix("9000000000000001"), "000001");
    }
}
