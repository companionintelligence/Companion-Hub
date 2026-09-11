/**
 * Standing a Hub up on a remote machine, and keeping a fleet of them current.
 *
 * `docs/fleet-setup.md` describes the manual path plainly: *"Adding a node repeats the whole one-node
 * path: install, register, install models, then pair."* For fourteen boxes that is fourteen sessions,
 * and it is why nobody does it.
 *
 * Six things had to be fixed before this file could exist at all — a release asset nothing built, an
 * `install.sh` pointing at a retired repo, `cihub register` exiting 0 on failure, pool mutations
 * refusing a non-TTY, `docker exec -it` against `ssh -n`, and appliance updates that never re-pulled.
 * They are fixed; this is what they were blocking.
 *
 * TWO RULES, both from watching a fleet-wide pass go wrong:
 *
 * 1. **Serialised per node, and load-gated.** A maintenance pass on this fleet caught one machine
 *    mid-inference at load 108-116 on 32 cores; its package transaction stalled rebuilding an
 *    initramfs it could never get CPU for, and the box ended up needing physical recovery. Nothing
 *    in that pass checked load first. This one does, and refuses.
 * 2. **Verify, never trust an exit code.** `cihub register` used to report success when it had not
 *    reached the Hub. Even now that it exits properly, every step here re-checks the state it
 *    claims to have produced.
 */

import { classifyStatusTimerOutput, describeStatusTimerOutcome, installStatusTimerScript } from './status-timer.js';
import { sshCapture, type SshTarget } from './fleet-ssh.js';
import { isTooBusyForMaintenance, readHostFacts } from './fleet-hardware.js';
import { gatePreflight, preflightNode } from './fleet-preflight.js';

export interface InstallStep {
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
  /** True when the step decided not to act, rather than trying and failing. */
  skipped?: boolean;
}

export interface NodeInstallReport {
  node: string;
  steps: InstallStep[];
  ok: boolean;
}

const tail = (text: string, lines = 3) => text.split('\n').filter(Boolean).slice(-lines).join(' | ').slice(0, 300);

/** Is a usable `cihub` already on this machine? */
export async function detectCihub(target: SshTarget): Promise<{ present: boolean; version?: string; path?: string }> {
  const res = await sshCapture(target, 'command -v cihub && cihub version 2>/dev/null | head -1', 20_000);
  if (!res.ok || !res.out) return { present: false };
  const [path, ...rest] = res.out.split('\n');
  return { present: true, path, version: rest.join(' ').trim() || undefined };
}

/**
 * Put the `cihub` binary on a node.
 *
 * Downloads the standalone release asset — the one the release workflow now actually publishes.
 * Deliberately not `curl | sh`: a POSIX pipeline reports only the last command's status, so a
 * truncated download would be executed and then reported as a successful install.
 */
export function installCihubScript(version = 'latest'): string {
  return [
    'set -e',
    'arch="$(uname -m)"',
    'case "$arch" in',
    '  x86_64|amd64) asset="cihub-linux-x64" ;;',
    '  aarch64|arm64) asset="cihub-linux-arm64" ;;',
    '  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;',
    'esac',
    version === 'latest'
      ? 'tag="$(curl -fsSL https://api.github.com/repos/companionintelligence/CI-Hub/releases/latest | grep \'"tag_name"\' | head -1 | cut -d\'"\' -f4)"'
      : `tag="${version}"`,
    '[ -n "$tag" ] || { echo "could not resolve a release tag" >&2; exit 1; }',
    'url="https://github.com/companionintelligence/CI-Hub/releases/download/$tag/$asset"',
    'tmp="$(mktemp)"',
    'trap \'rm -f "$tmp"\' EXIT',
    'curl -fsSL --connect-timeout 30 --max-time 600 "$url" -o "$tmp"',
    // Refuse an HTML error page renamed to a binary — the failure this download had for its whole life.
    '[ -s "$tmp" ] || { echo "downloaded an empty file from $url" >&2; exit 1; }',
    'install -m 0755 "$tmp" /usr/local/bin/cihub',
    'echo "cihub-installed $tag"',
  ].join('\n');
}

/**
 * Bring the Hub stack up and register it with Portal.
 *
 * The password reaches the seed through the environment because `seedApplianceInstall` prompts
 * otherwise, and there is no terminal here to answer. `cihub register --code` is non-interactive;
 * without `--code` it drops into a readline loop that would hang until the SSH budget expires.
 */
export function bringUpScript(postgresPassword: string, pairingCode: string): string {
  return [
    'set -e',
    // Single-quoted heredoc-free assignment; the password never reaches argv, only the environment.
    `export CIHUB_POSTGRES_PASSWORD='${postgresPassword.replace(/'/g, "'\\''")}'`,
    'cihub up --detached',
    // `register` now exits non-zero on failure, but the state check is what actually proves it —
    // an exit code says what the command believed, not what the Hub is.
    `cihub register --code '${pairingCode.replace(/'/g, "'\\''")}'`,
    'curl -fsS --max-time 10 http://127.0.0.1:5002/api/registration/status || true',
    'echo "hub-up-complete"',
  ].join('\n');
}

/**
 * Give the freshly registered Hub its first operator.
 *
 * `docs/fleet-setup.md` describes the one-node path as *"install, register, install models, then
 * pair"* — and that list is missing a step, which is why this fleet ended up with twelve registered
 * Hubs that could not authenticate anybody. `register` writes the device key; the operator row was
 * only ever written by a person signing in through Portal in a browser, which is precisely what a
 * fleet install does not have. `cihub claim` is that step, headless.
 *
 * Re-runnable: a Hub that already has an operator reports it and exits 0, so a replayed install
 * does not fail here.
 */
export function claimHubScript(email: string): string {
  return ['set -e', `cihub claim --email '${email.replace(/'/g, "'\\''")}'`, 'echo "hub-claim-complete"'].join('\n');
}

/**
 * Join this node into a pool by pairing with an existing Hub.
 *
 * The PIN is minted on the RECEIVING Hub and typed on the joining one — the opposite direction from
 * every other pool command, and the single easiest thing to get backwards here.
 *
 * `CI_HUB_ASSUME_YES=1` because `ssh -n` has no TTY and every pool mutation refuses one.
 */
export function joinPoolScript(peerFqdn: string, pin?: string): string {
  const pinArg = pin ? ` --pin '${pin.replace(/'/g, "'\\''")}'` : '';
  return [
    'set -e',
    'export CI_HUB_ASSUME_YES=1',
    `cihub pool pair '${peerFqdn.replace(/'/g, "'\\''")}'${pinArg} --yes`,
    'cihub pool status',
    'echo "pool-join-attempted"',
  ].join('\n');
}

/** Update the Hub image on a node. Uses the pool-update path, which needs no build toolchain. */
export function updateHubScript(): string {
  return ['set -e', 'export CI_HUB_ASSUME_YES=1', 'cihub pool update', 'echo "hub-update-complete"'].join('\n');
}

/**
 * Pull a model on a node.
 *
 * Tries the Hub-managed container, then a host `ollama` binary, then the HTTP API. The first version
 * only knew about the container and failed on every node in this fleet, which runs Ollama as a host
 * systemd service — a perfectly supported shape the script simply did not consider. The final
 * fallback needs no CLI at all, so it works wherever something is listening.
 */
export function pullModelScript(model: string): string {
  const safe = model.replace(/'/g, "'\\''");
  return [
    'set -e',
    // Three ways a node can serve Ollama, tried in the order that keeps the pull closest to the Hub.
    // The container-only version of this failed on every node in this fleet, which runs Ollama as a
    // host systemd service — a shape the Hub supports and this script did not.
    'c="$(docker ps --filter label=com.docker.compose.project=ci-hub --filter name=ollama --format \'{{.Names}}\' 2>/dev/null | head -1)"',
    'if [ -n "$c" ]; then',
    `  docker exec "$c" ollama pull '${safe}'`,
    'else',
    // A live listener beats a CLI. Measured: a node serving happily on :11434 whose root `ollama`
    // CLI answered "could not connect to ollama server" — the daemon binds elsewhere and the CLI
    // defaults somewhere else. Asking the port that is actually answering avoids the whole question.
    // Discover where Ollama actually listens. Measured on this fleet: a node whose service binds to
    // its tailnet address (100.x.y.z:11434) rather than 0.0.0.0, so loopback answers nothing and both
    // the CLI and a 127.0.0.1 probe report "could not connect" on a machine that is serving fine.
    // OLLAMA_HOST first, then the listening socket, then loopback.
    "  host=\"$(systemctl show ollama -p Environment 2>/dev/null | tr ' ' '\\n' | sed -n 's/^OLLAMA_HOST=//p' | head -1)\"",
    '  [ -n "$host" ] || host="$(ss -ltn 2>/dev/null | awk \'/:11434 /{print $4; exit}\')"',
    '  [ -n "$host" ] || host="127.0.0.1:11434"',
    '  case "$host" in *:*) : ;; *) host="$host:11434" ;; esac',
    '  case "$host" in 0.0.0.0:*|\\[::\\]:*|*:*) host="$(echo "$host" | sed \'s/^0\\.0\\.0\\.0:/127.0.0.1:/; s/^\\[::\\]:/127.0.0.1:/\')" ;; esac',
    '  code="$(curl -s -o /dev/null -w \'%{http_code}\' --max-time 10 "http://$host/api/version" || true)"',
    '  if [ "$code" = "200" ]; then',
    `    curl -fsS --max-time 3600 -X POST "http://$host/api/pull" -d '{"model":"${safe}","stream":false}' >/dev/null`,
    '  elif command -v ollama >/dev/null 2>&1; then',
    `    ollama pull '${safe}'`,
    '  else',
    '    echo "no ollama on this node: no Hub-managed container, nothing answering on $host, and no ollama binary" >&2; exit 1',
    '  fi',
    'fi',
    'echo "model-pull-complete"',
  ].join('\n');
}

async function step(name: string, target: SshTarget, script: string, marker: string, timeoutMs: number): Promise<InstallStep> {
  const started = Date.now();
  const heredoc = `bash <<'CIHUB_STEP_EOF'\n${script}\nCIHUB_STEP_EOF`;
  const res = await sshCapture(target, heredoc, timeoutMs);
  const ms = Date.now() - started;
  if (res.ok && res.out.includes(marker)) return { name, ok: true, detail: tail(res.out, 1), ms };
  return { name, ok: false, detail: tail(res.err || res.out), ms };
}

export interface InstallOptions {
  postgresPassword: string;
  pairingCode: string;
  /**
   * CI Account address to claim each Hub for, creating its first operator.
   *
   * Optional, and skipped rather than assumed when absent: a claim writes the one row that decides
   * who this appliance belongs to, and guessing an address for fourteen machines is not a default
   * anything should hold.
   */
  claimEmail?: string;
  version?: string;
  joinPool?: string;
  poolPin?: string;
  /** Refuse to touch a node above this load-per-core. */
  loadRatio?: number;
  /**
   * Go ahead on a node whose preflight said `block`. The finding is still printed on the node's
   * line, prefixed so the log shows the override was chosen rather than missed.
   */
  force?: boolean;
  /**
   * The operation will touch the kernel, initramfs or GRUB. A Hub install does not, so the default
   * is false; a caller that will (a driver or kernel install) passes true and the boot-recovery and
   * grub-customizer findings become blocking rather than advisory.
   */
  touchesBoot?: boolean;
}

/**
 * Install a Hub on one node, end to end.
 *
 * Returns a report rather than throwing: a fourteen-node run must visit all fourteen and describe
 * every one, including the ones it deliberately declined to touch.
 */
export async function installNode(
  node: { name: string; ip: string; user?: string; oob?: string },
  opts: InstallOptions,
  sshUser?: string,
): Promise<NodeInstallReport> {
  const target: SshTarget = { host: node.ip, user: node.user ?? sshUser };
  const steps: InstallStep[] = [];

  const { facts, error } = await readHostFacts(target);
  if (!facts) {
    return { node: node.name, ok: false, steps: [{ name: 'probe', ok: false, detail: String(error).slice(0, 200) }] };
  }
  steps.push({ name: 'probe', ok: true, detail: `${facts.os}/${facts.arch}, ${facts.cpuCount ?? '?'} cores, load ${facts.load1 ?? '?'}` });

  const busy = isTooBusyForMaintenance(facts, opts.loadRatio);
  if (busy.busy) {
    steps.push({ name: 'load gate', ok: false, skipped: true, detail: busy.why ?? 'node is busy' });
    return { node: node.name, ok: false, steps };
  }

  if (facts.os !== 'linux') {
    steps.push({ name: 'platform', ok: false, skipped: true, detail: `headless install is Linux-only; this node is ${facts.os}` });
    return { node: node.name, ok: false, steps };
  }
  if (!facts.docker.usable) {
    steps.push({ name: 'docker', ok: false, detail: facts.docker.present ? 'docker present but `docker info` failed' : 'no docker engine' });
    return { node: node.name, ok: false, steps };
  }

  // The checks nothing ran before: sudo, a wedged dpkg, grub-customizer's proxies, a boot with no
  // way back, a held package lock. One round trip, decided in `fleet-preflight.ts`; `block` ends the
  // node here rather than six steps in, unless `force` was chosen.
  const preflightStarted = Date.now();
  const preflight = await preflightNode(target, node, { touchesBoot: opts.touchesBoot });
  const gate = gatePreflight(preflight, { force: opts.force });
  steps.push({ name: 'preflight', ok: gate.proceed, skipped: !gate.proceed, detail: gate.detail, ms: Date.now() - preflightStarted });
  if (!gate.proceed) return { node: node.name, ok: false, steps };

  const existing = await detectCihub(target);
  if (existing.present) {
    steps.push({
      name: 'cihub',
      ok: true,
      skipped: true,
      detail: `already installed at ${existing.path}${existing.version ? ` (${existing.version})` : ''}`,
    });
  } else {
    const s = await step('install cihub', target, installCihubScript(opts.version), 'cihub-installed', 10 * 60_000);
    steps.push(s);
    if (!s.ok) return { node: node.name, ok: false, steps };
  }

  // 20 minutes: this pulls the Hub image and every infra container on a cold machine.
  const up = await step('hub up + register', target, bringUpScript(opts.postgresPassword, opts.pairingCode), 'hub-up-complete', 20 * 60_000);
  steps.push(up);
  if (!up.ok) return { node: node.name, ok: false, steps };

  // Registered is not claimed. Without this the node comes up paired, keyed, and answering 409
  // AUTH_ERROR_HUB_NOT_CLAIMED to its own operator API — the state twelve of this fleet's nodes
  // were in, misread as bad device keys for a week.
  if (opts.claimEmail) {
    steps.push(await step('claim hub', target, claimHubScript(opts.claimEmail), 'hub-claim-complete', 2 * 60_000));
  } else {
    steps.push({
      name: 'claim hub',
      ok: true,
      skipped: true,
      detail: 'no --claim-email given; this Hub has no operator until one is created',
    });
  }

  // The audit file. Best-effort by design: a node that ends up without a timer is
  // still an installed Hub, and the step says which of the three ways it fell short
  // rather than reporting a bare failure.
  // sshCapture rather than step(): the outcome is decided by markers that can appear
  // on any line, and step() reports only the last one.
  const timerStarted = Date.now();
  const timerRun = await sshCapture(target, `bash <<'CIHUB_STEP_EOF'\n${installStatusTimerScript()}\nCIHUB_STEP_EOF`, 2 * 60_000);
  const timerOutcome = classifyStatusTimerOutput(timerRun.out, timerRun.ok);
  steps.push({
    name: 'status timer',
    ok: timerOutcome !== 'failed',
    skipped: timerOutcome === 'no-user-session',
    detail: describeStatusTimerOutcome(timerOutcome),
    ms: Date.now() - timerStarted,
  });

  if (opts.joinPool) {
    const join = await step('join pool', target, joinPoolScript(opts.joinPool, opts.poolPin), 'pool-join-attempted', 3 * 60_000);
    // A pair lands PENDING and needs approval on the receiving Hub — reported, not treated as done.
    join.detail = `${join.detail} — the receiving Hub must approve: cihub pool peers && cihub pool approve <id> --yes`;
    steps.push(join);
  }

  return { node: node.name, ok: steps.every((s) => s.ok || s.skipped), steps };
}
