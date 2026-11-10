/**
 * Local model management and the MCP toggle.
 *
 * `cihub models` drives Ollama directly because it is the embeddings backend every chat backend
 * shares; richer per-backend model control lives behind the Hub API. Ollama is normally a native
 * service on the host. No shipped compose file runs one, so the container is only a custom stack's.
 */

import { existsSync } from 'node:fs';
import { upsertEnvVar } from '../env-file.js';
import { publicWebRepairHasFailures, resolveHubApiBase, runPublicWebRepair, runPublicWebStatus } from '../public-web-cli.js';
import { resolveEnvFromArgs, usageAndExit } from './cli-args.js';
import { getEnvFileOrExit, renderConfigLines } from './cli-compose-env.js';
import { findComposeName } from './cli-doctor.js';
import { commandExists, run, runCapture } from './cli-proc.js';
import { requireRepoRoot } from './cli-repo-context.js';
import { OLLAMA_RESOLVE_HOST_SH } from './fleet-ollama-version.js';
import { requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { bold, printMessageBox } from './cli-ui.js';
import { applianceEnvFilePaths } from './paths.js';

// --- models ---

/**
 * The `OLLAMA_HOST` that reaches this machine's Ollama. Its CLI dials loopback unless told otherwise.
 * A service bound to its tailnet address answers nothing there, so the CLI reads "could not connect"
 * on a node that is serving fine. An `OLLAMA_HOST` the operator set stays in charge.
 */
function hostOllamaEnv(): Record<string, string> {
  if (process.env.OLLAMA_HOST || process.platform === 'win32') return {};
  const { stdout, ok } = runCapture('sh', ['-c', [...OLLAMA_RESOLVE_HOST_SH, 'printf %s "$host"'].join('\n')]);
  return ok && stdout ? { OLLAMA_HOST: stdout } : {};
}

export function runModelsCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  const ollamaContainer = findComposeName('ollama');
  if (!ollamaContainer && !commandExists('ollama')) {
    printMessageBox(
      'Models',
      [
        'No Ollama found: the Hub runs no Ollama container and this machine has no `ollama` command.',
        'Install Ollama on this machine, then run this again.',
      ],
      'red',
    );
    process.exitCode = 1;
    return;
  }
  // The Hub's own container when it has one, otherwise the host's Ollama, in the same `ollama <verb>` form.
  const ollama = (ollamaArgs: string[], execFlags: string[] = []) =>
    ollamaContainer ? run('docker', ['exec', ...execFlags, ollamaContainer, 'ollama', ...ollamaArgs]) : run('ollama', ollamaArgs, hostOllamaEnv());

  if (subcommand === 'list') {
    printMessageBox('Installed models', [ollamaContainer ? `Container: ${ollamaContainer}` : 'Ollama on this machine'], 'cyan');
    ollama(['list']);
    return;
  }

  if (subcommand === 'install' || subcommand === 'pull') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models install <model-name>  (e.g. llama3, mistral, phi3)');
    printMessageBox('Installing model', [`Pulling ${bold(name)} via Ollama \u2014 this may take a few minutes\u2026`], 'green');
    // `-it` allocates a TTY, and `docker exec -it` on a non-TTY stdin fails outright with "the input
    // device is not a TTY". Every fleet call arrives over `ssh -n`, so the flags have to follow the
    // stream we actually have rather than assuming a terminal.
    ollama(['pull', name], process.stdin.isTTY ? ['-it'] : []);
    return;
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models rm <model-name>');
    printMessageBox('Removing model', [`Removing ${bold(name)} from Ollama\u2026`], 'yellow');
    ollama(['rm', name]);
    return;
  }

  usageAndExit(`Unknown models subcommand: ${subcommand}. Use: list, install, rm`);
}

// --- purge ---

// --- MCP ---

export function setMcpState(env: HubEnv, enabled: boolean) {
  requireRepoOrApplianceContext(`${BASE_COMMAND} mcp`);
  const ctx = resolveHubContext(env);
  // An install keeps two env files that are meant to match (see applianceEnvFilePaths). The Hub can
  // be started from either, so a switch written to one alone can leave the other turning MCP back on.
  const envFiles = ctx.dataDir ? applianceEnvFilePaths(ctx.dataDir).filter((file) => existsSync(file)) : [ctx.envFile];
  for (const envFile of envFiles) upsertEnvVar(envFile, 'MCP_ENABLED', enabled ? 'true' : 'false');
  const lines = renderConfigLines(ctx);
  // The Hub reads this once, at boot, so the file changing changes nothing until it restarts.
  lines.push('', `Restart the Hub to apply this: ${bold(`${BASE_COMMAND} restart${ctx.appliance ? '' : ` ${ctx.env}`}`)}`);
  if (enabled) {
    lines.push('', `Create a key with ${bold(`${BASE_COMMAND} api-key create`)} — MCP requires an 'mcp'-scoped key.`);
  }
  printMessageBox(enabled ? 'MCP enabled' : 'MCP disabled', lines, enabled ? 'green' : 'yellow');
}

// --- public web ---

export async function runPublicWebCommand(args: string[]) {
  requireRepoRoot('cihub public-web');
  const appFlagIndex = args.indexOf('--app');
  const appName = appFlagIndex >= 0 ? args[appFlagIndex + 1] : undefined;
  const positional = args.filter((_, index) => index !== appFlagIndex && (appFlagIndex < 0 || index !== appFlagIndex + 1));
  const subcommand = positional[0] || 'status';
  const env = resolveEnvFromArgs(positional.slice(1));
  const envFileName = getEnvFileOrExit(env);

  try {
    if (subcommand === 'status') {
      const lines = await runPublicWebStatus(envFileName);
      printMessageBox(`Public Web status  [${env}]`, lines, 'cyan');
      return;
    }

    if (subcommand === 'repair') {
      const lines = await runPublicWebRepair(envFileName, appName);
      const failed = publicWebRepairHasFailures(lines);
      printMessageBox(`Public Web repair  [${env}]`, lines, failed ? 'yellow' : 'green');
      if (failed) process.exitCode = 1;
      return;
    }

    usageAndExit(`Usage: ${BASE_COMMAND} public-web <status|repair> [env] [--app <name>]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
      printMessageBox('Hub unavailable', [`Could not reach Hub at ${resolveHubApiBase(envFileName)}.`, 'Start the Hub first: cihub up'], 'red');
      process.exit(1);
    }
    throw error;
  }
}
