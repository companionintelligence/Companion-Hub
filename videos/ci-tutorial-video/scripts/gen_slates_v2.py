# Placeholder slates for every v2 shot id with no file yet. Mobile ids get a
# portrait canvas (the Remotion phone frame crops to it). Never overwrites an
# existing file. Run: uv run --with pillow python scripts/gen_slates_v2.py
import os
from PIL import Image, ImageDraw, ImageFont

IDS = [
    "portal-signup", "portal-signup-mobile", "portal-store-public",
    "portal-store-public-mobile", "portal-home", "portal-home-mobile",
    "portal-add-device-dialog", "portal-pairing-code-dialog",
    "portal-pairing-code-dialog-mobile", "hub-device-registration-empty",
    "hub-device-registration-provisioning", "hub-device-registration-complete",
    "hub-device-registration-mobile-code", "hub-device-registration-mobile-provisioning",
    "hub-onboarding-form", "hub-onboarding-installing", "hub-home-dashboard",
    "hub-home-dashboard-mobile", "hub-settings-overview", "hub-resource-monitor",
    "hub-store-grid", "hub-store-featured", "hub-store-featured-mobile",
    "hub-store-ci-category", "hub-app-details-immich", "hub-install-dialog-immich",
    "hub-app-installing-immich", "hub-app-install-progress-immich",
    "hub-app-running-immich", "hub-app-running-immich-mobile", "app-immich-live",
    "app-immich-live-mobile", "portal-home-with-device", "portal-home-with-device-mobile",
]

BG, FG, MUTED, BORDER = "#0A222E", "#82FCFC", "#9BB4BB", "#2C676D"
out = os.path.join(os.path.dirname(__file__), "..", "public", "screens")
os.makedirs(out, exist_ok=True)
font_big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 56)
font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 32)

made = 0
for shot in IDS:
    path = os.path.join(out, f"{shot}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        continue
    w, h = (1080, 2340) if "mobile" in shot else (1920, 1080)
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([30, 30, w - 30, h - 30], outline=BORDER, width=2)
    d.text((w / 2, h / 2 - 40), shot, font=font_big, fill=FG, anchor="mm")
    d.text((w / 2, h / 2 + 40), "capture pending", font=font_small, fill=MUTED, anchor="mm")
    img.save(path)
    print(f"slate {shot} ({w}x{h})")
    made += 1
print(f"created {made} slates")
