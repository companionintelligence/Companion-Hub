#!/usr/bin/env python3
"""Fix up the icon sets that `tauri icon` writes, so they follow the Hub mark's rules.

Run after `pnpm --filter desktop icons` and `pnpm --filter mobile icons` (both scripts run it
for you). Safe to run again: every step is idempotent. Needs Pillow and rsvg-convert; the ICNS
step also needs macOS `iconutil` and is skipped where that is missing.

What `tauri icon` gets wrong for this mark, and what this script does about it:

  small sizes     It scales the full mark down to every size. At 48 px and below the full mark's
                  thin gaps close up, so those sizes are redrawn from logos/mark-small.svg: the
                  small PNGs, and the 16-48 px frames of icon.ico and icon.icns.
  iOS marketing   AppIcon-512@2x.png (1024 px) is written with an alpha channel, which App Store
                  Connect rejects. It is flattened to RGB.
  Android hdpi    The legacy launcher icons come out 49 px; the committed set and
                  packages/frontend/src/tests/mobile-icons.test.ts want 72 px (48 dp at 1.5x).
  Android adaptive  The foreground is written edge to edge, so every launcher mask crops the
                  mark's outer ring. It is redrawn with the disc inside the 66 dp safe zone.
  stale copies    In packages/mobile, `tauri icon` writes into src-tauri/gen/ and leaves
                  src-tauri/icons/ios and icons/android as they were, so the new files are
                  copied back to keep both sets identical.
  newline         It strips the trailing newline from ic_launcher_background.xml.

Paths resolve from this file (packages/frontend/hub-brand/scripts), so run it from anywhere.
"""
import io
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
PACKAGES = os.path.normpath(os.path.join(BRAND, "..", ".."))
SMALL_SVG = os.path.join(BRAND, "logos", "mark-small.svg")
SOURCE_PNG = os.path.join(BRAND, "logos", "app-icon-source.png")
SMALL_MAX = 48                                   # px; the rule in hub-brand/README.md

DESKTOP = os.path.join(PACKAGES, "desktop", "src-tauri", "icons")
MOBILE = os.path.join(PACKAGES, "mobile", "src-tauri", "icons")
MOBILE_GEN_IOS = os.path.join(PACKAGES, "mobile", "src-tauri", "gen", "apple", "Assets.xcassets", "AppIcon.appiconset")
MOBILE_GEN_ANDROID = os.path.join(PACKAGES, "mobile", "src-tauri", "gen", "android", "app", "src", "main", "res")
SKIP = {"tray.png"}                              # already the small mark, mirrored from hub-brand


def rel(path):
    return os.path.relpath(path, PACKAGES)


def small(px):
    out = subprocess.run(["rsvg-convert", "-w", str(px), SMALL_SVG], check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(out)).convert("RGBA")


def full(px):
    return Image.open(SOURCE_PNG).convert("RGBA").resize((px, px), Image.LANCZOS)


def frame(px):
    return small(px) if px <= SMALL_MAX else full(px)


def same(a, b):
    return a.size == b.size and a.tobytes() == b.tobytes()


def write_png(img, path):
    img.save(path, optimize=True)


# --- small sizes -----------------------------------------------------------------------------
def small_pngs(icons):
    """Top-level square PNGs of a Tauri icon folder (32x32.png, Square30x30Logo.png, ...)."""
    n = 0
    for name in sorted(os.listdir(icons)):
        path = os.path.join(icons, name)
        if not name.endswith(".png") or name in SKIP or not os.path.isfile(path):
            continue
        cur = Image.open(path).convert("RGBA")
        if cur.width != cur.height or cur.width > SMALL_MAX:
            continue
        want = small(cur.width)
        if not same(cur, want):
            write_png(want, path)
            n += 1
    return n


def small_ico(icons):
    path = os.path.join(icons, "icon.ico")
    if not os.path.exists(path):
        return 0
    sizes = sorted(Image.open(path).info.get("sizes", []))
    sizes = [s[0] for s in sizes]
    frames = [frame(s) for s in sizes]
    buf = io.BytesIO()
    frames[-1].save(buf, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    if buf.getvalue() == open(path, "rb").read():
        return 0
    open(path, "wb").write(buf.getvalue())
    return 1


def small_icns(icons):
    path = os.path.join(icons, "icon.icns")
    if not os.path.exists(path):
        return 0
    if not shutil.which("iconutil"):
        print("  skip icon.icns (iconutil not found; macOS only)", rel(icons))
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.mkdir(iconset)
        for base in (16, 32, 128, 256, 512):
            write_png(frame(base), os.path.join(iconset, f"icon_{base}x{base}.png"))
            write_png(frame(base * 2), os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
        out = os.path.join(tmp, "icon.icns")
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True, capture_output=True)
        data = open(out, "rb").read()
    if data == open(path, "rb").read():
        return 0
    open(path, "wb").write(data)
    return 1


# --- iOS -------------------------------------------------------------------------------------
def flatten_marketing(path):
    if not os.path.exists(path):
        return False
    img = Image.open(path)
    if "A" not in img.getbands():
        return False
    rgba = img.convert("RGBA")
    ground = rgba.getpixel((2, 2))[:3] + (255,)          # the icon's own opaque corner colour
    Image.alpha_composite(Image.new("RGBA", rgba.size, ground), rgba).convert("RGB").save(path, optimize=True)
    return True


# --- Android ---------------------------------------------------------------------------------
LAUNCHER = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE_DISC = 0.60          # of the 108 dp layer; the safe zone is 66 dp = 0.611


def android(res):
    n = 0
    for density, px in LAUNCHER.items():
        d = os.path.join(res, f"mipmap-{density}")
        if not os.path.isdir(d):
            continue
        icon = frame(px)                                  # >= 48 px, so the full mark
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            p = os.path.join(d, name)
            if os.path.exists(p) and not same(Image.open(p).convert("RGBA"), icon):
                write_png(icon, p)
                n += 1
        layer = round(px * 108 / 48)                      # adaptive layer: 108 dp
        fg = Image.new("RGBA", (layer, layer), (0, 0, 0, 0))
        disc = full(round(layer * ADAPTIVE_DISC))
        fg.alpha_composite(disc, ((layer - disc.width) // 2, (layer - disc.height) // 2))
        p = os.path.join(d, "ic_launcher_foreground.png")
        if os.path.exists(p) and not same(Image.open(p).convert("RGBA"), fg):
            write_png(fg, p)
            n += 1
    xml = os.path.join(res, "values", "ic_launcher_background.xml")
    if os.path.exists(xml):
        text = open(xml).read()
        if not text.endswith("\n"):
            open(xml, "w").write(text + "\n")
            n += 1
    return n


def copy_back(src_dir, dst_dir, only_ext=(".png", ".xml")):
    """Copy files that exist in both trees from the generated project back over the icons/ copy."""
    n = 0
    for root, _, files in os.walk(dst_dir):
        for name in files:
            if not name.endswith(only_ext):
                continue
            dst = os.path.join(root, name)
            src = os.path.join(src_dir, os.path.relpath(dst, dst_dir))
            if os.path.exists(src) and open(src, "rb").read() != open(dst, "rb").read():
                shutil.copyfile(src, dst)
                n += 1
    return n


def main():
    for tool in ("rsvg-convert",):
        if not shutil.which(tool):
            sys.exit(f"post_tauri_icons: {tool} not found")
    for icons in (DESKTOP, MOBILE):
        if os.path.isdir(icons):
            print(f"  {rel(icons)}: {small_pngs(icons)} small PNG(s), ico {small_ico(icons)}, icns {small_icns(icons)} redrawn")
    if os.path.isdir(MOBILE_GEN_ANDROID):
        print(f"  gen/android: {android(MOBILE_GEN_ANDROID)} file(s) fixed")
        n = copy_back(MOBILE_GEN_ANDROID, os.path.join(MOBILE, "android"))
        print(f"  icons/android: {n} file(s) copied from gen/android")
    for marketing in (
        os.path.join(MOBILE_GEN_IOS, "AppIcon-512@2x.png"),
        os.path.join(MOBILE, "ios", "AppIcon-512@2x.png"),
        os.path.join(DESKTOP, "ios", "AppIcon-512@2x.png"),
    ):
        if flatten_marketing(marketing):
            print("  flattened", rel(marketing))
    if os.path.isdir(MOBILE_GEN_IOS):
        n = copy_back(MOBILE_GEN_IOS, os.path.join(MOBILE, "ios"), (".png",))
        print(f"  icons/ios: {n} file(s) copied from gen/apple")
    return 0


if __name__ == "__main__":
    sys.exit(main())
