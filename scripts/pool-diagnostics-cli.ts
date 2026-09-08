/**
 * Hub Pool preflight for `cihub pool doctor`.
 *
 * Every check here exists because a real fleet rollout hit the failure it names, and hit it
 * SILENTLY: the node reported itself healthy to its own operator throughout. That is the shape of
 * the whole module — it does not ask "is this node up", it asks "is there any reason peers will
 * refuse to use this node while it keeps saying it is fine".
 *
 * Contract matches `bridge-diagnostics-cli.ts` and `network-diagnostics-cli.ts`:
 * `runPoolDoctorSection` returns `{ lines, issueCount, remediationCommands }` and a probe that
 * blows up degrades to one line rather than taking down the report. That matters more here than in
 * the sibling modules — this runs on machines with no Docker, no Tailscale and no Hub, and a
 * preflight that cannot run on a machine that has not been set up yet is not a preflight.
 *
 * Read-only, and deliberately so: nothing here pairs, unpairs, writes a setting, restarts anything
 * or edits config. The one check that spends anything (GPU time, C3) is opt-in and reports itself
 * as skipped otherwise.
 *
 * Secrets: the operator key is read from `state/settings.json` to reach authenticated routes and is
 * never printed. Neither is a PIN, a peer token, or any `TAILSCALE_OAUTH_*` value — no check here
 * reads one.
 */
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { isHubContainerRunning, probeHostPort, resolveHubContainerName, runBridgeDoctorSection } from './bridge-diagnostics-cli';
import { parseEnvFile } from './env-file';
import { BIND_MOUNT_DIRS } from './lib/bind-mounts';
import { cliFail, cliOk, cliWarn, colorize, dim, sanitizeForBox, STEP_ICONS } from './lib/cli-ui';
import { resolveRootFolderHost } from './lib/paths';
import { readHubApiKey } from './public-web-cli';

// ─────────────────────────────────────────────────────────────────────────────
// Constants mirrored from the backend. Cited, not guessed — a doctor that
// asserts against a made-up budget is worse than no doctor.
// ─────────────────────────────────────────────────────────────────────────────

/** CAPABILITIES_PROBE_TIMEOUT_MS (hub-pool-peer.service.ts:73). A peer's probe is abandoned at this point. */
export const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;
/** Half the budget: past this a normal jitter spike crosses the line, so it is reported before it does. */
export const CAPABILITIES_WARN_MS = CAPABILITIES_PROBE_TIMEOUT_MS / 2;
/**
 * OWN_INVENTORY_TTL_MS (hub-pool-peer.service.ts:93). Deliberately BELOW the ~30s peer poll, which
 * is why every peer probe rebuilds the inventory from cold and why this module must never measure a
 * warm one. `GET /api/inference/health` and `GET /api/inference/v1/models` both call straight
 * through to `InferenceRouterService`, which caches nothing — so the numbers below are cold by
 * construction, not by timing luck.
 */
export const OWN_INVENTORY_TTL_MS = 20_000;
/** CONNECT_TIMEOUT_MS (hub-pool-proxy.service.ts:28) — how long a peer waits for response HEADERS. */
export const POOL_PROXY_CONNECT_TIMEOUT_MS = 15_000;
/** MIN_PAIR_BY_ADDRESS_PROTOCOL (hub-pool-peer-auth.ts). Below this, pairing by address cannot work. */
export const MIN_PAIR_BY_ADDRESS_PROTOCOL = 2;
/**
 * A name resolution slower than this is a budget problem, not a network hiccup.
 *
 * The failure this threshold exists for takes ~5s: an unresolvable Docker-compose service name
 * fails INSTANTLY under curl but blocks in `getaddrinfo` (EAI_AGAIN) under Node's resolver, which
 * is what the Hub actually uses. Six such lookups is the whole 8s budget on its own.
 */
export const DNS_SLOW_MS = 1_000;
/** Docker's own default when `dns_opt` is absent: 5 attempts x 2s. The number the remediation restores. */
const DNS_ATTEMPTS_REMEDIATION = ['dns_opt:', '  - attempts:5', '  - timeout:2'];

const DEFAULT_API_PORT = 5002;
const DEFAULT_CONTAINER_UID = 1000;
const DEFAULT_CONTAINER_GID = 1000;

/** Local HTTP budgets. Generous: a doctor that times out where the product would not is a false alarm. */
const HUB_PROBE_TIMEOUT_MS = 6_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 20_000;
const PER_BACKEND_TIMEOUT_MS = 12_000;
const DNS_PROBE_TIMEOUT_MS = 15_000;
/** First HTTPS request after `tailscale serve` is enabled blocks on cert issuance. Measured at ~30s. */
const TAILSCALE_SERVE_TIMEOUT_MS = 8_000;
const TAILSCALE_SERVE_RETRY_TIMEOUT_MS = 40_000;
const CLI_TIMEOUT_MS = 10_000;
/** C3 asks an engine to generate. The budget under test is 15s; the probe must outlive it to measure it. */
const NON_STREAMING_PROBE_TIMEOUT_MS = 45_000;

/** Inference backends whose URL the Hub resolves by name on every capabilities build. */
const BACKEND_URL_VARS = [
  { label: 'OLLAMA_URL', vars: ['OLLAMA_URL'] },
  { label: 'VLLM_URL', vars: ['VLLM_URL'] },
  { label: 'LEMONADE_URL', vars: ['LEMONADE_URL'] },
  { label: 'MTPLX_URL', vars: ['MTPLX_URL'] },
  { label: 'DSPARK_URL', vars: ['DSPARK_URL'] },
  // lucebox.backend.ts:161 reads SPECULATIVE_INFERENCE_URL first and falls back to LUCEBOX_URL.
  { label: 'LUCEBOX_URL', vars: ['SPECULATIVE_INFERENCE_URL', 'LUCEBOX_URL'] },
] as const;

/** INFERENCE_BACKEND_TYPES (packages/common/src/types/inference.ts:84), in the order the fan-out builds them. */
const INFERENCE_BACKENDS = ['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Result shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - `ok` / `warn` / `fail` — the check ran and decided.
 * - `unknown` — the check could NOT run (no Docker, no Tailscale, no key). Never counted as an
 *   issue: "I could not look" and "I looked and it is broken" must not share an encoding, or an
 *   unequipped machine reports a fleet-wide outage.
 * - `skipped` — the check was deliberately not run (opt-in, or a precondition made it meaningless).
 */
export type PoolCheckVerdict = 'ok' | 'warn' | 'fail' | 'unknown' | 'skipped';

export interface PoolCheck {
  /** Stable id (`A1`, `C2`) so an operator and a bug report can name the same line. */
  id: string;
  label: string;
  verdict: PoolCheckVerdict;
  detail: string;
  /** Indented lines under the check: breakdowns, and why a failure matters. */
  notes?: string[];
  /** Commands that fix it, surfaced in `remediationCommands` as well as inline. */
  commands?: string[];
}

export interface PoolDoctorSection {
  lines: string[];
  issueCount: number;
  remediationCommands: string[];
}

export interface PoolDoctorOptions {
  /** C3 only. It asks an engine to generate, so it costs GPU time and never runs unasked. */
  checkLatency?: boolean;
  /** Environment label for remediation lines (`cihub up prod`). Cosmetic only. */
  env?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 24;

function renderVerdict(verdict: PoolCheckVerdict, detail: string): string {
  if (verdict === 'ok') return cliOk(detail);
  if (verdict === 'warn') return cliWarn(detail);
  if (verdict === 'fail') return cliFail(detail);
  return colorize(`${STEP_ICONS.pending} ${detail}`, 'dim');
}

export function formatPoolCheckLines(checks: PoolCheck[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`  ${check.id} ${check.label.padEnd(LABEL_WIDTH, ' ')} ${renderVerdict(check.verdict, check.detail)}`);
    for (const note of check.notes ?? []) lines.push(`       ${note}`);
    for (const command of check.commands ?? []) lines.push(`       ${colorize(`$ ${command}`, 'green')}`);
  }
  return lines;
}

/** Issues are decided failures only. See {@link PoolCheckVerdict} for why `unknown` is excluded. */
export function countPoolIssues(checks: PoolCheck[]): number {
  return checks.filter((check) => check.verdict === 'fail' || check.verdict === 'warn').length;
}

export function summarisePoolChecks(checks: PoolCheck[]): string {
  const counts = {
    fail: checks.filter((c) => c.verdict === 'fail').length,
    warn: checks.filter((c) => c.verdict === 'warn').length,
    unknown: checks.filter((c) => c.verdict === 'unknown').length,
    skipped: checks.filter((c) => c.verdict === 'skipped').length,
  };
  const parts = [
    counts.fail > 0 ? `${counts.fail} failed` : '',
    counts.warn > 0 ? `${counts.warn} warned` : '',
    counts.unknown > 0 ? `${counts.unknown} undetermined` : '',
    counts.skipped > 0 ? `${counts.skipped} skipped` : '',
  ].filter(Boolean);
  return parts.length === 0 ? `all ${checks.length} checks passed` : parts.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Probes — none of these throw
// ─────────────────────────────────────────────────────────────────────────────

interface HttpProbe {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string;
  error: string | null;
}

async function timedFetch(url: string, timeoutMs: number, init: RequestInit = {}): Promise<HttpProbe> {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    // Body is drained inside the measurement on purpose for the capability probes: the Hub's peer
    // reads the whole snapshot too, and a response whose headers arrive fast but whose body trickles
    // still blows the peer's budget.
    const body = await response.text();
    return { ok: response.ok, status: response.status, ms: performance.now() - started, body: body.slice(0, 200_000), error: null };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, status: null, ms: performance.now() - started, body: '', error: message };
  }
}

function parseJsonBody<T>(probe: HttpProbe): T | null {
  try {
    return JSON.parse(probe.body) as T;
  } catch {
    return null;
  }
}

function runCli(command: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
    return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
  } catch {
    // spawnSync throws when the binary is missing on some platforms rather than returning ENOENT.
    return { ok: false, stdout: '' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A — can this node be a pool member at all?
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvFoundation {
  envFileName: string;
  exists: boolean;
  apiPort: number | null;
  rootFolderHost: string | null;
  containerUid: number;
  containerGid: number;
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

function parseId(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function readEnvFoundation(envFileName: string): EnvFoundation {
  const resolved = path.isAbsolute(envFileName) ? envFileName : path.join(process.cwd(), envFileName);
  const vars = parseEnvFile(envFileName);
  return {
    envFileName,
    exists: existsSync(resolved),
    apiPort: parsePort(vars.API_PORT),
    rootFolderHost: vars.ROOT_FOLDER_HOST?.trim() ? vars.ROOT_FOLDER_HOST.trim() : null,
    containerUid: parseId(vars.CI_HUB_CONTAINER_UID, DEFAULT_CONTAINER_UID),
    containerGid: parseId(vars.CI_HUB_CONTAINER_GID, DEFAULT_CONTAINER_GID),
  };
}

/**
 * A1 — the env file defines the two variables nothing else can supply.
 *
 * Four fleet nodes shipped with a stub env holding neither, and there is no non-interactive way to
 * write one — so the remediation here is the literal lines to append, not a command that would open
 * a wizard the operator is not sitting in front of.
 */
export function checkEnvFoundation(foundation: EnvFoundation, defaultRootFolderHost: string): PoolCheck {
  const missing: string[] = [];
  if (foundation.apiPort === null) missing.push('API_PORT');
  if (foundation.rootFolderHost === null) missing.push('ROOT_FOLDER_HOST');

  if (!foundation.exists) {
    return {
      id: 'A1',
      label: 'Env file',
      verdict: 'fail',
      detail: `${sanitizeForBox(foundation.envFileName)} does not exist — this node has no configuration to be a pool member with`,
      notes: [
        'Every check below falls back to a default it had to guess. Write the file first.',
        '`cihub wizard` and `cihub setup` write a complete one, but both are interactive; the two',
        'lines below are the non-interactive minimum.',
      ],
      commands: [
        `printf 'API_PORT=%s\\n' ${DEFAULT_API_PORT} >> ${foundation.envFileName}`,
        `printf 'ROOT_FOLDER_HOST=%s\\n' '${defaultRootFolderHost}' >> ${foundation.envFileName}`,
      ],
    };
  }

  if (missing.length > 0) {
    return {
      id: 'A1',
      label: 'Env file',
      verdict: 'fail',
      detail: `${sanitizeForBox(foundation.envFileName)} defines neither of: ${missing.join(', ')}`,
      notes: [
        'A stub env file is the shape four fleet nodes shipped in. Nothing downstream can recover it:',
        'API_PORT is the port peers and the tunnel dial, ROOT_FOLDER_HOST is where the Hub keeps its state.',
      ],
      commands: missing.map((key) =>
        key === 'API_PORT'
          ? `printf 'API_PORT=%s\\n' ${DEFAULT_API_PORT} >> ${foundation.envFileName}`
          : `printf 'ROOT_FOLDER_HOST=%s\\n' '${defaultRootFolderHost}' >> ${foundation.envFileName}`,
      ),
    };
  }

  return {
    id: 'A1',
    label: 'Env file',
    verdict: 'ok',
    detail: `${sanitizeForBox(foundation.envFileName)} — API_PORT=${foundation.apiPort}, ROOT_FOLDER_HOST=${sanitizeForBox(
      foundation.rootFolderHost ?? '',
    )}`,
  };
}

/** A2 — the Hub answers at all. Separated from A3 so "not running" never reads as "no Hub Pool". */
export function checkHubHealth(probe: HttpProbe, base: string, listening: boolean, env: string): PoolCheck {
  if (probe.ok) {
    return { id: 'A2', label: 'Hub API', verdict: 'ok', detail: `${base}/api/health answered 200 in ${Math.round(probe.ms)}ms` };
  }
  if (!listening) {
    return {
      id: 'A2',
      label: 'Hub API',
      verdict: 'fail',
      detail: `nothing is listening on ${base}`,
      notes: ['A node whose Hub is not running is not a pool member, and peers report it as unreachable.'],
      commands: [`cihub up ${env}`],
    };
  }
  return {
    id: 'A2',
    label: 'Hub API',
    verdict: 'fail',
    detail:
      probe.status === null
        ? `${base}/api/health did not answer (${sanitizeForBox(probe.error ?? 'unknown error')})`
        : `${base}/api/health answered ${probe.status}`,
    notes: ['Something holds the port but it is not a healthy Hub — check the container, not the network.'],
    commands: [`cihub logs ${env}`],
  };
}

/**
 * A3 — does this BUILD have Hub Pool, and which protocol.
 *
 * Three outcomes that mean three different things, and collapsing any two of them is how a fleet
 * node sat on protocol 1 for a week with nothing saying so.
 */
export function checkPoolProtocol(probe: HttpProbe, base: string): PoolCheck {
  if (probe.status === 404) {
    return {
      id: 'A3',
      label: 'Hub Pool build',
      verdict: 'fail',
      detail: `${base}/api/inference/pool/identify returned 404 — this build predates Hub Pool`,
      notes: ['There is no pooling on this node at all, and no setting that turns it on.'],
      commands: ['cihub update'],
    };
  }
  if (!probe.ok) {
    return {
      id: 'A3',
      label: 'Hub Pool build',
      verdict: 'unknown',
      detail:
        probe.status === null
          ? `could not reach ${base}/api/inference/pool/identify (${sanitizeForBox(probe.error ?? 'unknown error')})`
          : `${base}/api/inference/pool/identify answered ${probe.status}`,
      notes: ['Cannot tell whether this build has Hub Pool while the Hub is not answering (see A2).'],
    };
  }

  const body = parseJsonBody<{ isCiHub?: boolean; poolProtocol?: number }>(probe);
  if (body === null) {
    return {
      id: 'A3',
      label: 'Hub Pool build',
      verdict: 'unknown',
      detail: '/identify answered 200 with a body this CLI could not parse as JSON',
    };
  }
  if (typeof body.poolProtocol !== 'number') {
    return {
      id: 'A3',
      label: 'Hub Pool build',
      verdict: 'warn',
      detail: '/identify answered 200 but reports no poolProtocol — this node speaks pool protocol 1',
      notes: [
        `Protocol ${MIN_PAIR_BY_ADDRESS_PROTOCOL} is the floor for pairing by address, so a v${MIN_PAIR_BY_ADDRESS_PROTOCOL} peer cannot pair with this node`,
        'by IP at all — only by MagicDNS name, and only if the other side initiates. Nothing in',
        '`pool status` on this node says so.',
      ],
      commands: ['cihub update'],
    };
  }
  if (body.poolProtocol < MIN_PAIR_BY_ADDRESS_PROTOCOL) {
    return {
      id: 'A3',
      label: 'Hub Pool build',
      verdict: 'warn',
      detail: `pool protocol ${body.poolProtocol} — below ${MIN_PAIR_BY_ADDRESS_PROTOCOL}, so pairing by address is impossible`,
      commands: ['cihub update'],
    };
  }
  return { id: 'A3', label: 'Hub Pool build', verdict: 'ok', detail: `pool protocol ${body.poolProtocol}` };
}

export interface DirOwnership {
  name: string;
  present: boolean;
  uid: number | null;
  gid: number | null;
  mode: number | null;
}

/** Can a process running as `uid:gid` write here? Pure, so the truth table is testable without root. */
export function pathWritableBy(entry: DirOwnership, uid: number, gid: number): boolean {
  if (!entry.present || entry.mode === null) return false;
  if (uid === 0) return true;
  if ((entry.mode & 0o002) !== 0) return true;
  if (entry.uid === uid && (entry.mode & 0o200) !== 0) return true;
  if (entry.gid === gid && (entry.mode & 0o020) !== 0) return true;
  return false;
}

export function inspectHubDataDirs(rootFolderHost: string): DirOwnership[] {
  return BIND_MOUNT_DIRS.map((name) => {
    const target = path.join(rootFolderHost, name);
    try {
      const stat = statSync(target);
      return { name, present: true, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    } catch {
      return { name, present: false, uid: null, gid: null, mode: null };
    }
  });
}

/**
 * A4 — the container user can write its own state.
 *
 * This is the one that killed a node outright: Docker created the bind-mount sources as root:root,
 * the Hub died EACCES writing `/data/state/settings.json`, and the operator saw an unhealthy
 * container with no reason attached to it. Checked by stat rather than by running a container, so
 * it still works on a machine with no Docker — which is exactly the machine that has this problem.
 */
export function checkDataDirOwnership(entries: DirOwnership[], rootFolderHost: string, uid: number, gid: number): PoolCheck {
  const missing = entries.filter((entry) => !entry.present);
  const unwritable = entries.filter((entry) => entry.present && !pathWritableBy(entry, uid, gid));

  if (entries.length === 0) {
    return { id: 'A4', label: 'Data dir ownership', verdict: 'unknown', detail: 'no data directories to inspect' };
  }

  if (unwritable.length === 0 && missing.length === 0) {
    return {
      id: 'A4',
      label: 'Data dir ownership',
      verdict: 'ok',
      detail: `all ${entries.length} bind-mount dirs under ${sanitizeForBox(rootFolderHost)} are writable by ${uid}:${gid}`,
    };
  }

  const notes: string[] = [];
  if (unwritable.length > 0) {
    notes.push(
      `Not writable by the container user ${uid}:${gid}: ${unwritable
        .map((entry) => `${entry.name} (${entry.uid}:${entry.gid} ${(entry.mode ?? 0).toString(8).padStart(3, '0')})`)
        .join(', ')}`,
      'The Hub dies EACCES on /data/state/settings.json when state/ is one of these, and the',
      'container just goes unhealthy — nothing in the logs names the directory.',
    );
  }
  if (missing.length > 0) {
    notes.push(
      `Absent, so Docker will create them at compose up: ${missing.map((entry) => entry.name).join(', ')}`,
      'Docker creates a missing bind-mount source as root:root, which is how the above happens.',
    );
  }

  return {
    id: 'A4',
    label: 'Data dir ownership',
    verdict: unwritable.length > 0 ? 'fail' : 'warn',
    detail: `${unwritable.length} unwritable, ${missing.length} absent under ${sanitizeForBox(rootFolderHost)}`,
    notes,
    commands: [`sudo chown -R ${uid}:${gid} ${rootFolderHost}`],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — tailnet reachability. The transport has NO fallback.
// ─────────────────────────────────────────────────────────────────────────────

export interface TailscaleSelf {
  available: boolean;
  backendState: string | null;
  dnsName: string | null;
}

export function parseTailscaleStatus(stdout: string): TailscaleSelf {
  try {
    const parsed = JSON.parse(stdout) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const dnsName = typeof parsed.Self?.DNSName === 'string' ? parsed.Self.DNSName.replace(/\.$/, '') : null;
    return {
      available: true,
      backendState: typeof parsed.BackendState === 'string' ? parsed.BackendState : null,
      dnsName: dnsName && dnsName.length > 0 ? dnsName : null,
    };
  } catch {
    return { available: false, backendState: null, dnsName: null };
  }
}

export function readTailscaleSelf(): TailscaleSelf {
  const result = runCli('tailscale', ['status', '--json']);
  if (!result.ok || result.stdout.length === 0) return { available: false, backendState: null, dnsName: null };
  return parseTailscaleStatus(result.stdout);
}

/** B1 — connected, and named. Peers address this node as `https://<MagicDNS name>` and nothing else. */
export function checkTailnet(self: TailscaleSelf): PoolCheck {
  if (!self.available) {
    return {
      id: 'B1',
      label: 'Tailnet',
      verdict: 'unknown',
      detail: 'the tailscale CLI is not installed or did not answer — cannot determine tailnet state',
      notes: ['Hub Pool has no transport other than the tailnet; without Tailscale this node cannot pool at all.'],
    };
  }
  if (self.backendState !== 'Running') {
    return {
      id: 'B1',
      label: 'Tailnet',
      verdict: 'fail',
      detail: `tailscaled reports ${sanitizeForBox(self.backendState ?? 'no state')} — not connected`,
      commands: ['sudo tailscale up'],
    };
  }
  if (self.dnsName === null) {
    return {
      id: 'B1',
      label: 'Tailnet',
      verdict: 'fail',
      detail: 'connected, but this node has no MagicDNS name',
      notes: [
        'Every peer callback is built as https://<nodeFqdn> with no fallback, so an unnamed node',
        'cannot be reached by any peer regardless of how healthy it is.',
        'Enable MagicDNS for the tailnet in the Tailscale admin console (DNS → MagicDNS).',
      ],
    };
  }
  return { id: 'B1', label: 'Tailnet', verdict: 'ok', detail: `connected as ${sanitizeForBox(self.dnsName)}` };
}

/**
 * B2 — `tailscale serve` is actually publishing, and the cert exists.
 *
 * `tailscale serve` needs an operator grant. Without it the Hub logs "Failed to publish the Hub on
 * the Private VPN" once at boot and then behaves normally forever, while every peer callback —
 * which is hardcoded to `https://<nodeFqdn>` with no plain-HTTP fallback — fails.
 */
/**
 * Whether `tailscale serve` is publishing this node's Hub, read from the local serve config.
 *
 * This is the authoritative signal, and an HTTPS request to our OWN MagicDNS name is not.
 * `tailscale serve` listens for tailnet peers; a request a node makes to its own name does not
 * loop back through it. Measured: `https://<self>/…` answers 200 from a peer and fails outright
 * from the node itself, so a self-probe reports a perfectly healthy node as totally unreachable —
 * and prints a remediation the operator has already applied.
 */
export function readTailscaleServeTarget(apiPort: number): { configured: boolean; publishesHub: boolean; raw: string } {
  const result = spawnSync('tailscale', ['serve', 'status'], { encoding: 'utf8', timeout: 10_000 });
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || raw === '' || /no serve config/i.test(raw)) {
    return { configured: false, publishesHub: false, raw };
  }
  // A published Hub shows the local origin it proxies to, e.g. "|-- proxy http://localhost:5002".
  const publishesHub = new RegExp(`(127\\.0\\.0\\.1|localhost)[:/]${apiPort}\\b`).test(raw);
  return { configured: true, publishesHub, raw };
}

export function checkTailscaleServe(
  probe: HttpProbe | null,
  self: TailscaleSelf,
  apiPort: number,
  retried: boolean,
  serve: { configured: boolean; publishesHub: boolean },
  skipReason?: string,
): PoolCheck {
  const remediation = `sudo tailscale set --operator=$USER && tailscale serve --bg --yes --https=443 http://localhost:${apiPort}`;
  if (self.dnsName === null || probe === null) {
    return {
      id: 'B2',
      label: 'Tailscale serve',
      verdict: 'unknown',
      detail: skipReason ?? 'no MagicDNS name to probe (see B1)',
      ...(skipReason ? { commands: [remediation] } : {}),
    };
  }
  if (probe.ok) {
    return {
      id: 'B2',
      label: 'Tailscale serve',
      verdict: 'ok',
      detail: `https://${sanitizeForBox(self.dnsName)}/ serves /identify in ${Math.round(probe.ms)}ms${retried ? ' (second attempt — the first blocked on cert issuance)' : ''}`,
    };
  }
  if (probe.status !== null) {
    return {
      id: 'B2',
      label: 'Tailscale serve',
      verdict: 'fail',
      detail: `https://${sanitizeForBox(self.dnsName)}/api/inference/pool/identify answered ${probe.status}`,
      notes: ['Something is published at this name, but it is not this Hub. Peers reach that instead.'],
      commands: [remediation],
    };
  }
  // A self-probe cannot reach our own serve listener, so its failure is NOT evidence of a problem.
  // Fall back to the serve config, which is what actually decides whether peers can reach us.
  if (serve.publishesHub) {
    return {
      id: 'B2',
      label: 'Tailscale serve',
      verdict: 'ok',
      detail: `serve publishes http://localhost:${apiPort} on https://${sanitizeForBox(self.dnsName)}/`,
      notes: [
        'Confirmed from the local serve config, not by an HTTPS request: a node cannot reach its own',
        'MagicDNS name through its own serve listener, so a self-probe fails on a healthy node too.',
        'Run `cihub pool doctor` on a PEER to confirm the path end to end.',
      ],
    };
  }
  if (serve.configured) {
    return {
      id: 'B2',
      label: 'Tailscale serve',
      verdict: 'fail',
      detail: `serve is configured but does not publish this Hub's port (${apiPort})`,
      notes: ['Something else is being served at this name; peer callbacks will reach that instead.'],
      commands: [remediation],
    };
  }
  return {
    id: 'B2',
    label: 'Tailscale serve',
    verdict: 'fail',
    detail: 'no `tailscale serve` config on this node',
    notes: [
      'Peer callbacks use https://<nodeFqdn> with NO plain-HTTP fallback, so this is total: no peer',
      'can reach this node, and the Hub reports itself healthy the whole time.',
      '`tailscale serve` needs an operator grant, which is what the first half of the fix below does.',
    ],
    commands: [remediation],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C — peer budget. The most important section.
// ─────────────────────────────────────────────────────────────────────────────

export interface BackendTiming {
  backend: string;
  ms: number;
  ok: boolean;
  detail: string;
}

/**
 * C1 — does a cold capabilities build fit inside the peer's 8s probe budget?
 *
 * Measured at 10.02s on a real node. Every peer probe timed out, the node was marked `unreachable`
 * across the fleet, nothing routed to it — and `cihub pool status` on the node itself said
 * `healthy` throughout, because the node never probes itself.
 *
 * The build is `Promise.all([getStatus(), listModels()])` (hub-pool-peer.service.ts:1110), i.e. TWO
 * concurrent fan-outs across all six backends, so both halves are timed together here rather than
 * one being doubled. Both routes call `InferenceRouterService` with no cache in front, and the
 * inventory TTL is below the peer poll interval, so this is the cold path by construction.
 */
export function checkCapabilityBudget(totalMs: number, halves: string[], perBackend: BackendTiming[], measuredBothHalves: boolean): PoolCheck {
  const rounded = Math.round(totalMs);
  const slowest = [...perBackend].sort((a, b) => b.ms - a.ms)[0];
  const notes = [
    `Budget ${CAPABILITIES_PROBE_TIMEOUT_MS}ms (CAPABILITIES_PROBE_TIMEOUT_MS). Measured cold: the ${OWN_INVENTORY_TTL_MS}ms inventory TTL`,
    'is below the ~30s peer poll, so every real probe rebuilds this from scratch too.',
    ...halves.map((half) => `  ${half}`),
  ];
  if (!measuredBothHalves) {
    notes.push(
      'Only one of the two concurrent fan-outs could be measured on this build, so the real cold',
      'build is at least this slow and probably slower.',
    );
  }
  if (perBackend.length > 0) {
    notes.push(
      'Per backend (each timed on its own so the slow one is named, not averaged away):',
      ...perBackend.map((entry) => `  ${entry.backend.padEnd(10, ' ')} ${String(Math.round(entry.ms)).padStart(6, ' ')}ms  ${entry.detail}`),
    );
  }

  if (totalMs > CAPABILITIES_PROBE_TIMEOUT_MS) {
    return {
      id: 'C1',
      label: 'Capabilities budget',
      verdict: 'fail',
      detail: `cold capabilities build took ${rounded}ms — OVER the ${CAPABILITIES_PROBE_TIMEOUT_MS}ms peer probe budget`,
      notes: [
        ...notes,
        'Every peer probe of this node times out. It goes `unreachable` fleet-wide, nothing routes to',
        'it, and it keeps reporting itself healthy to its own operator.',
        ...(slowest ? [`Start with ${slowest.backend} at ${Math.round(slowest.ms)}ms, then check C2 — a blocked DNS lookup lands here.`] : []),
      ],
    };
  }
  if (totalMs >= CAPABILITIES_WARN_MS) {
    return {
      id: 'C1',
      label: 'Capabilities budget',
      verdict: 'warn',
      detail: `cold capabilities build took ${rounded}ms — inside ${CAPABILITIES_PROBE_TIMEOUT_MS}ms but under 2x margin`,
      notes: [...notes, `Under ${CAPABILITIES_WARN_MS}ms is the margin worth holding; a load spike from here crosses the budget.`],
    };
  }
  return {
    id: 'C1',
    label: 'Capabilities budget',
    verdict: 'ok',
    detail: `cold capabilities build took ${rounded}ms of the ${CAPABILITIES_PROBE_TIMEOUT_MS}ms budget`,
    notes,
  };
}

export interface BackendUrlSpec {
  label: string;
  variable: string;
  url: string;
  hostname: string | null;
  isIpLiteral: boolean;
  malformed: boolean;
}

/** Hostnames safe to embed in an injected probe script. Anything else is reported, never executed. */
const SAFE_HOSTNAME = /^[A-Za-z0-9._-]{1,253}$/;

/**
 * The Hub container's own environment, which is the authority on where its backends are.
 *
 * Reading the env FILE is not enough and was the original defect here: `docker-compose.prod.yml`
 * sets OLLAMA_URL/VLLM_URL/MTPLX_URL/DSPARK_URL/LEMONADE_URL in the service's `environment:` block,
 * so on a compose install the file has none of them and the container has all of them. A check that
 * read only the file reported "no backend URLs configured" on a node running six backends — exactly
 * inverting the finding it exists to make.
 */
export function readBackendVarsFromContainer(): Record<string, string> | null {
  const container = resolveHubContainerName();
  if (!container) return null;
  const wanted = new Set(BACKEND_URL_VARS.flatMap((entry) => entry.vars));
  const result = spawnSync('docker', ['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const vars: Record<string, string> = {};
  for (const line of (result.stdout ?? '').split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    // Only the backend URL vars. Everything else in that block is secrets we must never read in.
    if (wanted.has(name)) vars[name] = line.slice(eq + 1).trim();
  }
  return vars;
}

export function resolveBackendUrlSpecs(vars: Record<string, string>): BackendUrlSpec[] {
  const specs: BackendUrlSpec[] = [];
  for (const entry of BACKEND_URL_VARS) {
    const variable = entry.vars.find((name) => vars[name]?.trim());
    if (!variable) continue;
    const url = (vars[variable] ?? '').trim();
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
      specs.push({ label: entry.label, variable, url, hostname, isIpLiteral, malformed: false });
    } catch {
      specs.push({ label: entry.label, variable, url, hostname: null, isIpLiteral: false, malformed: true });
    }
  }
  return specs;
}

export interface DnsProbeResult {
  host: string;
  ms: number;
  code: string | null;
}

/** Where the measurement was taken. The container is authoritative; the host cannot see compose DNS. */
export type DnsVantage = 'container' | 'host';

/** Where the backend URL values came from. Compose sets them on the container, not in the env file. */
export type BackendVarsSource = 'container' | 'file';

function dnsProbeScript(hosts: string[]): string {
  return (
    `const dns=require('dns');const hs=${JSON.stringify(hosts)};const out=[];` +
    '(async()=>{for(const h of hs){const t=Date.now();' +
    'const r=await new Promise(res=>dns.lookup(h,(e)=>res({ms:Date.now()-t,code:e?(e.code||"ERROR"):null})));' +
    'out.push({host:h,ms:r.ms,code:r.code});}' +
    'process.stdout.write(JSON.stringify(out));})();'
  );
}

/**
 * Resolve each hostname the way the Hub does, and time it.
 *
 * `dns.lookup` / getaddrinfo, deliberately — NOT curl and NOT getent. An unresolvable
 * Docker-compose service name fails instantly under curl and blocks ~5s under Node's resolver, so a
 * curl-based check cannot see this bug at all. It is the reason the whole 8s budget disappears with
 * no backend being slow.
 */
export function probeDnsFromContainer(hosts: string[]): DnsProbeResult[] | null {
  const container = resolveHubContainerName();
  if (!container) return null;
  const result = spawnSync('docker', ['exec', container, 'node', '-e', dnsProbeScript(hosts)], {
    encoding: 'utf8',
    timeout: DNS_PROBE_TIMEOUT_MS * Math.max(hosts.length, 1) + 10_000,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse((result.stdout ?? '').trim()) as DnsProbeResult[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function probeDnsFromHost(hosts: string[]): Promise<DnsProbeResult[]> {
  const results: DnsProbeResult[] = [];
  for (const host of hosts) {
    const started = Date.now();
    const code = await new Promise<string | null>((resolve) => {
      dns.lookup(host, (error) => resolve(error ? (error.code ?? 'ERROR') : null));
    });
    results.push({ host, ms: Date.now() - started, code });
  }
  return results;
}

/**
 * C2 — every configured backend URL resolves, and resolves fast.
 *
 * From the container when one is running, because that is the only vantage that can tell a
 * compose-internal name from a broken one. From the host otherwise — where a fast failure is
 * genuinely undecidable (it may resolve inside the container), but a SLOW one is the defect itself
 * and is reported as such regardless of vantage: a lookup that blocks costs the budget wherever it
 * is measured.
 */
export function checkBackendDns(
  specs: BackendUrlSpec[],
  results: DnsProbeResult[],
  vantage: DnsVantage,
  varsSource: BackendVarsSource = 'file',
): PoolCheck {
  if (specs.length === 0) {
    return {
      id: 'C2',
      label: 'Backend DNS',
      verdict: 'ok',
      detail:
        varsSource === 'container'
          ? 'the Hub container has no backend URLs set, so the capabilities build resolves nothing'
          : 'no backend URLs in the env file, and no Hub container to read the compose environment from',
    };
  }

  const byHost = new Map(results.map((result) => [result.host, result]));
  const notes: string[] = [];
  let failures = 0;
  let undecided = 0;

  for (const spec of specs) {
    if (spec.malformed) {
      failures += 1;
      notes.push(`${spec.variable.padEnd(26, ' ')} ${cliFail(`not a URL: ${sanitizeForBox(spec.url)}`)}`);
      continue;
    }
    if (spec.isIpLiteral) {
      notes.push(`${spec.variable.padEnd(26, ' ')} ${cliOk(`${sanitizeForBox(spec.hostname ?? '')} — IP literal, no lookup`)}`);
      continue;
    }
    const host = spec.hostname ?? '';
    const result = byHost.get(host);
    if (!result) {
      undecided += 1;
      notes.push(`${spec.variable.padEnd(26, ' ')} ${colorize(`${sanitizeForBox(host)} — not probed`, 'dim')}`);
      continue;
    }
    const label = `${sanitizeForBox(host)} ${result.ms}ms`;
    if (result.code === null && result.ms < DNS_SLOW_MS) {
      notes.push(`${spec.variable.padEnd(26, ' ')} ${cliOk(`${label} — resolves`)}`);
      continue;
    }
    if (result.ms >= DNS_SLOW_MS) {
      failures += 1;
      notes.push(
        `${spec.variable.padEnd(26, ' ')} ${cliFail(`${label} — ${result.code === null ? 'resolves, but blocks' : `blocks then fails ${result.code}`}`)}`,
      );
      continue;
    }
    if (vantage === 'container') {
      failures += 1;
      notes.push(`${spec.variable.padEnd(26, ' ')} ${cliWarn(`${label} — ${result.code}, the name does not exist`)}`);
      continue;
    }
    undecided += 1;
    notes.push(`${spec.variable.padEnd(26, ' ')} ${colorize(`${label} — ${result.code} from the host; undecidable here`, 'dim')}`);
  }

  notes.push(
    ...(vantage === 'container'
      ? [
          'Measured inside the Hub container with dns.lookup — the resolver and the vantage the Hub itself uses.',
          varsSource === 'container'
            ? 'URLs read from the container environment, where compose actually sets them.'
            : 'URLs read from the env file: the Hub container reported none, so compose may not set them here.',
        ]
      : [
          'Measured on the HOST with dns.lookup: there is no Hub container to probe from.',
          'A name that fails FAST here may still resolve inside the container, so those are undecidable.',
          'A lookup that BLOCKS is reported either way — it costs the budget from any vantage.',
        ]),
  );

  if (failures === 0) {
    return {
      id: 'C2',
      label: 'Backend DNS',
      verdict: undecided > 0 ? 'unknown' : 'ok',
      detail:
        undecided > 0
          ? `${specs.length} backend URL(s): none blocking, ${undecided} undecidable from this vantage`
          : `${specs.length} backend URL(s) all resolve under ${DNS_SLOW_MS}ms`,
      notes,
    };
  }

  return {
    id: 'C2',
    label: 'Backend DNS',
    verdict: 'fail',
    detail: `${failures} of ${specs.length} backend URL(s) do not resolve cleanly`,
    notes: [
      ...notes,
      '',
      `Each blocked lookup is spent inside the ${CAPABILITIES_PROBE_TIMEOUT_MS}ms capabilities budget (C1). Two of them is the whole budget.`,
      'Fix both halves:',
      '  1. Point the variable at a real address, or at a closed port so it fails instantly',
      '     e.g. MTPLX_URL=http://127.0.0.1:1  (a refusal is instant; an unresolvable name is not)',
      '  2. Bound the container resolver, on the `hub` service in docker-compose.prod.yml:',
      ...DNS_ATTEMPTS_REMEDIATION.map((line) => `       ${line}`),
      '     This repo’s docker-compose.prod.yml already has both; appliance installs seeded before it do not.',
    ],
  };
}

/** Parameter count in billions, read off a model id (`gemma3:27b` → 27). Used only to pick the heaviest. */
export function modelParameterBillions(id: string): number {
  const match = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id.replace(/[:_/-]/g, ' '));
  return match?.[1] ? Number(match[1]) : 0;
}

export interface LoadedModel {
  id: string;
  state?: string;
  local?: boolean;
  backend?: string;
}

/** The heaviest model currently held by an engine — the one that actually exercises the 15s budget. */
export function pickLargestLoadedModel(models: LoadedModel[]): LoadedModel | null {
  const loaded = models.filter((model) => model.local !== false && model.state !== 'available' && typeof model.id === 'string');
  if (loaded.length === 0) return null;
  return [...loaded].sort((a, b) => modelParameterBillions(b.id) - modelParameterBillions(a.id) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * C3 — non-streaming headroom against the 15s peer connect timeout.
 *
 * A warm 27B model could not return HEADERS inside 15s non-streaming while the identical streaming
 * request answered in ~1s: the engine buffers the whole completion before the first byte, and the
 * peer's `CONNECT_TIMEOUT_MS` fires on headers, not on the body.
 *
 * Opt-in, because it asks an engine to generate.
 */
export function checkNonStreamingHeadroom(
  probe: HttpProbe | null,
  model: LoadedModel | null,
  attribution: { pooled: boolean; servedBy: string | null },
  skipReason = 'skipped — spends GPU time; re-run with --check-latency',
): PoolCheck {
  if (probe === null || model === null) {
    return {
      id: 'C3',
      label: 'Non-streaming headroom',
      verdict: 'skipped',
      detail: skipReason,
      notes: [
        `Would measure first-byte latency of a non-streaming completion against the ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms`,
        'peer connect timeout (hub-pool-proxy.service.ts:28), which fires on HEADERS, not on the body.',
      ],
    };
  }

  const rounded = Math.round(probe.ms);
  const base = `${sanitizeForBox(model.id)} answered headers in ${rounded}ms`;

  if (attribution.pooled && attribution.servedBy !== 'local') {
    return {
      id: 'C3',
      label: 'Non-streaming headroom',
      verdict: 'unknown',
      detail: `${base}, but this node has connected peers so the request may have been pooled`,
      notes: [
        `Served by: ${sanitizeForBox(attribution.servedBy ?? 'could not be determined from the routing log')}.`,
        'The figure is not attributable to this node. Re-run with the pool disabled to measure it,',
        'or read `cihub pool log --limit 1` to see where it went.',
      ],
    };
  }

  if (!probe.ok) {
    return {
      id: 'C3',
      label: 'Non-streaming headroom',
      verdict: 'fail',
      detail:
        probe.status === null
          ? `no headers for ${sanitizeForBox(model.id)} after ${rounded}ms (${sanitizeForBox(probe.error ?? 'unknown error')})`
          : `${sanitizeForBox(model.id)} answered ${probe.status} after ${rounded}ms`,
      notes: [`A peer abandons this hop at ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms.`],
    };
  }

  if (probe.ms > POOL_PROXY_CONNECT_TIMEOUT_MS) {
    return {
      id: 'C3',
      label: 'Non-streaming headroom',
      verdict: 'fail',
      detail: `${base} — OVER the ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms peer connect timeout`,
      notes: [
        'A peer forwarding a non-streaming request for this model gives up before the headers arrive,',
        'even though the identical streaming request answers in about a second — the engine buffers',
        'the whole completion first, and the timeout fires on headers.',
        'Prefer streaming for this model, or serve it from a node that answers faster.',
      ],
    };
  }

  if (probe.ms >= POOL_PROXY_CONNECT_TIMEOUT_MS / 2) {
    return {
      id: 'C3',
      label: 'Non-streaming headroom',
      verdict: 'warn',
      detail: `${base} — inside ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms but under 2x margin`,
    };
  }

  return { id: 'C3', label: 'Non-streaming headroom', verdict: 'ok', detail: `${base}, well inside ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

async function collectSectionA(
  foundation: EnvFoundation,
  base: string,
  apiPort: number,
  env: string,
): Promise<{ checks: PoolCheck[]; health: HttpProbe }> {
  const defaultRoot = resolveRootFolderHost(foundation.envFileName);
  const checks: PoolCheck[] = [checkEnvFoundation(foundation, defaultRoot)];

  const listening = await probeHostPort(apiPort);
  const health = await timedFetch(`${base}/api/health`, HUB_PROBE_TIMEOUT_MS);
  checks.push(checkHubHealth(health, base, listening, env));

  const identify = await timedFetch(`${base}/api/inference/pool/identify`, HUB_PROBE_TIMEOUT_MS);
  checks.push(checkPoolProtocol(identify, base));

  const root = foundation.rootFolderHost ?? defaultRoot;
  if (existsSync(root)) {
    checks.push(checkDataDirOwnership(inspectHubDataDirs(root), root, foundation.containerUid, foundation.containerGid));
  } else {
    checks.push({
      id: 'A4',
      label: 'Data dir ownership',
      verdict: 'warn',
      detail: `${sanitizeForBox(root)} does not exist yet`,
      notes: [
        'Docker creates every missing bind-mount source as root:root at compose up, which is exactly',
        'the failure this check exists for. Create the tree first, owned by the container user.',
      ],
      commands: [`mkdir -p ${root} && sudo chown -R ${foundation.containerUid}:${foundation.containerGid} ${root}`],
    });
  }

  return { checks, health };
}

async function collectSectionB(apiPort: number, hubAnswering: boolean): Promise<PoolCheck[]> {
  const self = readTailscaleSelf();
  const checks: PoolCheck[] = [checkTailnet(self)];

  if (self.dnsName === null) {
    checks.push(checkTailscaleServe(null, self, apiPort, false, readTailscaleServeTarget(apiPort)));
    return checks;
  }
  // `tailscale serve` proxies to http://localhost:<API_PORT>. With nothing behind that port there is
  // no publishing to verify, and probing anyway spends the retry budget (up to ~48s waiting out a
  // cert that will never be needed) to report a failure the operator already saw as A2.
  if (!hubAnswering) {
    checks.push(
      checkTailscaleServe(
        null,
        self,
        apiPort,
        false,
        readTailscaleServeTarget(apiPort),
        'not probed — the Hub is not answering locally (see A2), so serve has nothing to publish',
      ),
    );
    return checks;
  }

  const url = `https://${self.dnsName}/api/inference/pool/identify`;
  let probe = await timedFetch(url, TAILSCALE_SERVE_TIMEOUT_MS);
  let retried = false;
  // The first HTTPS request after serve is enabled blocks on cert issuance (~30s measured). One
  // retry, because reporting that as a hard failure sends the operator to fix something that works.
  if (!probe.ok && probe.status === null) {
    retried = true;
    probe = await timedFetch(url, TAILSCALE_SERVE_RETRY_TIMEOUT_MS);
  }
  checks.push(checkTailscaleServe(probe, self, apiPort, retried, readTailscaleServeTarget(apiPort)));
  return checks;
}

async function measurePerBackend(base: string, apiKey: string | undefined): Promise<BackendTiming[]> {
  if (!apiKey) return [];
  const timings: BackendTiming[] = [];
  // Sequential on purpose: run in parallel and a shared bottleneck is charged to whichever backend
  // happens to finish last, which is the opposite of naming the slow one.
  for (const backend of INFERENCE_BACKENDS) {
    const probe = await timedFetch(`${base}/api/inference/models/runtime?backend=${backend}`, PER_BACKEND_TIMEOUT_MS, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = parseJsonBody<{ discoveryUnavailable?: boolean; models?: unknown[] }>(probe);
    const detail = probe.ok
      ? body?.discoveryUnavailable
        ? 'not running'
        : `${body?.models?.length ?? 0} model(s)`
      : probe.status === null
        ? sanitizeForBox(probe.error ?? 'no answer')
        : `HTTP ${probe.status}`;
    timings.push({ backend, ms: probe.ms, ok: probe.ok, detail });
  }
  return timings;
}

/**
 * Time one COLD capabilities build.
 *
 * `getOwnInventory` awaits `Promise.all([getStatus(), listModels()])`, so the real build pays for
 * TWO concurrent fan-outs across all six backends, not one — measuring a single route under-reports
 * exactly the node that is about to fall out of the fleet.
 *
 * `GET /api/inference/v1/models` is the second half, but appliance builds predating that route 404
 * instantly, which measures no concurrency at all. When that happens the pair is re-measured as two
 * concurrent `getStatus()` calls: a slightly pessimistic stand-in (it repeats the model merge as
 * well as the probe) and an honest one, rather than reporting half a number as if it were whole.
 */
async function measureColdCapabilityBuild(
  base: string,
): Promise<{ totalMs: number; halves: string[]; statusProbe: HttpProbe; measuredBothHalves: boolean }> {
  const health = () => timedFetch(`${base}/api/inference/health`, CAPABILITY_PROBE_TIMEOUT_MS);

  const started = performance.now();
  const [statusProbe, modelsProbe] = await Promise.all([health(), timedFetch(`${base}/api/inference/v1/models`, CAPABILITY_PROBE_TIMEOUT_MS)]);
  const totalMs = performance.now() - started;

  if (modelsProbe.ok || !statusProbe.ok) {
    return {
      totalMs,
      statusProbe,
      measuredBothHalves: modelsProbe.ok,
      halves: [
        `getStatus()  /api/inference/health      ${Math.round(statusProbe.ms)}ms`,
        `listModels() /api/inference/v1/models   ${modelsProbe.ok ? `${Math.round(modelsProbe.ms)}ms` : `HTTP ${modelsProbe.status ?? 'no answer'}`}`,
      ],
    };
  }

  const retryStarted = performance.now();
  const [first, second] = await Promise.all([health(), health()]);
  const retryTotalMs = performance.now() - retryStarted;
  return {
    totalMs: retryTotalMs,
    statusProbe: first,
    measuredBothHalves: true,
    halves: [
      `getStatus()  /api/inference/health      ${Math.round(first.ms)}ms`,
      `getStatus()  /api/inference/health      ${Math.round(second.ms)}ms  (stand-in for listModels(): this build has no /v1/models route)`,
    ],
  };
}

async function collectSectionC(base: string, envFileName: string, apiKey: string | undefined, options: PoolDoctorOptions): Promise<PoolCheck[]> {
  const checks: PoolCheck[] = [];

  const { totalMs, halves, statusProbe, measuredBothHalves } = await measureColdCapabilityBuild(base);

  if (statusProbe.ok) {
    const perBackend = await measurePerBackend(base, apiKey);
    const budget = checkCapabilityBudget(totalMs, halves, perBackend, measuredBothHalves);
    if (perBackend.length === 0) {
      budget.notes = [
        ...(budget.notes ?? []),
        'Per-backend breakdown needs the operator key from <ROOT_FOLDER_HOST>/state/settings.json.',
        'None was found, so the slow backend cannot be named here. Pair the Hub: cihub register',
      ];
    }
    checks.push(budget);
  } else {
    checks.push({
      id: 'C1',
      label: 'Capabilities budget',
      verdict: 'unknown',
      detail:
        statusProbe.status === null
          ? `could not time a capabilities build (${sanitizeForBox(statusProbe.error ?? 'no answer')})`
          : `/api/inference/health answered ${statusProbe.status}`,
      notes: ['The Hub has to be answering for this to mean anything — see A2.'],
    });
  }

  // Container first: compose puts these in the service `environment:` block, not the env file.
  const containerVars = readBackendVarsFromContainer();
  const fileVars = parseEnvFile(envFileName);
  const varsSource: BackendVarsSource = containerVars && Object.keys(containerVars).length > 0 ? 'container' : 'file';
  const vars = varsSource === 'container' ? ({ ...fileVars, ...containerVars } as Record<string, string>) : fileVars;
  const specs = resolveBackendUrlSpecs(vars);
  const hosts = [...new Set(specs.filter((spec) => !spec.malformed && !spec.isIpLiteral && spec.hostname).map((spec) => spec.hostname as string))];
  const safeHosts = hosts.filter((host) => SAFE_HOSTNAME.test(host));
  let vantage: DnsVantage = 'host';
  let results: DnsProbeResult[] = [];
  if (safeHosts.length > 0) {
    const fromContainer = isHubContainerRunning() ? probeDnsFromContainer(safeHosts) : null;
    if (fromContainer) {
      vantage = 'container';
      results = fromContainer;
    } else {
      results = await probeDnsFromHost(safeHosts);
    }
  }
  checks.push(checkBackendDns(specs, results, vantage, varsSource));

  checks.push(await collectNonStreamingCheck(base, apiKey, options));
  return checks;
}

async function collectNonStreamingCheck(base: string, apiKey: string | undefined, options: PoolDoctorOptions): Promise<PoolCheck> {
  if (!options.checkLatency) {
    return checkNonStreamingHeadroom(null, null, { pooled: false, servedBy: null });
  }

  const modelsProbe = await timedFetch(`${base}/api/inference/v1/models`, CAPABILITY_PROBE_TIMEOUT_MS);
  const body = parseJsonBody<{ data?: LoadedModel[] }>(modelsProbe);
  const model = pickLargestLoadedModel(body?.data ?? []);
  if (!model) {
    return checkNonStreamingHeadroom(
      null,
      null,
      { pooled: false, servedBy: null },
      modelsProbe.ok ? 'skipped — no loaded model to measure against' : 'skipped — could not list models to pick one (see A2)',
    );
  }

  // Whether the answer can be attributed to THIS node has to be known before the number is
  // believed: /v1/chat/completions auto-upgrades to pooled routing when any peer is connected.
  const pooled = await hasConnectedPeers(base, apiKey);

  const probe = await timedFetch(`${base}/api/inference/v1/chat/completions`, NON_STREAMING_PROBE_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
  });

  const servedBy = pooled ? await lastRoutedNode(base, apiKey) : 'local';
  return checkNonStreamingHeadroom(probe, model, { pooled, servedBy });
}

async function hasConnectedPeers(base: string, apiKey: string | undefined): Promise<boolean> {
  if (!apiKey) return false;
  const probe = await timedFetch(`${base}/api/inference/pool/status`, HUB_PROBE_TIMEOUT_MS, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = parseJsonBody<{ peerCounts?: { connected?: number } }>(probe);
  return (body?.peerCounts?.connected ?? 0) > 0;
}

async function lastRoutedNode(base: string, apiKey: string | undefined): Promise<string | null> {
  if (!apiKey) return null;
  const probe = await timedFetch(`${base}/api/inference/pool/routing-log?limit=1`, HUB_PROBE_TIMEOUT_MS, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = parseJsonBody<{ entries?: { node?: string | null }[] }>(probe);
  return body?.entries?.[0]?.node ?? null;
}

/**
 * Run the Hub Pool preflight.
 *
 * Never throws: the outer catch mirrors `runBridgeDoctorSection`, and every individual check
 * degrades to an `unknown` verdict rather than aborting the run. On a machine with no Docker, no
 * Tailscale and no Hub this still produces a full report — that machine is the one being set up.
 */
export async function runPoolDoctorSection(envFileName: string, options: PoolDoctorOptions = {}): Promise<PoolDoctorSection> {
  try {
    return await collectPoolDoctorSection(envFileName, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { lines: [`Hub Pool preflight       unavailable (${sanitizeForBox(message)})`], issueCount: 0, remediationCommands: [] };
  }
}

async function collectPoolDoctorSection(envFileName: string, options: PoolDoctorOptions): Promise<PoolDoctorSection> {
  const env = options.env ?? 'prod';
  const foundation = readEnvFoundation(envFileName);
  const apiPort = foundation.apiPort ?? DEFAULT_API_PORT;
  const base = `http://127.0.0.1:${apiPort}`;
  // Read, never printed. Reaching an authenticated route with it is fine; disclosing it is not.
  const apiKey = readHubApiKey(envFileName);

  const sectionA = await collectSectionA(foundation, base, apiPort, env);
  const sectionB = await collectSectionB(apiPort, sectionA.health.ok);
  const sectionC = await collectSectionC(base, envFileName, apiKey, options);
  // Section D is the existing bridge module, unchanged: it already probes from inside the container
  // (the only vantage where a filtered bridge is visible) and already derives the ufw rule.
  const bridge = await runBridgeDoctorSection(envFileName);

  const checks = [...sectionA.checks, ...sectionB, ...sectionC];
  const issueCount = countPoolIssues(checks) + bridge.issueCount;
  const remediationCommands = [...checks.flatMap((check) => check.commands ?? []), ...bridge.remediationCommands];

  const lines = [
    `Hub Pool preflight       ${summarisePoolChecks(checks)}`,
    ...(foundation.apiPort === null ? [dim(`  API_PORT was not set, so every probe above used the default ${DEFAULT_API_PORT}.`)] : []),
    '',
    dim('A  Can this node be a pool member at all?'),
    ...formatPoolCheckLines(sectionA.checks),
    '',
    dim('B  Tailnet reachability — the transport peers use, which has no fallback'),
    ...formatPoolCheckLines(sectionB),
    '',
    dim('C  Peer budget — what a peer measures before it decides this node is unreachable'),
    ...formatPoolCheckLines(sectionC),
    '',
    dim("D  Host bridge — the Hub container's path to host inference backends"),
    ...bridge.lines.map((line) => `  ${line}`),
  ];

  return { lines, issueCount, remediationCommands };
}
