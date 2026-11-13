/**
 * 「云同步（WebDAV）」分区（顶栏 ⚙ →「备份与恢复」弹框）。
 *
 * ## 边界（与 core `cloud_sync` 对齐）
 *
 * - **只同步账号与凭据**：六个作用域，不含配置 / 网关；
 * - **手动触发**：上传 / 下载两个按钮，不做后台自动同步；
 * - **下载是写操作**：同 uid 覆盖、缺失新增，落盘前 core 会强制快照 ⇒ 前端先二次确认；
 * - **密码不回显**：只显示「已保存」，留空表示沿用；云端文件由「同步密码」加密。
 */

import { useCallback, useEffect, useState } from "react";
import { CloudDownload, CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { DemoAction } from "@/components/demo-action";
import { SettingsFieldRow, SettingsGroup } from "@/components/settings-primitives";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import * as api from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { ImportPreviewScopeRow, ImportSummary, SyncConfigView } from "@/lib/types";

/** 结果行按字段求和（与备份导入的结果口径一致）。 */
function sumField(rows: ImportPreviewScopeRow[] | undefined, key: "added" | "overwritten" | "skipped"): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

/** 「云同步」分区。 */
export function CloudSyncSection() {
  const t = useT();

  const [view, setView] = useState<SyncConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [syncPassword, setSyncPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.getSyncConfig();
      setView(next);
      setUrl(next.url);
      setUsername(next.username);
      setError("");
    } catch (e) {
      setError(api.asError(e));
      toast.error(t("sync.loadFailed"), { description: api.asError(e) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = saving || uploading || downloading;
  const configured = Boolean(
    view?.url && view.username && view.hasPassword && view.hasSyncPassword,
  );
  // 上传 / 下载走**已保存**的配置；表单有未保存改动时必须先保存，否则会静默用旧地址执行。
  const dirty =
    url !== (view?.url ?? "") ||
    username !== (view?.username ?? "") ||
    password !== "" ||
    syncPassword !== "";

  async function save() {
    if (busy) return;
    setSaving(true);
    setError("");
    try {
      const next = await api.saveSyncConfig({ url, username, password, syncPassword });
      setView(next);
      setPassword("");
      setSyncPassword("");
      toast.success(t("sync.saved"));
    } catch (e) {
      setError(api.asError(e));
      toast.error(t("sync.saveFailed"), { description: api.asError(e) });
    } finally {
      setSaving(false);
    }
  }

  /** 只刷新时间戳等展示字段，不覆盖用户正在编辑的输入。 */
  async function refreshView() {
    try {
      setView(await api.getSyncConfig());
    } catch {
      /* 时间戳刷新失败不影响主流程 */
    }
  }

  async function upload() {
    if (busy) return;
    setUploading(true);
    setError("");
    try {
      const result = await api.syncUpload();
      await refreshView();
      const size = Math.max(1, Math.round(result.bytes / 1024));
      toast.success(t("sync.uploadSuccess", { count: result.accounts, size }), {
        description:
          result.skipped > 0 ? t("sync.uploadSkipped", { count: result.skipped }) : undefined,
      });
    } catch (e) {
      setError(api.asError(e));
      toast.error(t("sync.uploadFailed"), { description: api.asError(e) });
    } finally {
      setUploading(false);
    }
  }

  async function download() {
    if (busy) return;
    setDownloading(true);
    setError("");
    try {
      const summary: ImportSummary = await api.syncDownload();
      setConfirmOpen(false);
      await refreshView();
      const counts = {
        added: sumField(summary.perScope, "added"),
        overwritten: sumField(summary.perScope, "overwritten"),
        skipped: sumField(summary.perScope, "skipped"),
      };
      if (summary.failed > 0) {
        toast.error(t("sync.downloadPartial", { count: summary.failed }), {
          description: t("sync.downloadSuccess", counts),
        });
      } else {
        toast.success(t("sync.downloadSuccess", counts));
      }
    } catch (e) {
      setError(api.asError(e));
      toast.error(t("sync.downloadFailed"), { description: api.asError(e) });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <SettingsGroup id="settings-cloud-sync" title={t("sync.title")}>
        <CardContent className="space-y-0 p-0">
          <p className="border-b border-border/60 bg-muted/25 px-4 py-3 text-xs leading-5 text-muted-foreground">
            {t("sync.intro")}
          </p>

          {loading ? (
            <div className="space-y-2 px-4 py-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : (
            <>
              <SettingsFieldRow
                label={t("sync.urlLabel")}
                description={t("sync.urlDesc")}
                htmlFor="sync-url"
                stacked
              >
                <Input
                  id="sync-url"
                  className="w-full"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t("sync.urlPlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                />
              </SettingsFieldRow>

              <SettingsFieldRow
                label={t("sync.usernameLabel")}
                htmlFor="sync-username"
                stacked
              >
                <Input
                  id="sync-username"
                  className="w-full"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t("sync.usernamePlaceholder")}
                  spellCheck={false}
                  autoComplete="off"
                />
              </SettingsFieldRow>

              <SettingsFieldRow
                label={t("sync.passwordLabel")}
                description={t("sync.passwordDesc")}
                htmlFor="sync-password"
                stacked
              >
                <Input
                  id="sync-password"
                  className="w-full"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={
                    view?.hasPassword ? t("sync.passwordSaved") : t("sync.passwordLabel")
                  }
                  autoComplete="new-password"
                />
              </SettingsFieldRow>

              <SettingsFieldRow
                label={t("sync.syncPasswordLabel")}
                description={t("sync.syncPasswordDesc")}
                htmlFor="sync-sync-password"
                stacked
              >
                <Input
                  id="sync-sync-password"
                  className="w-full"
                  type="password"
                  value={syncPassword}
                  onChange={(event) => setSyncPassword(event.target.value)}
                  placeholder={
                    view?.hasSyncPassword
                      ? t("sync.syncPasswordSaved")
                      : t("sync.syncPasswordLabel")
                  }
                  autoComplete="new-password"
                />
              </SettingsFieldRow>

              <p className="border-t border-border/60 px-4 py-2.5 text-xs leading-5 text-muted-foreground">
                {t("sync.securityNote")}
              </p>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                <span>
                  {t("sync.lastUpload", {
                    time: view?.lastUploadAt ? formatDate(view.lastUploadAt) : t("sync.never"),
                  })}
                </span>
                <span>
                  {t("sync.lastDownload", {
                    time: view?.lastDownloadAt ? formatDate(view.lastDownloadAt) : t("sync.never"),
                  })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
                <DemoAction>
                  {/* 读取失败时 `view` 为 null：此时保存会把已存配置覆盖成空值，故禁用。 */}
                  <Button size="sm" onClick={() => void save()} disabled={busy || !view}>
                    {saving ? <Loader2 className="animate-spin" /> : null}
                    {saving ? t("sync.saving") : t("sync.save")}
                  </Button>
                </DemoAction>

                <DemoAction>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void upload()}
                    disabled={busy || !configured || dirty}
                  >
                    {uploading ? <Loader2 className="animate-spin" /> : <CloudUpload />}
                    {uploading ? t("sync.uploading") : t("sync.upload")}
                  </Button>
                </DemoAction>

                <DemoAction>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmOpen(true)}
                    disabled={busy || !configured || dirty}
                  >
                    {downloading ? <Loader2 className="animate-spin" /> : <CloudDownload />}
                    {downloading ? t("sync.downloading") : t("sync.download")}
                  </Button>
                </DemoAction>

                {!configured ? (
                  <span className="text-xs text-muted-foreground">{t("sync.notConfigured")}</span>
                ) : dirty ? (
                  <span className="text-xs text-muted-foreground">{t("sync.unsaved")}</span>
                ) : null}
              </div>
            </>
          )}

          {error && (
            <div className="px-4 pb-3">
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          )}
        </CardContent>
      </SettingsGroup>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sync.downloadConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("sync.downloadConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={downloading}>
              {t("sync.downloadConfirmCancel")}
            </Button>
            <Button onClick={() => void download()} disabled={downloading}>
              {downloading ? <Loader2 className="animate-spin" /> : null}
              {t("sync.downloadConfirmOk")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
