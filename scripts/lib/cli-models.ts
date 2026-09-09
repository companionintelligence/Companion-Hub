/**
 * Local model management and the MCP toggle.
 *
 * `cihub models` drives the Ollama container directly because it is the embeddings backend every
 * chat backend shares; richer per-backend model control lives behind the Hub API.
 */

import { upsertEnvVar } from '../env-file.js';
import { publicWebRepairHasFailures, resolveHubApiBase, runPublicWebRepair, runPublicWebStatus } from '../public-web-cli.js';
import { resolveEnvFromArgs, usageAndExit } from './cli-args.js';
import { getEnvFileOrExit, renderConfigLines } from './cli-compose-env.js';
import { findComposeName } from './cli-doctor.js';
import { run } from './cli-proc.js';
import { requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { bold, printMessageBox } from './cli-ui.js';

// --- models ---

export function runModelsCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  const ollamaContainer = findComposeName('ollama');
  if (!ollamaContainer) {
    printMessageBox('Models', ['Ollama container not running. Start the hub first: cihub up'], 'red');
    process.exitCode = 1;
    return;
  }

  if (subcommand === 'list') {
    printMessageBox('Installed models', [`Container: ${ollamaContainer}`], 'cyan');
    run('docker', ['exec', ollamaContainer, 'ollama', 'list']);
    return;
  }

  if (subcommand === 'install' || subcommand === 'pull') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models install <model-name>  (e.g. llama3, mistral, phi3)');
    printMessageBox('Installing model', [`Pulling ${bold(name)} via Ollama \u2014 this may take a few minutes\u2026`], 'green');
    // `-it` allocates a TTY, and `docker exec -it` on a non-TTY stdin fails outright with "the input
    // device is not a TTY". Every fleet call arrives over `ssh -n`, so the flags have to follow the
    // stream we actually have rather than assuming a terminal.
    const ttyFlags = process.stdin.isTTY ? ['-it'] : [];
    run('docker', ['exec', ...ttyFlags, ollamaContainer, 'ollama', 'pull', name]);
    return;
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models rm <model-name>');
    printMessageBox('Removing model', [`Removing ${bold(name)} from Ollama\u2026`], 'yellow');
    run('docker', ['exec', ollamaContainer, 'ollama', 'rm', name]);
    return;
  }

  usageAndExit(`Unknown models subcommand: ${subcommand}. Use: list, install, rm`);
}

// --- purge ---

// --- MCP ---

export function setMcpState(env: HubEnv, enabled: boolean) {
  const envFileName = getEnvFileOrExit(env);
  upsertEnvVar(envFileName, 'MCP_ENABLED', enabled ? 'true' : 'false');
  const lines = renderConfigLines(env);
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
