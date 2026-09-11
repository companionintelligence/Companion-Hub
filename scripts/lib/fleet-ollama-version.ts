/**
 * Pinning, confirming and reporting the Ollama version across the fleet.
 *
 * MEASURED 2026-09-10: eighteen nodes ran eighteen different histories of `ollama.com/install.sh`,
 * and the versions spanned 0.12.11 → 0.33.3. The installer was never given a version, so every node
 * got whatever was current the day someone ran it, and nothing afterwards ever reported the spread —
 * `fleet status` had no version column, and `fleet backends` adopts any listener on :11434 without
 * asking how old it is. All eighteen were brought to one version by hand that night. This file is
 * what makes that a command instead of an evening.
 *
 * Three rules, each from that night:
 *
 * 1. **One pinned version, in one place.** {@link OLLAMA_PINNED_VERSION} is what a fresh install
 *    gets and what `status` measures the fleet against. `--ollama-version` overrides it for a run;
 *    `latest` is refused, because "whatever is current today" is the policy that produced the spread.
 * 2. **An install is not done until `/api/version` says the pinned number.** The installer's exit
 *    code says the tarball unpacked; only the running daemon can say what version is serving. The
 *    check asks the bind the node actually uses, because several nodes here bind OLLAMA_HOST to
 *    their tailnet address and answer nothing on loopback — `curl localhost:11434` reads "no Ollama"
 *    on a machine that is serving fine.
 * 3. **Unmeasured is never a version.** A node that cannot be asked renders as `—` with the reason,
 *    never as "missing" and never as whatever it reported last time.
 *
 * Nothing here runs without an explicit command; `status` reads, `backends`/`update` need `--execute`.
 */

import { readHostFacts, isTooBusyForMaintenance } from './fleet-hardware.js';
import type { FleetNode } from './fleet-roster.js';
import { classifySshFailure, sshCapture, type SshFailure, type SshTarget } from './fleet-ssh.js';

/**
 * The version every node should be running.
 *
 * Bump this deliberately, then roll it with `cihub fleet update --ollama --execute`. It is the value
 * the fleet was hand-aligned to on 2026-09-10.
 */
export const OLLAMA_PINNED_VERSION = '0.34.0';

/** Ollama's `/api/version` on the node's own port. */
export const OLLAMA_API_PORT = 11434;

/** An exact release, optionally pre-release-tagged: `0.34.0`, `0.35.0-rc1`. Never a range, never a word. */
const RELEASE_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export class OllamaVersionError extends Error {}

/**
 * The version a run installs: the pin, or an explicit override.
 *
 * Throws on anything that is not an exact release. `latest` gets its own message because it is the
 * natural thing to type and the exact policy that produced an eighteen-version fleet.
 */
export function resolveOllamaVersion(override?: string): string {
  if (override === undefined) return OLLAMA_PINNED_VERSION;
  const trimmed = override.trim().replace(/^v/i, '');
  if (trimmed === 'latest' || trimmed === '') {
    throw new OllamaVersionError(
      `--ollama-version needs an exact release such as ${OLLAMA_PINNED_VERSION}; '${override}' is the unpinned install that spread this fleet across 0.12.11 → 0.33.3.`,
    );
  }
  if (!RELEASE_SHAPE.test(trimmed)) {
    throw new OllamaVersionError(`--ollama-version must look like x.y.z (got '${override}'). The pinned default is ${OLLAMA_PINNED_VERSION}.`);
  }
  return trimmed;
}

// ─── Reading the version a node is actually serving ──────────────────────────

/**
 * Shell that leaves the address Ollama listens on in `$host`.
 *
 * The same resolution `pullModelScript` uses — OLLAMA_HOST from the unit's environment, then the
 * listening socket, then loopback — copied rather than shared so the two scripts can be edited
 * independently. Two tolerances added here: `systemctl show -p Environment` prefixes its first
 * token with `Environment=`, which hid an OLLAMA_HOST declared first in the unit; and `ss` prints a
 * wildcard bind as `*:11434`, which is not an address curl can dial.
 */
export const OLLAMA_RESOLVE_HOST_SH: readonly string[] = [
  "host=\"$(systemctl show ollama -p Environment 2>/dev/null | tr ' ' '\\n' | sed -n 's/^\\(Environment=\\)\\{0,1\\}OLLAMA_HOST=//p' | head -1)\"",
  'host="$(printf \'%s\' "$host" | sed \'s#^https\\{0,1\\}://##\')"',
  `[ -n "$host" ] || host="$(ss -ltn 2>/dev/null | awk '/:${OLLAMA_API_PORT} /{print $4; exit}')"`,
  `[ -n "$host" ] || host="127.0.0.1:${OLLAMA_API_PORT}"`,
  `case "$host" in *:*) : ;; *) host="$host:${OLLAMA_API_PORT}" ;; esac`,
  'host="$(printf \'%s\' "$host" | sed \'s/^0\\.0\\.0\\.0:/127.0.0.1:/; s/^\\[::\\]:/127.0.0.1:/; s/^\\*:/127.0.0.1:/\')"',
];

/**
 * Ask a node which Ollama it is serving, at the bind it actually uses.
 *
 * Prints `ollama-host=` and then exactly one of `ollama-version=` or `ollama-version-error=`, and
 * always exits 0 — a non-zero exit from this script would be indistinguishable from SSH failing,
 * and the two are different findings. `attempts` exists for the moment after an install, when the
 * daemon is restarting and the first probe legitimately finds nothing.
 */
export function ollamaVersionScript(opts: { attempts?: number } = {}): string {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 1));
  return [
    ...OLLAMA_RESOLVE_HOST_SH,
    'echo "ollama-host=$host"',
    'body=""',
    'i=0',
    `while [ "$i" -lt ${attempts} ]; do`,
    '  body="$(curl -fsS --max-time 5 "http://$host/api/version" 2>/dev/null)" && break',
    '  body=""',
    '  i=$((i+1))',
    `  [ "$i" -lt ${attempts} ] && sleep 2`,
    'done',
    'if [ -z "$body" ]; then',
    '  if command -v ollama >/dev/null 2>&1; then',
    '    echo "ollama-version-error=nothing answered at $host, though an ollama binary is on PATH — daemon down, or bound elsewhere"',
    '  else',
    '    echo "ollama-version-error=nothing answered at $host and no ollama binary on PATH"',
    '  fi',
    '  exit 0',
    'fi',
    'v="$(printf \'%s\' "$body" | sed -n \'s/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\' | head -1)"',
    'if [ -n "$v" ]; then echo "ollama-version=$v"; else echo "ollama-version-error=unparseable /api/version body: $(printf \'%s\' "$body" | head -c 120)"; fi',
    'exit 0',
  ].join('\n');
}

export interface OllamaVersionReading {
  /** Roster name, so a summary can name the machine. */
  node: string;
  /** Exactly what `/api/version` returned. Absent whenever it could not be read. */
  version?: string;
  /** The bind the version was read from. */
  host?: string;
  /** `node`: resolved on the machine over SSH. `remote`: `:11434` dialled from here, when SSH could not. */
  source?: 'node' | 'remote';
  /** Why there is no version. Set exactly when `version` is absent. */
  reason?: string;
}

/** Parse {@link ollamaVersionScript} output. Never throws; garbage becomes a reason. */
export function parseOllamaVersionOutput(out: string): Pick<OllamaVersionReading, 'version' | 'host' | 'reason'> {
  let host: string | undefined;
  let version: string | undefined;
  let reason: string | undefined;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('ollama-host=')) host = trimmed.slice('ollama-host='.length) || undefined;
    else if (trimmed.startsWith('ollama-version=')) version = trimmed.slice('ollama-version='.length).trim().replace(/^v/i, '') || undefined;
    else if (trimmed.startsWith('ollama-version-error=')) reason = trimmed.slice('ollama-version-error='.length) || 'unspecified error';
  }
  if (version) return { host, version };
  return { host, reason: reason ?? (out.trim() ? `unrecognised probe output: ${out.trim().slice(0, 120)}` : 'the version probe printed nothing') };
}

/**
 * Was the version that was asked for the version that is serving?
 *
 * Pure, and the only place that decides. Never `ok` without a version: an install whose daemon
 * cannot be asked is unconfirmed, not successful.
 */
export function judgeOllamaVersion(
  expected: string,
  reading: Pick<OllamaVersionReading, 'version' | 'host' | 'reason'>,
): { ok: boolean; why: string } {
  const want = expected.replace(/^v/i, '');
  const where = reading.host ? ` at ${reading.host}` : '';
  if (!reading.version) {
    return {
      ok: false,
      why: `installed, but could not confirm the version${where}: ${reading.reason ?? 'no /api/version answer'} — not reporting success on a version nobody read`,
    };
  }
  if (reading.version !== want) {
    return {
      ok: false,
      why: `/api/version${where} reports ${reading.version}, not the ${want} that was installed — the daemon serving is not the one asked for`,
    };
  }
  return { ok: true, why: `/api/version${where} confirms ${want}` };
}

/** Read the running version on one node over SSH, at the bind it resolves for itself. */
export async function readOllamaVersionOnNode(
  target: SshTarget,
  opts: { attempts?: number; timeoutMs?: number } = {},
): Promise<Pick<OllamaVersionReading, 'version' | 'host' | 'reason'>> {
  const attempts = opts.attempts ?? 1;
  // Each attempt is a 5 s curl plus a 2 s pause; the budget must outlast every attempt or a slow
  // restart is reported as SSH timing out.
  const timeoutMs = opts.timeoutMs ?? Math.max(20_000, attempts * 8_000);
  const res = await sshCapture(
    target,
    `bash <<'CIHUB_OLLAMA_VERSION_EOF'\n${ollamaVersionScript({ attempts })}\nCIHUB_OLLAMA_VERSION_EOF`,
    timeoutMs,
  );
  if (res.out.includes('ollama-host=')) return parseOllamaVersionOutput(res.out);
  return { reason: `ssh ${classifySshFailure(res)}${res.err ? `: ${res.err.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 120)}` : ''}` };
}

/** After an install: wait for the daemon, read the version at its bind, and judge it against the pin. */
export async function confirmOllamaVersion(
  target: SshTarget,
  expected: string,
): Promise<{ ok: boolean; why: string; version?: string; host?: string }> {
  const reading = await readOllamaVersionOnNode(target, { attempts: 10 });
  return { ...judgeOllamaVersion(expected, reading), version: reading.version, host: reading.host };
}

async function fetchRemoteVersion(ip: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${OLLAMA_API_PORT}/api/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' && body.version ? body.version.replace(/^v/i, '') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface VersionProbeInput {
  node: FleetNode;
  /** What the status probe already learned about SSH, so a denied node is not dialled twice. */
  sshOk?: boolean;
  sshFailure?: SshFailure;
}

/**
 * Read one node's version for `status`.
 *
 * On the node first, over SSH, because that is the only way to reach a daemon bound to loopback or
 * to its tailnet address alone. From here second, on `:11434`, for a node that serves but grants no
 * SSH — two machines on this fleet are exactly that. Neither answer standing in for the other is the
 * point: the reading says which one it is.
 */
export async function readOllamaVersion(input: VersionProbeInput, opts: { user?: string; timeoutMs?: number } = {}): Promise<OllamaVersionReading> {
  const { node } = input;
  const httpTimeout = opts.timeoutMs ?? 4_000;
  const reasons: string[] = [];

  if (!node.local && input.sshOk !== false) {
    const onNode = await readOllamaVersionOnNode(
      { host: node.ip, user: node.user ?? opts.user },
      { attempts: 1, timeoutMs: Math.max(httpTimeout, 15_000) },
    );
    if (onNode.version) return { node: node.name, version: onNode.version, host: onNode.host, source: 'node' };
    if (onNode.reason) reasons.push(onNode.reason);
  } else if (!node.local) {
    reasons.push(`ssh ${input.sshFailure ?? 'unavailable'}`);
  }

  const remote = await fetchRemoteVersion(node.ip, httpTimeout);
  if (remote) return { node: node.name, version: remote, host: `${node.ip}:${OLLAMA_API_PORT}`, source: 'remote' };
  reasons.push(`:${OLLAMA_API_PORT} did not answer from here`);

  return { node: node.name, reason: reasons.join('; ') };
}

/** Read every node, bounded. Order of the result matches the input. */
export async function readOllamaVersions(
  inputs: readonly VersionProbeInput[],
  opts: { user?: string; timeoutMs?: number; concurrency?: number } = {},
): Promise<OllamaVersionReading[]> {
  const out: OllamaVersionReading[] = new Array(inputs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      out[i] = await readOllamaVersion(inputs[i] as VersionProbeInput, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 4), Math.max(inputs.length, 1)) }, worker));
  return out;
}

// ─── Standing against the pin ────────────────────────────────────────────────

/** Numeric x.y.z comparison; a pre-release sorts below its release. NaN never escapes. */
export function compareOllamaVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

export type PinStanding = 'at-pin' | 'behind' | 'ahead' | 'unmeasured';

export function standingAgainstPin(version: string | undefined, pin: string): PinStanding {
  if (!version) return 'unmeasured';
  const c = compareOllamaVersions(version, pin);
  return c === 0 ? 'at-pin' : c < 0 ? 'behind' : 'ahead';
}

/** The cell `status` prints for one node. Unmeasured is a dash, never a number. */
export function renderOllamaCell(reading: OllamaVersionReading, pin: string): { text: string; standing: PinStanding } {
  const standing = standingAgainstPin(reading.version, pin);
  switch (standing) {
    case 'at-pin':
      return { text: reading.version as string, standing };
    case 'behind':
      return { text: `${reading.version} ◂ behind pin ${pin}`, standing };
    case 'ahead':
      return { text: `${reading.version} ▸ ahead of pin ${pin}`, standing };
    case 'unmeasured':
      return { text: '—', standing };
  }
}

/**
 * One line for the whole fleet: `0.34.0 on 17/18; behind: localhost-0 (0.30.9)`.
 *
 * The denominator is every node asked, not every node that answered, so an unmeasured machine
 * lowers the count and is named with its reason instead of quietly leaving the fraction.
 */
export function summariseOllamaVersions(readings: readonly OllamaVersionReading[], pin: string): string {
  const by = (want: PinStanding) => readings.filter((r) => standingAgainstPin(r.version, pin) === want);
  const parts = [`${pin} on ${by('at-pin').length}/${readings.length}`];
  const behind = by('behind');
  const ahead = by('ahead');
  const unmeasured = by('unmeasured');
  if (behind.length) parts.push(`behind: ${behind.map((r) => `${r.node} (${r.version})`).join(', ')}`);
  if (ahead.length) parts.push(`ahead: ${ahead.map((r) => `${r.node} (${r.version})`).join(', ')}`);
  if (unmeasured.length) parts.push(`unmeasured: ${unmeasured.map((r) => `${r.node} (${r.reason ?? 'no reading'})`).join(', ')}`);
  return parts.join('; ');
}

// ─── Moving a node to the pin ────────────────────────────────────────────────

/**
 * Re-run the official installer at an exact version, on a node that already has Ollama.
 *
 * Download-to-file-then-run, same as the fresh install and for the same two reasons: a pipeline
 * reports only its last command's status, and the control machine's permission model refuses to
 * pipe a downloaded installer into a root shell. The installer honours `OLLAMA_VERSION` and restarts
 * the systemd unit itself; the `ollama.service.d/` drop-in that carries each node's OLLAMA_HOST is
 * not touched by it, so a node bound to its tailnet address stays bound there.
 */
export function ollamaUpgradeScript(version: string): string {
  const pinned = resolveOllamaVersion(version);
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'installer="$(mktemp)"',
    'trap \'rm -f "$installer"\' EXIT',
    'curl -fsSL --connect-timeout 30 --max-time 300 https://ollama.com/install.sh -o "$installer"',
    `OLLAMA_VERSION='${pinned}' sh "$installer"`,
    'echo "ollama-upgrade-complete"',
  ].join('\n');
}

export interface OllamaUpgradeResult {
  outcome: 'upgraded' | 'current' | 'skipped' | 'failed';
  why: string;
  from?: string;
  to?: string;
  host?: string;
  ms?: number;
}

/** The tarball is 1–2 GB, more with the ROCm bundle. A budget tuned for a fast node abandons a slow one mid-write. */
const UPGRADE_TIMEOUT_MS = 20 * 60_000;

/**
 * Bring one node to the pinned version, and prove it.
 *
 * Refuses rather than installs when there is no Ollama to upgrade — that is `fleet backends`' job,
 * and it also writes the bind drop-in this path deliberately leaves alone. Refuses a busy node for
 * the reason every fleet mutation here does. Reports `current` without downloading anything when
 * the node already serves the pin, so a fleet-wide pass is cheap to re-run.
 */
export async function upgradeOllamaOnNode(
  target: SshTarget,
  version: string,
  opts: { loadRatio?: number; timeoutMs?: number } = {},
): Promise<OllamaUpgradeResult> {
  const to = resolveOllamaVersion(version);
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const { facts, error } = await readHostFacts(target);
  if (!facts) return { outcome: 'failed', why: `could not read the node: ${String(error).slice(0, 160)}`, ms: elapsed() };
  if (facts.os !== 'linux') return { outcome: 'skipped', why: `the installer is Linux-only; this node is ${facts.os}`, ms: elapsed() };
  const busy = isTooBusyForMaintenance(facts, opts.loadRatio);
  if (busy.busy) return { outcome: 'skipped', why: `refusing to restart Ollama: ${busy.why}`, ms: elapsed() };

  const before = await readOllamaVersionOnNode(target, { attempts: 1 });
  if (!before.version) {
    return {
      outcome: 'skipped',
      why: `no Ollama to upgrade (${before.reason}) — install one with 'cihub fleet backends --backends ollama --execute'`,
      host: before.host,
      ms: elapsed(),
    };
  }
  if (before.version === to)
    return { outcome: 'current', why: `already ${to} at ${before.host}`, from: before.version, to, host: before.host, ms: elapsed() };

  const run = await sshCapture(
    target,
    `sudo -n bash <<'CIHUB_OLLAMA_UPGRADE_EOF'\n${ollamaUpgradeScript(to)}\nCIHUB_OLLAMA_UPGRADE_EOF`,
    opts.timeoutMs ?? UPGRADE_TIMEOUT_MS,
  );
  const tail = (text: string) => text.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200);
  if (/sudo:.*password is required|a terminal is required/i.test(`${run.err}${run.out}`)) {
    return {
      outcome: 'failed',
      why: 'passwordless sudo is not available for this account, so the installer cannot run unattended',
      from: before.version,
      to,
      ms: elapsed(),
    };
  }
  if (!run.ok || !run.out.includes('ollama-upgrade-complete')) {
    const why =
      run.code === null
        ? `no completion marker within ${Math.round((opts.timeoutMs ?? UPGRADE_TIMEOUT_MS) / 60_000)} minutes`
        : `installer exited ${run.code}`;
    return { outcome: 'failed', why: `${why}: ${tail(run.err || run.out)}`, from: before.version, to, ms: elapsed() };
  }

  const confirmed = await confirmOllamaVersion(target, to);
  if (!confirmed.ok) return { outcome: 'failed', why: confirmed.why, from: before.version, to, host: confirmed.host, ms: elapsed() };
  return { outcome: 'upgraded', why: `${before.version} → ${to}; ${confirmed.why}`, from: before.version, to, host: confirmed.host, ms: elapsed() };
}
