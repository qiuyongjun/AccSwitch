//! 开机自启的**注册身份**与启动期自愈。
//!
//! ## 为什么注册名固定为旧品牌 `BuddySwitch`（**不是笔误，不要"顺手改对"**）
//!
//! 2026-10-21 产品更名为 AccSwitch，但那之前发布的版本（截至 `v2026.10.201902`）
//! 都是以 `BuddySwitch` 这个名字向系统注册自启的：
//!
//! - macOS：`~/Library/LaunchAgents/BuddySwitch.plist`（文件名与 `Label` 都是它）
//! - Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `BuddySwitch` 值
//! - Linux：`~/.config/autostart/BuddySwitch.desktop`
//!
//! `tauri-plugin-autostart` 的 `app_name` **缺省取 `package_info().name`**，也就是
//! `tauri.conf.json` 的 `productName`。改名后若不显式指定，注册名会跟着变成 `AccSwitch`
//! ⇒ 老用户的旧条目还指向旧路径（`/Applications/BuddySwitch.app/…`，升级后已不存在），
//! 而新名字下查不到任何条目 ⇒ **升级后"开机自启"悄悄变回关闭，且每次登录都有一条
//! 指向已删除 app 的失败启动**。这条回归不会报错、不会弹窗，只会静默失效。
//!
//! 三个选项里选了最省事也最稳的一个：
//!
//! 1. **注册名冻结为旧名**（本模块）：老用户的条目名不变，`is_enabled()` 依然为真；
//! 2. 用新名 + 写迁移代码：要按平台分别读写 plist / 注册表 / desktop 文件，代码量与
//!    失败面都大得多，收益只是"系统里那个条目叫得更好听"——而它**对用户不可见**
//!    （macOS 登录项列表显示的是 bundle 名，不是 plist 文件名）；
//! 3. 不管：静默失效。
//!
//! 这与仓库对其它外部标识符的既定做法一致：进程排除、hook 识别、卸载项过滤都保留了
//! 旧名 `buddy-switch` / `BuddySwitch`（见 `8383510` 的提交说明），好让旧安装残留仍能被
//! 认出并替换。**外部标识符跟产品名走是错的：它们一旦发布就永久固化。**
//!
//! ## 为什么还要在启动时"刷一次"注册
//!
//! 条目名不变只能保证"看起来还开着"，**路径不会自动跟着更新**：`productName` 改了，
//! 打包目录随之从 `BuddySwitch.app` / `Program Files\BuddySwitch` 变成 `AccSwitch`。
//! 旧的 plist / Run 值里存的是**旧的绝对路径**，launchd 与 Windows 都只认那个路径
//! ⇒ 条目还在、开机却起不来（`is_enabled()` 只看条目名是否存在，对路径陈旧一无所知，
//! 于是界面上还会显示"已开启"，属于"骗人"的那种失效）。
//!
//! 因此启动时若该条目存在，就调一次 `enable()` 用当前 exe 路径重写它 —— 幂等、只影响
//! **用户本来就已经打开**的开关，不会替任何人做决定。关闭状态的用户完全不碰。
//!
//! ## 失败策略
//!
//! 全过程**尽力而为**：读不到状态或重写失败都只打日志。自启是可选能力，不能因为它
//! 让应用起不来；用户关心的是主界面能不能开。

/// 自启条目的注册名，**永久固定为更名前的 `BuddySwitch`**（见模块头）。
///
/// 改动它 = 让所有老用户的开关变成孤儿条目。真要换名，必须先发布一版带迁移逻辑的
/// 代码（读旧条目 → 写新条目 → 删旧条目），而不是直接改这个常量。
pub const REGISTRATION_NAME: &str = "BuddySwitch";

/// 启动期自愈：条目存在时用**当前** exe 路径重写一次。
///
/// 只处理"用户已经把开关打开"的情况；关闭或读不出状态一律不动。
#[cfg(desktop)]
pub fn refresh_registration(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    match manager.is_enabled() {
        // 已开启 ⇒ 原地重写路径（`enable()` 是幂等的：写 plist / 写 Run 值）。
        Ok(true) => {
            if let Err(error) = manager.enable() {
                eprintln!("[autostart] 刷新开机自启注册失败（不影响本次启动）：{error}");
            }
        }
        Ok(false) => {}
        Err(error) => eprintln!("[autostart] 读取开机自启状态失败：{error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::REGISTRATION_NAME;

    /// 绊线测试：注册名必须停在更名前的旧标识上。
    ///
    /// 这条断言看起来像"把常量抄了一遍"，作用是让**误改**变成一次编译后的红灯：
    /// 下一个人把 `REGISTRATION_NAME` 改成 `AccSwitch` 时，失败信息会直接告诉他
    /// 为什么不能改，而不是等到老用户抱怨"开机不自启了"才发现。
    #[test]
    fn registration_name_stays_on_the_pre_rename_identifier() {
        assert_eq!(
            REGISTRATION_NAME, "BuddySwitch",
            "自启注册名不能跟着 productName 改名：已发布版本用的是 BuddySwitch，改了老用户的自启条目会变孤儿（见模块头）"
        );
    }
}
