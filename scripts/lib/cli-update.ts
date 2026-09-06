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
  let memoryUrl = parsed.memoryUrl;
  let memoryKey = parsed.memoryKey;

  // Prompted only on a TTY. In CI or a pipe, a missing flag is a usage error rather
  // than a hang waiting on stdin nobody is attached to.
  if ((!memoryUrl || !memoryKey) && input.isTTY) {
    const rl = createInterface({ input, output });
    try {
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
        memoryUrl = (await rl.question('  Companion Memory URL: ')).trim();
      }
      if (!memoryKey) {
        memoryKey = (await rl.question('  Companion Memory API key (Settings → API Keys): ')).trim();
      }
    } finally {
      rl.close();
    }
  }

  // Still missing after the prompt, or never prompted because this is not a TTY.
  if (!memoryUrl || !memoryKey) {
    usageAndExit(`${BASE_COMMAND} connect ${agent} needs --memory-url and --memory-key (or a TTY to prompt on).`);
  }

  await connectAgent({ agent, memoryUrl: normalizeMemoryUrl(memoryUrl), memoryKey, hubUrl, hubKey, force, dryRun });
}
