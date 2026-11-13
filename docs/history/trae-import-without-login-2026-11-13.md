# 导入账号「免重新登录」可行性调研（2026-11-13）

> 状态：**只读历史** —— 一次性调研（本地客户端逆向 + GitHub 生态对照）。若后续采纳，需同步改
> `docs/specs/CLIENTLESS-AUTH-PLAN.md` §2 与 `docs/history/trae-login-materialize-probe-2026-09-29.md` §2/§7 的判定。
>
> **一句话结论**：2026-09-29 判「账号库凭据无法忠实写入客户端」的那两个缺口
> （`account` 富对象、`iCubeServerData`），**已在客户端源码层面被证伪**：
> `account` 是 `GetUserInfo` 响应的**确定性映射**（公式在 `out/main.js` 里），
> `iCubeServerData` 只是**派生缓存**，客户端自己会重建。
> 真正的新增硬约束只有一个：**refresh 需要设备私钥**（DeviceProof），
> 而导入的账号库不含私钥 —— 所以**该迁移的是「设备身份」，不是「登录态」**。
>
> **落地状态（2026-11-13 追加）**：按本结论实现了**只搬运、不构造**的最小切片 ——
> `crates/buddy-switch-core/src/modules/trae/carrier.rs`（登录态迁移包）+ 三条命令
> （`trae_login_readiness` / `trae_carrier_export` / `trae_carrier_import`）。
> 方案 ③（`refresh` + `GetUserInfo` 重建 `cloudide`）**未实施**：风险与本文件 §4 的判断一致，
> 收益不足以抵消「写坏用户登录态」的风险。真机验证 E1–E3 仍未做。

---

## 0. 问题重述

用户的实际症状：**从另一台电脑导入的账号，本机从未登录过，切换时必须人工重新登录一次。**

根因链（按现有实现）：

1. `switch_account` 只认「快照」；快照只能由「客户端已登录时保存」产生；
2. 导入的是账号库形态（`UserID` / `jwt` / `refresh_token`），**不含客户端登录态**；
3. 于是「让客户端显示这个账号」这件事，被绑定到「必须有一次用户态登录」。

本文回答：**能不能在没有用户态登录的前提下，让客户端接受一个外来账号。**

---

## 1. 本地逆向取证（Trae CN 3.4.18 / VS Code 1.107.1）

取证对象：`%LOCALAPPDATA%\Programs\Trae CN\resources\app\out\main.js`（16 MB，未压缩符号名保留）。
本文所有结论标注证据级别：**✅ 源码直读** / **⚠️ 推断** / **❓ 待实测**。

### 1.1 决定性的发现：客户端自己的「登录态迁移」只搬三个键

`main.js` 里的 `migrateLoginState(sourceDir, targetDir)`（TRAE 升级/换产品线时自用）：

```js
const a = "iCubeAuthInfo://usertag";
const c = new Set(["iCubeAuthInfo://icube.cloudide", a]);
const l = u => c.has(u) || u.startsWith("iCubeAuthInfo://icube-dc:");
// cloudide / icube-dc:* → write-if-missing
// usertag              → { ...源, ...目标 } 合并
// 收尾：o.iCubeNativeAppStartSetup = true
```

✅ 三条推论：

| 结论 | 含义 |
|:--|:--|
| **`iCubeServerData` 不在迁移清单里** | 它是**派生缓存**，不是身份。客户端自己会重新拉。 |
| **`iCubeAuthInfo://icube-dc:<deviceId>` 在清单里** | **设备私钥被视为账号可携带的资产**，官方自己就这么搬。 |
| **迁移后置 `iCubeNativeAppStartSetup = true`** | ⚠️ 推断：该布尔量是「按首次启动处理、重建服务端数据」的开关（源码只证明迁移会置它，未证明读取侧语义）。 |

> 这直接推翻了 `trae-login-materialize-probe-2026-09-29.md` §2 与 §8 的判据
> 「完整态 = 9 键且含 `iCubeServerData`」。**`iCubeServerData` 的缺失不能用来判定登录态不完整**，
> 只能用来判定「缓存还没拉过」。

### 1.2 `cloudide` 条目的完整构造公式（此前被判「拿不到」的 `account`）

`main.js` 内 `pS` / `bO`（`refreshToken()` 与登录回调共用同一构造函数）：

```js
pS = (apiHost, s, i, userTag, storeRegion) => ({
  token:            s.Token,
  refreshToken:     s.RefreshToken,
  expiredAt:        dFe(s.TokenExpireAt, s.TokenExpireDuration),
  refreshExpiredAt: new Date(s.RefreshExpireAt).toISOString(),
  tokenReleaseAt:   new Date().toISOString(),
  userId:           i.UserID,
  host:             apiHost,
  userRegion:       { region: i.AIRegion, _aiRegion: i.AIRegion },
  account:          bO(i, userTag, storeRegion),
});

bO = (t, e, i) => ({
  username:           t.ScreenName,
  iss: "", iat: 0, organization: "", work_country: "",
  email:              t.NonPlainTextEmail ?? "",
  avatar_url:         t.AvatarUrl,
  description:        t.Description,
  scope:              "marscode",        // gt.MARSCODE（常量，不是服务端字段）
  loginScope:         "TRAE",            // si.TRAE（常量）
  nonPlainTextMobile: t.NonPlainTextMobile,
  storeCountryCode:   i?.countryCode ?? "",
  storeCountrySrc:    t.StoreCountrySrc ?? "",
  storeRegion:        i?.region ?? UNKNOWN,
  userTag:            e ?? "row",        // mo.ROW
  migrateToSG:        t?.MigrateToSG ?? false,
});
```

★ 关键点：`account.scope` 是**客户端写死的常量** `marscode`，不是服务端下发的不可知字段。
2026-09-29 之所以只能写 `{username}`，是因为当时没找到这条构造链，而不是它不可得。

### 1.3 refresh 全流程 = 我们需要的「免登录重建」路径

```js
async refreshToken(t, e) {
  const s = await this.request.exchangeTokenByRefreshToken(this.apiHost, t, e.token, await this.c);
  const r = await this.request.getUserInfo(this.apiHost, s.Token);   // ★ account 的来源
  const { userTag: n, storeRegion: o } = await this._updateByOriginUserInfo(r);
  return pS(this.apiHost, s, r, n, o);                               // ★ 直接合成 cloudide
}
```

两个接口：

| 步骤 | 请求 | 响应关键字段 |
|:--|:--|:--|
| 1 | `POST {host}/trae/api/v3/oauth/ExchangeToken` | `Result.Token` / `RefreshToken` / `TokenExpireAt` / `TokenExpireDuration` / `RefreshExpireAt` |
| 2 | `POST {host}/cloudide/api/v3/trae/GetUserInfo`，body `{ReqSource:"IDE", IDEVersion}` | `UserID` / `ScreenName` / `AvatarUrl` / `NonPlainTextEmail` / `Description` / `NonPlainTextMobile` / `StoreCountrySrc` / `AIRegion` / `MigrateToSG` |

`storeRegion` 由 `buildStoreRegionByUidCountry(UserID, StoreCountry, userTag, MigrateToSG)` **本地算出**，
不需要额外请求 —— 即整条链**离线可复现**（`userTag` / `storeRegion` 缺失时退化为 `row` / UNKNOWN）。

ⓘ 本仓 `account.rs` 的 `exchange_token_for()` **已经拿到了 `body`**（`try_refresh_variant` 返回 `(access, refresh, body)`），
但只有 `access` / `refresh` 被使用，`body` 被丢弃（`Ok((access_token, refresh_token, _body))`）。
**第 2 步 `GetUserInfo` 是目前唯一缺的拼图**，约 60 行代码量。

### 1.4 客户端为什么「拒绝并清空」——三个登出点（解释 09-29 事故）

> 2026-11-13 修订：初稿把主因归到 `register-user` 失败，复核源码后确认那条只在 **beta 通道**触发
> （`zo(this.h)==="beta" && (... await logout())`）。稳定通道的真实主因是下面第 1 条。

| # | 触发点 | 代码表现 | 后果 |
|:--|:--|:--|:--|
| 1 | `UserInfoManager.e()` | 缓存 userInfo 解析失败 / 字段校验不过（`account.storeRegion`、`account.userTag`、`migrateToSG` 缺失）⇒ `catch` → `[UserInfoManager] corrupted local storage, forcing logout` → `setUserInfo(void 0, true)` | **强制登出并清掉服务端数据** |
| 2 | `_updateByOriginUserInfo` | `if (userInfo.userId !== t.UserID) throw UserInfoNotMatchError` | 缓存 userInfo 与新 token 不同源 ⇒ 抛错 |
| 3 | `ICubeProductService` register-user | `POST /icube/api/v1/user` 返回 `success:false` 时，**仅 beta 通道** `await this.j.logout()` | 强制登出（稳定通道只记日志） |

机制链条（稳定通道）：2026-09-29 写的 `account` 只有 `{username}` ⇒ 缺 `storeRegion` / `userTag` / `migrateToSG`
⇒ 第 1 条判缓存损坏 ⇒ 强制登出 ⇒ `iCubeServerData` 被删。
**这就是「7 键 + 无 serverData」的真实成因**，不是「服务端判定账号不一致」。

★ 反过来说：`bO()` 恰好为这三个字段都提供了确定值 —— `storeRegion` 由
`buildStoreRegionByUidCountry()` 本地算、`userTag` 默认 `row`、`migrateToSG` 默认 `false`。
**只要按 §1.2 的公式写，"缓存损坏"这个触发点就不可能命中。**

⚠️ 另有一份 userInfo 缓存在 **`state.vscdb`**（`UserInfoManager` 的 `persistedKey = iCubeAuthInfo://<authProviderId>`，
值是 tc 同族信封：`u0` 写 / `r4` 读，**不是 DPAPI**）。它与 `storage.json` 的 `cloudide` 必须同源，
否则命中第 1/2 条。**只换 `storage.json` 不换这个键，切换必然登出** —— 这是 §8「坏状态回灌」的真正机制。

### 1.5 多实例能力（顺带取证）

| 能力 | 证据 | 结论 |
|:--|:--|:--|
| `--user-data-dir` | `main.js` 的 `getUserDataPath` 分支：`VSCODE_PORTABLE` → `VSCODE_APPDATA` → `--user-data-dir` → `%APPDATA%` | ✅ 支持 |
| `--extensions-dir` | 参数表存在，4 处引用 | ✅ 支持 |
| 单实例锁粒度 | `code.lock` 位于 userData 内；IPC 句柄由 user-data-dir 路径派生（`WARNING: IPC handle ... longer than N chars, try a shorter --user-data-dir`） | ✅ **每 userData 一个实例，可并行多开** |
| `--remote-debugging-port` | 参数存在（Electron 层） | ✅ CDP 可用 |

---

## 2. GitHub 生态对照（同问题、不同路线）

| 仓库 | 形态 | 核心路线 | 对「免登录」的价值 |
|:--|:--|:--|:--|
| [`bean0283/trae-switch-cn`](https://github.com/bean0283/trae-switch-cn) | Tauri 2，MIT | 冷切换：**杀进程 → 还原账号载体 → 重启**，失败自动回滚；另做会话库解密/迁移 | 与本仓同路线，**同样没解决「外来账号无载体」** |
| [`xhrxgr/Trae-Work-CN-Account-Manager`](https://github.com/xhrxgr/Trae-Work-CN-Account-Manager) | Tauri 2 | **多开**：每账号独立 `--user-data-dir` + 共享 `--extensions-dir`；零侵入、不杀进程；**本地解密读已有登录态**；支持「Token 添加账号」 | ★ 证明多开可行；但每实例 3–8 GB，且「Token 添加」仍需一次落地写盘 |
| [`Yang-505/Trae-Account-Manager`](https://github.com/Yang-505/Trae-Account-Manager) | 上者的上游 | 同上 | 同上 |
| [`crush1994/Trae-AutoCheckin`](https://github.com/crush1994/Trae-AutoCheckin) | Python 脚本 | 只取 `refresh_token` 跑签到；**另有「手机号 + 短信验证码」网页登录路径，完全不需要客户端** | ★★ 真正「免客户端」的登录替代：验证码换 token |
| [`JsonLing/trae-cn-provider`](https://github.com/JsonLing/trae-cn-provider) | 代理/插件 | 直接读本机 `storage.json`；明确记录 **tc 信封密钥材料内嵌于密文（第 6–38 字节），不依赖 Keychain/DPAPI** | 佐证跨机解密可行；也记录了「客户端运行期间会主动删掉 cloudide 键」 |
| [`yiyiqd/trae-session-export`](https://github.com/yiyiqd/trae-session-export) | 脚本 | 会话库解密 | 与本问题无关，会话迁移用 |
| `likecu/trae-minimax-client`（DeepWiki 文档） | Python 客户端 | REST 认证：`Authorization: Bearer` **与** `x-cloudide-token` 双头；记录 IPC `ckg.refresh_token` 的循环依赖 | 佐证 `GetUserInfo` 可被外部调用 |
| DSH `account-pool` 插件 | 服务器插件 | **不做网页登录**，直接导入桌面端 `storage.json` 整文件 | ★ 与本文结论同向：**搬文件，不搬 JWT** |

**生态共识**：没有一个仓库声称「只凭 JWT 就能让客户端登录」；
能做「免登录」的，都是**把源机的登录态/设备身份当文件搬过去**，或**用验证码换一次 token**。

---

## 3. 方案矩阵

| # | 方案 | 是否免除用户态登录 | 增量成本 | 主要风险 |
|:--|:--|:--|:--|:--|
| **A** | **导入「设备身份包」+ 本地重建 `cloudide`**（推荐） | ✅ 完全免除 | 中：`GetUserInfo` 封装 + 写盘加固 | 跨机 deviceId 复用的服务端风控 ❓ |
| B | 导入**完整 `storage.json` 三键**（cloudide + usertag + icube-dc）直接写盘 | ✅ 免除（token 未过期时零请求） | 低：本质是"便携快照"，但只导 3 个键 | 源机 `account` 可能已过期；变体串味（SOLO/CN） |
| C | **短信验证码登录**换 `refresh_token`（无需客户端） | ⚠️ 需一次验证码（人参与，但不是"登录客户端"） | 中：网页登录流程复刻 | 风控/短信成本；与"用户态"诉求部分不符 |
| D | **多开**（`--user-data-dir` per account） | ❌ 仍需每实例登录一次 | 高：每实例 3–8 GB 磁盘 | 磁盘；不解决"外来账号" |
| E | 网关直连（凭据池，不落客户端） | ✅ 已支持 | 零（已落地） | 只解决 API 用量，不解决「客户端界面显示该账号」 |

> A/B 的差别只在「谁来重建 `cloudide`」：A 本地重建（token 一定新鲜），B 直接搬（token 可能过期，过期后仍需 refresh）。
> 两者都必须解决 **§1.4 的 state.vscdb 同源问题**，否则切换后必被登出。

---

## 4. 推荐路线 A 的落地步骤

### 4.1 导入侧（源机）—— 扩一个字段，不换格式

现状：导出 `RawAccount` 数组（`UserID` / `jwt` / `refresh_token`）。
增加一个**可选**的 `device_identity` 对象（缺省不写，保持老文件可读）：

```jsonc
{
  "UserID": "…", "jwt": "Cloud-IDE-JWT …", "refresh_token": "…",
  "device_identity": {
    "device_id": "3563979885552250",
    "icube_dc": "<storage.json 里 iCubeAuthInfo://icube-dc:<deviceId> 的密文原值>",
    "usertag":  "<iCubeAuthInfo://usertag 的密文原值>"
  }
}
```

密文**原样搬运**（不要求源机解密）：tc 信封的 pepper 是随包分发的公开常量表，
目标机用同一套 `tc_decrypt` 即可解开拿私钥 —— 见 `crates/buddy-switch-core/src/modules/trae/icube.rs` 模块头。

### 4.2 重建侧（目标机）

```
1. refresh：exchange_token_for(variant, refresh_token, device_id)   ← 已有
             （有 device_identity 时带 proof；无则沿用现有「不发 proof」变体）
2. 补取账号：POST {host}/cloudide/api/v3/trae/GetUserInfo
             headers: Authorization: <jwt> + x-cloudide-token: <token>
             body:    { ReqSource: "IDE", IDEVersion: <product.json appVersion> }
3. 合成：按 §1.2 的 pS/bO 公式生成 cloudide（scope 固定 "marscode"）
4. 写盘（一个事务，顺序固定）：
     a. storage.json["iCubeAuthInfo://icube.cloudide"]      = 新信封（tc_encrypt）
     b. storage.json["iCubeAuthInfo://icube-dc:<deviceId>"] = device_identity.icube_dc（若导入）
     c. storage.json["iCubeAuthInfo://usertag"]             = 合并写（只改自己那条）
     d. storage.json["iCubeNativeAppStartSetup"]            = true      ← ★ 新增，触发服务端数据重建
     e. state.vscdb 删除 UserInfoManager 的 persistedKey 缓存            ← ★ 必须，否则 UserInfoNotMatch
     f. 清除 logs/ 与 -wal/-shm（沿用现有 RESTORE_PURGE_RELATIVES）
5. 客户端启动 → 自行 refreshServerData 补齐 iCubeServerData（无需我们构造）
```

写完后**读回复核**：解开 `cloudide` 校验 `userId` 与 `account.scope == "marscode"`；
`iCubeServerData` 缺失属于**正常**，不得当成失败（这与现有 `client_state_looks_complete` 的判据冲突，需一并改）。

### 4.3 必须先做的三个实验（本会话无法代跑：需 GUI 客户端）

| # | 实验 | 判据 |
|:--|:--|:--|
| E1 | 无 proof 的 `ExchangeToken` 对**导入账号**是否成功 | 现有变体 4/6 是否返回 `Token`。成功 ⇒ 方案 A 连设备包都不需要 |
| E2 | 有源机 `icube-dc`（跨机）时 refresh 是否被拒 | `20403 Device not match` ⇒ 设备绑定校验存在，方案降级为 B/C |
| E3 | 按 4.2 写盘后启动客户端 | 界面显示目标账号且**不被登出**；`storage.json` 出现新的 `iCubeServerData` |

沙箱配方沿用 `trae-login-materialize-probe-2026-09-29.md` §4：`set APPDATA=<临时目录>` 后启动，不动真机 profile。
⚠️ 该文 §8 的教训仍然有效：**`kill_client_for` 沙箱隔离不了**，E3 必须人工确认客户端已关闭。

---

## 5. 对既有文档的修订建议（采纳后再动）

| 文档 | 现结论 | 应改为 |
|:--|:--|:--|
| `history/trae-login-materialize-probe-2026-09-29.md` §2 | `account` 是服务端下发、无法复现 | `account` 是 `GetUserInfo` 的确定性映射，字段与常量见本文 §1.2 |
| 同上 §7 | 客户端「判定账号不一致」⇒ 不可行 | 真实成因是 register-user 失败触发 `logout()`；`account.scope` 补齐后不触发 |
| 同上 §8 | 完整性判据 = 含 `iCubeServerData` | 判据改为「`cloudide.userId` 与 `state.vscdb` 缓存同源」；`iCubeServerData` 是派生缓存 |
| `specs/CLIENTLESS-AUTH-PLAN.md` §2 | Trae 无客户端不能登录、不能续期 | 保留「不能登录」，新增「可导入设备身份包后本地重建」 |
| `profile.rs` `client_state_looks_complete` | 以 `iCubeServerData` 存在为完整性判据 | 需改为同源校验，否则会误判「新建的信封」为坏状态并拒绝回写 |

---

## 6. 结论

1. **「必须重新登录一次」不是协议限制，是当前导入格式的信息缺失** —— 缺的是设备身份，不是登录态。
2. 客户端**自己的**迁移逻辑（只搬 cloudide + usertag + icube-dc、不搬 serverData）就是最好的配方参照。
3. `account` 富对象与 `iCubeServerData` 两个历史"缺口"，一个可算、一个可省 —— 09-29 的「不可行」判定应予修正。
4. 剩余唯一真实不确定性在**服务端是否接受跨机复用的设备身份**（E2）。若接受，方案 A 可完全消除用户态登录；
   若不接受，退到 C（短信验证码）仍比"打开客户端扫码登录"轻。
