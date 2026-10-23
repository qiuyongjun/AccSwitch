/**
 * 「添加账号」抽屉 —— 逐值对齐原型 `drawerAdd()`
 *（`buddy-switch-prototype.html:3708-3734`、样式 `demo.css:509-519 / 481-495 / 538-547`）。
 *
 * ## 为什么必须有这一层（而不是让「添加账号」直接开 OAuth 对话框）
 *
 * 原型点工具栏「+ 添加账号」是 `case "add-account": stop(); drawerAdd();`（`:4235`）——
 * **先开一个抽屉**，各种方式（OAuth 登录 / 从本机导入 / 导入备份文件）各占一张
 * `.opt` 可点卡。本仓此前**跳过**了这一层，`+ 添加账号` 直接 `setOauthOpen(true)`。
 *
 * ## ★ 抽屉只负责「添加方式 + 粘贴凭据」（2026-10-23 收敛）
 *
 * 2026-10-12 曾把原工具栏「⋯」溢出菜单的内容并进本抽屉（`moreTools`：两枚开关 + 两个动作）。
 * 2026-10-23 用户要求**整块删除** —— 理由不是「不好看」，而是**职责重叠**：
 *
 * - 自动签到 / 自动旅行 / 跳过已签到：**设置页**已有等价开关，两处各放一份必然打架；
 * - 导出：**批量条**已有「导出所选」，一键导出全量没有第二个语义；
 * - 「签到并刷新全部积分」：与「一键刷新」「批量刷新」构成**第三套刷新语义**
 *   （签到 + 积分 + 旅行 + 今日 Token 混在一个动作里），失败原因分不清。
 *
 * ⇒ 现在的结构只有两段：① 添加方式卡（基础三张 + 平台专属 `extraOptions`）
 * ② 未装客户端提示。开关归设置页、批量动作归批量条、刷新归页头 / 批量条 —— 抽屉不再承载入口。
 *
 * ⇒ 三平台的「添加账号」入口**同一个组件、同一套结构**，差异只有数据
 *（`extraOptions` 由页面注入），与 `account-toolbar.tsx` 同一条纪律。
 *
 * ## 几何（逐值对齐）
 *
 * -抽屉：复用 `ui/sheet.tsx`（本轮已对齐为 `bg-card` / `w-3/4 sm:max-w-[460px]`），
 *   即原型 `.drawer` 的 `width:min(460px,94vw)`（`demo.css:483`）。
 * - 作用域副标题：原型是 `.tiny` = **11px**（`demo.css:550`），作用域名用 `<b>` 加粗。
 * - `.opt`（`demo.css:509-519`）：`flex items-center gap:11px`、`padding:12px 13px`、
 *   `rounded-[11px]`、`border` + `bg-card-2`；hover 换 `--accent` 底 + `--border-strong` 描边。
 *   图标块 `32×32 rounded-[9px] bg-muted`；标题 `12.5px/550`；说明 `11px muted`；
 *   右侧 `ArrowRight`（继承全局 `svg 16px`，原型未给单独尺寸）。
 * - 未装客户端提示：原型是 `warning` 描边卡（`demo.css:3730-3732`），这里同样式。
 */

import type { LucideIcon } from "lucide-react";
import { ArrowRight, Download, LogIn, TriangleAlert, Upload } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type AddAccountWay = "oauth" | "local" | "backup";

/** 一张「添加方式」卡（平台专属的那些经 `extraOptions` 注入）。 */
export interface DrawerOption {
  key: string;
  icon: LucideIcon;
  /** 已 i18n。 */
  title: string;
  /** 已 i18n。 */
  desc: string;
  disabled?: boolean;
  onClick: () => void;
}

export interface AddAccountDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 作用域显示名（如「WorkBuddy 国际版」），用于副标题。 */
  scopeLabel: string;
  /** 当前作用域是否检测到客户端 —— 未检测到时禁用「从本机导入」并给提示。 */
  installed: boolean;
  onPick: (way: AddAccountWay) => void;
  /**
   * ★ 实际渲染的**基础方式**子集（缺省 = 原型三张全出）。
   *
   * 平台能力子集：某方式尚未落地的平台**不渲染对应卡** —— 摆一张点下去必然失败的卡，
   * 与「禁用按钮不给解释」一样糟（与 `account-batch-bar`「缺哪个就不渲染哪个」
   * 同一条纪律）。⚠️ 收窄前先确认该方式在**该平台的后端命令链**里真的不存在：
   * Qoder 侧「OAuth 设备码 / 导入备份」都尚未落地 ⇒ 只留 `["local"]`，
   * 「粘贴 PAT」走 `extraOptions`（那是已落地的真实命令）。
   */
  ways?: AddAccountWay[];
  /** 平台专属的**额外**添加方式（如 Trae 的「粘贴 JWT」），接在基础三张卡之后。 */
  extraOptions?: DrawerOption[];
  labels: {
    /** 副标题前半句，作用域名之后紧接（原型：「当前作用域：」）。 */
    scopeHintPrefix: string;
    /** 副标题后半句（原型：「。选择一种方式添加账号。」）。 */
    scopeHintSuffix: string;
    oauthTitle: string;
    oauthDesc: string;
    localTitle: string;
    localDesc: string;
    backupTitle: string;
    backupDesc: string;
    notInstalled: string;
    title: string;
  };
}

/** 单个 `.opt` 可点卡（原型 `demo.css:509-519`）。 */
function Option({
  icon: Icon,
  title,
  desc,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[11px] border border-border bg-card-2 px-3 py-3 text-left transition-all",
        "hover:border-border-strong hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {/* 32×32 / r9 / 底 --muted（原型 `.opt .ico`，`demo.css:515`） */}
      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      {/* `.t b` 12.5px/550 · `.t span` 11px muted（`demo.css:518-519`） */}
      <span className="min-w-0 flex-1">
        <b className="block text-[12.5px] font-[550] leading-tight">{title}</b>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{desc}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

export function AddAccountDrawer({
  open,
  onOpenChange,
  scopeLabel,
  installed,
  onPick,
  ways = ["oauth", "local", "backup"],
  extraOptions,
  labels,
}: AddAccountDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-full sm:max-w-[460px]">
        <SheetHeader className="border-b border-border px-4 py-3.5">
          {/* 原型抽屉标题走 `openDrawer(body, "添加账号")`，标题即「添加账号」 */}
          <SheetTitle className="text-[14px] font-semibold">{labels.title}</SheetTitle>
          {/* 原型 `drawerAdd()`（`:3712`）：「当前作用域：`<b>`作用域名</b>`。选择一种方式添加账号。」
              `.tiny` = 11px（`demo.css:550`），作用域名用 `<b>` 加粗。
              ⇒ 文案拆成前后两半拼，作用域名单独渲染（不能整体丢给 t() 替换）。 */}
          <SheetDescription className="text-[11px] leading-relaxed">
            {labels.scopeHintPrefix}
            <b className="text-foreground">{scopeLabel}</b>
            {labels.scopeHintSuffix}
          </SheetDescription>
        </SheetHeader>

        {/* `.dsec` = `flex flex-col gap:9px`（`demo.css:490`） */}
        <div className="flex flex-col gap-2.5 overflow-y-auto p-4">
          <div className="flex flex-col gap-2.5">
            {/* 基础三张卡按 `ways` 收窄（缺省全出）；平台尚未落地的方式**不渲染**（见 Props）。 */}
            {ways.includes("oauth") && (
              <Option
                icon={LogIn}
                title={labels.oauthTitle}
                desc={labels.oauthDesc}
                onClick={() => {
                  onOpenChange(false);
                  onPick("oauth");
                }}
              />
            )}
            {ways.includes("local") && (
              /* ⚠️ **不置灰**（issue #62）：禁用既不给原因也不给替代，用户只会看到
                 「点不动」。没装客户端时它仍然可点，由页面回一句「改用哪两条路」。 */
              <Option
                icon={Upload}
                title={labels.localTitle}
                desc={installed ? labels.localDesc : labels.notInstalled}
                onClick={() => {
                  onOpenChange(false);
                  onPick("local");
                }}
              />
            )}
            {ways.includes("backup") && (
              <Option
                icon={Download}
                title={labels.backupTitle}
                desc={labels.backupDesc}
                onClick={() => {
                  onOpenChange(false);
                  onPick("backup");
                }}
              />
            )}
            {/* 平台专属的额外方式（Trae：粘贴 JWT 兜底）—— 由页面注入，壳内不含平台判断。 */}
            {extraOptions?.map((option) => (
              <Option
                key={option.key}
                icon={option.icon}
                title={option.title}
                desc={option.desc}
                disabled={option.disabled}
                onClick={() => {
                  onOpenChange(false);
                  option.onClick();
                }}
              />
            ))}
          </div>

          {/* 未装客户端提示（原型 `:3730-3732`）：描边 warning 卡 */}
          {!installed ? (
            <div className="mt-1 flex items-center gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2">
              <TriangleAlert className="size-[15px] shrink-0 text-warning" aria-hidden="true" />
              <span className="text-[11px] leading-relaxed text-warning">{labels.notInstalled}</span>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}