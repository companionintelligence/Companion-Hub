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

    # Radial glows behind icon positions (Tauri defaults: ~180, ~480 @ y≈170)
    def radial_blob(cx: int, cy: int, radius: int, fill: tuple[int, int, int, int]) -> None:
        bbox = [cx - radius, cy - radius, cx + radius, cy + radius]
        draw.ellipse(bbox, fill=fill)

    radial_blob(180, 208, 88, (6, 108, 128, 46))
    radial_blob(480, 208, 88, (6, 108, 128, 46))

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Arrow between icon columns — bbox centered at midpoint (180 + 480) / 2 = 330
    ay = 208
    tail_x = 300
    neck_x = 336
    tip_x = 360
    half_head = 12
    draw.line([(tail_x, ay), (neck_x, ay)], fill=ARROW, width=6)
    draw.polygon([(tip_x, ay), (neck_x, ay - half_head), (neck_x, ay + half_head)], fill=ARROW)

    # Typography (DejaVu ships with most Linux/macOS Python installs)
    try:
        title_font = ImageFont.truetype("DejaVuSans-Bold.ttf", 22)
        sub_font = ImageFont.truetype("DejaVuSans.ttf", 14)
    except OSError:
        title_font = ImageFont.load_default()
        sub_font = ImageFont.load_default()

    title = "Install Companion Hub"
    subtitle = "Drag Companion Hub into Applications to install."

    def measure(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont) -> float:
        if hasattr(draw, "textlength"):
            return float(draw.textlength(text, font=font))
        bbox = draw.textbbox((0, 0), text, font=font)
        return float(bbox[2] - bbox[0])

    tw = measure(title, title_font)
    sw = measure(subtitle, sub_font)

    draw.text(((WIDTH - tw) / 2, 36), title, fill=TITLE, font=title_font)
    draw.text(((WIDTH - sw) / 2, 72), subtitle, fill=SUBTITLE, font=sub_font)

    img.save(out_path, "PNG", optimize=True)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
