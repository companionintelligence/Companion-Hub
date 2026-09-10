/**
 * Read-only diagnostics: `cihub logs`, `cihub status`, `cihub doctor`, and `cihub uninstall`.
 *
 * `doctor` composes sections from the bridge and network diagnostics modules so each area can
 * grow its own checks without this file learning about them.
 */

import { existsSync } from 'node:fs';
import path, { join } from 'node:path';
import { runBridgeDoctorSection } from '../bridge-diagnostics-cli.js';
import { parseEnvFile } from '../env-file.js';
import { runHubCleanup } from '../hub-cleanup-lib.js';
import { runNetworkDoctorSection } from '../network-diagnostics-cli.js';
import { HubUnreachableError } from '../public-web-cli.js';
import { getEnvFileOrExit, hasCloudflareTunnelToken, hasCloudflareTunnelTokenAtDataDir } from './cli-compose-env.js';
import { fetchHubClaimStatus, HubClaimNoDeviceKey, type HubClaimStatus } from './hub-claim.js';
import { run, runCapture } from './cli-proc.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { checkDockerAvailable, requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { bold, cliFail, cliOk, cliWarn, colorize, dim, printMessageBox, STEP_ICONS } from './cli-ui.js';
import { composeArgsForContext, envOverridesForContext, type HubContext, requireRepoOrApplianceContext, resolveHubContext } from './hub-context.js';
import { resolveRootFolderHost } from './paths.js';

export function logsHub(env: HubEnv, service?: string) {
  const ctx = resolveHubContext(env);
  const envOverrides = envOverridesForContext(ctx);
  const args = composeArgsForContext(ctx);
  args.push('logs', '-f');
  if (service) args.push(service);
  run('docker', args, envOverrides, ctx.cwd);
}

/**
 * Does this Hub have an operator to be?
 *
 * The half-provisioned state doctor exists to catch: `cihub register` succeeded, the device key is
 * on disk, and the `user` table is empty — so every operator-authenticated call answers 409 and the
 * node looks, from the outside, like it has a broken key. Twelve fleet nodes sat like that. Doctor
 * is what an installer runs at the end of a node, so this is where it gets caught.
 *
 * A line, a failure count, and never a guess: a Hub that is not running, or that this machine holds
 * no device key for, has told us nothing about its operators, and reporting a fault there would put
 * a red line on every pre-install machine.
 */
export async function runOperatorDoctorSection(envFileName: string): Promise<{ lines: string[]; failureCount: number; issueCount: number }> {
  let status: HubClaimStatus;

  try {
    status = await fetchHubClaimStatus(envFileName);
  } catch (error) {
    const why =
      error instanceof HubClaimNoDeviceKey
        ? 'no device key on this machine'
        : error instanceof HubUnreachableError
          ? 'Hub not answering'
          : error instanceof Error
            ? error.message.slice(0, 60)
            : String(error).slice(0, 60);

    return { lines: [`Operator             ${colorize(`${STEP_ICONS.pending} unknown`, 'dim')}  ${dim(why)}`], failureCount: 0, issueCount: 0 };
  }

  if (status.operators > 0) {
    return { lines: [`Operator             ${cliOk(`${status.operators} present`)}`], failureCount: 0, issueCount: 0 };
  }

  // Before pairing, having no operator is the expected state, not a fault — there is nothing yet to
  // claim the Hub on behalf of. `cihub register` is the next step, and it is not doctor's business.
  if (!status.registered) {
    return {
      lines: [`Operator             ${cliWarn('none yet')}  ${dim(`register first: ${BASE_COMMAND} register`)}`],
      failureCount: 0,
      issueCount: 1,
    };
  }

  return {
    lines: [`Operator             ${cliFail('none')}  ${dim(`Hub is registered but unclaimed — ${BASE_COMMAND} claim --email <you@example.com>`)}`],
    failureCount: 1,
    issueCount: 1,
  };
}

export async function doctorHub(env: HubEnv, options?: { repairNetworks?: boolean }) {
  const ctx = resolveHubContext(env);
  if (ctx.appliance) {
    requireRepoOrApplianceContext('cihub doctor', 'allow-missing');
  } else {
    requireRepoRoot('cihub doctor');
  }
  const resolvePath = (p: string) => (path.isAbsolute(p) ? p : join(process.cwd(), p));
  const envFileName = ctx.envFile;
  const rootFolderHost = ctx.appliance ? (ctx.dataDir as string) : resolveRootFolderHost(envFileName);
  const composeFiles = ctx.composeFiles;
  const networkSection = await runNetworkDoctorSection(envFileName, { repairNetworks: options?.repairNetworks });
  // Host services the Hub dials over the Docker bridge. A default-deny host
  // firewall drops these silently and the failure is invisible from the host,
  // so it is checked from inside the container.
  const bridgeSection = await runBridgeDoctorSection(envFileName);
  // The one check that is about the Hub's own identity rather than the machine under it.
  const operatorSection = await runOperatorDoctorSection(envFileName);
  const dockerOk = checkDockerAvailable();
  const composeOk = runCapture('docker', ['compose', 'version']).ok;
  const composeFilesFound = composeFiles.every((file) => existsSync(resolvePath(file)));
  const lines = [
    `Docker               ${dockerOk ? cliOk('available') : cliFail('unavailable')}`,
    `Docker Compose       ${composeOk ? cliOk('available') : cliFail('unavailable')}`,
    `Env file             ${existsSync(resolvePath(envFileName)) ? cliOk('found') : cliWarn('missing')}  ${envFileName}`,
    `Root folder          ${existsSync(rootFolderHost) ? cliOk('present') : cliWarn('missing')}  ${rootFolderHost}`,
    `Compose files        ${composeFilesFound ? cliOk('found') : cliFail('missing')}  ${composeFiles.join(', ')}`,
    `Tunnel token         ${doctorHasTunnelToken(ctx) ? cliOk('present') : colorize(`${STEP_ICONS.pending} absent`, 'dim')}`,
    ...operatorSection.lines,
    ...networkSection.lines,
    ...bridgeSection.lines,
  ];
  // Which local checks may fail the command is already decided by how each line is drawn: `cliFail`
  // is a machine that cannot run the stack, `cliWarn` is state doctor exists to report — a missing
  // env file before setup is an answer, not a fault.
  const failureCount =
    [dockerOk, composeOk, composeFilesFound].filter((ok) => !ok).length +
    networkSection.failureCount +
    bridgeSection.failureCount +
    operatorSection.failureCount;
  const issueCount = networkSection.issueCount + bridgeSection.issueCount + operatorSection.issueCount;
  printMessageBox(`Hub doctor  [${ctx.env}]`, lines, failureCount > 0 ? 'red' : issueCount > 0 ? 'yellow' : 'cyan');
  if (failureCount > 0) process.exitCode = 1;
}

/**
 * Tunnel token lives at `<ROOT>/../tunnel/token` (compose bind). Also accepts the
 * legacy nested `<dataDir>/tunnel/token` so doctor matches profile detection.
 */
function doctorHasTunnelToken(ctx: HubContext): boolean {
  if (ctx.appliance && ctx.dataDir) {
    return hasCloudflareTunnelTokenAtDataDir(ctx.dataDir);
  }
  return hasCloudflareTunnelToken(ctx.envFile);
}

export async function uninstallHub(force: boolean) {
  requireRepoRoot('cihub uninstall');
  const confirmed = await confirmDestructiveAction('Uninstalling CI-Hub', force, 'Remove CI-Hub runtime state from this machine? [y/N]: ');
  if (!confirmed) {
    printMessageBox('Uninstall cancelled', ['Left Docker volumes, configs, and caches untouched.'], 'yellow');
    return;
  }
  const summary = runHubCleanup();
  const failures = summary.failedDirs + summary.failedCommands;
  printMessageBox(
    failures > 0 ? 'Uninstall incomplete' : 'Uninstall complete',
    [
      `removed directories: ${summary.removedDirs}`,
      `skipped directories: ${summary.skippedDirs}`,
      `directory failures: ${summary.failedDirs}`,
      `commands attempted: ${summary.attemptedCommands}`,
      `command failures: ${summary.failedCommands}`,
    ],
    failures > 0 ? 'red' : 'green',
  );
  // State the operator asked to be gone is still on the machine; a re-run or manual removal is owed.
  if (failures > 0) process.exitCode = 1;
}

export function findComposeName(keyword: string): string {
  const { stdout } = runCapture('docker', [
    'ps',
    '--filter',
    'label=com.docker.compose.project=ci-hub',
    '--filter',
    `name=${keyword}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.split('\n').find(Boolean) || '';
}

export function showStatus(env: HubEnv) {
  if (!checkDockerAvailable()) {
    printMessageBox('Hub status', ['Docker is not running or not reachable.'], 'red');
    return;
  }

  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const lines: string[] = [];

  // -- containers --
  const { stdout: psOut } = runCapture('docker', [
    'ps',
    '-a',
    '--filter',
    'label=com.docker.compose.project=ci-hub',
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Ports}}',
  ]);
  lines.push(dim('Containers'));
  if (psOut) {
    for (const row of psOut.split('\n').filter(Boolean)) {
      const [name, status, ports] = row.split('\t');
      const isUp = (status || '').toLowerCase().startsWith('up');
      const dot = isUp ? colorize(STEP_ICONS.done, 'green') : colorize(STEP_ICONS.fail, 'red');
      const portsStr = ports ? dim(`  ${ports}`) : '';
      lines.push(`  ${dot} ${bold(name || '')}  ${dim(status || '')}${portsStr}`);
    }
  } else {
    lines.push(`  ${dim('No CI-Hub containers \u2014 run: cihub up')}`);
  }

  // -- network / access URLs --
  lines.push('');
  lines.push(dim('Network'));
  const localPort = fileVars.FRONTEND_PORT || fileVars.BACKEND_PORT || '5002';
  lines.push(`  Dashboard      ${colorize(`http://localhost:${localPort}`, 'cyan')}`);

  const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN || fileVars.CLOUDFLARE_DOMAIN;
  const tunnelContainer = findComposeName('tunnel') || findComposeName('cloudflared');
  const tunnelUp = tunnelContainer.length > 0;
  if (cfDomain) {
    const cfStatus = tunnelUp ? cliOk('active') : cliWarn('tunnel down');
    lines.push(`  Cloudflare     ${cfStatus}  ${colorize(`https://${cfDomain}`, 'cyan')}`);
  } else {
    lines.push(`  Cloudflare     ${tunnelUp ? cliOk('active') : colorize(`${STEP_ICONS.pending} not configured`, 'dim')}`);
  }

  const headscaleContainer = findComposeName('headscale');
  const { stdout: tsIp } = runCapture('tailscale', ['ip', '--4']);
  const tsIpClean = tsIp.trim();
  const tailscaleActive = tsIpClean.length > 0 || headscaleContainer.length > 0;
  if (tailscaleActive) {
    lines.push(`  Tailscale VPN  ${cliOk('active')}  ${tsIpClean ? colorize(tsIpClean, 'cyan') : dim('(headscale)')}`);
  } else {
    lines.push(`  Tailscale VPN  ${colorize(`${STEP_ICONS.pending} inactive`, 'dim')}`);
  }

  // -- ollama models --
  const ollamaContainer = findComposeName('ollama');
  if (ollamaContainer) {
    lines.push('');
    lines.push(dim('Models (Ollama)'));
    const { stdout: modelOut, ok } = runCapture('docker', ['exec', ollamaContainer, 'ollama', 'list']);
    const models = ok ? modelOut.split('\n').filter(Boolean).slice(1) : [];
    if (models.length > 0) {
      for (const m of models) lines.push(`  ${dim(m)}`);
    } else {
      lines.push(`  ${dim('None installed \u2014 run: cihub models install llama3')}`);
    }
  }

  printMessageBox(`Hub status  [${env}]`, lines, 'cyan');
}
