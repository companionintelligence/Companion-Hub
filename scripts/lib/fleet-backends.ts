/**
 * Installing inference backends without a desktop.
 *
 * CI-Hub can install all six backends today — but only from the Tauri desktop app, in Rust
 * (`packages/desktop/src-tauri/src/inference_runners.rs`). The NestJS `install()` is advisory text
 * that re-runs a health check and tells you to visit ollama.com. So on a headless fleet node there
 * has been no supported way to install anything, which is the single thing blocking `fleet install`.
 *
 * These are the same recipes, transposed. Three deliberate differences from the Rust originals:
 *
 * 1. **`sudo`, not `pkexec`/`osascript`.** The desktop escalates through polkit on Linux and an
 *    `osascript … with administrator privileges` dialog on macOS. Both open a GUI prompt, which on a
 *    node reached over SSH means the install hangs forever against a dialog nobody can see.
 * 2. **Adoption is checked first, always.** PAIR's best idea: "installing" an engine that is already
 *    running downloads nothing and adopts the listener. Re-running an install must be cheap and safe,
 *    because on a fleet it WILL be re-run.
 * 3. **A gate that fails says why, and is not an error.** A node without an NVIDIA GPU cannot run
 *    vLLM. That is a fact about the machine, not a failure of the install, and reporting it as a
 *    failure is how a fleet report becomes noise nobody reads.
 *
 * NOTHING HERE RUNS AUTOMATICALLY. Every function is invoked by an explicit `--execute`.
 */

import type { HostFacts } from './fleet-hardware.js';
import { confirmOllamaVersion, resolveOllamaVersion } from './fleet-ollama-version.js';
import {
  BIND_MARKERS,
  classifyBindApplyOutput,
  type OllamaBindMode,
  ollamaBindApplyShell,
  ollamaBindPreflightShell,
  ollamaOwnershipGuardShell,
} from './fleet-ollama-bind.js';
import { classifyRuntimeApplyOutput, type OllamaRuntimeSettings, ollamaRuntimeApplyShell, RUNTIME_DROPIN } from './fleet-ollama-runtime.js';
import { classifyProbeFirewallOutput, probeFirewallApplyShell } from './fleet-probe-firewall.js';

export const INSTALLABLE_BACKENDS = ['ollama', 'vllm', 'lucebox', 'dspark', 'mtplx', 'lemonade'] as const;
export type InstallableBackend = (typeof INSTALLABLE_BACKENDS)[number];

export interface BackendPlan {
  backend: InstallableBackend;
  /** 'install' — run it. 'adopt' — already answering. 'skip' — this machine cannot run it. */
  action: 'install' | 'adopt' | 'skip';
  /** Why, in one sentence. Always populated; a plan that cannot explain itself is not a plan. */
  why: string;
  /** The shell to run for 'install'. Empty otherwise. */
  script?: string;
  /** Port the backend will answer on once up. */
  port?: number;
  /** True when the script needs root. Surfaced so a dry run can say so before anything is attempted. */
  needsSudo?: boolean;
  /**
   * The exact version the script installs, when the backend has one. Set for ollama; the install is
   * not reported done until `/api/version` on the node answers with this number.
   */
  pinnedVersion?: string;
}

/** Per-run choices that change what a plan installs, as opposed to whether it can. */
export interface BackendPlanOptions {
  /**
   * Where the Ollama daemon should listen. `tailnet` (the default) binds the node's Tailscale IPv4;
   * `all` is 0.0.0.0; `local` is loopback. One policy, chosen here, written to one file, and read
   * back after the restart — see `fleet-ollama-bind.ts` for why each of those three words matters.
   */
  ollamaBind?: OllamaBindMode;
  /** Overrides {@link OLLAMA_PINNED_VERSION} for this run. Validated by `resolveOllamaVersion`. */
  ollamaVersion?: string;
}

export const DEFAULT_OLLAMA_BIND: OllamaBindMode = 'all';

/**
 * Backends whose default port identifies them unambiguously.
 *
 * vllm, mtplx and lucebox ALL default into the 8000 space, so a listener there attributes to none of
 * them on port evidence alone — telling them apart needs a fingerprint of `/v1/models` (the QA
 * harness does exactly that, keying on `owned_by`). Claiming adoption from a port collision produced
 * a visibly wrong plan on the first live run: every node running lucebox on :8000 was reported as
 * "adopt mtplx", a backend not installed anywhere on this fleet.
 */
const UNAMBIGUOUS_PORT_BACKENDS: ReadonlySet<InstallableBackend> = new Set(['ollama', 'lemonade', 'dspark']);

const PORTS: Record<InstallableBackend, number> = {
  ollama: 11434,
  lemonade: 13305,
  dspark: 8080,
  mtplx: 8000,
  vllm: 8002,
  lucebox: 8000,
};

/**
 * The environment the installer manages for Ollama besides the bind.
 *
 * `OLLAMA_LLM_LIBRARY=vulkan` on gfx1151. ROCm there runs NO_VMM and cannot back a large contiguous
 * allocation with GTT: the driver advertises the whole ~60 GB pool as free and then fails to allocate
 * 21 GB, so every model above the ~2 GB VRAM carve-out fails to load with an allocation error. Six
 * nodes on this fleet returned HTTP 500 on every real model until this was forced. Measured after:
 * 0 → 53.4 tok/s on the exact model that had been failing.
 *
 * Exported because the adopt path writes the same canonical file as the install path, and the two
 * must agree on its contents or a re-run would strip a setting the previous run added.
 *
 * Deliberately NOT where `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH` or
 * `OLLAMA_IGPU_ENABLE` live: those are per-run operator choices, written to their own drop-in by
 * `fleet-ollama-runtime.ts` so that changing one never rewrites (or restarts over) the bind.
 */
export function ollamaManagedEnvironment(facts: HostFacts): string[] {
  const gfx = facts.gpus.find((g) => g.vendor === 'amd')?.gfx;
  const env: string[] = [];
  if (gfx === 'gfx1151') {
    // Load-bearing, and the reason is not obvious from the symptom: see the doc comment above.
    env.push('OLLAMA_LLM_LIBRARY=vulkan');
  }
  return env;
}

/**
 * Ollama on Linux.
 *
 * Transposed from `ollama_linux_install_script()`, minus the polkit wrapper, plus the bind policy.
 *
 * · `OLLAMA_LLM_LIBRARY=vulkan` on gfx1151. ROCm there runs NO_VMM and cannot back a large
 *   contiguous allocation with GTT: the driver advertises the whole ~60 GB pool as free and then
 *   fails to allocate 21 GB, so every model above the ~2 GB VRAM carve-out fails to load with an
 *   allocation error. Six nodes on this fleet returned HTTP 500 on every real model until this was
 *   forced. Measured after: 0 → 53.4 tok/s on the exact model that had been failing.
 *
 * `version` is passed to the installer as `OLLAMA_VERSION`, which it honours. Without it every node
 * got whatever ollama.com served that day — measured 2026-09-10 as 0.12.11 → 0.33.3 across eighteen
 * nodes — and nothing ever reported the spread. See `fleet-ollama-version.ts`.
 *
 * Order matters and was measured: the ownership guard runs BEFORE ollama.com's installer, because
 * that installer itself runs `systemctl enable ollama && systemctl restart ollama` on a systemd box —
 * on beta-1, where a user-scope `ollama-local.service` owns :11434 and the system unit is disabled,
 * that alone starts the colliding second daemon. After the install, one drop-in is written (the
 * canonical bind file, carrying the managed environment too), every legacy file that set
 * `OLLAMA_HOST` and nothing else is moved aside by name, and `systemctl show ollama -p Environment`
 * is re-read to prove the merged value is the requested one. A mismatch fails the step.
 */
function ollamaLinuxScript(facts: HostFacts, bind: OllamaBindMode, version: string): string {
  const lines = [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    // Before anything is downloaded: is the system unit even the right thing to touch here, and
    // can the requested bind be satisfied at all?
    ollamaOwnershipGuardShell(),
    ollamaBindPreflightShell(bind),
    // The desktop script installs curl/zstd across six package managers. Keep that breadth: a node
    // that lacks curl is exactly the fresh machine this command exists for.
    'need=""',
    'command -v curl >/dev/null 2>&1 || need="curl ca-certificates"',
    'command -v zstd >/dev/null 2>&1 || need="$need zstd"',
    'if [ -n "$need" ]; then',
    '  if command -v apt-get >/dev/null 2>&1; then apt-get install -y --no-install-recommends $need || { apt-get update && apt-get install -y --no-install-recommends $need; };',
    '  elif command -v dnf >/dev/null 2>&1; then dnf install -y $need;',
    '  elif command -v yum >/dev/null 2>&1; then yum install -y $need;',
    '  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm $need;',
    '  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install $need;',
    '  elif command -v apk >/dev/null 2>&1; then apk add --no-cache $need;',
    '  else echo "no known package manager for: $need" >&2; exit 1; fi',
    'fi',
    // Download then run, never `curl | sh`: a POSIX pipeline reports only the last command's status,
    // so a truncated download would be executed and then reported as a successful install.
    'installer="$(mktemp)"',
    'trap \'rm -f "$installer"\' EXIT',
    'curl -fsSL --connect-timeout 30 --max-time 300 https://ollama.com/install.sh -o "$installer"',
    // Pinned. `version` has already passed resolveOllamaVersion, so it is a bare x.y.z and safe to quote.
    `OLLAMA_VERSION='${version}' sh "$installer"`,
    'if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files ollama.service >/dev/null 2>&1; then',
    // One file, a name that outranks every legacy one, and a read-back. Fails on mismatch.
    ollamaBindApplyShell(bind, { extraEnv: ollamaManagedEnvironment(facts) }),
    'fi',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    'if getent group ollama >/dev/null 2>&1; then usermod -aG ollama "${SUDO_USER:-$(id -un)}" || true; fi',
    'echo "ollama-install-complete"',
  ];
  return lines.join('\n');
}

/**
 * vLLM on Linux with an NVIDIA GPU.
 *
 * `ensure_python_cli(data_dir, "vllm", "vllm", "vllm", 10)` in the original: a managed venv, always
 * `pip install --upgrade` with no version pin. Reproduced rather than "improved" — pinning here would
 * diverge from what the desktop installs on the same fleet, and two versions of vLLM across a pool is
 * a worse problem than an unpinned one.
 */
function vllmLinuxScript(dataDir: string): string {
  return [
    'set -e',
    `RUNNER_DIR="${dataDir}/runners/vllm"`,
    'mkdir -p "$RUNNER_DIR"',
    // Same discovery order as host_python(): newest first, minimum 3.10.
    'PY=""',
    'for c in python3.13 python3.12 python3.11 python3.10 python3 python; do',
    '  command -v "$c" >/dev/null 2>&1 || continue',
    '  v="$("$c" -c "import sys; print(f\'{sys.version_info.major}.{sys.version_info.minor}\')" 2>/dev/null || echo 0.0)"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion for the generated script, not a forgotten template literal — JS must NOT interpolate it.
    '  maj="${v%%.*}"; min="${v#*.}"',
    '  if [ "$maj" = "3" ] && [ "$min" -ge 10 ] 2>/dev/null; then PY="$c"; break; fi',
    'done',
    '[ -n "$PY" ] || { echo "vLLM needs Python 3.10+; none found on PATH" >&2; exit 1; }',
    '[ -x "$RUNNER_DIR/venv/bin/python" ] || "$PY" -m venv "$RUNNER_DIR/venv"',
    '"$RUNNER_DIR/venv/bin/python" -m pip install --upgrade pip >/dev/null',
    '"$RUNNER_DIR/venv/bin/python" -m pip install --upgrade vllm',
    '[ -x "$RUNNER_DIR/venv/bin/vllm" ] || { echo "vllm installed but produced no vllm command" >&2; exit 1; }',
    'echo "vllm-install-complete"',
  ].join('\n');
}

/**
 * lucebox: a Docker container, so "install" is a pull plus a run.
 *
 * Image choice mirrors the Rust: CUDA when nvidia-smi answers, ROCm when /dev/kfd and /dev/dri both
 * exist, and otherwise no supported GPU. The container's internal port is 8080 mapped to the host
 * port — a detail worth keeping exact, since getting it backwards produces a container that starts
 * and never answers.
 */
function luceboxScript(facts: HostFacts, dataDir: string, port: number): string {
  const cuda = facts.gpus.some((g) => g.vendor === 'nvidia' && g.driverWorking);
  const image = cuda ? 'ghcr.io/luce-org/lucebox-hub:cuda12' : 'ghcr.io/luce-org/lucebox-hub:rocm';
  const gpuFlags = cuda ? '--gpus all' : '--device /dev/kfd --device /dev/dri --security-opt seccomp=unconfined';
  return [
    'set -e',
    `mkdir -p "${dataDir}/runners/lucebox/models"`,
    `docker pull ${image}`,
    // A stopped container keeps the host port it was created with, so reuse beats recreate.
    'if [ -n "$(docker ps -a --filter name=^ci-hub-inference-lucebox$ --format "{{.Names}}")" ]; then',
    '  docker start ci-hub-inference-lucebox',
    'else',
    '  docker run -d --name ci-hub-inference-lucebox --restart unless-stopped \\',
    `    -p ${port}:8080 \\`,
    `    -v "${dataDir}/runners/lucebox/models:/opt/lucebox-hub/server/models" \\`,
    `    ${gpuFlags} \\`,
    `    ${image}`,
    'fi',
    'echo "lucebox-install-complete"',
  ].join('\n');
}

/**
 * Decide what to do about one backend on one machine.
 *
 * Pure: takes facts, returns a plan. Every gate is a claim quoted from the Rust original, so the
 * headless path and the desktop path agree about what a machine can run.
 */
export function planBackend(backend: InstallableBackend, facts: HostFacts, dataDir: string, opts: BackendPlanOptions = {}): BackendPlan {
  const port = PORTS[backend];
  const bind = opts.ollamaBind ?? DEFAULT_OLLAMA_BIND;

  // Adoption first, where the evidence actually supports it. Cheap, and makes re-running safe.
  if (facts.enginesListening.includes(port)) {
    if (UNAMBIGUOUS_PORT_BACKENDS.has(backend)) {
      return { backend, action: 'adopt', why: `already answering on :${port} — adopted, nothing installed`, port };
    }
    // Shared 8000 space: something is there, and this function cannot say what. Skipping is the
    // honest answer — installing over a live listener would fight it for the port, and claiming
    // adoption would credit this backend with another one's service.
    return {
      backend,
      action: 'skip',
      why: `port :${port} is already in use, and vllm/mtplx/lucebox share it — cannot attribute it without fingerprinting /v1/models, so nothing is installed or claimed here`,
      port,
    };
  }

  switch (backend) {
    case 'ollama':
      if (facts.os !== 'linux') {
        // macOS ships the daemon inside a menu-bar GUI app; Windows the same. Neither can be brought
        // up headlessly by this path, and pretending otherwise would install something that never serves.
        return { backend, action: 'skip', why: `headless install is Linux-only; on ${facts.os} the daemon comes from the GUI app`, port };
      }
      {
        const version = resolveOllamaVersion(opts.ollamaVersion);
        return {
          backend,
          action: 'install',
          why: `not listening — installing ${version} from ollama.com/install.sh (${opts.ollamaVersion ? '--ollama-version' : 'pinned'}), binding ${describeBind(bind)}`,
          script: ollamaLinuxScript(facts, bind, version),
          port,
          needsSudo: true,
          pinnedVersion: version,
        };
      }

    case 'vllm': {
      if (facts.os === 'windows') return { backend, action: 'skip', why: 'no native Windows path; use the WSL2/Linux GPU path', port };
      if (facts.os === 'darwin') {
        return {
          backend,
          action: 'skip',
          why: 'the Apple-Silicon vLLM-Metal installer runs an interactive upstream script; not attempted headlessly',
          port,
        };
      }
      const nvidia = facts.gpus.find((g) => g.vendor === 'nvidia');
      if (!nvidia) return { backend, action: 'skip', why: 'requires an NVIDIA GPU; none detected', port };
      if (!nvidia.driverWorking) {
        return {
          backend,
          action: 'skip',
          why: `an NVIDIA card is present but its driver is not answering (${nvidia.driverNote ?? 'nvidia-smi failed'})`,
          port,
        };
      }
      return { backend, action: 'install', why: 'NVIDIA GPU present — installing vLLM into a managed venv', script: vllmLinuxScript(dataDir), port };
    }

    case 'lucebox': {
      if (facts.os === 'darwin') return { backend, action: 'skip', why: 'Docker cannot pass Apple Silicon Metal through to this runner', port };
      if (!facts.docker.usable) {
        return {
          backend,
          action: 'skip',
          why: facts.docker.present
            ? 'docker is installed but `docker info` failed — daemon down, or this account lacks access'
            : 'requires a working Docker engine; none present',
          port,
        };
      }
      const cuda = facts.gpus.some((g) => g.vendor === 'nvidia' && g.driverWorking);
      const rocm = facts.gpus.some((g) => g.vendor === 'amd' && g.driverWorking);
      if (!cuda && !rocm) return { backend, action: 'skip', why: 'requires a supported NVIDIA or AMD GPU; none detected', port };
      return {
        backend,
        action: 'install',
        why: `${cuda ? 'NVIDIA' : 'AMD'} GPU present — pulling the ${cuda ? 'CUDA' : 'ROCm'} image`,
        script: luceboxScript(facts, dataDir, port),
        port,
      };
    }

    case 'dspark':
    case 'mtplx':
      if (!facts.appleSilicon) return { backend, action: 'skip', why: 'this native MLX runner is supported only on Apple Silicon', port };
      // The recipes exist (venv + pip, then a LaunchAgent), but every node on this fleet is Linux, so
      // shipping an untested Apple-Silicon path would be a claim nothing has ever exercised.
      return {
        backend,
        action: 'skip',
        why: 'Apple Silicon host: install from the desktop app — the headless path for MLX runners is not implemented yet',
        port,
      };

    case 'lemonade':
      // Deliberately excluded from the desktop's DEFAULT_AUTOMATIC_RUNNERS too. It is an
      // operator-managed host service; the Hub only ever probes it.
      return {
        backend,
        action: 'skip',
        why: 'operator-managed service — CI-Hub probes it and never installs it (see github.com/lemonade-sdk/lemonade)',
        port,
      };
  }
}

/** Plan every backend for one machine, in a stable order. */
export function planAllBackends(
  facts: HostFacts,
  dataDir: string,
  only?: readonly InstallableBackend[],
  opts: BackendPlanOptions = {},
): BackendPlan[] {
  const wanted = only?.length ? only : INSTALLABLE_BACKENDS;
  return wanted.map((backend) => planBackend(backend, facts, dataDir, opts));
}

/** The bind mode in the words a plan line uses. */
export function describeBind(bind: OllamaBindMode): string {
  switch (bind) {
    case 'tailnet':
      return 'the tailnet address (tailscale ip -4)';
    case 'all':
      return 'all interfaces (0.0.0.0), guarded to tailnet, loopback and Docker bridges';
    case 'local':
      return 'loopback only (127.0.0.1)';
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

import { sshCapture, type SshTarget } from './fleet-ssh.js';

export interface BackendInstallResult {
  backend: InstallableBackend;
  outcome: 'installed' | 'adopted' | 'skipped' | 'failed';
  why: string;
  /** Trailing output, bounded. Enough to diagnose, short enough to print for fourteen nodes. */
  detail?: string;
  ms?: number;
}

/**
 * How long one backend install may take.
 *
 * Generous because these are genuinely slow: `pip install vllm` pulls CUDA wheels measured in
 * gigabytes, and `docker pull` of the lucebox CUDA image is a similar order. A budget tuned for a
 * fast case would abandon a working install half-way and leave the node in a state nothing recorded.
 */
const INSTALL_TIMEOUT_MS = 30 * 60_000;

/**
 * Run one backend plan on one machine.
 *
 * `sudo -n` — non-interactive. A node whose sudo wants a password fails immediately with a message
 * saying so, rather than hanging until the timeout against a prompt nobody can answer.
 */
export async function executeBackendPlan(target: SshTarget, plan: BackendPlan, timeoutMs = INSTALL_TIMEOUT_MS): Promise<BackendInstallResult> {
  if (plan.action !== 'install' || !plan.script) {
    return { backend: plan.backend, outcome: plan.action === 'adopt' ? 'adopted' : 'skipped', why: plan.why };
  }

  // Heredoc rather than an argv string: these scripts contain quotes, `$`, and their own heredocs,
  // and shell-escaping them into a one-liner is how a script silently becomes a different script.
  const marker = `CIHUB_${plan.backend.toUpperCase()}_EOF`;
  const runner = plan.needsSudo ? 'sudo -n bash' : 'bash';
  const command = `${runner} <<'${marker}'\n${plan.script}\n${marker}`;

  const started = Date.now();
  const result = await sshCapture(target, command, timeoutMs);
  const ms = Date.now() - started;
  const tail = (text: string) => text.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 400);

  if (plan.backend === 'ollama') {
    // The bind step decides its own outcome by marker, and two of its outcomes are not failures of
    // the install: a refusal is a fact about the machine (something else owns the port), reported as
    // skipped so a fleet run continues; a mismatch is the one thing this step exists to catch, and
    // its sentence is the whole diagnosis.
    const bind = classifyBindApplyOutput(result.out, result.err);
    if (bind.outcome === 'refused') return { backend: plan.backend, outcome: 'skipped', why: bind.why, detail: tail(result.out), ms };
    if (bind.outcome === 'mismatch' || bind.outcome === 'failed') {
      return {
        backend: plan.backend,
        outcome: 'failed',
        why: bind.why,
        detail: bind.detail.join(' | ').slice(0, 400) || tail(result.err || result.out),
        ms,
      };
    }
    if (result.ok && result.out.includes(`${plan.backend}-install-complete`)) {
      // The marker says the installer finished and the bind read back; only the daemon can say
      // which version is serving. Asked at the bind the node resolves for itself, because several
      // nodes here bind to their tailnet address and answer nothing on loopback. A mismatch or an
      // unanswered probe is a failure — success is never printed for a version nobody read.
      if (plan.pinnedVersion) {
        const confirmed = await confirmOllamaVersion(target, plan.pinnedVersion);
        const total = Date.now() - started;
        if (!confirmed.ok) return { backend: plan.backend, outcome: 'failed', why: confirmed.why, detail: tail(result.out), ms: total };
        return {
          backend: plan.backend,
          outcome: 'installed',
          why: `${plan.why}; ${bind.why}; ${confirmed.why}`,
          detail: bind.detail.join(' | ').slice(0, 400) || tail(result.out),
          ms: total,
        };
      }
      return {
        backend: plan.backend,
        outcome: 'installed',
        why: `${plan.why}; ${bind.why}`,
        detail: bind.detail.join(' | ').slice(0, 400) || tail(result.out),
        ms,
      };
    }
  }
  if (result.ok && result.out.includes(`${plan.backend}-install-complete`)) {
    return { backend: plan.backend, outcome: 'installed', why: plan.why, detail: tail(result.out), ms };
  }
  // `sudo -n` refusing is the single most likely failure on a fresh node, and its message is
  // unmistakable — naming it beats a generic non-zero exit.
  if (/sudo:.*password is required|a terminal is required/i.test(`${result.err}${result.out}`)) {
    return {
      backend: plan.backend,
      outcome: 'failed',
      why: 'passwordless sudo is not available for this account, so the install cannot run unattended',
      detail: tail(result.err),
      ms,
    };
  }
  return {
    backend: plan.backend,
    outcome: 'failed',
    why: result.code === null ? `no completion marker within ${Math.round(timeoutMs / 60_000)} minutes` : `install exited ${result.code}`,
    detail: tail(result.err || result.out),
    ms,
  };
}

// ─── Bind policy on an adopted Ollama ────────────────────────────────────────

/**
 * Apply the bind policy to an Ollama that is already running as the system unit.
 *
 * The install path writes the canonical file as part of installing; a node that already serves
 * Ollama is adopted and never runs that script, so without this the fourteen nodes that already have
 * Ollama would keep their fourteen bind arrangements forever. Same shell, same guard, same read-back,
 * minus the installer and minus `systemctl enable` (whoever set the unit up decided that).
 *
 * `sudo -n` as everywhere in this file. The caller decides whether to run it at all — on a node whose
 * assessment is already `managed` for the requested bind, there is nothing to do and nothing is run.
 */
export async function applyOllamaBindPolicy(
  target: SshTarget,
  bind: OllamaBindMode,
  facts: HostFacts,
  timeoutMs = 3 * 60_000,
): Promise<BackendInstallResult> {
  const script = [
    'set -e',
    ollamaOwnershipGuardShell(),
    ollamaBindApplyShell(bind, { extraEnv: ollamaManagedEnvironment(facts), enable: false }),
  ].join('\n');
  const command = `sudo -n bash <<'CIHUB_OLLAMA_BIND_EOF'\n${script}\nCIHUB_OLLAMA_BIND_EOF`;
  const started = Date.now();
  const result = await sshCapture(target, command, timeoutMs);
  const ms = Date.now() - started;
  const outcome = classifyBindApplyOutput(result.out, result.err);
  const detail = outcome.detail.join(' | ').slice(0, 400) || undefined;
  if (/sudo:.*password is required|a terminal is required/i.test(`${result.err}${result.out}`)) {
    return {
      backend: 'ollama',
      outcome: 'failed',
      why: 'passwordless sudo is not available for this account, so the bind cannot be applied unattended',
      ms,
    };
  }
  switch (outcome.outcome) {
    case 'applied':
      return { backend: 'ollama', outcome: 'installed', why: `bind applied — ${outcome.why}`, detail, ms };
    case 'refused':
      return { backend: 'ollama', outcome: 'skipped', why: outcome.why, detail, ms };
    case 'mismatch':
    case 'failed':
      return { backend: 'ollama', outcome: 'failed', why: outcome.why, detail, ms };
    case 'incomplete':
      return {
        backend: 'ollama',
        outcome: 'failed',
        why:
          result.code === null
            ? `no completion marker within ${Math.round(timeoutMs / 60_000)} minutes`
            : `bind step exited ${result.code} without a ${BIND_MARKERS.complete} marker`,
        detail: detail ?? (result.err || result.out).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400),
        ms,
      };
  }
}

// ─── Runtime settings on an Ollama the system unit owns ─────────────────────

/**
 * Write the runtime drop-in and restart Ollama only if it changed.
 *
 * Runs after the bind step, whether that installed or adopted: the runtime file is separate from the
 * bind file by design (see `fleet-ollama-runtime.ts`), so on a node where both change the daemon
 * restarts twice on the first run and never again — the second run compares bytes and touches
 * nothing. The caller reports the `was → is` transition this returns whatever the outcome.
 */
export async function applyOllamaRuntimeSettings(
  target: SshTarget,
  settings: OllamaRuntimeSettings,
  timeoutMs = 3 * 60_000,
): Promise<BackendInstallResult & { transition: string }> {
  const script = ['set -e', ollamaRuntimeApplyShell(settings)].join('\n');
  const command = `sudo -n bash <<'CIHUB_OLLAMA_RUNTIME_EOF'\n${script}\nCIHUB_OLLAMA_RUNTIME_EOF`;
  const started = Date.now();
  const result = await sshCapture(target, command, timeoutMs);
  const ms = Date.now() - started;
  const outcome = classifyRuntimeApplyOutput(result.out, result.err, settings);
  const transition = outcome.transition;
  if (/sudo:.*password is required|a terminal is required/i.test(`${result.err}${result.out}`)) {
    return {
      backend: 'ollama',
      outcome: 'failed',
      why: 'passwordless sudo is not available for this account, so the runtime settings cannot be applied unattended',
      ms,
      transition,
    };
  }
  switch (outcome.outcome) {
    case 'applied':
      return { backend: 'ollama', outcome: 'installed', why: `runtime ${transition} — ${outcome.why}`, ms, transition };
    case 'unchanged':
      return { backend: 'ollama', outcome: 'adopted', why: `runtime ${transition} — ${outcome.why}`, ms, transition };
    case 'refused':
      return { backend: 'ollama', outcome: 'skipped', why: outcome.why, ms, transition };
    case 'mismatch':
      return { backend: 'ollama', outcome: 'failed', why: `runtime ${transition} — ${outcome.why}`, ms, transition };
    case 'incomplete':
      return {
        backend: 'ollama',
        outcome: 'failed',
        why:
          result.code === null
            ? `no completion marker within ${Math.round(timeoutMs / 60_000)} minutes`
            : `runtime step exited ${result.code} without writing ${RUNTIME_DROPIN}`,
        detail: (result.err || result.out).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400) || undefined,
        ms,
        transition,
      };
  }
}

// ─── Firewall rules for the Hub's engine probes ─────────────────────────────

export interface ProbeFirewallResult {
  outcome: 'applied' | 'present' | 'skipped' | 'failed';
  why: string;
  added: number[];
  /** Ports a DENY/REJECT of the table's own already refuses: they fail fast, and nothing was appended behind it. */
  blocked: number[];
  ms?: number;
}

/**
 * Allow the Docker bridges through ufw to the ports the Hub probes, on one node.
 *
 * `ports` is what the plan found missing; the shell re-checks each against `ufw status` anyway — in
 * table order, so a reject that arrived since the probe gets nothing appended behind it — and proves
 * the table admits the bridge afterwards, so "Rule added" alone is never reported as done.
 */
export async function applyProbeFirewall(target: SshTarget, ports: readonly number[], timeoutMs = 60_000): Promise<ProbeFirewallResult> {
  const script = ['set -e', probeFirewallApplyShell(ports)].join('\n');
  const command = `sudo -n bash <<'CIHUB_PROBE_FIREWALL_EOF'\n${script}\nCIHUB_PROBE_FIREWALL_EOF`;
  const started = Date.now();
  const result = await sshCapture(target, command, timeoutMs);
  const ms = Date.now() - started;
  if (/sudo:.*password is required|a terminal is required/i.test(`${result.err}${result.out}`)) {
    return {
      outcome: 'failed',
      why: 'passwordless sudo is not available for this account, so the firewall rules cannot be added unattended',
      added: [],
      blocked: [],
      ms,
    };
  }
  const outcome = classifyProbeFirewallOutput(result.out, result.err, ports);
  switch (outcome.outcome) {
    case 'applied':
    case 'present':
    case 'skipped':
    case 'failed':
      return { outcome: outcome.outcome, why: outcome.why, added: outcome.added, blocked: outcome.blocked, ms };
    case 'incomplete':
      return {
        outcome: 'failed',
        why:
          result.code === null
            ? `no completion marker within ${Math.round(timeoutMs / 1000)} s`
            : `firewall step exited ${result.code} without a completion marker`,
        added: outcome.added,
        blocked: outcome.blocked,
        ms,
      };
  }
}
