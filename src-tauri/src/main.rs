// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 兼容旧版「会话监听」写进客户端配置的 `hook --source ...` 调用：功能已删除，
    // 这里读掉 stdin（避免客户端写管道触发 EPIPE）后静默退出 —— 绝不能再把 GUI 拉起来。
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("hook") {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(0);
    }
    buddy_switch_rust_lib::run()
}
