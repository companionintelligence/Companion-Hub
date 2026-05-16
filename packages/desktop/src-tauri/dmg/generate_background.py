#!/usr/bin/env python3
"""Raster Companion Hub DMG window artwork (660×400, Finder defaults).

Run from repo root or this directory after editing layout constants:
  python3 packages/desktop/src-tauri/dmg/generate_background.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH = 660
HEIGHT = 400

# Brand (CI logo SVG + app dark theme)
BG_TOP = (18, 22, 34)
BG_BOTTOM = (26, 32, 52)
TITLE = (240, 244, 248)
SUBTITLE = (165, 176, 198)
ARROW = (255, 255, 255)
# Light blue-turquoise orbs: same family as `--chart-2` in
# packages/frontend/src/styles/globals.css, nudged cooler / more azure (solid fill).
BRAND_BLOB_RGBA = (216, 245, 253, 255)


def _load_font(size: int, *, bold: bool) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Resolve a scalable TTF — required for real point sizes.

    DejaVu is common on Linux (CI); macOS usually lacks DejaVu, so we fall back to
    Supplemental Arial. Without a TTF, Pillow's ``load_default()`` is a tiny bitmap
    font and ignores ``size`` (why headline text looked stuck 'small' on Mac).
    """
    if bold:
        candidates = (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "DejaVuSans-Bold.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
        )
    else:
        candidates = (
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
        )
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _interpolate_color(y: float) -> tuple[int, int, int]:
    t = max(0.0, min(1.0, y / HEIGHT))
    return tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))


def main() -> None:
    out_path = Path(__file__).resolve().parent / "dmg-background.png"
    img = Image.new("RGB", (WIDTH, HEIGHT))
    px = img.load()
    for y in range(HEIGHT):
        row_c = _interpolate_color(float(y))
        for x in range(WIDTH):
            px[x, y] = row_c

    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # Radial discs behind icon columns (x matches tauri.conf app / Applications positions).
    def radial_blob(cx: int, cy: int, radius: int, fill: tuple[int, int, int, int]) -> None:
        bbox = [cx - radius, cy - radius, cx + radius, cy + radius]
        draw.ellipse(bbox, fill=fill)

    # Brand-tinted discs (--chart-2 hue, very light)
    # Disc + arrow vertical center. Tauri `appPosition.y` is icon top-left (see tauri.conf.json).
    # Offset is tuned so orbs sit slightly higher than the icon stack — not locked to icon center.
    TAURI_DMG_ICON_Y = 202
    disc_center_offset = 24
    icon_row_cy = TAURI_DMG_ICON_Y + disc_center_offset
    circle_r = 112
    radial_blob(180, icon_row_cy, circle_r, BRAND_BLOB_RGBA)
    radial_blob(480, icon_row_cy, circle_r, BRAND_BLOB_RGBA)

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Arrow between icon columns — bbox centered at midpoint (180 + 480) / 2 = 330
    ay = icon_row_cy
    tail_x = 300
    neck_x = 336
    tip_x = 360
    half_head = 12
    draw.line([(tail_x, ay), (neck_x, ay)], fill=ARROW, width=6)
    draw.polygon([(tip_x, ay), (neck_x, ay - half_head), (neck_x, ay + half_head)], fill=ARROW)

    # Typography (TTF required — see _load_font docstring)
    title_font = _load_font(32, bold=True)
    sub_font = _load_font(19, bold=False)

    title = "Install Companion Hub"
    subtitle = "Drag Companion Hub into Applications to install."

    def measure(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont) -> float:
        if hasattr(draw, "textlength"):
            return float(draw.textlength(text, font=font))
        bbox = draw.textbbox((0, 0), text, font=font)
        return float(bbox[2] - bbox[0])

    tw = measure(title, title_font)
    sw = measure(subtitle, sub_font)

    draw.text(((WIDTH - tw) / 2, 14), title, fill=TITLE, font=title_font)
    draw.text(((WIDTH - sw) / 2, 58), subtitle, fill=SUBTITLE, font=sub_font)

    img.save(out_path, "PNG", optimize=True)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
