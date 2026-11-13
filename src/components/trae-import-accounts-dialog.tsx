import { useEffect, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { useT, type Translate } from "@/lib/i18n";
import type { TraeImportPreviewAccount, TraeVariantId } from "@/lib/trae-types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 导入到哪个产品线的账号库（两条线的账号库分家）。 */
  variant: TraeVariantId;
  /** 导入完成后回调（参数为导入结果计数）。 */
  onImported?: (result: { imported: number; skipped: number; overwritten: number }) => void;
}

/** 导入预览账号展示名（脱敏展示：名字 / UID）。 */
function previewLabel(a: TraeImportPreviewAccount, t: Translate): string {
  return a.name || (a.userId ? t("trae.comp.import.uid", { uid: a.userId }) : t("trae.comp.import.item", { index: a.index + 1 }));
}

/** 迁移包的格式标识（与 Rust 侧 `carrier::CARRIER_FORMAT` 必须一致）。 */
const CARRIER_FORMAT = "accswitch.trae.carrier/1";

/** 从文件内容里认出的迁移包信息（**只读结构**，真校验在 Rust 侧）。 */
interface CarrierHint {
  userId: string;
  capturedAt: string;
  sourceApp: string;
  hasSessionDb: boolean;
}

/**
 * 识别「登录态迁移包」。
 *
 * 前端只做**识别**、不做校验：格式/字段/变体是否匹配一律由
 * `carrier::read_carrier_text` 判定，两边各写一份校验规则必然分叉。
 * 这里唯一的职责是「把导入界面切到迁移包形态」，让用户看到自己在导什么。
 */
function detectCarrier(text: string): CarrierHint | null {
  try {
    const raw = JSON.parse(text) as {
      format?: string;
      userId?: string;
      capturedAt?: string;
      sourceApp?: string;
      files?: { path?: string }[];
    };
    if (raw.format !== CARRIER_FORMAT) return null;
    return {
      userId: raw.userId ?? "",
      capturedAt: raw.capturedAt ?? "",
      sourceApp: raw.sourceApp ?? "",
      hasSessionDb: (raw.files ?? []).some((file) => (file.path ?? "").endsWith("state.vscdb")),
    };
  } catch {
    return null;
  }
}

/**
 * 导入 Trae 账号弹框：选 JSON 文件 → 后端解析预览 → 勾选账号 → 导入合并。
 *
 * 与 WorkBuddy 的 `ImportAccountsDialog` 同构。预览只回「有无 JWT / refresh_token」
 * 的布尔量，**不回明文**——脱敏发生在 Rust 侧（`export_import::preview_accounts`），
 * 前端拿不到也可能是刻意不拿。
 */
export function TraeImportAccountsDialog({ open, onOpenChange, variant, onImported }: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [preview, setPreview] = useState<TraeImportPreviewAccount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [parsing, setParsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 认出的迁移包（非空时界面切到「导入登录态」形态，不再走账号预览）。 */
  const [carrier, setCarrier] = useState<CarrierHint | null>(null);
  /** 迁移包导入结果（`null` = 尚未导入）。 */
  const [carrierDone, setCarrierDone] = useState<{
    skipped: boolean;
    slot: string;
    createdAccount: boolean;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setFileName("");
      setFileText("");
      setPreview([]);
      setSelected(new Set());
      setParsing(false);
      setBusy(false);
      setError("");
      setCarrier(null);
      setCarrierDone(null);
    }
  }, [open]);

  function chooseFile() {
    fileInputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // 清空 value，允许再次选择同一文件
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setFileName(file.name);
      setFileText(text);
      setError("");
      setCarrierDone(null);
      // 迁移包与账号库是两种文件：先认一下，认出来就不走账号预览那条路。
      const hint = detectCarrier(text);
      setCarrier(hint);
      if (hint) {
        setPreview([]);
        setSelected(new Set());
        setParsing(false);
        return;
      }
      setParsing(true);
      api
        .traePreviewImportAccounts(text)
        .then((res) => {
          setPreview(res.accounts);
          setSelected(new Set(res.accounts.map((a) => a.index)));
        })
        .catch((err) => {
          setPreview([]);
          setSelected(new Set());
          setError(api.asError(err));
        })
        .finally(() => setParsing(false));
    };
    reader.readAsText(file);
  }

  const allSelected = preview.length > 0 && selected.size === preview.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(preview.map((a) => a.index)));
  }

  function toggle(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function doImport() {
    if (busy || parsing || !fileText) return;
    // 迁移包：落成快照槽位；账号库缺记录时后端会补建（成功时触发父级刷新列表）。
    if (carrier) {
      setBusy(true);
      setError("");
      try {
        const res = await api.traeCarrierImport(fileText, variant);
        setCarrierDone({
          skipped: res.materialized.skipped,
          slot: res.materialized.slot,
          createdAccount: res.createdAccount,
        });
        // 新建了账号记录就必须让父组件重拉列表：切换卡片来自账号库，
        // 不刷新的话用户看不到这个账号，等于白导。
        if (res.createdAccount) {
          onImported?.({ imported: 1, skipped: 0, overwritten: 0 });
        }
      } catch (e) {
        setError(api.asError(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.traeImportAccounts(fileText, [...selected], variant);
      onImported?.(res);
      onOpenChange(false);
    } catch (e) {
      setError(api.asError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>{t("trae.comp.import.title")}</DialogTitle>
          <DialogDescription>{t("trae.comp.import.desc")}</DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={onFileChange}
        />

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={chooseFile} disabled={busy}>
            <FileUp />
            {t("trae.comp.import.chooseFile")}
          </Button>
          {fileName && <span className="truncate text-xs text-muted-foreground">{fileName}</span>}
        </div>

        {carrier && (
          <div className="space-y-2">
            <Alert>
              <AlertDescription className="space-y-1">
                <span className="block font-medium">
                  {t("trae.comp.carrier.detected", { uid: carrier.userId })}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("trae.comp.carrier.meta", {
                    app: carrier.sourceApp || "—",
                    time: carrier.capturedAt,
                  })}
                </span>
                <span className="block text-xs">{t("trae.comp.carrier.explain")}</span>
              </AlertDescription>
            </Alert>
            {!carrier.hasSessionDb && (
              <Alert variant="warning">
                <AlertDescription>{t("trae.comp.carrier.noSessionDb")}</AlertDescription>
              </Alert>
            )}
            {carrierDone && (
              <Alert>
                <AlertTitle>
                  {carrierDone.skipped
                    ? t("trae.comp.carrier.skipped")
                    : t("trae.comp.carrier.done")}
                </AlertTitle>
                <AlertDescription className="break-all font-mono text-xs">
                  {carrierDone.slot}
                  {carrierDone.createdAccount && (
                    <span className="mt-1 block font-sans text-muted-foreground">
                      {t("trae.comp.carrier.createdAccount")}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {parsing && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" /> {t("trae.comp.import.parsing")}
          </div>
        )}

        {!parsing && preview.length > 0 && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t("trae.comp.import.summary", { total: preview.length, count: selected.size })}
              </span>
              <button type="button" className="text-primary hover:underline" onClick={toggleAll}>
                {allSelected ? t("trae.comp.import.deselectAll") : t("trae.comp.import.selectAll")}
              </button>
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {preview.map((a) => (
                <label
                  key={a.index}
                  className="flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={selected.has(a.index)}
                    onChange={() => toggle(a.index)}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{previewLabel(a, t)}</span>
                  {!a.hasJwt && <Badge variant="outline">{t("trae.comp.import.missingJwt")}</Badge>}
                </label>
              ))}
            </div>
          </>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("trae.comp.import.cancel")}
          </Button>
          {carrier ? (
            carrierDone ? (
              <Button onClick={() => onOpenChange(false)}>{t("trae.comp.carrier.doneBtn")}</Button>
            ) : (
              <Button onClick={doImport} disabled={busy || parsing}>
                {busy ? <Loader2 className="animate-spin" /> : <FileUp />}
                {busy ? t("trae.comp.carrier.importing") : t("trae.comp.carrier.import")}
              </Button>
            )
          ) : (
            <Button onClick={doImport} disabled={busy || parsing || selected.size === 0}>
              {busy ? t("trae.comp.import.busy") : t("trae.comp.import.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
