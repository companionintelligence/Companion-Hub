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
  code: 'ok' | 'unauthorized' | 'wrong-path' | 'missing-intents-scope' | 'pre-g1-gateway' | 'unreachable' | 'http-error';
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
    return { ok: true, code: 'ok', message: `Hub MCP is reachable and the key sees ${toolCount} tools.` };
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

/** The anonymous, predictable registry URL the Hermes docs also tell users to curl. */
export function tarballUrl(pkg: string, version: string): string {
  const bare = pkg.split('/').pop() as string;
  return `https://registry.npmjs.org/${pkg}/-/${bare}-${version}.tgz`;
}

// --- paths ------------------------------------------------------------------

export function openClawConfigPath(home = homedir()): string {
  return join(process.env.OPENCLAW_CONFIG_DIR || join(home, '.openclaw'), 'openclaw.json');
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
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${String((error as Error).message)}). Fix or move it before connecting.`);
  }
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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<{ status?: number; body: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, body: await res.text().catch(() => '') };
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
 * Called twice deliberately. A released pre-G1 gateway rejects alternating requests
 * with 400, so a single call has a coin-flip chance of looking healthy — which is
 * exactly how that defect stayed hidden long enough to reach a release.
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
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  const alternating = (first.status === 400) !== (second.status === 400) && (first.status === 400 || second.status === 400);
  if (alternating) return triageMcpProbe(second.status, undefined, true);

  let toolCount: number | undefined;
  // The transport may answer as SSE, so the JSON can be wrapped in `data:` lines.
  const payload = second.body.includes('"result"') ? second.body.slice(second.body.indexOf('{', second.body.indexOf('"result"') - 40)) : second.body;
  try {
    const line = payload.split('\n').find((l) => l.includes('"tools"')) ?? payload;
    const json = JSON.parse(line.replace(/^data:\s*/, '')) as { result?: { tools?: unknown[] } };
    toolCount = json.result?.tools?.length;
  } catch {
    toolCount = undefined;
  }
  return triageMcpProbe(second.status, toolCount);
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
  const existing = readJsonIfPresent(configPath);

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
  const install = run('openclaw', ['plugins', 'install', spec, '--force']);
  if (!install.ok) {
    printMessageBox('Install failed', [install.stderr.trim() || install.stdout.trim() || `openclaw plugins install exited ${install.status}`], 'red');
    if (backup) restoreBackup(configPath, backup);
    process.exit(2);
  }

  // Re-read: the installer just wrote its own entry, and merging onto the pre-install
  // copy would drop it.
  const afterInstall = readJsonIfPresent(configPath);
  const { config: finalConfig, changes: finalChanges } = mergeOpenClawConfig(afterInstall, { url: ctx.memoryUrl, token: ctx.memoryKey });
  writeJsonAtomic(configPath, finalConfig);

  const lint = run('openclaw', ['doctor', '--lint', '--json']);
  const ourFindings = lintFindingsForOurKeys(lint.stdout);
  if (ourFindings.length > 0) {
    if (backup) restoreBackup(configPath, backup);
    printMessageBox(
      'Config rejected — restored from backup',
      [...ourFindings, '', ...(backup ? [`Restored ${configPath} from ${backup}`] : ['No previous config existed to restore.'])],
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

  // `tar -x` overwrites but never removes, so extracting over an older install leaves
  // modules a later version deleted, plus their stale __pycache__, in a directory
  // Python imports from. Credentials live outside this directory, so this is safe.
  rmDirRecursive(dir);
  mkdirSync(dir, { recursive: true });

  const fetched = run('bash', ['-c', `curl -fL ${JSON.stringify(url)} | tar -xz -C ${JSON.stringify(dir)} --strip-components=1`]);
  if (!fetched.ok) {
    printMessageBox('Download failed', [`Could not fetch ${url}`, fetched.stderr.trim() || `exit ${fetched.status}`], 'red');
    process.exit(2);
  }
  if (!existsSync(join(dir, 'plugin.yaml'))) {
    printMessageBox(
      'Install failed',
      [`Extracted archive has no plugin.yaml in ${dir}`, 'Hermes discovers providers by scanning for that file, so it would not be found.'],
      'red',
    );
    process.exit(2);
  }

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
      '',
      `  URL: ${ctx.memoryUrl}`,
      '  Key: the Companion Memory API key you just probed with',
      '',
      'That is a command-line command, not a chat message — typed at the chat prompt,',
      'Hermes will simply answer it and nothing gets configured.',
      '',
      'Then enable `companionintelligence` on the Hermes /plugins page.',
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
