/**
 * 更新源仓库 —— **必须与 `git remote origin` 一致，且仓库真实存在**。
 *
 * ⚠️ 改名/换仓时最容易漏的一处：仓库地址写错不会编译失败、不会运行时报错，
 * 用户只会看到「已是最新」（实际是 404）或打开一个 404 的 Release 页。
 * 同步改三处：本文件、`crates/buddy-switch-core/src/modules/update.rs` 的 `GITHUB_OWNER`
 * / `GITHUB_REPO`、`src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`。
 */
export const GITHUB_OWNER = "qiuyongjun";
export const GITHUB_REPO = "AccSwitch";
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASE_URL = `${GITHUB_REPOSITORY_URL}/releases/latest`;

/** 在桌面端通过 Tauri opener 打开，在 webui 端打开新标签页。 */
export async function openReleaseUrl(url = GITHUB_RELEASE_URL): Promise<void> {
  const isWebui = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  if (isWebui) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
