/**
 * Version reporting, host updates, and connecting an existing BYO agent.
 *
 * `cihub update` deliberately delegates to the installed `companion-hub` desktop binary rather
 * than reimplementing the download/verify/relaunch dance: that binary owns its own replacement.
 * What it does NOT delegate is the question of whether the two channels agree — the CLI ships on
 * one and the Hub stack image on another, and nothing used to notice when they drifted apart. Every
 * update entry point now opens with that answer; see cli-version-skew.ts.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { usageAndExit } from './cli-args.js';
import { BASE_COMMAND } from './cli-types.js';
import { colorize, printMessageBox } from './cli-ui.js';
import { packageRevision, packageVersion } from './cli-compose-env.js';
import { describeTarget, installBinaryOverSelf, planSelfUpdate, selfUpdateUsage } from './cli-self-update.js';
import { classifyCliInstall, cliUpdateInstructions, gatherSkew, type SkewReport, type SkewSnapshot } from './cli-version-skew.js';
import { connectAgent, normalizeMemoryUrl, parseConnectArgs } from './connect-agent.js';
import { downloadReleaseAsset } from './fleet-cihub-binary.js';
import { promptHiddenPassword } from './seed-appliance.js';

/**
 * `cihub version` now names the commit too when the build stamped one.
 *
 * A release build says `cihub 0.2.73` and nothing more, because the version IS the identity. A
 * `dev`, PR or pre-tag build shares a version string with every other build of that line, and
 * reporting only that is how an appliance and a laptop both claimed `0.2.72` while running
 * different code.
 */
export function renderVersion(): string {
  const revision = packageRevision();
  return revision ? `${BASE_COMMAND} ${packageVersion()} (${revision.slice(0, 9)})` : `${BASE_COMMAND} ${packageVersion()}`;
}

/** The colour a skew report is printed in — the same mapping everywhere it is shown. */
export function skewBoxColor(report: SkewReport): 'red' | 'yellow' | 'cyan' {
  return report.severity === 'fail' ? 'red' : report.severity === 'warn' ? 'yellow' : 'cyan';
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

/**
 * `cihub update` — report where the two channels stand, then move the one this binary can move.
 *
 * The report comes first and always, including on `--check`, because it is the only place the two
 * versions are ever named side by side. The delegation below is unchanged: the desktop binary owns
 * its own replacement, and the `cihub` inside it comes along for free.
 *
 * What changed is the failure. `companion-hub` is not installed on a headless appliance, so this
 * used to end at "Install CI Hub desktop" — advice that does not apply to the machine it was
 * printed on, on the machines where the skew actually bites. Now it names the command for the
 * channel this CLI really came from.
 */
export async function runHostUpdate(args: string[]) {
  const checkOnly = args.includes('--check');
  const snapshot = gatherSkew();
  printMessageBox('CLI and Hub stack', snapshot.report.lines, skewBoxColor(snapshot.report));

  const binary = resolveCompanionHubBinary();
  const result = spawnSync(binary, checkOnly ? ['update', '--check'] : ['update'], { stdio: 'inherit' });
  if (!result.error) {
    // A proven version mismatch survives a successful desktop update — the stack is the other
    // channel — so it must not be reported as a clean run.
    process.exit(result.status || (snapshot.report.severity === 'fail' ? 1 : 0));
  }

  // No desktop app on this machine: the appliance case, and the one where the skew actually bites.
  // `cihub update` used to end here with "Install CI Hub desktop", advice that does not apply to a
  // headless node. A standalone binary CAN update itself, so this is the one command either way.
  if (snapshot.channel.kind === 'standalone') {
    printMessageBox(
      'No desktop app on this machine',
      [`${binary} is not installed here.`, 'This cihub is a standalone binary, so it updates itself instead.'],
      'cyan',
    );
    await runSelfUpdateCommand(checkOnly ? ['--check'] : [], snapshot);
    return;
  }

  printMessageBox(
    'Nothing to update from here',
    [
      `${binary} is not installed here, so there is no desktop update to run.`,
      'This cihub came from somewhere else; update it with:',
      ...cliUpdateInstructions(snapshot.channel, snapshot.stack?.version ?? undefined).map((line) => `  ${line}`),
      '',
      `The Hub stack is a separate channel: ${BASE_COMMAND} pool update`,
    ],
    'yellow',
  );
  // Exit 1 whether or not this was a check: nothing was updated, and a scripted caller that treats
  // 0 as "up to date" would be wrong.
  process.exit(1);
}

/**
 * `cihub self-update` — replace this standalone binary with the release the stack runs.
 *
 * See cli-self-update.ts for why the package-manager channels are refused and why this needs a
 * token. Nothing here touches the Hub stack: `cihub pool update` is that half, and keeping them
 * apart is what lets an operator fix one without recreating containers to do it.
 */
export async function runSelfUpdateCommand(args: string[], gathered?: SkewSnapshot) {
  for (const arg of args) {
    if (arg !== '--check' && arg !== '--to' && !arg.startsWith('--to=') && !/^\d/.test(arg) && !/^v\d/.test(arg)) {
      usageAndExit(`Unknown argument: ${arg}\n${selfUpdateUsage(BASE_COMMAND)}`);
    }
  }
  const checkOnly = args.includes('--check');
  const toFlag = args.indexOf('--to');
  const inlineTo = args.find((arg) => arg.startsWith('--to='));
  const requestedVersion = inlineTo ? inlineTo.slice('--to='.length) : toFlag >= 0 ? args[toFlag + 1] : undefined;
  if ((toFlag >= 0 && !requestedVersion) || (inlineTo && !requestedVersion)) usageAndExit(selfUpdateUsage(BASE_COMMAND));

  // `cihub update` has already gathered and printed this; re-reading it would print the box twice.
  const snapshot = gathered ?? gatherSkew();
  if (!gathered) printMessageBox('CLI and Hub stack', snapshot.report.lines, skewBoxColor(snapshot.report));

  const plan = planSelfUpdate({
    channel: classifyCliInstall(process.execPath),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    requestedVersion,
    stackVersion: snapshot.stack?.version ?? null,
  });
  if (!plan.ok) {
    printMessageBox('Cannot self-update', [plan.why, '', ...plan.fix.map((line) => `  ${line}`)], 'yellow');
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    printMessageBox(
      'Self-update (check only)',
      [
        `Would install ${plan.assetName} ${plan.version} — ${plan.reason}.`,
        `Over ${describeTarget(plan.target)}.`,
        'Nothing was downloaded or replaced.',
      ],
      'cyan',
    );
    return;
  }

  let asset: { path: string; tag: string };
  try {
    asset = await downloadReleaseAsset({ token: plan.token, assetName: plan.assetName, version: plan.version });
  } catch (error) {
    printMessageBox(
      'Self-update failed',
      [error instanceof Error ? error.message : String(error), '', '  Check the token can read the private repository: gh auth status'],
      'red',
    );
    process.exitCode = 1;
    return;
  }

  const installed = installBinaryOverSelf({
    sourceBytes: readFileSync(asset.path),
    targetPath: plan.target,
    // `latest` is a pointer, not a claim about what the asset reports, so only a named version is
    // held to matching. The binary still has to run and identify itself either way.
    expectedVersion: plan.version === 'latest' ? undefined : plan.version,
  });
  printMessageBox(
    installed.ok ? 'Self-update complete' : 'Self-update failed',
    [installed.message, ...(installed.ok ? [`Release ${asset.tag}. Run \`${BASE_COMMAND} doctor\` to confirm it matches the stack.`] : [])],
    installed.ok ? 'green' : 'red',
  );
  if (!installed.ok) process.exitCode = 1;
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
