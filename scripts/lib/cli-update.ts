/**
 * Version reporting, host updates, and connecting an existing BYO agent.
 *
 * `cihub update` deliberately delegates to the installed `companion-hub` desktop binary rather
 * than reimplementing the download/verify/relaunch dance: that binary owns its own replacement.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseEnvFile } from '../env-file.js';
import { usageAndExit } from './cli-args.js';
import { isApplianceMode } from './cli-repo-context.js';
import { BASE_COMMAND } from './cli-types.js';
import { colorize, printMessageBox } from './cli-ui.js';
import { envFileMap, packageVersion } from './cli-compose-env.js';
import { resolveProdApplianceContext } from './paths.js';
import { connectAgent, normalizeMemoryUrl, parseConnectArgs } from './connect-agent.js';
import { promptHiddenPassword } from './seed-appliance.js';

export function renderVersion(): string {
  return `${BASE_COMMAND} ${packageVersion()}`;
}

/**
 * Build identity as `GET /api/hub/build` reports it. Mirrors `HubBuildInfo` in
 * `packages/backend/src/core/build-info/hub-build-info.ts`; every field is optional here because
 * this CLI talks to Hubs older than that endpoint.
 */
export type HubBuildInfoResponse = {
  version?: string | null;
  channel?: string | null;
  gitSha?: string | null;
  gitShaShort?: string | null;
  builtAt?: string | null;
  imageRef?: string | null;
  imageDigest?: string | null;
  source?: string | null;
  declaredVersion?: string | null;
  summary?: string | null;
};

/** Short: `cihub version` must answer promptly on a Hub that is down, not hang waiting for one. */
const HUB_BUILD_TIMEOUT_MS = 2_500;

/**
 * The running Hub's build, or null when this node has none reachable.
 *
 * Null covers three different, equally ordinary states — no Hub running, an older Hub without the
 * endpoint (404), a Hub still starting — and `cihub version` prints the same "not reachable" line
 * for all of them. Distinguishing them is `cihub status`'s job, not this command's.
 */
export async function fetchHubBuildInfo(apiBase: string, timeoutMs = HUB_BUILD_TIMEOUT_MS): Promise<HubBuildInfoResponse | null> {
  try {
    const res = await fetch(`${apiBase}/api/hub/build`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as HubBuildInfoResponse) : null;
  } catch {
    return null;
  }
}

/**
 * The `hub` lines of `cihub version`.
 *
 * Deliberately verbose about provenance rather than printing one number. The failure this replaces
 * was a Hub reporting a confident, wrong version: `CI_HUB_VERSION` from the install's env file, which
 * no build writes and which was wrong on 10 of 16 fleet Hubs. So the build stamp and the env file's
 * claim are printed as two separate facts, and when they disagree the output says so — an operator
 * comparing a node against GHCR needs to see which of the two they have been reading.
 */
export function formatHubBuildLines(info: HubBuildInfoResponse | null, apiBase: string): string[] {
  if (!info) {
    return [`hub    not reachable at ${apiBase}`];
  }

  if (info.source === 'unstamped' || (!info.version && !info.gitSha)) {
    // Predates the build stamp, or was built locally. Saying so is the honest answer; the env
    // file's number is shown only as the unreliable claim it is.
    const declared = info.declaredVersion ? ` (env file claims ${info.declaredVersion})` : '';
    return [`hub    unidentified build — this image carries no build stamp${declared}`];
  }

  const lines = [`hub    ${info.summary?.trim() || info.version || info.gitShaShort || 'unknown'}`];
  if (info.channel) lines.push(`       channel ${info.channel}`);
  if (info.imageRef) lines.push(`       image   ${info.imageRef}`);
  // The digest is the only thing that separates two images sharing a tag — the measured case was
  // 17 appliances on one untagged index while `:latest` and `:dev` were two other indexes entirely.
  if (info.imageDigest) lines.push(`       digest  ${info.imageDigest}`);
  if (info.builtAt) lines.push(`       built   ${info.builtAt}`);
  if (info.declaredVersion && info.version && normalizeVersionForCompare(info.declaredVersion) !== normalizeVersionForCompare(info.version)) {
    lines.push(`       note    env file says CI_HUB_VERSION=${info.declaredVersion}, which does not match this build`);
  }
  return lines;
}

/** `v0.2.73` and `0.2.73` are the same release; only a real difference is worth warning about. */
function normalizeVersionForCompare(value: string): string {
  return value.trim().replace(/^v(?=\d)/, '');
}

/**
 * `cihub version` — this binary's version, then the running Hub's build.
 *
 * Two artifacts, two answers, and they legitimately differ: rolling the Hub image never updates the
 * `cihub` binary (they ship through separate channels), so printing one number for both would be
 * wrong in the common case.
 */
export async function runVersionCommand(apiBase?: string): Promise<string> {
  const lines = [renderVersion()];
  const base = apiBase ?? resolveDefaultHubApiBase();
  lines.push(...formatHubBuildLines(await fetchHubBuildInfo(base), base));
  return lines.join('\n');
}

/**
 * Where to ask.
 *
 * `cihub version` must answer outside a checkout, with no stack configured, and on a machine that
 * has never run `cihub up`. So this resolves paths only — deliberately NOT through
 * `resolveHubContext`, which in appliance mode can prompt for a Postgres password and seed a fresh
 * install. Asking a binary its version must never write anything.
 *
 * `existsSync` before `parseEnvFile` because that helper is not total on a missing path, and every
 * candidate here is allowed to be absent.
 */
export function resolveDefaultHubApiBase(): string {
  const port = process.env.API_PORT?.trim() || readApiPortFromEnvFiles() || '5002';
  return `http://127.0.0.1:${port}`;
}

function readApiPortFromEnvFiles(): string | undefined {
  const candidates = isApplianceMode() ? [resolveProdApplianceContext().envFilePath] : [envFileMap.prod, envFileMap.dev, envFileMap.local];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const port = parseEnvFile(candidate).API_PORT?.trim();
      if (port) return port;
    } catch {
      // An unreadable or malformed env file is not a reason to fail `cihub version`.
    }
  }
  return undefined;
}

// --- Host update (delegates to companion-hub binary) ---

/** First non-empty line from `where`/`which` stdout (Windows `where` may return multiple paths). */
export function firstPathFromLookupOutput(output: string): string | undefined {
  const line = output
    .trim()
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || undefined;
}

function resolveExecutableOnPath(name: string): string | undefined {
  const isWindows = process.platform === 'win32';
  const result = isWindows ? spawnSync('where', [name], { encoding: 'utf8', shell: true }) : spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }
  return firstPathFromLookupOutput(result.stdout);
}

export function resolveCompanionHubBinary(): string {
  const candidates = ['companion-hub', 'Companion Hub'];
  for (const name of candidates) {
    const resolved = resolveExecutableOnPath(name);
    if (resolved) {
      return resolved;
    }
  }
  return 'companion-hub';
}

export function runHostUpdate(args: string[]) {
  const checkOnly = args.includes('--check');
  const binary = resolveCompanionHubBinary();
  const cliArgs = checkOnly ? ['update', '--check'] : ['update'];
  const result = spawnSync(binary, cliArgs, { stdio: 'inherit' });
  if (result.error) {
    console.error(`${colorize('Error', 'red')}: Could not run ${binary}. Install CI Hub desktop or run from the app Settings.`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// --- connect an existing agent (BYO) ---

/**
 * Only one reader may own stdin at a time: `promptHiddenPassword` puts the TTY in raw mode itself,
 * so a readline interface left open across it would take half the operator's keystrokes. Hence a
 * fresh interface per visible question, closed again before the hidden one starts.
 */
async function askVisible(label: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

async function askSecret(label: string): Promise<string> {
  try {
    return await promptHiddenPassword(label, input, output);
  } finally {
    // promptHiddenPassword resumes stdin and has no close() to pause it again the way readline does.
    // A flowing stdin keeps the event loop alive, so `cihub connect` would sit at the shell after
    // printing its result instead of exiting.
    input.pause();
  }
}

/**
 * Prompt seam. Held on an object rather than called directly so a test can drive the connect flow
 * without a TTY — `vi.spyOn(prompts, 'askSecret')` replaces the raw-mode reader, which otherwise
 * rejects outright when stdin is a pipe.
 */
export const prompts = { ask: askVisible, askSecret };

/**
 * Fill in whatever `--memory-url` / `--memory-key` did not supply.
 *
 * The API key is read without echo. Typed into a plain readline prompt it lands in scrollback, in
 * the tmux/screen buffer, and in whatever screen share or session recording happens to be running —
 * a long-lived Memory credential handed to everything watching the terminal. The URL is not a
 * secret and stays visible, because a mistyped host is the failure people actually hit.
 *
 * Prompting needs a terminal on stdin *and* stdout, the gate `resolvePostgresPassword` already uses:
 * `promptHiddenPassword` rejects without both, and stdout matters because the label and the trailing
 * newline are written there. A piped or CI run therefore falls through to the usage error rather
 * than hanging on a prompt nobody can answer.
 */
async function resolveConnectCredentials(parsed: { memoryUrl?: string; memoryKey?: string }): Promise<{ memoryUrl?: string; memoryKey?: string }> {
  let { memoryUrl, memoryKey } = parsed;
  if (memoryUrl && memoryKey) return { memoryUrl, memoryKey };
  if (!input.isTTY || !output.isTTY) return { memoryUrl, memoryKey };

  if (!memoryUrl) {
    printMessageBox(
      'Companion Memory URL',
      [
        'This Hub can answer on more than one address, and the value is written once.',
        'Use the address this machine can reach — local network, Private VPN, or your',
        'exposed domain. See the connect docs if you are unsure which applies.',
      ],
      'cyan',
    );
    memoryUrl = (await prompts.ask('  Companion Memory URL: ')).trim();
  }
  if (!memoryKey) {
    memoryKey = (await prompts.askSecret('  Companion Memory API key (Settings → API Keys): ')).trim();
  }
  return { memoryUrl, memoryKey };
}

/**
 * `cihub connect openclaw|hermes` — see scripts/lib/connect-agent.ts for the design
 * notes, in particular why the memory-slot guard has to run before the installer.
 */
export async function runConnectCommand(args: string[]) {
  const usage =
    `Usage: ${BASE_COMMAND} connect openclaw|hermes --memory-url <url> --memory-key <key>\n` +
    '                     [--hub-url <url> --hub-key <key>]  also wire Hub MCP\n' +
    '                     [--force]                          claim a foreign memory slot\n' +
    '                     [--dry-run]                        print the plan, write nothing';

  // Parsing lives in connect-agent.ts so its rules can be tested without a terminal.
  const parsed = parseConnectArgs(args);
  if (parsed.error || !parsed.agent) usageAndExit(parsed.error ? `${parsed.error}\n${usage}` : usage);

  const agent = parsed.agent;
  const { hubUrl, hubKey, force, dryRun } = parsed;

  let credentials: { memoryUrl?: string; memoryKey?: string };
  try {
    credentials = await resolveConnectCredentials({ memoryUrl: parsed.memoryUrl, memoryKey: parsed.memoryKey });
  } catch (error) {
    // Ctrl+C at a readline prompt re-raises SIGINT and kills the process; at the hidden prompt it
    // rejects instead, so without this the operator gets a stack trace where they expect nothing.
    console.error(`${colorize('Error', 'red')}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const { memoryUrl, memoryKey } = credentials;

  // Still missing after the prompt, or never prompted because this is not a terminal.
  if (!memoryUrl || !memoryKey) {
    usageAndExit(`${BASE_COMMAND} connect ${agent} needs --memory-url and --memory-key (or a terminal to prompt on).`);
  }

  await connectAgent({ agent, memoryUrl: normalizeMemoryUrl(memoryUrl), memoryKey, hubUrl, hubKey, force, dryRun });
}
