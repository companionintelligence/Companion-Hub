#!/usr/bin/env bash
# Write per-process GPU VRAM to the Hub's state directory, for the Hub container to read.
#
# The Hub runs from an Alpine image with no nvidia-smi / rocm-smi and no GPU device access, so
# GpuProcessSamplerService cannot measure anything from inside the container on a fleet node.
# This is the host-side writer that seam expects: the same vendor query the sampler would run,
# written as JSON the Hub reads through /data/state/hardware/gpu_processes.json. Same shape of
# contract as gpu_pressure.json (schemaVersion + sampledAt, stale means unmeasured).
#
# Usage: cihub-gpu-processes.sh [STATE_DIR]
#   STATE_DIR defaults to $CI_HUB_STATE_PATH, else $ROOT_FOLDER_HOST/state, else
#   ~/.local/share/companion-hub/state. The file lands in STATE_DIR/hardware/.
#
# Runs in well under a second; install it on a timer (see cihub-gpu-processes.timer beside this file,
# 15 s cadence). Exit 0 with no file written when neither vendor tool answers — the Hub then reads
# "unmeasured", which is the truthful state, not "0".
set -euo pipefail

state_dir="${1:-${CI_HUB_STATE_PATH:-${ROOT_FOLDER_HOST:+$ROOT_FOLDER_HOST/state}}}"
state_dir="${state_dir:-$HOME/.local/share/companion-hub/state}"
out_dir="$state_dir/hardware"
out="$out_dir/gpu_processes.json"

sampled_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
vendor=""
source=""
rows=""

if command -v nvidia-smi >/dev/null 2>&1; then
  # `noheader,nounits` is load-bearing: with units the memory column reads "6104 MiB".
  # Output per line: "<pid>, <process_name>, <used_memory>" — process_name is a full path or the
  # process title, never containing a comma in practice; a row that does not parse is dropped.
  if raw="$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null)"; then
    vendor=nvidia
    source=nvidia-smi
    rows="$(printf '%s\n' "$raw" | awk -F', *' '
      NF >= 3 && $1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $3 > 0 {
        name = $2; gsub(/\\/, "\\\\", name); gsub(/"/, "\\\"", name)
        printf "%s{\"pid\":%d,\"processName\":\"%s\",\"vramMb\":%d}", (n++ ? "," : ""), $1, name, $3
      }')"
  fi
elif command -v rocm-smi >/dev/null 2>&1; then
  # The plain-text KFD table: PID, PROCESS NAME, GPU(s), VRAM USED (bytes), SDMA USED, CU OCCUPANCY.
  # Header and banner rows fail the numeric-PID test; a process holding no VRAM is dropped.
  if raw="$(rocm-smi --showpids 2>/dev/null)"; then
    vendor=amd
    source=rocm-smi
    rows="$(printf '%s\n' "$raw" | awk '
      NF >= 4 && $1 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ && $4 > 0 {
        name = $2; gsub(/\\/, "\\\\", name); gsub(/"/, "\\\"", name)
        printf "%s{\"pid\":%d,\"processName\":\"%s\",\"vramMb\":%d}", (n++ ? "," : ""), $1, name, int($4 / 1048576 + 0.5)
      }')"
  fi
fi

if [ -z "$vendor" ]; then
  exit 0
fi

mkdir -p "$out_dir"
tmp="$(mktemp "$out_dir/.gpu_processes.XXXXXX")"
printf '{"schemaVersion":1,"sampledAt":"%s","source":"%s","vendor":"%s","processes":[%s]}\n' "$sampled_at" "$source" "$vendor" "$rows" > "$tmp"
chmod 0644 "$tmp"
# Atomic: the Hub never sees a half-written file, and a reader mid-parse keeps the old inode.
mv -f "$tmp" "$out"
