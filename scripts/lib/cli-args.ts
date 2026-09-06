/**
 * Argument and flag normalization for the `cihub` command surface.
 *
 * Every function here is pure apart from the exit paths, so the dispatcher and the
 * command modules can share one parsing contract instead of each re-reading argv.
 */
import { allowedEnvs, BASE_COMMAND, type HubEnv, type RegisterHubOptions, type StartMode } from './cli-types.js';
import { bold, colorize, printMessageBox, renderHelp, STEP_ICONS } from './cli-ui.js';
import { isApplianceMode } from './cli-repo-context.js';

export function usageAndExit(message?: string, code = 2): never {
  if (message) console.error(colorize(`  ${STEP_ICONS.fail} ${message}`, 'red'));
  console.error(renderHelp());
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
  let code: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fresh') {
      fresh = true;
      continue;
    }
    if (arg === '--code') {
      const next = args[i + 1];
      if (!next) {
        usageAndExit(`Usage: ${BASE_COMMAND} register [env] [--fresh] [--code <code>]`);
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
    env: resolveEnvFromArgs(remaining),
  };
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
