#!/usr/bin/env python3
"""Rasterize the Hub logo SVGs into every PNG/ICO the Hub ships.

Run after build_hub_logo.py. Needs `rsvg-convert` (librsvg) and Pillow.

    python3 scripts/build_hub_rasters.py            # from packages/frontend/hub-brand

Outputs (all regenerated, never edited by hand):

    logos/app-icon-source.png     1024 px transparent disc, edge to edge: the one input to
                                  `tauri icon` for the desktop and mobile apps
    icons/png/favicon-96.png      small mark, transparent (tab icon, also embedded in the API)
    icons/png/favicon.ico         small mark at 16, 32 and 48 px
    icons/png/apple-touch-icon-180.png, icon-192.png, icon-512.png
                                  the full-bleed dark tile, opaque (apple-touch, maskable PWA)
    icons/png/mark-512.png        full mark, transparent (public/hub.png)
    icons/png/mark-small-160.png  small mark (setup page and bootstrap page logo, shown at 48 and 30 px)
    icons/png/mark-40.png         small mark (bootstrap page icon)
    icons/png/tray-64.png         small mark (system tray; macOS draws only its alpha, as a template)
"""
import io
import os
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
LOGOS = os.path.join(BRAND, "logos")
PNG = os.path.join(BRAND, "icons", "png")


def render(svg, px):
    """SVG -> RGBA PIL image, `px` wide, via rsvg-convert."""
    out = subprocess.run(
        ["rsvg-convert", "-w", str(px), os.path.join(LOGOS, svg)],
        check=True, capture_output=True,
    ).stdout
    return Image.open(io.BytesIO(out)).convert("RGBA")


def save(img, path, opaque=False):
    if opaque:
        assert img.mode != "RGBA" or img.getchannel("A").getextrema()[0] == 255, f"{path} must be opaque"
        img = img.convert("RGB")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print("  wrote", os.path.relpath(path, BRAND))


def main():
    save(render("mark-tight.svg", 1024), os.path.join(LOGOS, "app-icon-source.png"))
    save(render("mark-small.svg", 96), os.path.join(PNG, "favicon-96.png"))
    save(render("app-icon-square.svg", 180), os.path.join(PNG, "apple-touch-icon-180.png"), opaque=True)
    save(render("app-icon-square.svg", 192), os.path.join(PNG, "icon-192.png"), opaque=True)
    save(render("app-icon-square.svg", 512), os.path.join(PNG, "icon-512.png"), opaque=True)
    save(render("mark-tight.svg", 512), os.path.join(PNG, "mark-512.png"))
    save(render("mark-small.svg", 160), os.path.join(PNG, "mark-small-160.png"))
    save(render("mark-small.svg", 64), os.path.join(PNG, "tray-64.png"))
    save(render("mark-small.svg", 40), os.path.join(PNG, "mark-40.png"))

    # Each ICO frame is rendered at its own size: downscaling one big frame blurs the gaps.
    sizes = (16, 32, 48)
    frames = [render("mark-small.svg", s) for s in sizes]
    ico = os.path.join(PNG, "favicon.ico")
    frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print("  wrote", os.path.relpath(ico, BRAND))


if __name__ == "__main__":
    sys.exit(main())
