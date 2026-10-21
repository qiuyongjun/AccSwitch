import type { ReactNode } from "react";

import { AppSettingsGroups } from "@/components/app-settings";
import { BackupSection } from "@/components/settings/backup-section";
import { CacheSection } from "@/components/settings/cache-section";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

/**
 * 全局设置的弹框宿主。
 *
 * 「通用」与「备份与恢复」对所有客户端生效，因此不再挂在各客户端设置页的子导航里，
 * 而是收进顶栏 ⚙ 抽屉的两个入口。内容组件与设置页原本是同一份，这里只换外壳；
 * 弹框正文限高滚动，避免窄屏下把操作条挤出视口。
 */
function GlobalSettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 页头固定、正文滚到底：`flush` 去掉默认 p-5，避免滚动区下方留出一条被误认为
          「内容缺失」的空白；`minmax(0,1fr)` 让正文吃满剩余高度并自己滚。 */}
      <DialogContent
        width="wide"
        flush
        className="grid max-h-[86vh] grid-rows-[auto_minmax(0,1fr)]"
      >
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <div className="space-y-4">{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GeneralSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <GlobalSettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("appSettings.global.general")}
      description={t("appSettings.global.generalDesc")}
    >
      <AppSettingsGroups />
    </GlobalSettingsDialog>
  );
}

export function BackupRestoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <GlobalSettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("appSettings.global.backup")}
      description={t("appSettings.global.backupDesc")}
    >
      <BackupSection />
      <CacheSection />
    </GlobalSettingsDialog>
  );
}
