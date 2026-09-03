#!/bin/zsh
# Generate per-scene narration from storyboard/scenes.json narration lines.
# Voice: calm, plain-spoken — matches the CI brand read.
set -e
cd "$(dirname "$0")/.."
mkdir -p public/audio
VOICE="en-US-AndrewMultilingualNeural"

gen() {
  local id="$1" text="$2"
  uvx edge-tts --voice "$VOICE" --text "$text" --write-media "public/audio/${id}.mp3"
  echo "ok ${id}"
}

gen s02-platform-diagram "Three pieces work together. The Portal is the cloud control plane for accounts and devices. The Hub is the runtime on your own machine. And the Marketplace is the catalog of apps the Hub can install."
gen s03-portal-signup "Start at hub dot ci dot computer. Create a free account — it manages your devices and apps, not your data."
gen s04-portal-workspace-add-device "Your home screen shows every device and every app in one place. To bring a new machine in, add a device and give it a name."
gen s05-portal-pairing-code "The Portal hands you a one-time pairing code. That code is how your Hub proves it belongs to you."
gen s06-hub-device-registration "On the Hub, enter the code. It registers with the Portal, gets its own secure domain, and finishes setting itself up."
gen s07-hub-onboarding "First boot walks you through setup: pick your local AI models, choose remote access, and select your starter apps. One click installs everything."
gen s08-hub-home-dashboard "This is home. Real disk, real CPU, real memory — your apps running on a machine you can point to."
gen s09-store-browse "The App Store is fed by the open Marketplace catalog — over two hundred apps. Photos, media, automation, password management — plus Companion-exclusive apps you won't find anywhere else."
gen s10-install-lifecycle "Open an app to see exactly what it is and what it collects — which, on your own hardware, is nothing. Hit install, and watch it move from installing to running."
gen s11-app-live "And there it is — a full photo library, served from your own machine, reachable from anywhere through your own secure domain."
gen s12-portal-fleet "Back in the Portal, your device is online and your apps are one click away — from anywhere, on every device you own."
gen s13-outro "Companion Intelligence. Own your AI."
