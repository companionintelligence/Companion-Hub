/**
 * `cihub connect openclaw|hermes` — wire a locally-installed agent to this Hub's
 * Companion Memory, using each ecosystem's own official install channel.
 *
 * WHAT THIS IS NOT
 *
 * It is not a second distribution mechanism. The adapters are published packages
 * (`@companionintelligence/openclaw-memory`, `@companionintelligence/hermes-memory`),
 * and the docs describe installing them by hand. This command runs those same steps
 * and fills in the parts the official installers do not do — which for OpenClaw is
 * most of the config, because `plugins install` registers a plugin without selecting
 * it as the memory provider.
 *
 * It configures the machine it RUNS ON. A laptop that is not the Hub host follows the
 * documented manual path instead; that split is the design, not a gap.
 *
 * WHY THE SLOT GUARD RUNS FIRST
 *
 * Live-verified: `openclaw plugins install` force-switches `plugins.slots.memory` even
 * when a FOREIGN provider holds it (observed `memory-lancedb` -> `companionintelligence`,
 * no prompt). So the guard cannot be delegated to the installer — by the time the
 * installer has run, the previous value is already gone. It runs before anything is
 * written, and without `--force` a foreign slot aborts with nothing touched.
 *
 * EXIT CODES
 *   0  connected
 *   1  probe failed — nothing was written
 *   2  write failed — the backup was restored and its path printed
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bold, printMessageBox } from './cli-ui';

/**
 * Pinned deliberately. `connect` must never float on `latest`: the version it installs
 * is the version this Hub release was tested against, and a floating tag turns an
 * unrelated npm publish into an untested change on someone's machine. Bump these in a
 * PR, with the release notes that justify it.
 */
export const PINNED_VERSIONS = {
  openclaw: '2026.8.3',
  hermes: '2026.8.3',
} as const;

export const OPENCLAW_PACKAGE = '@companionintelligence/openclaw-memory';
export const HERMES_PACKAGE = '@companionintelligence/hermes-memory';

/** The plugin's manifest id — the config key, which is NOT the npm package name. */
export const PLUGIN_ID = 'companionintelligence';

export type Agent = 'openclaw' | 'hermes';

// --- probe triage -----------------------------------------------------------
//
// Every failure mode below was either observed live or is documented in the parent
// plan. Returning a named diagnosis rather than a status code is the whole point: a
// bare "401" sends people to re-mint a key when the real fault is the header name.

export type ProbeVerdict = {
  ok: boolean;
  /** Short machine-ish label, used in tests and the summary box. */
  code: 'ok' | 'unauthorized' | 'wrong-path' | 'missing-intents-scope' | 'pre-g1-gateway' | 'unreachable' | 'http-error' | 'rpc-error';
  message: string;
  /** What the operator should actually do. */
  hint?: string;
};

/** Diagnose a Companion Memory `GET /api/health` response. */
export function triageMemoryProbe(status: number | undefined, transportError?: string): ProbeVerdict {
  if (status === undefined) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach Companion Memory: ${transportError ?? 'no response'}`,
      hint: 'Check the URL is reachable from THIS machine. A hub answers on up to three addresses (local network, Private VPN, exposed domain) and only some are routable from here.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: 'unauthorized',
      message: `Companion Memory rejected the key (HTTP ${status}).`,
      hint: 'The key is sent as the x-api-key header, not Authorization: Bearer. Mint one in the memory UI under Settings → API Keys with the memory scope.',
    };
  }
  if (status === 404 || status === 405) {
    return {
      ok: false,
      code: 'wrong-path',
      message: `Companion Memory returned HTTP ${status} for /api/health.`,
      hint: 'Give the server base URL, not an endpoint path. A trailing /api/mcp is stripped for you; anything else is passed through as-is.',
    };
  }
  if (status >= 200 && status < 300) {
    return { ok: true, code: 'ok', message: 'Companion Memory is reachable and the key works.' };
  }
  return { ok: false, code: 'http-error', message: `Companion Memory returned HTTP ${status}.` };
}

/**
 * Diagnose an MCP `tools/list` result.
 *
 * The 0-tools case is the one worth naming. A key without the `intents` scope
 * authenticates fine and lists nothing, which reads as "the server is broken" when it
 * is really "this key may not see any tools".
 */
export function triageMcpProbe(status: number | undefined, toolCount: number | undefined, seenAlternating400 = false): ProbeVerdict {
  if (seenAlternating400) {
    return {
      ok: false,
      code: 'pre-g1-gateway',
      message: 'The Hub MCP gateway rejected every other request with HTTP 400.',
      hint: 'That is the pre-G1 gateway signature: the fix is merged but only lands on appliances running a release built after it. Retry, or update the Hub.',
    };
  }
  if (status === undefined) {
    return { ok: false, code: 'unreachable', message: 'Could not reach the Hub MCP endpoint.' };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: 'unauthorized',
      message: `Hub MCP rejected the key (HTTP ${status}).`,
      hint: 'Hub MCP takes Authorization: Bearer <key>, unlike Companion Memory which takes x-api-key. Mixing the two is the usual cause.',
    };
  }
  if (status === 405) {
    return {
      ok: false,
      code: 'wrong-path',
      message: 'Hub MCP returned HTTP 405.',
      hint: 'The endpoint is /api/mcp. A bare /mcp answers 405 rather than 404, which makes this look like a method problem.',
    };
  }
  if (status >= 200 && status < 300 && toolCount === 0) {
    return {
      ok: false,
      code: 'missing-intents-scope',
      message: 'Hub MCP authenticated the key but returned 0 tools.',
      hint: "The key is missing the 'intents' scope. A key without it authenticates and sees nothing, which is indistinguishable from an empty server unless you know to look.",
    };
  }
  if (status >= 200 && status < 300) {
    // An unreadable body still means the endpoint answered, so this stays a pass — but
    // it must not claim a count it does not have. "sees undefined tools" was the old
    // give-away that the 0-tool check had been skipped.
    return {
      ok: true,
      code: 'ok',
      message:
        toolCount === undefined ? 'Hub MCP is reachable and the key authenticates.' : `Hub MCP is reachable and the key sees ${toolCount} tools.`,
    };
  }
  return { ok: false, code: 'http-error', message: `Hub MCP returned HTTP ${status}.` };
}

// --- memory slot guard ------------------------------------------------------

export type SlotVerdict = { ok: boolean; current?: string; message: string };

/**
 * Decide whether it is safe to claim `plugins.slots.memory`.
 *
 * Ours or unset -> proceed. Anything else is a provider somebody chose on purpose, and
 * the installer would overwrite it silently, so refuse unless `--force`.
 */
export function checkMemorySlot(config: Record<string, unknown>, force: boolean): SlotVerdict {
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const slots = (plugins.slots ?? {}) as Record<string, unknown>;
  const current = typeof slots.memory === 'string' ? slots.memory : undefined;

  if (!current || current === PLUGIN_ID) {
    return { ok: true, current, message: current ? 'Memory slot already points at this plugin.' : 'Memory slot is unset.' };
  }
  if (force) {
    return { ok: true, current, message: `Claiming the memory slot from '${current}' because --force was given.` };
  }
  return {
    ok: false,
    current,
    message:
      `The memory slot is held by '${current}'. Re-run with --force to claim it. ` +
      'Note that installing the plugin by hand would take the slot WITHOUT asking, which is why this check runs before anything is written.',
  };
}

// --- openclaw config merge --------------------------------------------------

export type MergeInput = { url: string; token: string };
export type MergeResult = { config: Record<string, unknown>; changes: string[] };

/**
 * Merge the settings `openclaw plugins install` does not write.
 *
 * Minimal-diff on purpose: every key is set only if it differs, and `tools.alsoAllow`
 * is appended to rather than replaced. `tools.allow` is never created — it is an
 * exclusive allowlist, so bringing it into existence denies every tool not named in
 * it, which would break unrelated things on the user's machine.
 */
/**
 * Descend into `parent[key]`, creating an object there if what is present cannot hold
 * keys.
 *
 * Not `??=`: that only replaces null/undefined, so a config with `plugins: "core"` — a
 * hand-edit, or a schema change upstream — would sail through and then throw on the
 * first property write, halfway through the merge. Anything that is not a plain object
 * is replaced.
 */
function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

export function mergeOpenClawConfig(existing: Record<string, unknown>, input: MergeInput): MergeResult {
  const changes: string[] = [];
  // Structured clone keeps the caller's object untouched, so a failed lint can restore
  // from the backup without the in-memory copy having drifted.
  const config = structuredClone(existing) as Record<string, unknown>;

  const plugins = ensureObject(config, 'plugins');
  const slots = ensureObject(plugins, 'slots');
  if (slots.memory !== PLUGIN_ID) {
    slots.memory = PLUGIN_ID;
    changes.push(`plugins.slots.memory = ${PLUGIN_ID}`);
  }

  const entries = ensureObject(plugins, 'entries');
  const entry = ensureObject(entries, PLUGIN_ID);
  if (entry.enabled !== true) {
    entry.enabled = true;
    changes.push(`plugins.entries.${PLUGIN_ID}.enabled = true`);
  }

  // Passive capture needs this. agent_end is a conversation hook and OpenClaw only
  // delivers conversation hooks to a plugin whose entry opts in; without it you get
  // the tools but nothing accumulates, which is the whole point of Tier 2.
  const hooks = ensureObject(entry, 'hooks');
  if (hooks.allowConversationAccess !== true) {
    hooks.allowConversationAccess = true;
    changes.push(`plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess = true`);
  }

  const entryConfig = ensureObject(entry, 'config');
  if (entryConfig.url !== input.url) {
    entryConfig.url = input.url;
    changes.push(`plugins.entries.${PLUGIN_ID}.config.url = ${input.url}`);
  }
  if (entryConfig.token !== input.token) {
    entryConfig.token = input.token;
    changes.push(`plugins.entries.${PLUGIN_ID}.config.token = (set)`);
  }

  // Additive. OpenClaw's group:memory profile carries memory_search and memory_get but
  // not writes, so memory_store has to be named explicitly.
  const tools = ensureObject(config, 'tools');
  const alsoAllow = Array.isArray(tools.alsoAllow) ? (tools.alsoAllow as string[]) : [];
  if (alsoAllow.includes('memory_store')) {
    tools.alsoAllow = alsoAllow;
  } else {
    tools.alsoAllow = [...alsoAllow, 'memory_store'];
    changes.push('tools.alsoAllow += memory_store');
  }

  // Two memory runtimes observing one session both write, and the user gets duplicates.
  const rootHooks = ensureObject(config, 'hooks');
  const internal = ensureObject(rootHooks, 'internal');
  const internalEntries = ensureObject(internal, 'entries');
  const sessionMemory = ensureObject(internalEntries, 'session-memory');
  if (sessionMemory.enabled !== false) {
    sessionMemory.enabled = false;
    changes.push('hooks.internal.entries.session-memory.enabled = false');
  }

  return { config, changes };
}

// --- url helpers ------------------------------------------------------------

/** Strip a trailing slash and a legacy `/api/mcp` suffix, matching both adapters. */
export function normalizeMemoryUrl(url: string): string {
  const base = url.trim().replace(/\/+$/, '');
  return base.endsWith('/api/mcp') ? base.slice(0, -'/api/mcp'.length) : base;
}

/**
 * Reject a URL `fetch` cannot use, before it becomes a misleading network error.
 *
 * A bare `memory.example.com:8642` parses as a URL whose scheme is the hostname, so
 * `fetch` throws and the probe reports "Could not reach Companion Memory" with a hint
 * about firewalls and routing — sending people to inspect a network that is fine.
 *
 * No scheme is guessed. `http` is right for a hub on the local network and `https` for
 * an exposed domain; picking one silently would connect the wrong way or fail just as
 * opaquely. The Hermes wizard does prefix `http://`, so this says so explicitly rather
 * than leaving the two tools quietly disagreeing.
 */
export function urlProblem(url: string, label: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return `${label} is empty.`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${label} is not a URL: ${trimmed}\n  It needs a scheme — http:// on a local network or Private VPN, https:// for an exposed domain.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${label} uses ${parsed.protocol}, and only http:// and https:// can be probed: ${trimmed}\n  A bare host:port parses this way, with the host read as the scheme.`;
  }
  return undefined;
}

/** The anonymous, predictable registry URL the Hermes docs also tell users to curl. */
export function tarballUrl(pkg: string, version: string): string {
  const bare = pkg.split('/').pop() as string;
  return `https://registry.npmjs.org/${pkg}/-/${bare}-${version}.tgz`;
}

// --- paths ------------------------------------------------------------------

/**
 * Resolve the config file OpenClaw itself will read.
 *
 * This has to agree with the CLI exactly, because `connect` edits the same file
 * `openclaw plugins install` does. Disagreeing is worse than not writing at all: the
 * installer takes the memory slot in the REAL config while the merge lands in a file
 * nothing reads, so the machine ends up with the plugin selected and unconfigured — and
 * the slot guard, which reads this path, checks the wrong file and cannot protect a
 * foreign provider it never sees.
 *
 * Verified against the CLI with a marker config: `OPENCLAW_CONFIG_PATH` (a full file
 * path) redirects it and wins when both are set; `OPENCLAW_STATE_DIR` relocates the
 * state directory and is read as `<dir>/openclaw.json`. `--profile <name>` is sugar for
 * setting them under `~/.openclaw-<name>`.
 *
 * `OPENCLAW_CONFIG_DIR` — what this used to read — is honored by nothing. Under it the
 * CLI silently kept using the real config while we wrote somewhere else.
 */
export function openClawConfigPath(home = homedir()): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir || join(home, '.openclaw'), 'openclaw.json');
}

export function hermesPluginDir(home = homedir()): string {
  return join(process.env.HERMES_HOME || join(home, '.hermes'), 'plugins', PLUGIN_ID);
}

/** Timestamped so consecutive runs never overwrite each other's safety net. */
export function backupPathFor(path: string, stamp: string): string {
  return `${path}.${stamp}.bak`;
}

export function timestampForBackup(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

// --- filesystem helpers -----------------------------------------------------

export function readJsonIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String((error as Error).message)}). Fix or move it before connecting.`);
  }
  // Valid JSON that is not an object would merge without complaint and then serialize
  // back as an array or a bare string, silently dropping everything the merge added.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${path} contains ${Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`}, not a config object. Fix or move it before connecting.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write via a temp file and rename. A half-written openclaw.json is not merely a lost
 * edit: OpenClaw's schema is strict, so an invalid file gets quarantined at boot and
 * the user silently loses everything else in it.
 */
export function writeJsonAtomic(path: string, value: unknown) {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function backupFile(path: string, stamp: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const target = backupPathFor(path, stamp);
  copyFileSync(path, target);
  return target;
}

// --- process helpers --------------------------------------------------------

export type RunResult = { ok: boolean; stdout: string; stderr: string; status: number | null };

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: options.env ?? process.env });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

export function commandExists(name: string): boolean {
  const probe = process.platform === 'win32' ? spawnSync('where', [name], { shell: true }) : spawnSync('which', [name]);
  return probe.status === 0;
}

/**
 * `openclaw doctor --lint --json` reports findings for a lot of unrelated things — an
 * unset gateway mode, skills whose binaries are missing. Only findings whose path
 * points into what we wrote can mean WE broke the config, so only those may trigger a
 * restore. Treating any finding as ours would roll back a good write on an unrelated
 * warning, which is worse than not checking.
 */
export function lintFindingsForOurKeys(lintJson: string): string[] {
  let parsed: { findings?: { path?: string; message?: string; severity?: string }[] };
  try {
    parsed = JSON.parse(lintJson) as typeof parsed;
  } catch {
    return [];
  }
  const ours = ['plugins.slots.memory', `plugins.entries.${PLUGIN_ID}`, 'tools.alsoAllow', 'hooks.internal.entries.session-memory'];
  return (parsed.findings ?? [])
    .filter((f) => f.severity === 'error' || f.severity === 'fatal')
    .filter((f) => typeof f.path === 'string' && ours.some((prefix) => (f.path as string).startsWith(prefix)))
    .map((f) => `${f.path}: ${f.message ?? 'invalid'}`);
}

// --- live probes ------------------------------------------------------------

const PROBE_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<{ status?: number; body: string; sessionId?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, body: await res.text().catch(() => ''), sessionId: res.headers.get('mcp-session-id') ?? undefined };
  } catch (error) {
    return { body: '', error: String((error as Error).message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeMemory(baseUrl: string, key: string): Promise<ProbeVerdict> {
  // x-api-key, not Bearer. Both adapters send it this way and the server only reads it
  // from that header; sending Bearer here is a silent 401.
  const res = await fetchWithTimeout(`${baseUrl}/api/health`, { method: 'GET', headers: { 'x-api-key': key, Accept: 'application/json' } });
  return triageMemoryProbe(res.status, res.error);
}

/**
 * Probe Hub MCP with `initialize` then `tools/list`.
 *
 * The session header is not optional. The Hub answers `initialize` with an
 * `Mcp-Session-Id` and REQUIRES it on every later message — a `tools/list` without it
 * is rejected 400 "Missing Mcp-Session-Id header" by mcp.controller.ts before the SDK
 * is ever reached. Omitting it made a perfectly healthy Hub look like the pre-G1
 * gateway below, on every run.
 *
 * Sent only when the server issued one: a Hub configured stateless (no
 * `sessionIdGenerator`) returns no header and validates no session, and inventing one
 * there would earn a 404 "Session not found".
 *
 * `notifications/initialized` is deliberately not sent. The SDK marks the transport
 * initialized on the initialize REQUEST, so `tools/list` is already allowed, and a
 * notification would be one more thing to get wrong for no gain.
 *
 * Both messages are sent so the pre-G1 gateway is still caught: it rejected alternating
 * requests with 400, so a single call had a coin-flip chance of looking healthy — which
 * is how that defect stayed hidden long enough to reach a release.
 */
export async function probeHubMcp(baseUrl: string, key: string): Promise<ProbeVerdict> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/mcp`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

  const first = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cihub-connect', version: '1' } },
    }),
  });
  const second = await fetchWithTimeout(url, {
    method: 'POST',
    headers: first.sessionId ? { ...headers, 'Mcp-Session-Id': first.sessionId } : headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  // Release the session we just created rather than leaving it for the Hub's 30-minute
  // reaper. Best-effort — a probe that cannot clean up is still a successful probe.
  if (first.sessionId) {
    await fetchWithTimeout(url, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': first.sessionId } }).catch(() => undefined);
  }

  const alternating = (first.status === 400) !== (second.status === 400);
  if (alternating) return triageMcpProbe(second.status, undefined, true);

  const parsed = parseToolsListBody(second.body);
  // JSON-RPC carries application errors INSIDE a 200, so the status alone says nothing.
  // Reporting "reachable" here would wave through a server that just refused the call.
  if (parsed.rpcError && second.status !== undefined && second.status >= 200 && second.status < 300) {
    return { ok: false, code: 'rpc-error', message: `Hub MCP answered tools/list with an error: ${parsed.rpcError}` };
  }
  return triageMcpProbe(second.status, parsed.toolCount);
}

/**
 * Pull the tool count out of a `tools/list` response.
 *
 * Handles both shapes the streamable-HTTP transport can answer with: a plain JSON body,
 * and an SSE stream where the JSON arrives in `data:` lines. Per the SSE grammar,
 * consecutive `data:` lines in one event concatenate with newlines, and a blank line
 * ends the event.
 *
 * This replaces a scan that started slicing 40 characters before `"result"`. That held
 * only while `"result"` stayed within 40 characters of the envelope's opening brace —
 * any field ahead of it (a `_meta` block, a string request id) pushed it past, the slice
 * landed on the inner `{"tools":...}` brace, and the parse failed. A failed parse then
 * read as "reachable, sees undefined tools": success, with the 0-tool check — the whole
 * reason for counting — silently skipped.
 */
export function parseToolsListBody(body: string): { toolCount?: number; rpcError?: string } {
  const candidates: string[] = [];
  let event: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') {
      if (event.length > 0) candidates.push(event.join('\n'));
      event = [];
      continue;
    }
    // `data:foo` and `data: foo` are the same field; only one leading space is stripped.
    if (line.startsWith('data:')) event.push(line.slice(5).replace(/^ /, ''));
  }
  if (event.length > 0) candidates.push(event.join('\n'));
  // A plain JSON body has no `data:` lines at all, so try it whole as well.
  candidates.push(body.trim());

  let rpcError: string | undefined;
  for (const candidate of candidates) {
    if (candidate === '') continue;
    let json: { result?: { tools?: unknown[] }; error?: { message?: string; code?: number } };
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(json.result?.tools)) return { toolCount: json.result.tools.length };
    // Keep looking — an SSE stream may carry notifications before the real answer.
    if (json.error && rpcError === undefined) rpcError = json.error.message ?? `code ${json.error.code}`;
  }
  return { rpcError };
}

// --- orchestration ----------------------------------------------------------

export type ConnectOptions = {
  agent: Agent;
  memoryUrl: string;
  memoryKey: string;
  hubUrl?: string;
  hubKey?: string;
  force: boolean;
  dryRun: boolean;
};

/**
 * Probe everything BEFORE touching disk, then write.
 *
 * The ordering is the contract: a failed probe must leave the machine exactly as it
 * was, so nobody has to work out whether a half-connected agent needs undoing.
 */
export async function connectAgent(options: ConnectOptions): Promise<never> {
  const { agent, memoryUrl, memoryKey, hubUrl, hubKey, force, dryRun } = options;

  // Before probing, so a malformed URL is named as such instead of surfacing as an
  // unreachable host with a hint about firewalls.
  const urlProblems = [urlProblem(memoryUrl, '--memory-url'), ...(hubUrl ? [urlProblem(hubUrl, '--hub-url')] : [])].filter(
    (p): p is string => p !== undefined,
  );
  if (urlProblems.length > 0) {
    printMessageBox('Cannot connect — nothing was written', urlProblems, 'red');
    process.exit(1);
  }

  const memoryVerdict = await probeMemory(memoryUrl, memoryKey);
  const hubVerdict = hubUrl && hubKey ? await probeHubMcp(hubUrl, hubKey) : undefined;

  const failed = [memoryVerdict, ...(hubVerdict ? [hubVerdict] : [])].filter((v) => !v.ok);
  if (failed.length > 0) {
    printMessageBox(
      'Cannot connect — nothing was written',
      failed.flatMap((v) => [`${v.code}: ${v.message}`, ...(v.hint ? [`  ${v.hint}`] : []), '']),
      'red',
    );
    process.exit(1);
  }

  const lines: string[] = [memoryVerdict.message, ...(hubVerdict ? [hubVerdict.message] : [])];

  if (agent === 'openclaw') {
    await connectOpenClaw({ memoryUrl, memoryKey, hubUrl, hubKey, force, dryRun, lines });
  } else {
    await connectHermes({ memoryUrl, memoryKey, hubUrl, hubKey, dryRun, lines });
  }
  process.exit(0);
}

type AgentContext = {
  memoryUrl: string;
  memoryKey: string;
  hubUrl?: string;
  hubKey?: string;
  force?: boolean;
  dryRun: boolean;
  lines: string[];
};

async function connectOpenClaw(ctx: AgentContext): Promise<void> {
  const configPath = openClawConfigPath();

  // An unreadable config is a "nothing was written" failure like any other, so it gets
  // the same box and the same exit 1. Letting it propagate would reach the CLI's
  // top-level catch and print a raw stack over the advice the user needs.
  let existing: Record<string, unknown>;
  try {
    existing = readJsonIfPresent(configPath);
  } catch (error) {
    printMessageBox('Cannot connect — nothing was written', [String((error as Error).message)], 'red');
    process.exit(1);
  }

  // FIRST. The installer would overwrite a foreign slot without asking.
  const slot = checkMemorySlot(existing, ctx.force === true);
  if (!slot.ok) {
    printMessageBox('Cannot connect — nothing was written', [slot.message], 'red');
    process.exit(1);
  }

  const { changes } = mergeOpenClawConfig(existing, { url: ctx.memoryUrl, token: ctx.memoryKey });
  const spec = `npm:${OPENCLAW_PACKAGE}@${PINNED_VERSIONS.openclaw}`;

  if (ctx.dryRun) {
    printMessageBox(
      'Dry run — nothing written',
      [
        ...ctx.lines,
        '',
        `${bold('would install')}  openclaw plugins install ${spec}`,
        `${bold('would edit')}     ${configPath}`,
        ...(changes.length > 0 ? changes.map((c) => `  ${c}`) : ['  (config already matches)']),
        ...(ctx.hubUrl ? ['', `${bold('would add')}      openclaw mcp add ci-hub --url ${ctx.hubUrl}/api/mcp`] : []),
      ],
      'yellow',
    );
    return;
  }

  if (!commandExists('openclaw')) {
    printMessageBox(
      'Cannot connect — nothing was written',
      ['`openclaw` is not on PATH.', 'Install it first, or follow the manual path in the connect docs on the machine that has it.'],
      'red',
    );
    process.exit(1);
  }

  const stamp = timestampForBackup(new Date());
  const backup = backupFile(configPath, stamp);

  // The installer edits config too, so the backup has to be taken before it runs.
  //
  // Its `--force` is unrelated to ours: it means "overwrite an existing installed
  // plugin", which is what re-running connect to upgrade should do. It grants nothing
  // about the memory slot — the installer claims that either way, which is why the
  // guard above had to run first.
  const install = run('openclaw', ['plugins', 'install', spec, '--force']);
  if (!install.ok) {
    printMessageBox('Install failed', [install.stderr.trim() || install.stdout.trim() || `openclaw plugins install exited ${install.status}`], 'red');
    if (backup) restoreBackup(configPath, backup);
    process.exit(2);
  }

  // Re-read: the installer just wrote its own entry, and merging onto the pre-install
  // copy would drop it. This can throw — the installer owns the file between the backup
  // and here — and exit 2 promises the backup goes back, so it cannot escape.
  let afterInstall: Record<string, unknown>;
  try {
    afterInstall = readJsonIfPresent(configPath);
  } catch (error) {
    if (backup) restoreBackup(configPath, backup);
    printMessageBox(
      'Config unreadable after install',
      [String((error as Error).message), '', ...(backup ? [`Restored ${configPath} from ${backup}`] : [])],
      'red',
    );
    process.exit(2);
  }
  const { config: finalConfig, changes: finalChanges } = mergeOpenClawConfig(afterInstall, { url: ctx.memoryUrl, token: ctx.memoryKey });
  writeJsonAtomic(configPath, finalConfig);

  const lint = run('openclaw', ['doctor', '--lint', '--json']);
  const ourFindings = lintFindingsForOurKeys(lint.stdout);
  if (ourFindings.length > 0) {
    if (backup) restoreBackup(configPath, backup);
    printMessageBox(
      // Only claim a restore when one happened. With no prior config there is no
      // known-good state to return to, and saying otherwise hides a file still on disk.
      backup ? 'Config rejected — restored from backup' : 'Config rejected — left in place',
      [
        ...ourFindings,
        '',
        ...(backup
          ? [`Restored ${configPath} from ${backup}`]
          : ['There was no config before this run, so nothing was restored.', `Review or delete ${configPath}, then re-run.`]),
      ],
      'red',
    );
    process.exit(2);
  }

  if (ctx.hubUrl && ctx.hubKey) {
    const mcp = run('openclaw', [
      'mcp',
      'add',
      'ci-hub',
      '--url',
      `${ctx.hubUrl.replace(/\/+$/, '')}/api/mcp`,
      '--transport',
      'streamable-http',
      '--header',
      `Authorization=Bearer ${ctx.hubKey}`,
    ]);
    ctx.lines.push(mcp.ok ? 'Hub MCP server added as `ci-hub`.' : `Hub MCP add failed: ${mcp.stderr.trim() || mcp.status}`);
  }

  printMessageBox(
    'Connected',
    [
      ...ctx.lines,
      '',
      `${bold('installed')}  ${OPENCLAW_PACKAGE}@${PINNED_VERSIONS.openclaw}`,
      `${bold('config')}     ${configPath}`,
      ...(backup ? [`${bold('backup')}     ${backup}`] : []),
      ...(finalChanges.length > 0 ? ['', 'Changed:', ...finalChanges.map((c) => `  ${c}`)] : []),
      '',
      'Restart the OpenClaw gateway, then verify:',
      '  openclaw plugins inspect companionintelligence --runtime --json',
      'Look for "status": "loaded" and "activationReason": "selected memory slot".',
      'Or run /ci-memory in a session to check connectivity.',
    ],
    'green',
  );
}

async function connectHermes(ctx: AgentContext): Promise<void> {
  const dir = hermesPluginDir();
  const url = tarballUrl(HERMES_PACKAGE, PINNED_VERSIONS.hermes);

  if (ctx.dryRun) {
    printMessageBox(
      'Dry run — nothing written',
      [
        ...ctx.lines,
        '',
        `${bold('would fetch')}    ${url}`,
        `${bold('would extract')}  ${dir}`,
        '',
        'Then hand off to `hermes memory setup`, which owns the credentials.',
      ],
      'yellow',
    );
    return;
  }

  // Staged, then swapped. Downloading straight into `dir` means clearing it first —
  // `tar -x` overwrites but never removes, so extracting over an older install would
  // leave modules a later version deleted, plus their stale __pycache__, in a directory
  // Python imports from. But clearing first makes a network blip destroy a working
  // install: the user ends up with no plugin and an exit 2. Staging alongside gives
  // both — a clean tree, and an existing install that survives every failure up to the
  // rename. Credentials live outside this directory, so the swap loses nothing.
  const staging = `${dir}.incoming`;
  rmDirRecursive(staging);
  mkdirSync(staging, { recursive: true });

  // pipefail: without it the pipeline reports tar's status, so a curl that dies partway
  // through would be judged by whether tar could still read what arrived.
  const fetched = run('bash', [
    '-c',
    `set -o pipefail; curl -fL ${JSON.stringify(url)} | tar -xz -C ${JSON.stringify(staging)} --strip-components=1`,
  ]);
  if (!fetched.ok) {
    rmDirRecursive(staging);
    printMessageBox(
      'Download failed — nothing was changed',
      [
        `Could not fetch ${url}`,
        fetched.stderr.trim() || `exit ${fetched.status}`,
        ...(existsSync(dir) ? ['', `Any existing install at ${dir} was left alone.`] : []),
      ],
      'red',
    );
    process.exit(2);
  }
  if (!existsSync(join(staging, 'plugin.yaml'))) {
    rmDirRecursive(staging);
    printMessageBox(
      'Install failed — nothing was changed',
      ['The downloaded archive has no plugin.yaml.', 'Hermes discovers providers by scanning for that file, so it would not be found.'],
      'red',
    );
    process.exit(2);
  }

  rmDirRecursive(dir);
  renameSync(staging, dir);

  printMessageBox(
    'Plugin installed — one step left',
    [
      ...ctx.lines,
      '',
      `${bold('installed')}  ${HERMES_PACKAGE}@${PINNED_VERSIONS.hermes}`,
      `${bold('path')}       ${dir}`,
      '',
      'Credentials are owned by the Hermes wizard, which runs its own connection test',
      'and saves nothing if it fails. Finish with:',
      '',
      '  hermes memory setup',
      // Not a failure: installing the plugin ahead of the CLI is legitimate, and the
      // plugin directory is all this command owns. But the one remaining step is a
      // command, so say plainly that it is not runnable yet rather than let it fail.
      ...(commandExists('hermes') ? [] : ['', '  Note: `hermes` is not on PATH yet, so that step cannot run here yet.']),
      '',
      `  URL: ${ctx.memoryUrl}`,
      '  Key: the Companion Memory API key you just probed with',
      '',
      'That is a command-line command, not a chat message — typed at the chat prompt,',
      'Hermes will simply answer it and nothing gets configured.',
      '',
      'The wizard is the whole activation. `hermes plugins list` and the /plugins page',
      'will still show this as "not enabled" — that registry does not apply to memory',
      'providers (Hermes routes them to its own discovery), so enabling it there changes',
      'nothing and only raises a tool-override grant this plugin has no use for.',
      '',
      'Confirm with `hermes memory status` — it should report the provider as available.',
    ],
    'green',
  );
}

function restoreBackup(path: string, backup: string) {
  copyFileSync(backup, path);
  chmodSync(path, 0o600);
}

function rmDirRecursive(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
