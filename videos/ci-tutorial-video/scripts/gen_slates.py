# Placeholder slates for every shot id; capture agents overwrite by filename.
# Run: uv run --with pillow python scripts/gen_slates.py
import os
from PIL import Image, ImageDraw, ImageFont

SHOTS = [
    "portal-signup", "portal-login", "portal-home", "portal-add-device-dialog",
    "portal-pairing-code-dialog", "portal-home-with-device", "portal-store-public",
    "hub-device-registration-empty", "hub-device-registration-provisioning",
    "hub-device-registration-complete", "hub-register", "hub-onboarding-form",
    "hub-onboarding-installing", "hub-home-dashboard", "hub-store-grid",
    "hub-store-ci-category", "hub-app-details-immich", "hub-install-dialog-immich",
    "hub-app-installing-immich", "hub-app-running-immich", "app-immich-live",
]

BG, FG, MUTED, BORDER = "#0A222E", "#82FCFC", "#9BB4BB", "#2C676D"
out = os.path.join(os.path.dirname(__file__), "..", "public", "screens")
os.makedirs(out, exist_ok=True)

font_big = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 72)
font_small = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 36)

for shot in SHOTS:
    path = os.path.join(out, f"{shot}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print(f"skip {shot} (exists)")
        continue
    img = Image.new("RGB", (1920, 1080), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([40, 40, 1880, 1040], outline=BORDER, width=2)
    d.text((960, 500), shot, font=font_big, fill=FG, anchor="mm")
    d.text((960, 600), "placeholder — capture pending", font=font_small, fill=MUTED, anchor="mm")
    img.save(path)
    print(f"slate {shot}")
