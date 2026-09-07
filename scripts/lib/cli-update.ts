/**
 * Version reporting, host updates, and connecting an existing BYO agent.
 *
 * `cihub update` deliberately delegates to the installed `companion-hub` desktop binary rather
 * than reimplementing the download/verify/relaunch dance: that binary owns its own replacement.
 */
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { usageAndExit } from './cli-args.js';
import { BASE_COMMAND } from './cli-types.js';
import { colorize, printMessageBox } from './cli-ui.js';
import { packageVersion } from './cli-compose-env.js';
import { connectAgent, normalizeMemoryUrl, parseConnectArgs } from './connect-agent.js';
import { promptHiddenPassword } from './seed-appliance.js';

export function renderVersion(): string {
  return `${BASE_COMMAND} ${packageVersion()}`;
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
