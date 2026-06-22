#!/bin/zsh
# Placeholder slates for every shot in storyboard/shots.json.
# Per-shot capture agents overwrite these with real captures (same filename).
set -e
cd "$(dirname "$0")/.."
mkdir -p public/screens
FONT="/System/Library/Fonts/Helvetica.ttc"

SHOTS=(
  portal-signup portal-login portal-home portal-add-device-dialog
  portal-pairing-code-dialog portal-home-with-device portal-store-public
  hub-device-registration-empty hub-device-registration-provisioning
  hub-device-registration-complete hub-register hub-onboarding-form
  hub-onboarding-installing hub-home-dashboard hub-store-grid
  hub-store-ci-category hub-app-details-immich hub-install-dialog-immich
  hub-app-installing-immich hub-app-running-immich app-immich-live
)

for id in $SHOTS; do
  f="public/screens/${id}.png"
  [ -s "$f" ] && {echo "skip ${id} (exists)"; continue}
  ffmpeg -y -loglevel error -f lavfi -i "color=c=0x0A222E:s=1920x1080" \
    -vf "drawtext=fontfile=${FONT}:text='${id}':fontcolor=0x82FCFC:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2-50, \
         drawtext=fontfile=${FONT}:text='placeholder — capture pending':fontcolor=0x9BB4BB:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2+60" \
    -frames:v 1 "$f"
  echo "slate ${id}"
done
