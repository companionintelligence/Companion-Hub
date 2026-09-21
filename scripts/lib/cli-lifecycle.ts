/**
 * Bringing a Hub stack up: `cihub up`, `cihub setup`, and `cihub config`.
 *
 * Source-dev (`local`) and appliance stacks take deliberately different paths — the first runs
 * workspace dev processes, the second drives the packaged prod compose in the canonical data
 * dir — so the two start functions stay separate rather than branching throughout.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isHostPortBindConflict, runDockerComposeUpOnce } from '../compose-up.js';
import { healHubPortBindConflict, healHubPortsBeforeStartup } from '../heal-hub-ports.js';
import { initDockerConfig } from '../init-docker-config.js';
import { initGpuRuntime } from '../init-gpu-runtime.js';
import { initHostProbe } from '../init-host-probe.js';
import { initHubDataDirs } from '../init-hub-data-dirs.js';
import { initTraefik } from '../init-traefik.js';
import { syncPostgresPasswordFromEnv } from '../sync-postgres-password.js';
import { syncRabbitmqPasswordFromEnv } from '../sync-rabbitmq-password.js';
import { usageAndExit } from './cli-args.js';
import { buildEnvOverrides, ensureLocalDevRuntimeEnv, getComposeFiles, getEnvFileOrExit, renderConfigLines } from './cli-compose-env.js';
import { ensureLocalDevPortsAvailable, run, runBestEffort, runScript } from './cli-proc.js';
import { parseEnvFile } from '../env-file.js';
import { isApplianceMode, requireRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, type HubEnv, type StartMode } from './cli-types.js';
import { printMessageBox } from './cli-ui.js';
import { buildComposeBaseArgs, ensureApplianceInstall, envOverridesForContext, type HubContext, resolveHubContext } from './hub-context.js';

const POSTGRES_INFRA_SERVICES = ['ci-hub-queue', 'ci-hub-db'] as const;

/** Start Postgres (and queue), then align DB/broker passwords with the env file. */
async function ensurePostgresInfraAndSyncPassword(
  envFileName: string,
  composeFiles: string[],
  envOverrides: Record<string, string | undefined>,
  cwd?: string,
) {
  run('docker', [...buildComposeBaseArgs(envFileName, composeFiles), 'up', '-d', ...POSTGRES_INFRA_SERVICES], envOverrides, cwd);
  await runScript('scripts/sync-postgres-password.ts', () => syncPostgresPasswordFromEnv(envFileName), envOverrides);
  await runScript('scripts/sync-rabbitmq-password.ts', () => syncRabbitmqPasswordFromEnv(envFileName), envOverrides);
}

export function shouldRetryApkMirrorWithHostNetwork(
  output: string,
  envOverrides: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lower = output.toLowerCase();
  const isApkMirrorFetchFailure = lower.includes('apkindex.tar.gz') && lower.includes('temporary error (try again later)');
  return platform === 'linux' && isApkMirrorFetchFailure && envOverrides.DOCKER_BUILD_NETWORK !== 'host';
}

async function runDockerComposeUp(
  envFileName: string,
  files: string[],
  detached: boolean,
  envOverrides: Record<string, string | undefined>,
  cwd?: string,
): Promise<void> {
  const upArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) upArgs.push('-f', f);
  upArgs.push('up');
  if (detached) upArgs.push('-d');
  upArgs.push('--build');

  const maxAttempts = 3;
  let currentEnvOverrides: Record<string, string | undefined> = { ...envOverrides };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runDockerComposeUpOnce(upArgs, { envOverrides: currentEnvOverrides, cwd });
    if (result.status === 0) return;

    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (attempt < maxAttempts && shouldRetryApkMirrorWithHostNetwork(combined, currentEnvOverrides)) {
      printMessageBox(
        'Docker build network retry',
        ['Detected Alpine mirror fetch failure during image build.', 'Retrying with DOCKER_BUILD_NETWORK=host...'],
        'yellow',
      );
      currentEnvOverrides = { ...currentEnvOverrides, DOCKER_BUILD_NETWORK: 'host' };
      continue;
    }

    if (attempt < maxAttempts && isHostPortBindConflict(combined)) {
      const healed = healHubPortBindConflict(envFileName, combined, (message) => {
        printMessageBox('Port self-heal', [message], 'yellow');
      });
      if (healed.info.length > 0) {
        printMessageBox('Port self-heal', healed.info, 'yellow');
      }
      continue;
    }

    if (combined) {
      printMessageBox('Docker compose failed', combined.split('\n').slice(-8), 'red');
    }
    process.exit(result.status ?? 1);
  }
}

export async function startHub(mode: StartMode, env: HubEnv) {
  if (isApplianceMode()) {
    await ensureApplianceInstall();
    await startApplianceHub(resolveHubContext(env), mode === 'attached' ? 'attached' : 'detached');
    return;
  }
  requireRepoRoot(mode === 'local-dev' ? 'cihub up local' : 'cihub up');
  if (mode === 'local-dev' && env !== 'local') {
    usageAndExit('Source-based local development only supports the local environment. Use "cihub up <env>" for appliance environments.');
  }
  const envFileName = getEnvFileOrExit(env);
  await runScript('scripts/init-hub-data-dirs.ts', () => initHubDataDirs(), { ENV_FILE: envFileName });
  const envOverrides = buildEnvOverrides(envFileName);
  await runScript('scripts/init-gpu-runtime.ts', () => initGpuRuntime(), envOverrides);
  await runScript('scripts/init-host-probe.ts', () => initHostProbe(), { ENV_FILE: envFileName, ...envOverrides });

  if (mode === 'local-dev') {
    ensureLocalDevPortsAvailable();
    const runtimeVars = ensureLocalDevRuntimeEnv(envFileName);
    printMessageBox(
      'Starting local development',
      ['Environment: local', 'Bringing up PostgreSQL and RabbitMQ, then launching backend/frontend from source.'],
      'green',
    );
    await ensurePostgresInfraAndSyncPassword(envFileName, ['docker-compose.local.yml'], envOverrides);
    run('pnpm', ['run', 'dev:app'], { ...runtimeVars, ...envOverrides });
    return;
  }

  if (env !== 'local') await runScript('scripts/init-traefik.ts', () => initTraefik(), envOverrides);

  try {
    const portHeal = healHubPortsBeforeStartup(envFileName, (message) => {
      printMessageBox('Port preparation', [message], 'yellow');
    });
    if (portHeal.info.length > 0) {
      printMessageBox('Port preparation', portHeal.info, 'yellow');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Port preparation failed', [message], 'red');
    throw error;
  }

  const files = getComposeFiles(env);
  const detached = mode === 'detached';

  printMessageBox(
    'Starting hub',
    [`Environment: ${env}`, `Mode: ${detached ? 'detached' : 'attached'}`, `Compose files: ${files.join(', ')}`],
    'green',
  );
  await ensurePostgresInfraAndSyncPassword(envFileName, files, envOverrides);
  await runDockerComposeUp(envFileName, files, detached, envOverrides);
}

/**
 * Start a desktop-installed prod Hub from anywhere, using the canonical data dir's seeded
 * `.env` + `docker-compose.prod.yml`. Traefik config and the env file are provisioned by the
 * desktop app, so we do not re-run the repo-asset Traefik init here.
 */
async function startApplianceHub(ctx: HubContext, detachedMode: 'attached' | 'detached') {
  const dataDir = ctx.dataDir as string;
  const envOverrides = envOverridesForContext(ctx);

  await runScript(
    'scripts/init-hub-data-dirs.ts',
    () => initHubDataDirs(),
    { ENV_FILE: ctx.envFile, ROOT_FOLDER_HOST: dataDir, ...envOverrides },
    dataDir,
  );
  // `state/traefik/config/traefik.yml` and `acme_storage.json` are FILE bind mounts, so on a data dir
  // that has never had them compose stops at "bind source path does not exist" before `ci-hub`
  // starts. The checkout path has always run this (see startHub); the appliance path never did,
  // which is why a fresh headless `cihub up` could not bring traefik up — measured 2026-09-18 on
  // fifteen fleet nodes reinstalled from scratch, every one of them.
  await runScript('scripts/init-traefik.ts', () => initTraefik(), { ENV_FILE: ctx.envFile, ROOT_FOLDER_HOST: dataDir, ...envOverrides }, dataDir);
  await runScript('scripts/init-gpu-runtime.ts', () => initGpuRuntime(), envOverrides);
  await runScript('scripts/init-host-probe.ts', () => initHostProbe(), { ENV_FILE: ctx.envFile, ...envOverrides }, dataDir);

  try {
    const portHeal = healHubPortsBeforeStartup(ctx.envFile, (message) => {
      printMessageBox('Port preparation', [message], 'yellow');
    });
    if (portHeal.info.length > 0) {
      printMessageBox('Port preparation', portHeal.info, 'yellow');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Port preparation failed', [message], 'red');
    throw error;
  }

  const detached = detachedMode === 'detached';
  printMessageBox(
    'Starting hub',
    ['Environment: prod (canonical install)', `Data dir: ${dataDir}`, `Mode: ${detached ? 'detached' : 'attached'}`],
    'green',
  );
  await ensurePostgresInfraAndSyncPassword(ctx.envFile, ctx.composeFiles, envOverrides, dataDir);
  refreshFloatingHubImage(ctx, envOverrides, dataDir);
  await runDockerComposeUp(ctx.envFile, ctx.composeFiles, detached, envOverrides, dataDir);
}

/** A reference that names a build rather than a moving tag: `repo@sha256:…`. */
export function isDigestPinnedImage(ref: string | undefined): boolean {
  return typeof ref === 'string' && ref.includes('@sha256:');
}

/**
 * Pull the Hub image before compose looks for it, when CI_HUB_IMAGE is a tag.
 *
 * The seeded compose says `pull_policy: if_not_present` for `ci-hub`, which is right for a digest
 * (it cannot change) and wrong for `:latest` or `:dev`: a node that ever pulled the tag before
 * keeps that copy, whatever the tag points at now. A freshly reinstalled node ran a release image
 * seven days old that way on 2026-09-18, and the CLI that had just installed it called an API
 * route the old image did not have. `pool update` already pulls before it starts; a first `up`
 * on a floating tag has to as well. Best-effort: a node that cannot reach the registry starts
 * what it has, and says so.
 */
export function refreshFloatingHubImage(ctx: HubContext, envOverrides: Record<string, string | undefined>, cwd?: string): void {
  const image = envOverrides.CI_HUB_IMAGE ?? parseEnvFile(ctx.envFile).CI_HUB_IMAGE;
  if (isDigestPinnedImage(image)) return;
  const pulled = runBestEffort('docker', [...buildComposeBaseArgs(ctx.envFile, ctx.composeFiles), 'pull', 'ci-hub'], envOverrides, cwd);
  if (!pulled) {
    printMessageBox(
      'Image not refreshed',
      [`Could not pull ${image ?? 'the Hub image'}; starting the copy already on this machine.`, 'That copy may be older than the tag it carries.'],
      'yellow',
    );
  }
}

export async function setupHub(env: HubEnv) {
  if (isApplianceMode()) {
    await ensureApplianceInstall();
    const ctx = resolveHubContext(env);
    printMessageBox('Setup complete', [`Prod install is ready at ${ctx.dataDir}.`, `Next: ${BASE_COMMAND} up`], 'cyan');
    return;
  }
  requireRepoRoot('cihub setup');
  const envFileName = getEnvFileOrExit(env);
  await runScript('scripts/init-hub-data-dirs.ts', () => initHubDataDirs(), { ENV_FILE: envFileName });
  const envOverrides = buildEnvOverrides(envFileName);
  await runScript('scripts/init-traefik.ts', () => initTraefik(), envOverrides);
  await runScript('scripts/init-docker-config.ts', () => initDockerConfig(), envOverrides);

  if (!existsSync(join(process.cwd(), envFileName))) {
    printMessageBox(
      'Setup complete — env file still missing',
      [
        `Host assets prepared for ${env}, but ${envFileName} does not exist yet.`,
        `This template is not generated for you: cp .env.example ${envFileName}, then fill in the required values.`,
        `Then: ${BASE_COMMAND} up ${env}`,
      ],
      'yellow',
    );
    return;
  }

  printMessageBox(
    'Setup complete',
    [`Host assets prepared for ${env}.`, `Next: ${BASE_COMMAND} up ${env}`, `Then: ${BASE_COMMAND} register ${env}`],
    'green',
  );
}

export function printConfig(env: HubEnv) {
  printMessageBox('CI-Hub configuration', renderConfigLines(env), 'cyan');
}
