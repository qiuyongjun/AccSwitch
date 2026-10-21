#!/usr/bin/env python3
"""生成托盘图标素材（macOS 菜单栏 template / Windows·Linux 彩色）。

背景：两个平台对「颜色」的处理完全不同，这决定了本脚本产出**两份**素材。
  - macOS 菜单栏是 **template image**：系统只取 **alpha 通道**当形状，
    颜色由菜单栏前景色着色（浅色/深色模式自动适配）⇒ **RGB 被完全忽略**。
  - Windows / Linux 通知区**没有** template 语义（`icon_as_template` 是 no-op），
    RGB **原样生效** ⇒ 深色任务栏下黑色剪影几乎看不见，浅色任务栏下白色剪影
    同样几乎看不见。

结论：按平台分流素材——
  - `tray-icon-template.{png,rgba}`：36x36，形状取自 **专用托盘符号**
    `docs/images/brand/tray-mark.png`（与 App 图标同一套几何、去掉底板），
    RGB 一律填白色（`INK`）。不能直接把整枚 App 图标塞进菜单栏——
    那会得到一块实心圆角方块，既重又糊；alpha 才是形状的唯一来源。
  - `tray-icon-color.{png,rgba}`：32x32，直接使用 App 图标（含底板与圆角），
    保留源图的真实颜色与 alpha。Windows / Linux 托盘本就允许彩色应用图标。
  - 每个变体各写一份 `.rgba` 原始字节（`tray.rs` 用 `include_bytes!` 直接引用）
    与同名 `.png`（仅供预览/替换）。

⚠️ `tray.rs` 里有 `const ICON: &[u8; 36 * 36 * 4]` 与
`const COLOR_ICON: &[u8; 32 * 32 * 4]` 的**编译期长度断言**：
尺寸一旦不是 36 / 32，Rust 侧会直接编译失败，两者必须同步修改。

⚠️ **不要手工改产出的 PNG**。运行时真正生效的是 `.rgba`
（`tray.rs` 以 `include_bytes!` 引用），PNG 只是预览。手改 PNG 既不影响运行，
也会在下次跑本脚本时被静默覆盖 —— 要改就改 `INK`、托盘符号源图或 App 图标源图。

用法：python scripts/gen-tray-icon.py [源图路径] [托盘符号路径]
      默认 `docs/images/brand/logo.png` + `docs/images/brand/tray-mark.png`。
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "docs" / "images" / "brand"
ICONS = ROOT / "src-tauri" / "icons"
SIZE = 36          # macOS template 尺寸，必须与 tray.rs 的 36*36*4 断言一致
COLOR_SIZE = 32    # Windows/Linux 彩色尺寸，必须与 tray.rs 的 32*32*4 断言一致
# template 变体的填充色。白色：macOS 只取 alpha、忽略 RGB，故填什么都行，
# 填白便于肉眼在预览 PNG 上检查形状。
INK = (255, 255, 255)


def template_mask(mark_path: Path) -> Image.Image:
    """托盘符号的 alpha 掩码。符号源图本身就是「白色图形 + 透明底」。"""
    mark = Image.open(mark_path).convert("RGBA").resize(
        (SIZE, SIZE), Image.Resampling.LANCZOS
    )
    return mark.getchannel("A")


def build_template(mask: Image.Image) -> Image.Image:
    """macOS 变体：纯白剪影，颜色交给系统按 template image 着色。"""
    glyph = Image.new("RGBA", (SIZE, SIZE), (*INK, 0))
    glyph.putalpha(mask)
    return glyph


def color_source(src: Path) -> Image.Image:
    """彩色变体的源图下采样（保留真实颜色与 alpha，供出图与校验共用）。"""
    return Image.open(src).convert("RGBA").resize(
        (COLOR_SIZE, COLOR_SIZE), Image.Resampling.LANCZOS
    )


def build_color(source: Image.Image) -> Image.Image:
    """Windows / Linux 变体：App 图标原样缩小。

    透明处 RGB 置 0：LANCZOS 会把圆角外侧的源图颜色带进 alpha=0 的像素，
    虽然合成器会忽略，但部分预览工具会把它显示成脏边。
    """
    color = Image.new("RGBA", (COLOR_SIZE, COLOR_SIZE), (0, 0, 0, 0))
    sp = source.load()
    cp = color.load()
    assert sp is not None and cp is not None
    for y in range(COLOR_SIZE):
        for x in range(COLOR_SIZE):
            r, g, b, a = sp[x, y]
            if a:
                cp[x, y] = (r, g, b, a)
    return color


def write_raw(path: Path, image: Image.Image, size: int) -> bytes:
    """写出 `.rgba` 原始字节：tray.rs 以 include_bytes! 引用，长度必须恰好 size*size*4。"""
    raw = image.tobytes()
    expected = size * size * 4
    if len(raw) != expected:
        raise SystemExit(f"[gen-tray-icon] {path.name} 字节数异常：{len(raw)} != {expected}")
    path.write_bytes(raw)
    return raw


def verify(
    png_path: Path, raw: bytes, size: int, color_src: Image.Image | None = None
) -> None:
    """回读 PNG，确认它与 .rgba 同源，且颜色符合该变体的约定。

    挡的是 **PNG 往返编码失真**——Rust 侧吃的是 `.rgba`，PNG 只是给人看的预览；
    一旦 Pillow 在存盘时改动了 alpha 或把颜色压成别的值，两边就会悄悄分叉，
    而肉眼只看 PNG 看不出来。注意它**拦不住**「手改产物」：两个文件都在本函数
    之前被重写了，手改只会被静默覆盖（见文件头说明）。

    `color_src` 为 None 表示 template 变体，不透明像素的 RGB 必须是 `INK`；
    否则传入彩色变体的**源图下采样**，要求 RGB 逐像素等于它。
    """
    img = Image.open(png_path).convert("RGBA")
    if img.size != (size, size):
        raise SystemExit(
            f"[gen-tray-icon] {png_path.name} 尺寸异常：{img.size} != {(size, size)}"
        )
    got = img.tobytes()
    if len(got) != len(raw):
        raise SystemExit(
            f"[gen-tray-icon] {png_path.name} 与 .rgba 长度不一致：{len(got)} != {len(raw)}"
        )
    ref = color_src.tobytes() if color_src is not None else None
    for i in range(0, len(raw), 4):
        if got[i + 3] != raw[i + 3]:
            raise SystemExit(
                f"[gen-tray-icon] {png_path.name} 与 .rgba 的 alpha 在像素 {i // 4} 处不一致 "
                f"（{got[i + 3]} != {raw[i + 3]}）"
            )
        if raw[i + 3] == 0:
            continue
        if (got[i], got[i + 1], got[i + 2]) != (raw[i], raw[i + 1], raw[i + 2]):
            raise SystemExit(
                f"[gen-tray-icon] {png_path.name} 的 RGB 在像素 {i // 4} 处往返失真："
                f"{(got[i], got[i + 1], got[i + 2])} != {(raw[i], raw[i + 1], raw[i + 2])}"
            )
        expected = INK if ref is None else (ref[i], ref[i + 1], ref[i + 2])
        if (raw[i], raw[i + 1], raw[i + 2]) != expected:
            raise SystemExit(
                f"[gen-tray-icon] 像素 {i // 4} 的颜色不符合该变体约定："
                f"{(raw[i], raw[i + 1], raw[i + 2])} != {expected}"
            )


def report(name: str, raw: bytes, size: int, note: str) -> None:
    opaque = sum(1 for i in range(3, len(raw), 4) if raw[i] > 0)
    print(
        f"[gen-tray-icon] 已生成 {size}x{size} {note} "
        f"（不透明像素 {opaque}/{size * size}）"
    )
    print(f"[gen-tray-icon]   {name}.png  {len(raw)} bytes -> {name}.rgba")


def main() -> None:
    src = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else BRAND / "logo.png"
    mark = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else BRAND / "tray-mark.png"
    for path, label in ((src, "源图"), (mark, "托盘符号")):
        if not path.is_file():
            raise SystemExit(f"[gen-tray-icon] {label}不存在：{path}")

    ICONS.mkdir(parents=True, exist_ok=True)

    # macOS：36x36 纯白 template，RGB 被系统忽略。
    template = build_template(template_mask(mark))
    template_png = ICONS / "tray-icon-template.png"
    template.save(template_png, "PNG")
    verify(
        template_png,
        write_raw(ICONS / "tray-icon-template.rgba", template, SIZE),
        SIZE,
    )

    # Windows / Linux：32x32 彩色，RGB 原样生效。
    source = color_source(src)
    color = build_color(source)
    color_png = ICONS / "tray-icon-color.png"
    color.save(color_png, "PNG")
    verify(
        color_png,
        write_raw(ICONS / "tray-icon-color.rgba", color, COLOR_SIZE),
        COLOR_SIZE,
        color_src=source,
    )

    report("tray-icon-template", template.tobytes(), SIZE, f"单色托盘图标（填充色 RGB{INK}）")
    report("tray-icon-color", color.tobytes(), COLOR_SIZE, "彩色托盘图标（RGB 取自源图）")


if __name__ == "__main__":
    main()
