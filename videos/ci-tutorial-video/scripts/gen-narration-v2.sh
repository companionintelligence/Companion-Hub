#!/bin/zsh
# Generate per-scene v2 narration from storyboard/v2/narration-v2.md (pipe format:
# "<sceneId>|<text>"). Voice matches the v1 CI brand read.
set -e
cd "$(dirname "$0")/.."
mkdir -p public/audio
VOICE="en-US-AndrewMultilingualNeural"

while IFS='|' read -r id text; do
  [ -z "$id" ] && continue
  case "$id" in \#*) continue ;; esac
  uvx edge-tts --voice "$VOICE" --text "$text" --write-media "public/audio/${id}.mp3"
  echo "ok ${id}"
done < storyboard/v2/narration-v2.md

echo "done — $(ls public/audio/c*.mp3 2>/dev/null | wc -l | tr -d ' ') v2 tracks"
