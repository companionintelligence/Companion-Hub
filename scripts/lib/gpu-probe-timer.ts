/**
 * Rolling the host GPU probe (`scripts/host-probes/cihub-gpu-processes.*`) onto a fleet node.
 *
 * The Hub's `GpuProcessSamplerService` reads `/data/state/hardware/gpu_processes.json`, because the
 * `ci-hub` container (`node:22-alpine`) has neither `nvidia-smi` nor `rocm-smi` and cannot be given
 * the host's (glibc into musl). The probe beside `docs/fleet-setup.md`'s "Per-process GPU VRAM"
 * section is the writer; that section installs it by hand, one `scp` per node. This module is the
 * same install as one SSH step, so `fleet install` does it on every new node and
 * `cihub fleet update --gpu-probe` does it on an existing fleet.
 *
 * The three files are the checked-in ones, bundled into the CLI by `generate-bundled-hub-assets.ts`
 * — the operator's `cihub` may be the standalone binary, which carries no loose files. One writer,
 * one source of truth: nothing here renders a second script.
 *
 * **A user unit, like the status timer**, and for the same reason: the Hub's state directory belongs
 * to the account that brought the Hub up, so the unit must run as that account. Lingering is
 * enabled *before* `systemctl --user` is tried, because on core-3 (2026-09-21) the user manager only
 * existed once `loginctl enable-linger` had run — with no manager, `systemctl --user` cannot enable
 * anything, and the earlier ordering (enable, then linger) would have reported "no user session"
 * on a node that was one command away from working.
 */
import { BUNDLED_GPU_PROBE_SCRIPT, BUNDLED_GPU_PROBE_SERVICE, BUNDLED_GPU_PROBE_TIMER } from './bundled-hub-assets.generated.js';

/** The unit names the checked-in files carry — and the ones already installed on the fleet by hand. */
export const GPU_PROBE_TIMER_UNIT = 'cihub-gpu-processes.timer';
export const GPU_PROBE_SERVICE_UNIT = 'cihub-gpu-processes.service';
/** Under `~/.local/bin`, where the service's `ExecStart=%h/.local/bin/…` looks. Runnable by hand. */
export const GPU_PROBE_SCRIPT_NAME = 'cihub-gpu-processes.sh';

/** Parsed from the timer file so a cadence change there is not silently contradicted in a report. */
export const GPU_PROBE_INTERVAL_SECONDS = Number(/OnUnitActiveSec=(\d+)s/.exec(BUNDLED_GPU_PROBE_TIMER)?.[1] ?? Number.NaN);

/**
 * Shell to install the probe and its timer for the SSH user, idempotently, and take one sample.
 *
 * Refuses, with a marker, on a node with neither tool: a timer that fails every tick forever is
 * worse than none, and an Apple or CPU-only node (core-4) is not a bug. The first sample runs
 * before the timer is enabled so a tool that cannot answer as this account (KFD process entries
 * are root's to read) is reported here, on the node's own line, rather than discovered in
 * `journalctl --user`. The script exits 1 for exactly that case and 0, writing nothing, when no
 * tool exists — which the check above has already ruled out.
 */
export function installGpuProbeTimerScript(): string {
  return [
    'set -eu',
    // Where the ROCm packages put rocm-smi; not on a login shell's default PATH either.
    'export PATH="$PATH:/opt/rocm/bin"',
    'if ! command -v nvidia-smi >/dev/null 2>&1 && ! command -v rocm-smi >/dev/null 2>&1; then',
    '  echo "gpu-probe-no-tool"',
    '  exit 0',
    'fi',
    'bin_dir="$HOME/.local/bin"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template.
    'unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"',
    'mkdir -p "$bin_dir" "$unit_dir"',
    `cat >"$bin_dir/${GPU_PROBE_SCRIPT_NAME}" <<'CIHUB_GPU_PROBE_FILE'`,
    BUNDLED_GPU_PROBE_SCRIPT.trimEnd(),
    'CIHUB_GPU_PROBE_FILE',
    `chmod 0755 "$bin_dir/${GPU_PROBE_SCRIPT_NAME}"`,
    `cat >"$unit_dir/${GPU_PROBE_SERVICE_UNIT}" <<'CIHUB_GPU_PROBE_FILE'`,
    BUNDLED_GPU_PROBE_SERVICE.trimEnd(),
    'CIHUB_GPU_PROBE_FILE',
    `cat >"$unit_dir/${GPU_PROBE_TIMER_UNIT}" <<'CIHUB_GPU_PROBE_FILE'`,
    BUNDLED_GPU_PROBE_TIMER.trimEnd(),
    'CIHUB_GPU_PROBE_FILE',
    `"$bin_dir/${GPU_PROBE_SCRIPT_NAME}" || echo "gpu-probe-sample-failed"`,
    // Lingering first — see the module comment. Best-effort: it needs polkit or root, and a node
    // where it fails still samples whenever someone is logged in.
    'loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || echo "gpu-probe-no-linger"',
    // Without a user manager `systemctl --user` cannot talk to anything, which is reported rather
    // than silently skipped: the script and the units are in place, and the timer is not.
    'if ! systemctl --user show-environment >/dev/null 2>&1; then',
    '  echo "gpu-probe-no-user-session"',
    '  exit 0',
    'fi',
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${GPU_PROBE_TIMER_UNIT}`,
    'echo "gpu-probe-installed"',
  ].join('\n');
}

export type GpuProbeTimerOutcome = 'installed' | 'no-linger' | 'sample-failed' | 'no-user-session' | 'no-tool' | 'failed';

/** Read the script's markers back into a verdict, so each node reports what it got. */
export function classifyGpuProbeOutput(stdout: string, ok: boolean): GpuProbeTimerOutcome {
  if (stdout.includes('gpu-probe-no-tool')) return 'no-tool';
  if (stdout.includes('gpu-probe-no-user-session')) return 'no-user-session';
  if (!ok || !stdout.includes('gpu-probe-installed')) return 'failed';
  // The timer is in place and will keep trying; the tool did not answer as this account, which is
  // the more important fact for the operator and so takes precedence over the lingering warning.
  if (stdout.includes('gpu-probe-sample-failed')) return 'sample-failed';
  if (stdout.includes('gpu-probe-no-linger')) return 'no-linger';
  return 'installed';
}

export function describeGpuProbeOutcome(outcome: GpuProbeTimerOutcome): string {
  switch (outcome) {
    case 'installed':
      return `per-process GPU VRAM is written for the Hub every ${GPU_PROBE_INTERVAL_SECONDS} seconds`;
    case 'no-linger':
      return 'GPU probe timer installed, but it only runs while this user is logged in (lingering was refused)';
    case 'sample-failed':
      return `GPU probe timer installed, but the vendor tool did not answer as this account — check \`journalctl --user -u ${GPU_PROBE_SERVICE_UNIT}\``;
    case 'no-user-session':
      return 'no systemd user manager on this node even after enable-linger — the GPU probe files are in place but nothing runs them';
    case 'no-tool':
      return 'neither nvidia-smi nor rocm-smi on this node — per-process GPU VRAM stays unmeasured here';
    default:
      return 'GPU probe timer could not be installed';
  }
}
