/**
 * Argument and flag normalization for the `cihub` command surface.
 *
 * Every function here is pure apart from the exit paths, so the dispatcher and the
 * command modules can share one parsing contract instead of each re-reading argv.
 */
import { allowedEnvs, BASE_COMMAND, type HubEnv, type RegisterHubOptions, type StartMode } from './cli-types.js';
import { bold, colorize, printMessageBox, STEP_ICONS } from './cli-ui.js';
import { isApplianceMode } from './cli-repo-context.js';

/**
 * Two lines pointing at the real reference, not the reference itself: `renderHelp()` is ~99 rows, so
 * dumping it here pushed the one-line error off the top of a standard 24-row terminal.
 */
const USAGE_HINT_ENTRIES: { command: string; description: string }[] = [
  { command: `${BASE_COMMAND} --help`, description: 'Full command reference' },
  { command: `${BASE_COMMAND} man`, description: 'Manual-style command reference' },
];

/**
 * Exit with a usage error. The hint prints *before* the message so the message is the last thing
 * left on screen — on a short terminal that is the only line the caller is guaranteed to still see.
 */
export function usageAndExit(message?: string, code = 2): never {
  const width = Math.max(...USAGE_HINT_ENTRIES.map((entry) => entry.command.length));
  for (const entry of USAGE_HINT_ENTRIES) {
    console.error(`  ${colorize(entry.command.padEnd(width), 'green')}  ${entry.description}`);
  }
  if (message) console.error(colorize(`  ${STEP_ICONS.fail} ${message}`, 'red'));
  process.exit(code);
}

export function normalizeCliArgs(rawArgs: string[]) {
  return rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
}

export function resolveEnvFromArgs(args: string[], defaultEnv: HubEnv = 'local'): HubEnv {
  const found = args.find((a) => allowedEnvs.includes(a as HubEnv));
  const unknown = args.filter((a) => !allowedEnvs.includes(a as HubEnv));
  if (unknown.length > 0) usageAndExit(`Unexpected argument: ${unknown[0]}`);
  return (found || defaultEnv) as HubEnv;
}

export function printRemovedCommand(oldUsage: string, replacement: string, detail?: string): never {
  const lines = [`${oldUsage} was removed in this release.`, `Use ${bold(replacement)} instead.`];
  if (detail) lines.push(detail);
  printMessageBox('Command removed', lines, 'red');
  process.exit(2);
}

export function normalizeDetachedFlag(args: string[]): { detached: boolean; attached: boolean; remaining: string[] } {
  return {
    detached: args.includes('--detached'),
    attached: args.includes('--attached'),
    remaining: args.filter((arg) => arg !== '--detached' && arg !== '--attached'),
  };
}

export function normalizeRegisterFlags(args: string[]): RegisterHubOptions & { env: HubEnv } {
  let fresh = false;
  let move = false;
  let code: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fresh') {
      fresh = true;
      continue;
    }
    if (arg === '--move') {
      move = true;
      continue;
    }
    if (arg === '--code') {
      const next = args[i + 1];
      if (!next) {
        usageAndExit(`Usage: ${BASE_COMMAND} register [env] [--fresh] [--code <code>] [--move]`);
      }
      code = next;
      i++;
      continue;
    }
    if (arg.startsWith('--code=')) {
      code = arg.slice('--code='.length);
      continue;
    }
    remaining.push(arg);
  }

  return {
    fresh,
    code,
    move,
    env: resolveEnvFromArgs(remaining),
  };
}

/**
 * `cihub claim [env] [--email <addr>]`.
 *
 * Both spellings of the flag are accepted — `--email a@b.c` and `--email=a@b.c` — because half the
 * CLI already takes both and a claim that silently ran with no email would prompt on a fleet run
 * that has no terminal (see `readApiKeyFlag`, which was written after exactly that bug).
 */
export function normalizeClaimFlags(args: string[]): { email?: string; env: HubEnv } {
  let email: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--email') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        usageAndExit(`Usage: ${BASE_COMMAND} claim [env] [--email <you@example.com>]`);
      }
      email = next;
      i++;
      continue;
    }
    if (arg.startsWith('--email=')) {
      email = arg.slice('--email='.length);
      continue;
    }
    remaining.push(arg);
  }

  return { email, env: resolveEnvFromArgs(remaining) };
}

/** Non-local appliance stacks default to detached so `cihub up dev` returns after boot. */
export function resolveUpStartMode(
  env: HubEnv,
  options: { detached: boolean; attached: boolean },
  appliance: boolean = isApplianceMode(),
): StartMode {
  // Outside a checkout there is no source to run, so never start local-dev; default to detached
  // (matching `cihub up dev`) unless the user explicitly asked to stay attached.
  if (appliance) {
    return options.attached ? 'attached' : 'detached';
  }
  if (env === 'local') {
    return 'local-dev';
  }
  if (options.attached) {
    return 'attached';
  }
  if (options.detached || env === 'dev') {
    return 'detached';
  }
  return 'attached';
}
