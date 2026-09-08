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
 * or edits config. The one check that spends anything (GPU time, D3) is opt-in and reports itself
 * as skipped otherwise.
 *
 * Secrets: the operator key is read from `state/settings.json` to reach authenticated routes and is
 * never printed. Neither is a PIN, a peer token, or any `TAILSCALE_OAUTH_*` value — no check here
 * reads one.
 */
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHubContainerRunning, probeHostPort, resolveHubContainerName, runBridgeDoctorSection } from './bridge-diagnostics-cli';
import { parseEnvFile } from './env-file';
import { BIND_MOUNT_DIRS } from './lib/bind-mounts';
import { cliFail, cliOk, colorize, dim, sanitizeForBox, STEP_ICONS, type Tone } from './lib/cli-ui';
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
/** D3 asks an engine to generate. The budget under test is 15s; the probe must outlive it to measure it. */
const NON_STREAMING_PROBE_TIMEOUT_MS = 45_000;
/**
 * How many tokens D3 asks for.
 *
 * The defect D3 exists to catch is an engine that buffers the WHOLE completion before the first
 * byte, so the size of that completion is the measurement. `max_tokens: 1` leaves one token to
 * buffer: the node that failed in production with a real completion answers that probe promptly and
 * D3 prints ok — the check passing on the broken node. A few hundred tokens is what a pooled
 * request actually carries, and is what makes the printed number mean what the line says it means.
 */
const NON_STREAMING_PROBE_MAX_TOKENS = 256;

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
  /** D3 only. It asks an engine to generate, so it costs GPU time and never runs unasked. */
  checkLatency?: boolean;
  /** Environment label for remediation lines (`cihub up prod`). Cosmetic only. */
  env?: string;
  /**
   * Called as each section lands, with the elapsed milliseconds so far.
   *
   * A long run otherwise shows nothing at all until the very end — the caller cannot render its box
   * until the last probe returns — and a frozen terminal on a broken node invites the Ctrl-C that
   * cancels the diagnosis. Whether to print is the caller's call: it knows if anyone is watching.
   */
  onSectionDone?: (line: string, elapsedMs: number) => void;
  /**
   * B4 only: the `pool` subcommands THIS CLI build supports.
   *
   * Passed in rather than imported, because `cli-pool.ts` — where `POOL_SUBCOMMANDS` lives — already
   * imports this module, and reaching back for it would close the cycle. Omitted, B4 says it could
   * not determine rather than guessing at a list.
   */
  cliSubcommands?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const LABEL_WIDTH = 24;

/**
 * One glyph per verdict, and five different ones.
 *
 * `colorize` no-ops the moment stdout is not a TTY (cli-ui.ts), which is the normal case for a
 * report that is piped, redirected or pasted into a bug — i.e. every time this output travels. When
 * warn and unknown differ only by colour, they become the same byte sequence exactly then, and the
 * distinction the whole five-verdict split exists to keep ("I could not look" is not "it is broken")
 * disappears in the one place it is being read. Measured before this: A4 (warn) and C2 (unknown)
 * rendered as the identical bare circle.
 */
const VERDICT_GLYPHS: Record<PoolCheckVerdict, string> = {
  ok: STEP_ICONS.done,
  warn: '!',
  fail: STEP_ICONS.fail,
  unknown: '?',
  skipped: '-',
};

const VERDICT_TONES: Record<PoolCheckVerdict, Tone> = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
  unknown: 'dim',
  skipped: 'dim',
};

function renderVerdict(verdict: PoolCheckVerdict, detail: string): string {
  return colorize(`${VERDICT_GLYPHS[verdict]} ${detail}`, VERDICT_TONES[verdict]);
}

/** A warn inside a note block, wearing the same glyph the verdict column uses. */
function poolWarn(text: string): string {
  return colorize(`${VERDICT_GLYPHS.warn} ${text}`, VERDICT_TONES.warn);
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

export interface HttpProbe {
  ok: boolean;
  status: number | null;
  ms: number;
  body: string;
  error: string | null;
}

/** The one probe primitive, injectable so the timing code that uses it can be tested without a Hub. */
export type TimedFetch = (url: string, timeoutMs: number, init?: RequestInit) => Promise<HttpProbe>;

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
  /**
   * `stat` failed for a reason that is not absence — EACCES on the parent, EPERM, a symlink loop.
   *
   * Separate from `present` on purpose. Collapsing the two makes an unreadable tree look like a
   * missing one, and A4's remediation is a RECURSIVE chown: printing it for a directory whose state
   * was never observed hands the operator a destructive command based on nothing.
   */
  unreadable: boolean;
  uid: number | null;
  gid: number | null;
  mode: number | null;
}

/** `stat` errors that mean "I was not allowed to look", as opposed to "it is not there". */
const UNREADABLE_STAT_CODES = new Set(['EACCES', 'EPERM', 'ELOOP']);

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
      return { name, present: true, unreadable: false, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    } catch (error) {
      // ENOENT is a finding (Docker will create it root:root); EACCES is not — it is this process
      // being unable to look, and the two must not arrive at the same verdict.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return { name, present: false, unreadable: UNREADABLE_STAT_CODES.has(code ?? ''), uid: null, gid: null, mode: null };
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
  const unreadable = entries.filter((entry) => entry.unreadable);
  const missing = entries.filter((entry) => !entry.present && !entry.unreadable);
  const unwritable = entries.filter((entry) => entry.present && !pathWritableBy(entry, uid, gid));

  if (entries.length === 0) {
    return { id: 'A4', label: 'Data dir ownership', verdict: 'unknown', detail: 'no data directories to inspect' };
  }

  // Nothing under the root could be stat'ed. Those directories may be present and perfectly owned;
  // this process simply was not allowed to look, and there is no verdict to reach from that.
  if (unreadable.length === entries.length) {
    return {
      id: 'A4',
      label: 'Data dir ownership',
      verdict: 'unknown',
      detail: `cannot determine: none of the ${entries.length} bind-mount dirs under ${sanitizeForBox(rootFolderHost)} could be read`,
      notes: [
        '`stat` was refused on every one of them, so whether they exist and who owns them is unknown.',
        'Re-run as a user that can read that tree. No ownership fix is printed here on purpose: a',
        'recursive chown of a directory whose contents were never observed is not a repair, it is a',
        'guess with consequences.',
      ],
    };
  }

  if (unwritable.length === 0 && missing.length === 0 && unreadable.length === 0) {
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
  if (unreadable.length > 0) {
    notes.push(
      `Could not be read at all, so nothing is claimed about them: ${unreadable.map((entry) => entry.name).join(', ')}`,
      'A `stat` refused is not a directory missing. The whole-tree chown is withheld for that reason;',
      'only directories actually observed as unwritable are named below.',
    );
  }

  // The recursive chown is the measured fix, but only where every directory under the root was
  // seen. With even one unreadable entry it becomes `chown -R` over a tree this run never read, so
  // the fix narrows to exactly the directories observed to be wrong — and to none at all when the
  // only finding is absence, which `cihub up` handles.
  const commands =
    unreadable.length === 0
      ? [`sudo chown -R ${uid}:${gid} ${rootFolderHost}`]
      : unwritable.map((entry) => `sudo chown -R ${uid}:${gid} ${path.join(rootFolderHost, entry.name)}`);

  return {
    id: 'A4',
    label: 'Data dir ownership',
    // Decided findings keep their severity even when part of the tree was unreadable; `unknown` is
    // reserved for a run whose ONLY observation was that it could not look.
    verdict: unwritable.length > 0 ? 'fail' : missing.length > 0 ? 'warn' : 'unknown',
    detail: `${unwritable.length} unwritable, ${missing.length} absent${unreadable.length > 0 ? `, ${unreadable.length} unreadable` : ''} under ${sanitizeForBox(rootFolderHost)}`,
    notes,
    ...(commands.length > 0 ? { commands } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — version reconciliation.
//
// A node is four independently-updatable things — a checkout, an image, a compose file and a CLI —
// and nothing on it compared any two of them. Every check here is a skew that a 7-node rollout hit
// while each node reported itself healthy: a July checkout driving a dev-tip container, a node whose
// `git fetch` had been failing for two months reporting itself 0 commits behind, a new image under a
// compose file written before the mounts it needs existed.
//
// The rule the whole section is written to: an unprovable claim is not made. Where the evidence only
// supports "the repo has commits the image cannot contain", that is what is printed — never a
// version comparison inferred from two dates that happen to be ordered.
// ─────────────────────────────────────────────────────────────────────────────

/** Git is only ever asked questions here. Long enough for a cold `rev-list`, short enough to bound the run. */
const GIT_TIMEOUT_MS = 10_000;
/** The one git call that touches the network. It writes nothing — `ls-remote` has no ref to update. */
const LS_REMOTE_TIMEOUT_MS = 15_000;
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;

/** First seven of a sha, the form every git message uses. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `2026-09-08T04:55:34.695Z` → `2026-09-08`. The day is the resolution any of these comparisons has. */
function isoDay(value: string | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? '');
  return match?.[1] ?? null;
}

/**
 * A remote URL can carry a credential (`https://user:token@host/…`), and git echoes the URL back in
 * most of its network errors. Every string taken from git stderr goes through this first.
 */
export function scrubGitError(raw: string): string {
  const firstLine = raw.split('\n').find((line) => line.trim().length > 0) ?? '';
  return sanitizeForBox(firstLine.replace(/\/\/[^/@\s]*@/g, '//***@').trim()).slice(0, 160);
}

/**
 * Git, read-only and non-interactive.
 *
 * Every prompt is disabled deliberately: a credential prompt on a headless node is an unbounded
 * hang, and a preflight that hangs is worse than one that reports "could not determine". The askpass
 * helpers are REMOVED rather than pointed somewhere harmless — an askpass that answers (`echo` is
 * the usual trick) makes git attempt an authentication with whatever it printed, and a preflight
 * must not spend a login attempt on the operator's account.
 */
function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): { ok: boolean; stdout: string; stderr: string } {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' };
    // `undefined` drops the variable from the child environment outright, which is the point.
    env.GIT_ASKPASS = undefined;
    env.SSH_ASKPASS = undefined;
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: timeoutMs, env });
    return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
  } catch {
    // spawnSync throws rather than returning ENOENT on some platforms when git is not installed.
    return { ok: false, stdout: '', stderr: '' };
  }
}

export interface RepoIdentity {
  /** Worktree root, or null when this CLI is not running out of a checkout at all. */
  root: string | null;
  head: string | null;
  /** Commit date of HEAD, ISO-8601. */
  headIso: string | null;
}

/**
 * The checkout this CLI is running from — not merely the working directory.
 *
 * The module's own path is asked first on purpose: `cihub` is routinely run from somewhere else, and
 * the question B1 answers is "does the code I am executing match the container", which is a question
 * about where this file lives.
 */
export function readRepoIdentity(candidates: string[] = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()]): RepoIdentity {
  for (const candidate of candidates) {
    const root = runGit(['-C', candidate, 'rev-parse', '--show-toplevel']);
    if (!root.ok || root.stdout === '') continue;
    const head = runGit(['-C', root.stdout, 'rev-parse', 'HEAD']);
    if (!head.ok || head.stdout === '') continue;
    const date = runGit(['-C', root.stdout, 'show', '-s', '--format=%cI', 'HEAD']);
    return { root: root.stdout, head: head.stdout, headIso: date.ok && date.stdout !== '' ? date.stdout : null };
  }
  return { root: null, head: null, headIso: null };
}

export interface RunningImageIdentity {
  container: string;
  /** `org.opencontainers.image.revision` — the commit the image was built from, when the build stamped one. */
  revision: string | null;
  /** `org.opencontainers.image.created` — when the image was built. */
  imageCreatedIso: string | null;
  /** CI_HUB_VERSION on the container. A version string, and the only env VALUE this module keeps. */
  version: string | null;
  /** `com.docker.compose.service` — `ci-hub` on the canonical topology, `ci-os-hub` on the older one. */
  service: string | null;
  /** `com.docker.compose.project.config_files` — the compose file the container was CREATED FROM. */
  composeFiles: string[];
  /** Mount destinations inside the container. */
  mountTargets: string[];
  /** Environment variable NAMES. Values are dropped: that block is where the secrets are. */
  envNames: string[];
}

const IMAGE_INSPECT_FORMAT = [
  'revision={{index .Config.Labels "org.opencontainers.image.revision"}}',
  'imageCreated={{index .Config.Labels "org.opencontainers.image.created"}}',
  'service={{index .Config.Labels "com.docker.compose.service"}}',
  'composeFiles={{index .Config.Labels "com.docker.compose.project.config_files"}}',
  '{{range .Mounts}}mount={{.Destination}}{{println}}{{end}}{{range .Config.Env}}env={{.}}{{println}}{{end}}',
].join('\n');

/** Pure half of {@link readRunningImageIdentity}, so the whole parse is testable without Docker. */
export function parseHubContainerInspect(container: string, stdout: string): RunningImageIdentity {
  // A label Docker has no value for renders as an empty string on some daemons and `<no value>` on
  // others. Both mean absent, and reporting `<no value>` as a commit sha would be a fabricated one.
  const present = (raw: string | undefined): string | null => {
    const value = (raw ?? '').trim();
    return value === '' || value === '<no value>' ? null : value;
  };
  const fields = new Map<string, string>();
  const mountTargets: string[] = [];
  const envNames: string[] = [];
  let version: string | null = null;

  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const raw = line.slice(eq + 1).trim();
    if (key === 'mount') {
      if (raw !== '') mountTargets.push(raw);
      continue;
    }
    if (key === 'env') {
      const nameEnd = raw.indexOf('=');
      if (nameEnd <= 0) continue;
      const name = raw.slice(0, nameEnd);
      envNames.push(name);
      // The one value read out of this block, and it is a version string. Everything else beside it
      // is a password, a token or a key, so nothing else is even carried into the process.
      if (name === 'CI_HUB_VERSION') version = raw.slice(nameEnd + 1).trim() || null;
      continue;
    }
    fields.set(key, raw);
  }

  return {
    container,
    revision: present(fields.get('revision')),
    imageCreatedIso: present(fields.get('imageCreated')),
    version,
    service: present(fields.get('service')),
    composeFiles: (present(fields.get('composeFiles')) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    mountTargets,
    envNames,
  };
}

export function readRunningImageIdentity(): RunningImageIdentity | null {
  const container = resolveHubContainerName();
  if (!container) return null;
  const result = spawnSync('docker', ['inspect', container, '--format', IMAGE_INSPECT_FORMAT], {
    encoding: 'utf8',
    timeout: DOCKER_INSPECT_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  return parseHubContainerInspect(container, result.stdout ?? '');
}

/**
 * - `same` — the image was built from this exact commit.
 * - `repo-ahead` / `repo-behind` — one contains the other, and the distance is countable.
 * - `diverged` — neither contains the other.
 * - `absent` — the image's commit is not in this checkout's object store, so nothing can be counted.
 *   That is a finding, not a failure to measure: the running Hub is code this node has never seen.
 */
export type CommitRelation = 'same' | 'repo-ahead' | 'repo-behind' | 'diverged' | 'absent';

export interface RevisionComparison {
  relation: CommitRelation;
  /** Commits between the two, when countable. */
  count: number | null;
}

export function compareImageRevision(root: string, head: string, revision: string): RevisionComparison {
  if (head === revision) return { relation: 'same', count: 0 };
  if (!runGit(['-C', root, 'cat-file', '-e', `${revision}^{commit}`]).ok) return { relation: 'absent', count: null };
  const count = (range: string): number | null => {
    const result = runGit(['-C', root, 'rev-list', '--count', range]);
    const value = Number.parseInt(result.stdout, 10);
    return result.ok && Number.isInteger(value) ? value : null;
  };
  if (runGit(['-C', root, 'merge-base', '--is-ancestor', revision, head]).ok) return { relation: 'repo-ahead', count: count(`${revision}..${head}`) };
  if (runGit(['-C', root, 'merge-base', '--is-ancestor', head, revision]).ok)
    return { relation: 'repo-behind', count: count(`${head}..${revision}`) };
  return { relation: 'diverged', count: null };
}

/** The two identities on one line, so every verdict below carries the evidence it was decided on. */
function describeVersions(repo: RepoIdentity, image: RunningImageIdentity): string {
  const headPart = repo.head ? `HEAD ${shortSha(repo.head)}${isoDay(repo.headIso) ? ` (${isoDay(repo.headIso)})` : ''}` : 'HEAD unknown';
  const imagePart = image.revision ? `image ${shortSha(image.revision)}` : 'image (no commit label)';
  const built = isoDay(image.imageCreatedIso) ? ` built ${isoDay(image.imageCreatedIso)}` : '';
  const version = image.version ? `, CI_HUB_VERSION ${sanitizeForBox(image.version)}` : '';
  return `${headPart}  ·  ${imagePart}${built}${version}`;
}

/**
 * B1 — the checkout versus the image the container actually runs.
 *
 * A fleet node sat with a July checkout while its container ran a build from dev tip. Nothing on the
 * node compared them, so `cihub` there answered `✗ Unknown command: pool` while its own Hub served
 * the pool routes all day. The image label is the only evidence that settles it; without one this
 * check says what the timestamps can prove and stops there, rather than dressing two dates up as a
 * version comparison.
 */
export function checkRepoVersusImage(repo: RepoIdentity, image: RunningImageIdentity | null, comparison: RevisionComparison | null): PoolCheck {
  const id = 'B1';
  const label = 'Repo vs image';

  if (image === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because no running Hub container was found to compare this checkout against',
      notes: ['A stopped or crash-looping container cannot say which build it is. Start the Hub and re-run.'],
    };
  }
  if (repo.root === null || repo.head === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because this CLI is not running from a git checkout',
      notes: [
        `The container runs ${image.revision ? shortSha(image.revision) : 'an image with no commit label'}, and there is no repo here to reconcile it against.`,
        'That is the normal shape of an appliance install; it is only a problem on a node an operator',
        'also drives from a checkout.',
      ],
    };
  }

  const evidence = describeVersions(repo, image);

  if (image.revision === null || comparison === null) {
    const imageDay = isoDay(image.imageCreatedIso);
    const headDay = isoDay(repo.headIso);
    // The one direction two dates can actually prove: an image built BEFORE a commit cannot contain it.
    if (imageDay && headDay && imageDay < headDay) {
      return {
        id,
        label,
        verdict: 'warn',
        detail: `the image was built ${imageDay}, before HEAD was committed ${headDay} — the repo has commits the image cannot contain`,
        notes: [
          evidence,
          'The image carries no `org.opencontainers.image.revision` label, so this is a build-time',
          'comparison and not a version one: how many commits, and which, cannot be said from here.',
        ],
        commands: ['cihub update'],
      };
    }
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot correlate this checkout with the running image: it carries no commit label',
      notes: [
        evidence,
        'An image built after HEAD is consistent with BOTH a build from this checkout and a checkout',
        'that has since gone stale, so neither is claimed. B2 answers the staleness half directly.',
      ],
    };
  }

  const short = shortSha(image.revision);
  const count = comparison.count;

  if (comparison.relation === 'same') {
    return { id, label, verdict: 'ok', detail: `the container runs ${short}, built from this checkout's HEAD`, notes: [evidence] };
  }
  if (comparison.relation === 'repo-ahead') {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `the container runs ${short}, ${count === null ? 'some commits' : `${count} commit(s)`} behind this checkout`,
      notes: [evidence, 'The Hub is older than the code here: anything merged since is not running, however current the repo looks.'],
      commands: ['cihub update'],
    };
  }
  if (comparison.relation === 'repo-behind') {
    return {
      id,
      label,
      verdict: 'fail',
      detail: `this checkout is ${count === null ? 'some commits' : `${count} commit(s)`} behind ${short}, the commit the container runs`,
      notes: [
        evidence,
        'The Hub serves routes this checkout has never seen, and the `cihub` built from it does not',
        'know the commands that drive them. Measured on a fleet node as `✗ Unknown command: pool`',
        'against a Hub that was serving the pool routes the whole time.',
      ],
      commands: [`git -C ${sanitizeForBox(repo.root)} pull --ff-only && pnpm install`],
    };
  }
  if (comparison.relation === 'absent') {
    return {
      id,
      label,
      // Warn, not fail. The evidence supports "these are different builds" and nothing more: the
      // image may be genuinely ahead of this node, or this node may simply not have fetched yet —
      // the normal state of a fleet where images are built centrally and nodes fetch on their own
      // schedule. `fail` is reserved for a checkout provably behind its own container
      // (`repo-behind`), which is the state that produces `Unknown command: pool`. B2 reports the
      // unfetched half directly, and more precisely.
      verdict: 'warn',
      detail: `the container runs ${short}, a commit this checkout does not have`,
      notes: [
        evidence,
        'These are different builds, but WHICH is ahead cannot be said from here: the object store has',
        'no such commit, so there is no distance and no direction to report. Both readings are open —',
        'the image was built from code this node has never fetched, or this node simply has not',
        'fetched lately — see B2, which measures that half directly and is the line to read first.',
      ],
      commands: [`git -C ${sanitizeForBox(repo.root)} fetch origin`],
    };
  }
  return {
    id,
    label,
    verdict: 'warn',
    detail: `this checkout and the image have diverged — neither ${shortSha(repo.head)} nor ${short} contains the other`,
    notes: [evidence, 'A local branch is driving a container built from somewhere else; neither is a superset of the other.'],
  };
}

export interface UpstreamProbe {
  /** The ref compared against, e.g. `origin/dev`. */
  ref: string;
  remote: string;
  branch: string;
  /** Did the read-only remote read succeed? */
  reachable: boolean;
  /** Why not, scrubbed of any credential git echoed back. */
  error: string | null;
  remoteHead: string | null;
  /** Commits HEAD..<remote head>. Null when the remote commit is not in the local object store. */
  behind: number | null;
  /**
   * Commits <remote head>..HEAD — what this checkout has that the remote does not.
   *
   * Measured alongside `behind` from the same `--left-right` count, because behind-without-ahead is
   * the number that makes `pull --ff-only` sound like it will work. Null when uncountable.
   */
  ahead: number | null;
  /** What `git rev-list --count HEAD..<ref>` says from the CACHED ref — the number that lies. */
  cachedBehind: number | null;
}

/**
 * Ask the remote where the branch actually is, without writing a ref.
 *
 * `ls-remote` rather than `fetch`: a fetch would move `origin/<branch>` and quietly repair the very
 * condition this check exists to detect, on a command the operator ran to LOOK at the node.
 */
export function readUpstreamProbe(root: string): UpstreamProbe {
  const upstream = runGit(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const ref = upstream.ok && upstream.stdout.includes('/') ? upstream.stdout : 'origin/dev';
  const slash = ref.indexOf('/');
  const remote = ref.slice(0, slash);
  const branch = ref.slice(slash + 1);

  const cached = runGit(['-C', root, 'rev-list', '--count', `HEAD..${ref}`]);
  const cachedValue = Number.parseInt(cached.stdout, 10);
  const cachedBehind = cached.ok && Number.isInteger(cachedValue) ? cachedValue : null;

  const remoteRead = runGit(['-C', root, 'ls-remote', '--heads', remote, branch], LS_REMOTE_TIMEOUT_MS);
  const remoteHead = /^([0-9a-f]{7,40})\s/.exec(remoteRead.stdout)?.[1] ?? null;
  if (!remoteRead.ok || remoteHead === null) {
    const reason = remoteRead.ok ? `${remote} has no branch ${branch}` : scrubGitError(remoteRead.stderr) || 'git could not read the remote';
    return { ref, remote, branch, reachable: false, error: reason, remoteHead: null, behind: null, ahead: null, cachedBehind };
  }

  let behind: number | null = null;
  let ahead: number | null = null;
  if (runGit(['-C', root, 'cat-file', '-e', `${remoteHead}^{commit}`]).ok) {
    // `--left-right` over the symmetric difference gives both sides from ONE call: left is HEAD-only
    // (ahead), right is remote-only (behind). Counting only the right side is what reports a
    // diverged checkout as plainly "behind" and prescribes a `--ff-only` pull that cannot apply.
    const counted = runGit(['-C', root, 'rev-list', '--count', '--left-right', `HEAD...${remoteHead}`]);
    const [left, right] = counted.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10));
    if (counted.ok && Number.isInteger(left) && Number.isInteger(right)) {
      ahead = left as number;
      behind = right as number;
    }
  }
  return { ref, remote, branch, reachable: true, error: null, remoteHead, behind, ahead, cachedBehind };
}

/**
 * B2 — can this node even tell that it is behind?
 *
 * A node whose `git fetch` fails has a FROZEN `origin/<branch>`, so `git rev-list --count
 * HEAD..origin/dev` answers whatever the last successful fetch left — 0, forever. Measured on a
 * fleet node: auth failed, the count read 0, and HEAD was two months old. Repeating that number is
 * the bug, so a node that cannot read its remote reports behind as UNKNOWN and never as 0.
 */
export function checkUpstreamVisibility(repo: RepoIdentity, probe: UpstreamProbe | null): PoolCheck {
  const id = 'B2';
  const label = 'Upstream visibility';

  if (repo.root === null || repo.head === null || probe === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because this CLI is not running from a git checkout',
      notes: ['There is no ref to compare and nothing to fetch; an appliance install updates by image, not by pull.'],
    };
  }

  const cachedSays = probe.cachedBehind === null ? 'nothing' : String(probe.cachedBehind);

  if (!probe.reachable) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: `behind is UNKNOWN, not 0: ${probe.ref} could not be read (${probe.error ?? 'no reason reported'})`,
      notes: [
        `\`git rev-list --count HEAD..${probe.ref}\` answers ${cachedSays} on this node, and that number is`,
        'FROZEN at whatever the last successful fetch left behind — it reads the same on a current node',
        'and on one that is 400 commits stale.',
        'Measured on a fleet node: auth failed, the cached count read 0, and HEAD was two months old.',
        'Fix the credential first; every staleness number on this node is meaningless until then.',
      ],
      commands: [`git -C ${sanitizeForBox(repo.root)} ls-remote ${sanitizeForBox(probe.remote)}`],
    };
  }

  if (probe.remoteHead === repo.head) {
    return { id, label, verdict: 'ok', detail: `up to date with ${probe.ref} (${shortSha(repo.head)})` };
  }

  if (probe.behind === null) {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `${probe.ref} is at ${shortSha(probe.remoteHead ?? '')}, a commit this checkout has never fetched — behind by an unknown number`,
      notes: [
        `The remote answered, so this node is definitely behind; the cached ref says ${cachedSays}, which is`,
        'the stale number, not the real one. Fetch to make the distance countable.',
      ],
      commands: [`git -C ${sanitizeForBox(repo.root)} fetch ${sanitizeForBox(probe.remote)} ${sanitizeForBox(probe.branch)}`],
    };
  }

  if (probe.behind === 0) {
    const aheadBy = probe.ahead === null || probe.ahead === 0 ? '' : ` by ${probe.ahead} commit(s)`;
    return {
      id,
      label,
      verdict: 'ok',
      detail: `ahead of ${probe.ref} (${shortSha(probe.remoteHead ?? '')})${aheadBy}, not behind it`,
      notes: ['This checkout contains the remote branch tip, so nothing upstream is missing here.'],
    };
  }

  const cachedNote =
    probe.cachedBehind === 0
      ? [
          'The cached ref said 0. That is the failure this check exists for: without asking the remote,',
          'this node would have reported itself current while being this far behind.',
        ]
      : [`The cached ref said ${cachedSays}.`];

  // Behind AND ahead. Saying only "behind" here, with a `--ff-only` remediation, tells the operator
  // the checkout fast-forwards when git will refuse it outright ("Not possible to fast-forward").
  // Every node carrying one local commit is in this state, so the wrong half is the common half.
  if (probe.ahead !== null && probe.ahead > 0) {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `diverged from ${probe.ref}: ${probe.behind} commit(s) behind it and ${probe.ahead} ahead of it`,
      notes: [
        ...cachedNote,
        'This checkout carries commits the remote does not, so `pull --ff-only` cannot apply the',
        'upstream ones and no fast-forward is offered here — merging or rebasing local work is a',
        'decision, not a remediation. Read the local commits first:',
      ],
      commands: [`git -C ${sanitizeForBox(repo.root)} log --oneline ${shortSha(probe.remoteHead ?? '')}..HEAD`],
    };
  }

  return {
    id,
    label,
    verdict: 'warn',
    detail: `${probe.behind} commit(s) behind ${probe.ref}, measured against the remote rather than the cached ref`,
    notes: cachedNote,
    commands: [`git -C ${sanitizeForBox(repo.root)} pull --ff-only`],
  };
}

export interface ComposeServiceSpec {
  /** The service key actually found — `ci-hub` on the canonical topology, `ci-os-hub` on the older one. */
  service: string;
  /** Container-side paths the file declares. */
  mountTargets: string[];
  /** Variable NAMES the file declares. Values are never read: this is where compose keeps passwords. */
  envNames: string[];
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/**
 * The container-side path of a short-form volume entry.
 *
 * `${VAR:-/default}` contains a colon of its own, so every interpolation is masked before the entry
 * is split — otherwise `${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock:ro` splits
 * in the wrong place and the check reports a mount that is plainly there as missing.
 */
export function composeShortFormTarget(spec: string): string | null {
  const masked = spec.replace(/\$\{[^}]*\}/g, '$');
  const colon = masked.indexOf(':');
  if (colon < 0) return null; // an anonymous volume declares no host path
  const rest = masked.slice(colon + 1);
  const mode = rest.indexOf(':');
  const target = mode < 0 ? rest : rest.slice(0, mode);
  // A target that is itself interpolated cannot be compared with a resolved mount destination, and
  // guessing produces a "missing mount" for one that is present. Undecidable is not reported.
  if (target.includes('$') || !target.startsWith('/')) return null;
  return target;
}

export function parseComposeMountTargets(block: string[]): string[] {
  const targets: string[] = [];
  let inLongForm = false;
  for (const raw of block) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const item = line.startsWith('- ') ? line.slice(2).trim() : null;
    const candidate = item ?? line;
    // `- type: bind` opens the long form; `- ${ROOT}/state:/data/state` is the short one. The
    // discriminator is the space after the colon, which a path never has and a YAML key always does.
    const mapEntry = /^([A-Za-z_][\w-]*):\s+(.*)$/.exec(candidate);
    if (item !== null && mapEntry === null) {
      inLongForm = false;
      const target = composeShortFormTarget(unquote(item));
      if (target) targets.push(target);
      continue;
    }
    if (item !== null) inLongForm = true;
    if (!inLongForm || mapEntry === null) continue;
    if (mapEntry[1] === 'target') targets.push(unquote(mapEntry[2] ?? ''));
  }
  return targets.filter((target) => target !== '');
}

export function parseComposeEnvNames(block: string[]): string[] {
  const names: string[] = [];
  for (const raw of block) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    // Both shapes compose accepts: `- KEY=value` and `KEY: value`. Only the name is kept either way.
    const listEntry = /^-\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (listEntry?.[1]) {
      names.push(listEntry[1]);
      continue;
    }
    const mapEntry = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (mapEntry?.[1]) names.push(mapEntry[1]);
  }
  return names;
}

/**
 * Read one service's mounts and env NAMES out of a compose file.
 *
 * Hand-rolled rather than parsed: `scripts/` has no YAML dependency, and the two facts needed here —
 * container-side paths and variable names — are shallow enough to read off the indentation. Anything
 * it cannot make sense of returns null, which the check reports as undetermined rather than as drift.
 */
export function parseComposeService(source: string, services: readonly string[]): ComposeServiceSpec | null {
  const lines = source.split('\n');
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const meaningful = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');

  const servicesAt = lines.findIndex((line) => indentOf(line) === 0 && /^services:\s*$/.test(line.trim()));
  if (servicesAt < 0) return null;

  let serviceIndent: number | null = null;
  let start = -1;
  let end = lines.length;
  let found = '';
  for (let i = servicesAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!meaningful(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      // A top-level key after `services:` ends the block (`volumes:`, `networks:`, `secrets:`).
      if (start >= 0) end = i;
      break;
    }
    if (serviceIndent === null) serviceIndent = indent;
    if (indent !== serviceIndent) continue;
    const key = /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim())?.[1];
    if (key === undefined) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (services.includes(key)) {
      start = i;
      found = key;
    }
  }
  if (start < 0) return null;

  const body = lines.slice(start + 1, end).filter(meaningful);
  const childIndent = body.length === 0 ? 0 : Math.min(...body.map(indentOf));
  const blockUnder = (key: string): string[] => {
    const at = body.findIndex((line) => indentOf(line) === childIndent && line.trim() === `${key}:`);
    if (at < 0) return [];
    const rest = body.slice(at + 1);
    const stop = rest.findIndex((line) => indentOf(line) <= childIndent);
    return stop < 0 ? rest : rest.slice(0, stop);
  };

  return { service: found, mountTargets: parseComposeMountTargets(blockUnder('volumes')), envNames: parseComposeEnvNames(blockUnder('environment')) };
}

export interface ComposeDeclaration {
  path: string;
  spec: ComposeServiceSpec;
}

export interface ComposeDriftInput {
  image: RunningImageIdentity | null;
  /** The compose file the container was created from, and what it declares for that service. */
  created: ComposeDeclaration | null;
  /** Why `created` is null, when the container named a file this node could not read or parse. */
  createdReason: string | null;
  /** This checkout's own `docker-compose.prod.yml`, when the CLI runs from a repo. */
  repo: ComposeDeclaration | null;
}

/** Names of every backend URL variable, flattened. The only env drift worth reporting, and secret-free. */
const BACKEND_VAR_NAMES = new Set<string>(BACKEND_URL_VARS.flatMap((entry) => entry.vars));

/**
 * B3 — does the running container match what its compose declares?
 *
 * A fleet node ran a new image under an appliance compose written months earlier, so the container
 * was missing the host Tailscale socket and CLI that #1279 added. `/identify` returned
 * `nodeFqdn: null`, pairing could never complete, and nothing anywhere reported the mismatch — the
 * container was healthy, the image was current, and the compose file was simply old.
 *
 * The comparison is against the file the container was CREATED FROM, found from its own compose
 * label: an appliance keeps its copy under `~/.local/share/companion-hub/`, not in the repo, and
 * assuming the repo's file would compare a container against a document it has never met.
 */
export function checkComposeDrift(input: ComposeDriftInput, env: string): PoolCheck {
  const id = 'B3';
  const label = 'Compose drift';
  const { image, created, repo } = input;

  if (image === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because no running Hub container was found to compare against a compose file',
      notes: ['Mount and environment drift is only visible on a container that exists. Start the Hub and re-run.'],
    };
  }
  if (created === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: `cannot determine, because ${input.createdReason ?? 'the compose file this container was created from could not be read'}`,
      notes: [
        "The file is found from the container's own `com.docker.compose.project.config_files` label,",
        "because an appliance install keeps its compose outside the repo and the repo's copy would be",
        'the wrong document to compare against.',
      ],
    };
  }

  const missingMounts = created.spec.mountTargets.filter((target) => !image.mountTargets.includes(target));
  const declaredBackendVars = created.spec.envNames.filter((name) => BACKEND_VAR_NAMES.has(name));
  const missingVars = declaredBackendVars.filter((name) => !image.envNames.includes(name));
  const usesRepoCompose = repo !== null && repo.path === created.path;
  const repoOnlyMounts =
    repo === null || usesRepoCompose ? [] : repo.spec.mountTargets.filter((target) => !created.spec.mountTargets.includes(target));
  const source = `${sanitizeForBox(created.path)} (service ${sanitizeForBox(created.spec.service)})`;

  if (missingMounts.length > 0 || missingVars.length > 0) {
    return {
      id,
      label,
      verdict: 'fail',
      detail: `the running container is missing ${missingMounts.length} mount(s) and ${missingVars.length} backend URL var(s) its compose declares`,
      notes: [
        `Compared against ${source}.`,
        ...(missingMounts.length > 0 ? [`Mounts declared but not present: ${missingMounts.map((target) => sanitizeForBox(target)).join(', ')}`] : []),
        ...(missingVars.length > 0 ? [`Variables declared but not set: ${missingVars.map((name) => sanitizeForBox(name)).join(', ')}`] : []),
        'The container predates its own compose file: it was created before these lines were added and',
        'has not been recreated since. Missing /var/run/tailscale or /usr/bin/tailscale is the measured',
        'case — `/identify` then returns nodeFqdn:null and pairing can never complete, with the',
        'container reporting healthy throughout.',
      ],
      commands: [`cihub up ${env}`],
    };
  }

  if (repoOnlyMounts.length > 0) {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `the compose this container was created from is missing ${repoOnlyMounts.length} mount(s) this checkout declares`,
      notes: [
        `Created from ${source}, which is not this checkout's ${sanitizeForBox(repo?.path ?? '')}.`,
        `Declared here but not there: ${repoOnlyMounts.map((target) => sanitizeForBox(target)).join(', ')}`,
        'An appliance compose is a copy: `git pull` does not touch it, so a node can take a brand new',
        'image while keeping a compose file from before the mounts that image needs existed.',
      ],
      commands: ['cihub update'],
    };
  }

  return {
    id,
    label,
    verdict: 'ok',
    detail: `container matches ${created.spec.mountTargets.length} mount(s) and ${declaredBackendVars.length} backend URL var(s) declared in its compose`,
    notes: [`Compared against ${source}.`],
  };
}

export interface PoolRouteSupport {
  /** Route under `/api/inference/pool/`. */
  route: string;
  /** The `cihub pool` subcommand that drives it. */
  subcommand: string;
  /** Whether the Hub serves it. False only on a 404; null when the probe could not decide. */
  servedByHub: boolean | null;
}

/**
 * GET routes only, and every one of them read-only.
 *
 * The POST routes (`pins`, `peers/pair`, …) cannot be probed this way at all: a GET against a
 * POST-only Nest route answers 404, so probing one would report a route the Hub serves as absent.
 */
export const POOL_ROUTE_COMMANDS: readonly { route: string; subcommand: string }[] = [
  { route: 'status', subcommand: 'status' },
  { route: 'peers', subcommand: 'peers' },
  { route: 'peers/discoverable', subcommand: 'discover' },
  { route: 'routing-log', subcommand: 'log' },
  { route: 'settings', subcommand: 'enable' },
];

/**
 * B4 — does the Hub this CLI drives serve every pool route this CLI calls?
 *
 * One direction, because only one is observable from here. `cihub pool doctor` passes its own
 * `POOL_SUBCOMMANDS`, and {@link POOL_ROUTE_COMMANDS} ships in the same build, so a CLI genuinely
 * older than its Hub cannot run this check at all — it answers `✗ Unknown command: pool` and never
 * reaches this module. That skew is real, and B1 is where it is measured (a checkout behind the
 * commit its own container runs); asserting it from HERE would be asserting something this build
 * cannot see.
 *
 * What IS observable: a Hub that 404s a route this CLI drives, i.e. a Hub older than its CLI. The
 * opposite branch is kept only for a caller that declares a partial subcommand list, and says so
 * rather than dressing it up as a version skew.
 */
export function checkPoolCommandParity(routes: PoolRouteSupport[], subcommands: readonly string[] | null, repoRoot: string | null): PoolCheck {
  const id = 'B4';
  const label = 'CLI vs Hub routes';

  if (subcommands === null) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because the caller did not declare which pool subcommands this CLI build has',
      notes: ['`cihub pool doctor` passes them in; a direct call to this module can omit them, and then there is nothing to compare.'],
    };
  }

  const undecided = routes.filter((route) => route.servedByHub === null);
  if (undecided.length === routes.length) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot determine, because no pool route answered — the Hub is not reachable locally (see A2)',
      notes: ['A route that did not answer is not a route that is absent, so nothing is concluded from silence here.'],
    };
  }
  if (routes.every((route) => route.servedByHub === false)) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: 'cannot compare, because this Hub serves no pool routes at all (see A3)',
      notes: ['A build that predates Hub Pool has nothing for a CLI to be ahead of or behind; A3 is the finding.'],
    };
  }

  const hubAhead = routes.filter((route) => route.servedByHub === true && !subcommands.includes(route.subcommand));
  const cliAhead = routes.filter((route) => route.servedByHub === false && subcommands.includes(route.subcommand));

  if (hubAhead.length > 0) {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `the Hub serves ${hubAhead.length} pool route(s) the declared CLI command list does not cover`,
      notes: [
        ...hubAhead.map(
          (route) => `  /api/inference/pool/${route.route} is served, but \`cihub pool ${route.subcommand}\` is not in the declared list`,
        ),
        'Not a version skew: the route table and the subcommand list ship in the same build, so under',
        '`cihub pool doctor` this means the two disagree with each other. A CLI genuinely older than',
        'its Hub cannot reach this check — it answers `Unknown command: pool` — and B1 is what measures',
        'that, by comparing this checkout against the commit its own container runs.',
      ],
      commands: [repoRoot === null ? 'cihub update' : `git -C ${sanitizeForBox(repoRoot)} pull --ff-only && pnpm install`],
    };
  }

  if (cliAhead.length > 0) {
    return {
      id,
      label,
      verdict: 'warn',
      detail: `this CLI drives ${cliAhead.length} pool route(s) the Hub does not serve`,
      notes: [
        ...cliAhead.map((route) => `  \`cihub pool ${route.subcommand}\` calls /api/inference/pool/${route.route}, which answers 404`),
        'The Hub is older than this CLI, so those commands fail against it however current the checkout is.',
      ],
      commands: ['cihub update'],
    };
  }

  const decided = routes.length - undecided.length;
  if (undecided.length > 0) {
    return {
      id,
      label,
      verdict: 'unknown',
      detail: `${decided} of ${routes.length} pool route(s) agree with this CLI; ${undecided.length} did not answer`,
      notes: undecided.map((route) => `  /api/inference/pool/${route.route} — no answer, so neither side is judged on it`),
    };
  }
  return { id, label, verdict: 'ok', detail: `CLI and Hub agree on all ${routes.length} pool route(s) checked` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C — tailnet reachability. The transport has NO fallback.
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

/** C1 — connected, and named. Peers address this node as `https://<MagicDNS name>` and nothing else. */
export function checkTailnet(self: TailscaleSelf): PoolCheck {
  if (!self.available) {
    return {
      id: 'C1',
      label: 'Tailnet',
      verdict: 'unknown',
      detail: 'the tailscale CLI is not installed or did not answer — cannot determine tailnet state',
      notes: ['Hub Pool has no transport other than the tailnet; without Tailscale this node cannot pool at all.'],
    };
  }
  if (self.backendState !== 'Running') {
    return {
      id: 'C1',
      label: 'Tailnet',
      verdict: 'fail',
      detail: `tailscaled reports ${sanitizeForBox(self.backendState ?? 'no state')} — not connected`,
      commands: ['sudo tailscale up'],
    };
  }
  if (self.dnsName === null) {
    return {
      id: 'C1',
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
  return { id: 'C1', label: 'Tailnet', verdict: 'ok', detail: `connected as ${sanitizeForBox(self.dnsName)}` };
}

/**
 * C2 — `tailscale serve` is actually publishing, and the cert exists.
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
export interface ServeConfigState {
  /** Was the serve config readable at all? False means undetermined — never "not configured". */
  readable: boolean;
  /** Some serve config exists, whatever it publishes. */
  configured: boolean;
  /** A peer hitting `https://<name>/api/…` reaches THIS Hub. Nothing weaker counts. */
  publishesHub: boolean;
  /** Everything the config does publish, one line each, for a report that has to explain itself. */
  mounts: string[];
}

/** `http://localhost:5002`, `127.0.0.1:5002`, `[::1]:5002` — all the same target, all local. */
function proxiesToLocalPort(target: string, apiPort: number): boolean {
  for (const candidate of [target, `http://${target}`]) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
      if (port !== apiPort) continue;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    } catch {
      // Not a URL in this form; try the next.
    }
  }
  return false;
}

/**
 * What `tailscale serve` actually publishes, read from `serve status --json`.
 *
 * The text output was matched with a regex for `localhost:<port>` anywhere in it, which is true of
 * three configs that publish nothing a peer can use: a `/hub` path mount (peer callbacks to
 * `https://<name>/api/inference/pool/identify` 404), a listener on a port other than 443 (peers
 * dial 443 and nothing else), and a raw `tcp://` forward with no TLS termination (the HTTPS
 * handshake never completes). All three rendered as `ok`. What a peer callback needs is exact and
 * so is this: a handler at `/` on the `:443` listener, proxying to this Hub's port.
 */
export function parseTailscaleServeConfig(stdout: string, apiPort: number): ServeConfigState {
  const unreadable: ServeConfigState = { readable: false, configured: false, publishesHub: false, mounts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  if (parsed === null || typeof parsed !== 'object') return unreadable;

  const config = parsed as {
    TCP?: Record<string, { HTTPS?: unknown; TCPForward?: unknown; TerminateTLS?: unknown }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown; Path?: unknown; Text?: unknown }> }>;
  };
  const mounts: string[] = [];
  let publishesHub = false;

  for (const [hostPort, entry] of Object.entries(config.Web ?? {})) {
    for (const [mount, handler] of Object.entries(entry?.Handlers ?? {})) {
      const proxy = typeof handler?.Proxy === 'string' ? handler.Proxy : null;
      const served = proxy ?? (typeof handler?.Path === 'string' ? `file ${handler.Path}` : typeof handler?.Text === 'string' ? 'static text' : '?');
      mounts.push(`${sanitizeForBox(hostPort)}${sanitizeForBox(mount)} -> ${sanitizeForBox(served)}`);
      // `/` and `:443` are both load-bearing: a peer callback is `https://<name>/api/…` on the
      // default port, so a deeper mount or another listener serves something no peer will ask for.
      if (hostPort.endsWith(':443') && mount === '/' && proxy !== null && proxiesToLocalPort(proxy, apiPort)) publishesHub = true;
    }
  }

  for (const [port, entry] of Object.entries(config.TCP ?? {})) {
    const forward = typeof entry?.TCPForward === 'string' ? entry.TCPForward : null;
    if (forward === null) continue;
    // TLS-terminated TCP on 443 does publish the Hub over HTTPS; a raw forward does not, because
    // nothing on the node speaks TLS at the other end of it.
    const terminatesTls = typeof entry?.TerminateTLS === 'string' && entry.TerminateTLS !== '';
    mounts.push(`tcp:${sanitizeForBox(port)} -> ${sanitizeForBox(forward)}${terminatesTls ? ' (TLS terminated)' : ' (raw TCP)'}`);
    if (port === '443' && terminatesTls && proxiesToLocalPort(forward, apiPort)) publishesHub = true;
  }

  const configured = mounts.length > 0 || Object.keys(config.TCP ?? {}).length > 0;
  return { readable: true, configured, publishesHub, mounts };
}

export function readTailscaleServeTarget(apiPort: number): ServeConfigState {
  const result = spawnSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS });
  if (result.status !== 0) return { readable: false, configured: false, publishesHub: false, mounts: [] };
  return parseTailscaleServeConfig((result.stdout ?? '').trim(), apiPort);
}

export function checkTailscaleServe(
  probe: HttpProbe | null,
  self: TailscaleSelf,
  apiPort: number,
  retried: boolean,
  serve: ServeConfigState,
  skipReason?: string,
): PoolCheck {
  const remediation = `sudo tailscale set --operator=$USER && tailscale serve --bg --yes --https=443 http://localhost:${apiPort}`;
  const publishing = `serve publishes http://localhost:${apiPort} at / on :443`;
  const publishesInstead = serve.mounts.length > 0 ? [`Serve publishes instead: ${serve.mounts.join('; ')}`] : [];

  if (self.dnsName === null || probe === null) {
    // The skip path still KNOWS what the local config says, and the config is this check's authority
    // everywhere else. Emitting the config-writing remediation without consulting it hands the
    // operator a mutating command for a serve setup that is already correct — on a node whose only
    // problem is that its Hub is down.
    const notes = serve.publishesHub
      ? [`${publishing}, so nothing here needs changing — A2 is the finding.`]
      : serve.readable
        ? serve.configured
          ? ['The local serve config does not publish this Hub, so peers cannot reach it either way.', ...publishesInstead]
          : ['There is no serve config on this node, so peers cannot reach it once the Hub is back up.']
        : ['The serve config could not be read either, so nothing is claimed about it.'];
    return {
      id: 'C2',
      label: 'Tailscale serve',
      verdict: 'unknown',
      detail: skipReason ?? 'no MagicDNS name to probe (see C1)',
      notes,
      ...(skipReason && serve.readable && !serve.publishesHub ? { commands: [remediation] } : {}),
    };
  }
  if (probe.ok) {
    return {
      id: 'C2',
      label: 'Tailscale serve',
      verdict: 'ok',
      detail: `https://${sanitizeForBox(self.dnsName)}/ serves /identify in ${Math.round(probe.ms)}ms${retried ? ' (second attempt — the first blocked on cert issuance)' : ''}`,
    };
  }
  if (probe.status !== null) {
    return {
      id: 'C2',
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
      id: 'C2',
      label: 'Tailscale serve',
      verdict: 'ok',
      detail: `${publishing}, so https://${sanitizeForBox(self.dnsName)}/ reaches this Hub`,
      notes: [
        'Confirmed from the local serve config, not by an HTTPS request: a node cannot reach its own',
        'MagicDNS name through its own serve listener, so a self-probe fails on a healthy node too.',
        'Read from `tailscale serve status --json`: a handler at / on the :443 listener, which is',
        'exactly the path a peer callback takes. Run `cihub pool doctor` on a PEER to confirm it end to end.',
      ],
    };
  }
  // Undetermined, not broken: the self-probe cannot decide (it fails on healthy nodes) and the
  // config could not be read either, so there is nothing left to decide with.
  if (!serve.readable) {
    return {
      id: 'C2',
      label: 'Tailscale serve',
      verdict: 'unknown',
      detail: `could not read this node's serve config, and a node cannot probe its own serve listener`,
      notes: [
        '`tailscale serve status --json` did not answer, so whether peers can reach this Hub is',
        'unknown from here. The self-probe failure is not evidence either way.',
        'Run `cihub pool doctor` on a PEER, which sees this node from the side that matters.',
      ],
    };
  }
  if (serve.configured) {
    return {
      id: 'C2',
      label: 'Tailscale serve',
      verdict: 'fail',
      detail: `serve is configured, but nothing publishes http://localhost:${apiPort} at / on :443`,
      notes: [
        'Peer callbacks are https://<nodeFqdn>/api/inference/pool/… on port 443, so a deeper mount, a',
        'different listener or a raw TCP forward is not a path any peer will take.',
        ...publishesInstead,
      ],
      commands: [remediation],
    };
  }
  return {
    id: 'C2',
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
// Section D — peer budget. The most important section.
// ─────────────────────────────────────────────────────────────────────────────

export interface BackendTiming {
  backend: string;
  ms: number;
  ok: boolean;
  detail: string;
}

/**
 * D1 — does a cold capabilities build fit inside the peer's 8s probe budget?
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
      id: 'D1',
      label: 'Capabilities budget',
      verdict: 'fail',
      detail: `cold capabilities build took ${rounded}ms — OVER the ${CAPABILITIES_PROBE_TIMEOUT_MS}ms peer probe budget`,
      notes: [
        ...notes,
        'Every peer probe of this node times out. It goes `unreachable` fleet-wide, nothing routes to',
        'it, and it keeps reporting itself healthy to its own operator.',
        ...(slowest ? [`Start with ${slowest.backend} at ${Math.round(slowest.ms)}ms, then check D2 — a blocked DNS lookup lands here.`] : []),
      ],
    };
  }
  if (totalMs >= CAPABILITIES_WARN_MS) {
    return {
      id: 'D1',
      label: 'Capabilities budget',
      verdict: 'warn',
      detail: `cold capabilities build took ${rounded}ms — inside ${CAPABILITIES_PROBE_TIMEOUT_MS}ms but under 2x margin`,
      notes: [...notes, `Under ${CAPABILITIES_WARN_MS}ms is the margin worth holding; a load spike from here crosses the budget.`],
    };
  }
  return {
    id: 'D1',
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
  const wanted = new Set<string>(BACKEND_URL_VARS.flatMap((entry) => entry.vars));
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

/**
 * Where the backend URL values came from — and, when there are none, whether that was decidable.
 *
 * - `container` — read from the Hub container's own environment, which is authoritative.
 * - `file` — the container environment WAS readable and set none of them, so the env file is the
 *   whole configuration and an empty list is a real finding.
 * - `unreadable` — no container environment could be read at all (no Docker, container stopped,
 *   crash-looping, `docker inspect` refused). The env file is all there is, and on a compose
 *   install it is exactly where these variables are NOT. An empty list here means "could not
 *   look" — never "there is nothing to find".
 */
export type BackendVarsSource = 'container' | 'file' | 'unreadable';

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
 * D2 — every configured backend URL resolves, and resolves fast.
 *
 * From the container when one is running, because that is the only vantage that can tell a
 * compose-internal name from a broken one. From the host otherwise — where a fast failure is
 * genuinely undecidable (it may resolve inside the container), but a SLOW one is the defect itself
 * and is reported as such regardless of vantage: a lookup that blocks costs the budget wherever it
 * is measured.
 */
export function checkBackendDns(specs: BackendUrlSpec[], results: DnsProbeResult[], vantage: DnsVantage, varsSource: BackendVarsSource): PoolCheck {
  if (specs.length === 0) {
    // "I found no backend URLs" and "I could not read where the backend URLs live" are the same
    // empty list and opposite findings. Reporting the second as a green check is how this check —
    // the one a blocked lookup shows up in — reports 0 issues on precisely the install it exists
    // for: an appliance whose Hub container is stopped or crash-looping.
    if (varsSource === 'unreadable') {
      return {
        id: 'D2',
        label: 'Backend DNS',
        verdict: 'unknown',
        detail: 'cannot determine, because the container environment could not be read and the env file sets no backend URL',
        notes: [
          'Compose sets OLLAMA_URL/VLLM_URL/LEMONADE_URL/MTPLX_URL/DSPARK_URL in the `hub` service',
          '`environment:` block, NOT in the env file — so on a compose install an empty env file is',
          'the expected state and says nothing about what the Hub resolves.',
          'Start the Hub and re-run: with the container up this is measured from inside it, which is',
          'the only vantage that can tell a compose-internal name from a broken one.',
        ],
      };
    }
    return {
      id: 'D2',
      label: 'Backend DNS',
      verdict: 'ok',
      detail:
        varsSource === 'container'
          ? 'the Hub container has no backend URLs set, so the capabilities build resolves nothing'
          : 'neither the Hub container nor the env file sets a backend URL, so the build resolves nothing',
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
      notes.push(`${spec.variable.padEnd(26, ' ')} ${poolWarn(`${label} — ${result.code}, the name does not exist`)}`);
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
            : varsSource === 'file'
              ? 'URLs read from the env file: the Hub container reported none, so compose may not set them here.'
              : 'URLs read from the env file: the container environment could not be read, so this list may be short.',
        ]
      : [
          'Measured on the HOST with dns.lookup: there is no Hub container to probe from.',
          'A name that fails FAST here may still resolve inside the container, so those are undecidable.',
          'A lookup that BLOCKS is reported either way — it costs the budget from any vantage.',
        ]),
  );

  // The same reasoning as the empty case, one step weaker: a list read only from the env file while
  // the container environment was unreadable is a list that may be missing the URL that blocks.
  // A decided failure below still stands; a clean sweep of a possibly-partial list does not.
  const listMayBePartial = varsSource === 'unreadable';
  if (listMayBePartial) {
    notes.push('Compose sets these on the container, so any URL only set there is invisible to this run.');
  }

  if (failures === 0) {
    return {
      id: 'D2',
      label: 'Backend DNS',
      verdict: undecided > 0 || listMayBePartial ? 'unknown' : 'ok',
      detail:
        undecided > 0
          ? `${specs.length} backend URL(s): none blocking, ${undecided} undecidable from this vantage`
          : listMayBePartial
            ? `${specs.length} backend URL(s) from the env file resolve under ${DNS_SLOW_MS}ms, but the container's own list could not be read`
            : `${specs.length} backend URL(s) all resolve under ${DNS_SLOW_MS}ms`,
      notes,
    };
  }

  return {
    id: 'D2',
    label: 'Backend DNS',
    verdict: 'fail',
    detail: `${failures} of ${specs.length} backend URL(s) do not resolve cleanly`,
    notes: [
      ...notes,
      '',
      `Each blocked lookup is spent inside the ${CAPABILITIES_PROBE_TIMEOUT_MS}ms capabilities budget (D1). Two of them is the whole budget.`,
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
  /** `/v1/models` reports this as `["text"]`, `["embedding"]`, … (ModelState's sibling in inference.ts). */
  modality?: string[];
}

/** ModelState values that mean the weights are in VRAM right now (inference.ts:91). */
const RESIDENT_MODEL_STATES = new Set(['loaded', 'pinned']);

/**
 * The heaviest model an engine is actually holding — the one that exercises the 15s budget.
 *
 * Both filters are load-bearing, and both were measured against the live core-2 inventory:
 *
 * - state. `!== 'available'` also admits `pulled`, `pulling`, `loading` and `error`. A big `pulled`
 *   model is on disk and NOT in VRAM, so probing it forces a cold load and reports `OVER the 15000ms
 *   peer connect timeout` on a perfectly healthy node — blaming the buffering defect for a load.
 * - modality. `nomic-embed-text` survived the old filter. A chat-completion POST to an embedding or
 *   TTS model answers 400, which D3 printed as `answered 400 after Xms` under a note about peers
 *   abandoning the hop.
 */
export function pickLargestLoadedModel(models: LoadedModel[]): LoadedModel | null {
  const loaded = models.filter(
    (model) =>
      typeof model.id === 'string' &&
      model.local !== false &&
      RESIDENT_MODEL_STATES.has(model.state ?? '') &&
      // An absent modality list is an older build that does not report one; only a list that names
      // some OTHER modality is a reason to skip a model.
      (model.modality === undefined || model.modality.some((kind) => kind === 'text' || kind === 'llm')),
  );
  if (loaded.length === 0) return null;
  return [...loaded].sort((a, b) => modelParameterBillions(b.id) - modelParameterBillions(a.id) || a.id.localeCompare(b.id))[0] ?? null;
}

/**
 * D3 — non-streaming headroom against the 15s peer connect timeout.
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
      id: 'D3',
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
  const asked = `Asked for a ${NON_STREAMING_PROBE_MAX_TOKENS}-token non-streaming completion: the defect is an engine buffering the whole answer before the first byte, which one token cannot show.`;

  if (attribution.pooled && attribution.servedBy !== 'local') {
    return {
      id: 'D3',
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
      id: 'D3',
      label: 'Non-streaming headroom',
      verdict: 'fail',
      detail:
        probe.status === null
          ? `no headers for ${sanitizeForBox(model.id)} after ${rounded}ms (${sanitizeForBox(probe.error ?? 'unknown error')})`
          : `${sanitizeForBox(model.id)} answered ${probe.status} after ${rounded}ms`,
      notes: [asked, `A peer abandons this hop at ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms.`],
    };
  }

  if (probe.ms > POOL_PROXY_CONNECT_TIMEOUT_MS) {
    return {
      id: 'D3',
      label: 'Non-streaming headroom',
      verdict: 'fail',
      detail: `${base} — OVER the ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms peer connect timeout`,
      notes: [
        asked,
        'A peer forwarding a non-streaming request for this model gives up before the headers arrive,',
        'even though the identical streaming request answers in about a second — the engine buffers',
        'the whole completion first, and the timeout fires on headers.',
        'Prefer streaming for this model, or serve it from a node that answers faster.',
      ],
    };
  }

  if (probe.ms >= POOL_PROXY_CONNECT_TIMEOUT_MS / 2) {
    return {
      id: 'D3',
      label: 'Non-streaming headroom',
      verdict: 'warn',
      detail: `${base} — inside ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms but under 2x margin`,
      notes: [asked],
    };
  }

  return {
    id: 'D3',
    label: 'Non-streaming headroom',
    verdict: 'ok',
    detail: `${base}, well inside ${POOL_PROXY_CONNECT_TIMEOUT_MS}ms`,
    notes: [asked],
  };
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

/** Read one compose file's declaration for the Hub service, or say why it could not be read. */
function readComposeDeclaration(file: string, services: readonly string[]): { declaration: ComposeDeclaration | null; reason: string | null } {
  try {
    if (!existsSync(file)) return { declaration: null, reason: `${sanitizeForBox(file)} does not exist on this host` };
    const spec = parseComposeService(readFileSync(file, 'utf8'), services);
    if (spec === null)
      return {
        declaration: null,
        reason: `no ${services.map((name) => sanitizeForBox(name)).join(' or ')} service is declared in ${sanitizeForBox(file)}`,
      };
    return { declaration: { path: file, spec }, reason: null };
  } catch (error) {
    return {
      declaration: null,
      reason: `${sanitizeForBox(file)} could not be read (${sanitizeForBox(error instanceof Error ? error.message : String(error))})`,
    };
  }
}

function collectComposeDrift(image: RunningImageIdentity | null, repo: RepoIdentity): ComposeDriftInput {
  if (image === null) return { image, created: null, createdReason: null, repo: null };
  // Both topologies: the canonical `ci-hub` service and the older `ci-os-hub` one. The container's
  // own label names which it is, and the fallbacks cover a compose file that predates the label.
  const services = [...new Set([image.service, 'ci-hub', 'ci-os-hub'].filter((name): name is string => Boolean(name)))];
  const composeFile = image.composeFiles[0] ?? null;
  const created =
    composeFile === null
      ? {
          declaration: null,
          reason: 'the container carries no `com.docker.compose.project.config_files` label, so the compose it was created from is unknown',
        }
      : readComposeDeclaration(composeFile, services);
  const repoCompose = repo.root === null ? null : readComposeDeclaration(path.join(repo.root, 'docker-compose.prod.yml'), services).declaration;
  return { image, created: created.declaration, createdReason: created.reason, repo: repoCompose };
}

/** Does the Hub serve each pool route? A 404 is the only answer that means "absent" — 401 proves it exists. */
async function probePoolRoutes(base: string): Promise<PoolRouteSupport[]> {
  return Promise.all(
    POOL_ROUTE_COMMANDS.map(async (entry) => {
      const probe = await timedFetch(`${base}/api/inference/pool/${entry.route}`, HUB_PROBE_TIMEOUT_MS);
      return { ...entry, servedByHub: probe.status === null ? null : probe.status !== 404 };
    }),
  );
}

async function collectSectionB(base: string, hubAnswering: boolean, env: string, options: PoolDoctorOptions): Promise<PoolCheck[]> {
  const repo = readRepoIdentity();
  const image = readRunningImageIdentity();
  const comparison = repo.root !== null && repo.head !== null && image?.revision ? compareImageRevision(repo.root, repo.head, image.revision) : null;

  const checks: PoolCheck[] = [
    checkRepoVersusImage(repo, image, comparison),
    checkUpstreamVisibility(repo, repo.root === null || repo.head === null ? null : readUpstreamProbe(repo.root)),
    checkComposeDrift(collectComposeDrift(image, repo), env),
  ];

  // Probing five routes against a Hub that is not answering buys five timeouts and no information;
  // A2 already reported the reason, so the routes go in undecided instead.
  const routes = hubAnswering ? await probePoolRoutes(base) : POOL_ROUTE_COMMANDS.map((entry) => ({ ...entry, servedByHub: null as boolean | null }));
  checks.push(checkPoolCommandParity(routes, options.cliSubcommands ?? null, repo.root));
  return checks;
}

async function collectSectionC(apiPort: number, hubAnswering: boolean): Promise<PoolCheck[]> {
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
export async function measureColdCapabilityBuild(
  base: string,
  fetchProbe: TimedFetch = timedFetch,
): Promise<{ totalMs: number; halves: string[]; statusProbe: HttpProbe; measuredBothHalves: boolean }> {
  const health = () => fetchProbe(`${base}/api/inference/health`, CAPABILITY_PROBE_TIMEOUT_MS);

  // Nothing is called before this line: any warm-up request would prime the very fan-out being
  // timed, and a warm number is the one measurement this check must never report.
  const started = performance.now();
  const [statusProbe, modelsProbe] = await Promise.all([health(), fetchProbe(`${base}/api/inference/v1/models`, CAPABILITY_PROBE_TIMEOUT_MS)]);
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

async function collectSectionD(base: string, envFileName: string, apiKey: string | undefined, options: PoolDoctorOptions): Promise<PoolCheck[]> {
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
      id: 'D1',
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
  // Three states, not two: `null` is "could not read the container environment" and must not
  // collapse into "the container environment has none of these" — see {@link BackendVarsSource}.
  const varsSource: BackendVarsSource = containerVars === null ? 'unreadable' : Object.keys(containerVars).length > 0 ? 'container' : 'file';
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
      modelsProbe.ok
        ? 'skipped — no text model is resident on an engine right now, and a cold load measures the load, not the budget'
        : 'skipped — could not list models to pick one (see A2)',
    );
  }

  // Whether the answer can be attributed to THIS node has to be known before the number is
  // believed: /v1/chat/completions auto-upgrades to pooled routing when any peer is connected.
  const pooled = await hasConnectedPeers(base, apiKey);

  const probe = await timedFetch(`${base}/api/inference/v1/chat/completions`, NON_STREAMING_PROBE_TIMEOUT_MS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      // A prompt that actually produces the tokens asked for: an engine that buffers has to buffer
      // something before the check can see it doing so.
      messages: [{ role: 'user', content: 'Count from 1 to 100, separated by spaces.' }],
      max_tokens: NON_STREAMING_PROBE_MAX_TOKENS,
      stream: false,
    }),
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

/** Section headers, in render order. The letters an operator and a bug report name a line by. */
const SECTION_HEADERS: readonly { letter: string; title: string }[] = [
  { letter: 'A', title: 'Can this node be a pool member at all?' },
  { letter: 'B', title: 'Version reconciliation — is this node running the code it believes it is?' },
  { letter: 'C', title: 'Tailnet reachability — the transport peers use, which has no fallback' },
  { letter: 'D', title: 'Peer budget — what a peer measures before it decides this node is unreachable' },
  { letter: 'E', title: "Host bridge — the Hub container's path to host inference backends" },
];

/**
 * Run one section, and let a fault inside it take down that section ALONE.
 *
 * The single outer catch was not enough: an unexpected error anywhere threw away sections that had
 * already completed and skipped the ones after it, leaving the operator one line — `unavailable
 * (...)` — with `issueCount: 0`, which `cli-pool.ts` paints as a clean cyan box. Verified by
 * injecting a throw into section C: A and B had finished, and their results were discarded.
 */
async function collectSectionSafely(letter: string, collapsed: string[], run: () => Promise<PoolCheck[]>): Promise<PoolCheck[]> {
  try {
    return await run();
  } catch (error) {
    collapsed.push(letter);
    return [
      {
        // `unknown`, because nothing about the NODE was decided here — but the run still counts an
        // issue for it below, so a report with a collapsed section can never render as all-clear.
        id: `${letter}0`,
        label: 'Section unavailable',
        verdict: 'unknown',
        detail: `section ${letter} could not be collected (${sanitizeForBox(error instanceof Error ? error.message : String(error))})`,
        notes: [
          'This is a fault in the doctor, not a verdict about this node: the checks in this section',
          'never ran. Every other section below is unaffected and was collected normally.',
        ],
      },
    ];
  }
}

async function collectPoolDoctorSection(envFileName: string, options: PoolDoctorOptions): Promise<PoolDoctorSection> {
  const env = options.env ?? 'prod';
  const foundation = readEnvFoundation(envFileName);
  const apiPort = foundation.apiPort ?? DEFAULT_API_PORT;
  const base = `http://127.0.0.1:${apiPort}`;
  // Read, never printed. Reaching an authenticated route with it is fine; disclosing it is not.
  const apiKey = readHubApiKey(envFileName);
  const collapsed: string[] = [];

  // Each section prints as it lands. Sequential and bounded, the worst case is minutes on precisely
  // the broken node this targets, and `runPoolCommand` cannot render the box until the last probe
  // returns — so without this the operator watches a frozen terminal and reaches for Ctrl-C.
  const started = performance.now();
  const announce = (letter: string, title: string) => {
    const elapsed = performance.now() - started;
    options.onSectionDone?.(`${letter}  ${title} — ${(elapsed / 1000).toFixed(1)}s`, elapsed);
  };
  const header = (letter: string) => SECTION_HEADERS.find((entry) => entry.letter === letter) ?? { letter, title: '' };

  let health: HttpProbe = { ok: false, status: null, ms: 0, body: '', error: 'section A did not complete' };
  const sectionA = await collectSectionSafely('A', collapsed, async () => {
    const collected = await collectSectionA(foundation, base, apiPort, env);
    health = collected.health;
    return collected.checks;
  });
  announce('A', header('A').title);
  const sectionB = await collectSectionSafely('B', collapsed, () => collectSectionB(base, health.ok, env, options));
  announce('B', header('B').title);
  const sectionC = await collectSectionSafely('C', collapsed, () => collectSectionC(apiPort, health.ok));
  announce('C', header('C').title);
  const sectionD = await collectSectionSafely('D', collapsed, () => collectSectionD(base, envFileName, apiKey, options));
  announce('D', header('D').title);
  // Section E is the existing bridge module, unchanged: it already probes from inside the container
  // (the only vantage where a filtered bridge is visible) and already derives the ufw rule.
  const bridge = await runBridgeDoctorSection(envFileName).catch((error: unknown) => {
    collapsed.push('E');
    return {
      lines: [`Docker bridge            unavailable (${sanitizeForBox(error instanceof Error ? error.message : String(error))})`],
      issueCount: 0,
      remediationCommands: [],
    };
  });
  announce('E', header('E').title);

  const checks = [...sectionA, ...sectionB, ...sectionC, ...sectionD];
  // A collapsed section is counted even though its line is `unknown`: the two are different claims.
  // The line says nothing was decided about the node; the count says this report is not all-clear.
  const issueCount = countPoolIssues(checks) + bridge.issueCount + collapsed.length;
  const remediationCommands = [...checks.flatMap((check) => check.commands ?? []), ...bridge.remediationCommands];

  const lines = [
    `Hub Pool preflight       ${summarisePoolChecks(checks)}${collapsed.length > 0 ? `, ${collapsed.length} section(s) unavailable` : ''}`,
    ...(foundation.apiPort === null ? [dim(`  API_PORT was not set, so every probe above used the default ${DEFAULT_API_PORT}.`)] : []),
    '',
    ...SECTION_HEADERS.flatMap(({ letter, title }, index) => [
      ...(index === 0 ? [] : ['']),
      dim(`${letter}  ${title}`),
      ...(letter === 'E'
        ? bridge.lines.map((line) => `  ${line}`)
        : formatPoolCheckLines({ A: sectionA, B: sectionB, C: sectionC, D: sectionD }[letter] ?? [])),
    ]),
  ];

  return { lines, issueCount, remediationCommands };
}
