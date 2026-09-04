import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { isHostPortBindConflict, runDockerComposeUpOnce } from './compose-up';
import { parseEnvFile, upsertEnvVar } from './env-file';
import { CANONICAL_DATA_DIR_NAME, resolveProdApplianceContext, resolveRootFolderHost } from './lib/paths';
import { resolvePostgresPassword, seedApplianceInstall } from './lib/seed-appliance';
import {
  type DeviceIdResponse,
  type RegistrationStatusResponse,
  fetchDeviceId,
  fetchRegistrationStatus,
  fetchStateDrift,
  formatHubAccessUrl,
  isValidPairingCode,
  normalizePairingCode,
  pollRegistrationComplete,
  prepareFreshSetup,
  registrationComplete,
  resolveRegisterApiBase,
  submitPairingCode,
  waitForHubApi,
} from './lib/register-hub';
import { connectAgent, normalizeMemoryUrl, parseConnectArgs } from './lib/connect-agent';
import { healHubPortBindConflict, healHubPortsBeforeStartup } from './heal-hub-ports';
import { dockerBindMountPath } from './heal-hub-bind-mounts';
import { resolveAndPinHubDockerEngine, splitBrainConflict, enumerateDockerEngineCandidates, probeReachableEngines } from './lib/docker-engine';
import { getDeviceId as resolveLocalDeviceId } from './get-device-id';
import { isRelatedVolume, parseNames, runHubCleanup } from './hub-cleanup-lib';
import { initDockerConfig } from './init-docker-config';
import { initGpuRuntime } from './init-gpu-runtime';
import { initHostProbe } from './init-host-probe';
import { initHubDataDirs } from './init-hub-data-dirs';
import { initTraefik } from './init-traefik';
import { runPublicWebRepair, runPublicWebStatus, resolveHubApiBase, publicWebRepairHasFailures } from './public-web-cli';
import { syncPostgresPasswordFromEnv } from './sync-postgres-password';
import { syncRabbitmqPasswordFromEnv } from './sync-rabbitmq-password';
import { runBridgeDoctorSection } from './bridge-diagnostics-cli';
import { runNetworkDoctorSection } from './network-diagnostics-cli';
import { allowedEnvs, BASE_COMMAND, CI_CLOUD_DEFAULT, type HubEnv } from './lib/cli-types';
import {
  BOX_CHARS,
  STEP_ICONS,
  bold,
  box,
  cliFail,
  cliOk,
  cliWarn,
  colorize,
  dim,
  hr,
  printMessageBox,
  renderBanner,
  renderHelp,
  renderManPage,
  renderStep,
  renderWizardWelcome,
  stripAnsi,
  type StepStatus,
} from './lib/cli-ui';
import { ensureLocalDevPortsAvailable, run, runBestEffort, runCapture, runScript } from './lib/cli-proc';
import {
  buildEnvOverrides,
  ensureLocalDevRuntimeEnv,
  getComposeFiles,
  getEnvFileOrExit,
  hasCloudflareTunnelToken,
  hasCloudflareTunnelTokenAtDataDir,
  mergeComposeProfilesFromEnvFile,
  packageVersion,
  renderConfigLines,
} from './lib/cli-compose-env';

export { allowedEnvs, BASE_COMMAND, type HubEnv };
export type { StepStatus };
export { STEP_ICONS, BOX_CHARS };
export { stripAnsi, box, printMessageBox, renderStep, renderBanner, renderWizardWelcome, renderHelp, renderManPage };
export { getComposeFiles, mergeComposeProfilesFromEnvFile, buildEnvOverrides, ensureLocalDevRuntimeEnv };
export { parseEnvFile, upsertEnvVar };

type StartMode = 'local-dev' | 'attached' | 'detached';

const envFileMap: Record<HubEnv, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

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

export type RegisterHubOptions = {
  fresh?: boolean;
  code?: string;
};

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

// --- docker availability ---

function checkDockerAvailable(): boolean {
  return runCapture('docker', ['info']).ok;
}

/**
 * Commands that drive setup/lifecycle shell out to the repo's helper scripts
 * (tsx scripts/*.ts) and Docker Compose files, all resolved from process.cwd().
 * A global/npm install of cihub run outside a CI-Hub checkout has none of these,
 * so fail early with an actionable message instead of a cryptic tsx/docker error.
 */
export function isHubRepoRoot(cwd: string = process.cwd()): boolean {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(cwd, 'scripts'))) return false;
  try {
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string }).name === 'ci-hub';
  } catch {
    return false;
  }
}

function requireRepoRoot(action: string): void {
  if (isHubRepoRoot()) return;
  printMessageBox(
    'Run from a CI-Hub checkout',
    [
      `${action} runs CI-Hub's setup scripts and Docker Compose files,`,
      'so it must be run from a CI-Hub repository directory (the one containing',
      'package.json and docker-compose.local.yml).',
      '',
      'Packaged/global installs support: --help, man, version, status,',
      'config, and the app/models Docker passthrough commands.',
    ],
    'red',
  );
  process.exit(2);
}

// --- appliance (canonical prod) context ---

/**
 * Resolved execution context for a lifecycle command. In a CI-Hub checkout this mirrors the
 * historical repo behavior (env-arg honored, repo-relative `.env.<env>` + compose). Outside a
 * checkout we operate in "appliance" mode: the environment is inferred as `prod` and all paths
 * resolve to the canonical desktop data dir (`dirs::data_dir()/companion-hub`).
 */
export type HubContext = {
  env: HubEnv;
  appliance: boolean;
  /** Env file path: repo-relative name in checkout mode, absolute data-dir path in appliance mode. */
  envFile: string;
  /** Compose files: repo-relative names in checkout mode, absolute data-dir paths in appliance mode. */
  composeFiles: string[];
  /** Working directory for docker/compose invocations. */
  cwd: string;
  /** Canonical data dir (appliance mode only). */
  dataDir?: string;
};

/** True when the CLI is not running inside a CI-Hub checkout (a packaged/global prod install). */
export function isApplianceMode(cwd: string = process.cwd()): boolean {
  return !isHubRepoRoot(cwd);
}

export function resolveHubContext(env: HubEnv): HubContext {
  if (!isApplianceMode()) {
    return {
      env,
      appliance: false,
      envFile: getEnvFileOrExit(env),
      composeFiles: getComposeFiles(env),
      cwd: process.cwd(),
    };
  }
  const ctx = resolveProdApplianceContext();
  return {
    env: 'prod',
    appliance: true,
    envFile: ctx.envFilePath,
    composeFiles: [ctx.composePath],
    cwd: ctx.dataDir,
    dataDir: ctx.dataDir,
  };
}

let applianceNoticeShown = false;

/** Compose args bound to a resolved context (absolute paths in appliance mode). */
function composeArgsForContext(ctx: HubContext): string[] {
  return buildComposeBaseArgs(ctx.envFile, ctx.composeFiles);
}

/**
 * Resolve/pin the Hub Docker engine for appliance installs so CLI compose matches
 * the desktop app (`state/docker-engine.json`).
 */
function applyDockerEnginePin(overrides: Record<string, string | undefined>, dataDir: string): Record<string, string | undefined> {
  try {
    const engine = resolveAndPinHubDockerEngine({ dataDir });
    const reachable = probeReachableEngines(enumerateDockerEngineCandidates());
    const conflict = splitBrainConflict(engine, reachable);
    if (conflict) {
      printMessageBox('Docker engine conflict', [conflict], 'red');
      process.exit(1);
    }
    console.log(colorize(`→ Docker engine: ${engine.kind} at ${engine.dockerHost} (${engine.reason})`, 'dim'));
    const next = { ...overrides, DOCKER_HOST: engine.dockerHost };
    delete next.DOCKER_CONTEXT;
    if (engine.pathStyle) {
      next.CI_HUB_DOCKER_PATH_STYLE = engine.pathStyle;
    }
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Docker engine selection failed', [message], 'red');
    process.exit(1);
  }
}

/** Env overrides for a context; pins ROOT_FOLDER_HOST to the data dir in appliance mode. */
function envOverridesForContext(ctx: HubContext): Record<string, string | undefined> {
  let overrides = buildEnvOverrides(ctx.envFile);
  if (ctx.appliance && ctx.dataDir) {
    overrides.ROOT_FOLDER_HOST = ctx.dataDir;
    overrides = applyDockerEnginePin(overrides, ctx.dataDir);
  }
  return overrides;
}

function noteApplianceTarget(dataDir: string): void {
  if (applianceNoticeShown) return;
  applianceNoticeShown = true;
  printMessageBox('Targeting prod install', ['No CI-Hub checkout here \u2014 operating on the canonical prod data dir:', dim(dataDir)], 'cyan');
}

/**
 * After a reset (or first CLI start) there is no seeded `.env` + compose. Prompt for a
 * password and write a fresh appliance install instead of sending the user to the desktop app.
 */
async function ensureApplianceInstall(): Promise<void> {
  const ctx = resolveProdApplianceContext();
  if (ctx.exists) {
    noteApplianceTarget(ctx.dataDir);
    return;
  }

  printMessageBox(
    'No prod Hub install found',
    [
      `Creating a fresh install at ${ctx.dataDir}`,
      'Enter a password for the Hub database (POSTGRES_PASSWORD).',
      'Set POSTGRES_PASSWORD in the environment to skip the prompt.',
    ],
    'yellow',
  );

  try {
    const password = await resolvePostgresPassword({
      env: process.env,
      isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    });
    const seeded = seedApplianceInstall({ dataDir: ctx.dataDir, postgresPassword: password });
    printMessageBox(
      'Fresh Hub install created',
      [`Data dir: ${seeded.dataDir}`, `Image: ${seeded.hubImage}`, `Next: ${BASE_COMMAND} up continues automatically.`],
      'green',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Could not create Hub install', [message, `Expected prod data at: ${ctx.dataDir}`], 'red');
    process.exit(2);
  }
}

/**
 * Gate for lifecycle commands. Allows a CI-Hub checkout (repo mode) or a canonical prod install
 * (appliance mode). When the prod data dir has no seeded `.env` + compose:
 *  - `require-seed` (up/setup): seed interactively (password prompt) then continue.
 *  - `allow-missing` (down/reset/clean): proceed anyway so broken/partial installs can still be torn down.
 */
function requireRepoOrApplianceContext(action: string, gate: 'require-seed' | 'allow-missing' = 'require-seed'): void {
  if (isHubRepoRoot()) return;
  const ctx = resolveProdApplianceContext();
  if (ctx.exists) {
    noteApplianceTarget(ctx.dataDir);
    return;
  }
  if (gate === 'allow-missing') {
    if (!applianceNoticeShown) {
      applianceNoticeShown = true;
      printMessageBox(
        'Targeting prod install',
        ['No CI-Hub checkout and no seeded prod env at:', dim(ctx.dataDir), 'Proceeding with Docker-level cleanup only.'],
        'yellow',
      );
    }
    return;
  }
  printMessageBox(
    'No prod Hub install found',
    [
      `${action} needs a seeded Hub at ${ctx.dataDir}.`,
      `Run \`${BASE_COMMAND} up prod\` in a terminal to create one (it will prompt for a password).`,
    ],
    'red',
  );
  process.exit(2);
}

export function isFirstRun(envFile = '.env.local'): boolean {
  return !existsSync(join(process.cwd(), envFile));
}

// --- hub lifecycle ---

const POSTGRES_INFRA_SERVICES = ['ci-hub-queue', 'ci-hub-db'] as const;

function buildComposeBaseArgs(envFileName: string, files: string[]): string[] {
  const args = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) args.push('-f', f);
  return args;
}

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
    const result = await runDockerComposeUpOnce(upArgs, { detached, envOverrides: currentEnvOverrides, cwd });
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
  await runDockerComposeUp(ctx.envFile, ctx.composeFiles, detached, envOverrides, dataDir);
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
  printMessageBox(
    'Setup complete',
    [`Host assets prepared for ${env}.`, `Next: ${BASE_COMMAND} up ${env}`, `Then: ${BASE_COMMAND} register ${env}`],
    'green',
  );
}

export function printConfig(env: HubEnv) {
  printMessageBox('CI-Hub configuration', renderConfigLines(env), 'cyan');
}

export async function showDeviceId(options: { fromHub?: boolean; env?: HubEnv } = {}) {
  if (options.fromHub) {
    const env = options.env ?? 'local';
    const ctx = resolveHubContext(env);
    const apiBase = resolveRegisterApiBase(ctx.envFile);
    try {
      const deviceInfo = await fetchDeviceId(apiBase);
      if (!deviceInfo.device_id) {
        printMessageBox(
          'Device ID unavailable',
          ['The running Hub could not resolve a device ID.', 'Check backend logs and ensure the appliance initialized correctly.'],
          'red',
        );
        return;
      }
      console.log(deviceInfo.device_id);
      return;
    } catch (error) {
      printMessageBox(
        'Device ID lookup failed',
        [error instanceof Error ? error.message : String(error), `Ensure the Hub is running: ${BASE_COMMAND} up ${env}`],
        'red',
      );
      return;
    }
  }

  try {
    console.log(await resolveLocalDeviceId());
  } catch (error) {
    printMessageBox('Device ID lookup failed', [error instanceof Error ? error.message : String(error)], 'red');
  }
}

export async function registerHub(env: HubEnv, options: RegisterHubOptions = {}) {
  const ctx = resolveHubContext(env);
  if (ctx.appliance) {
    requireRepoOrApplianceContext('cihub register', 'require-seed');
  } else {
    requireRepoRoot('cihub register');
  }
  const envFileName = ctx.envFile;
  const fileVars = parseEnvFile(envFileName);
  const apiBase = resolveRegisterApiBase(envFileName);
  const fallbackPortal = process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT;

  printMessageBox('Checking Hub', [`Waiting for backend at ${apiBase}?`, `If this hangs, start the stack first: ${BASE_COMMAND} up ${env}`], 'cyan');
  const ready = await waitForHubApi(apiBase, 120_000);
  if (!ready) {
    printMessageBox(
      'Hub not reachable',
      [`Could not reach ${apiBase}/api/health within 2 minutes.`, `Run ${BASE_COMMAND} up ${env} and try again.`],
      'red',
    );
    return;
  }

  let status: RegistrationStatusResponse;
  try {
    status = await fetchRegistrationStatus(apiBase);
  } catch (error) {
    printMessageBox('Registration check failed', [error instanceof Error ? error.message : String(error)], 'red');
    return;
  }

  if (registrationComplete(status)) {
    printMessageBox('Already registered', [`Phase: ${status.phase}`, 'No pairing needed. Use cihub status to inspect tunnel and URLs.'], 'green');
    return;
  }

  let shouldPrepareFresh = options.fresh === true;
  if (!shouldPrepareFresh) {
    try {
      const drift = await fetchStateDrift(apiBase);
      shouldPrepareFresh = drift.detected;
    } catch {
      // Non-fatal ? proceed without auto-clearing drift.
    }
  }

  if (shouldPrepareFresh) {
    printMessageBox(
      'Clearing local registration state',
      [
        options.fresh
          ? 'Requested via --fresh: removing stale local registration artifacts before pairing.'
          : 'State drift detected: clearing local registration artifacts before pairing (same as "Set up as new device").',
      ],
      'cyan',
    );
    try {
      const prepared = await prepareFreshSetup(apiBase);
      if (!prepared.success) {
        printMessageBox('Prepare fresh failed', [prepared.message || 'Unknown error'], 'red');
        return;
      }
      printMessageBox('Local state cleared', [prepared.message], 'green');
    } catch (error) {
      printMessageBox('Prepare fresh failed', [error instanceof Error ? error.message : String(error)], 'red');
      return;
    }
  }

  let deviceInfo: DeviceIdResponse;
  try {
    deviceInfo = await fetchDeviceId(apiBase);
  } catch (error) {
    printMessageBox('Device info failed', [error instanceof Error ? error.message : String(error)], 'red');
    return;
  }

  const deviceId = deviceInfo.device_id;
  const portalUrl = (deviceInfo.ci_cloud_url || fallbackPortal).replace(/\/$/, '');

  if (!deviceId) {
    printMessageBox(
      'Device ID unavailable',
      ['The running Hub could not resolve a device ID.', 'Check backend logs and ensure the appliance initialized correctly.'],
      'red',
    );
    return;
  }

  printMessageBox(
    'Pair with Companion Cloud',
    [
      `${bold('device id')}  ${deviceId}`,
      `${bold('portal')}     ${colorize(portalUrl, 'cyan')}`,
      '',
      '1. Sign in at the portal URL above (or create an account).',
      '2. Generate a 6-character pairing code for this device.',
      '3. Enter the code below ? no browser access to this Hub is required.',
      '',
      'The Hub will provision your Cloudflare tunnel automatically after pairing.',
    ],
    'green',
  );

  let pairingCode = options.code ? normalizePairingCode(options.code) : '';
  if (options.code && !isValidPairingCode(pairingCode)) {
    printMessageBox('Invalid pairing code', [`"${options.code}" is not a valid 6-character code.`], 'red');
    return;
  }

  if (!isValidPairingCode(pairingCode)) {
    const rl = createInterface({ input, output });
    try {
      while (!isValidPairingCode(pairingCode)) {
        const answer = await rl.question('  Pairing code (6 characters): ');
        pairingCode = normalizePairingCode(answer);
        if (!isValidPairingCode(pairingCode)) {
          console.log(colorize('  Enter a valid 6-character code from your CI Account.', 'yellow'));
        }
      }
    } finally {
      rl.close();
    }
  }

  printMessageBox('Pairing', ['Submitting pairing code to the Hub?'], 'cyan');
  const pairResult = await submitPairingCode(apiBase, pairingCode);
  if (!pairResult.success) {
    printMessageBox('Pairing failed', [pairResult.message || 'Unknown error'], 'red');
    return;
  }

  const accessHint = formatHubAccessUrl(pairResult.domain, pairResult.subdomain);
  printMessageBox(
    'Pairing accepted',
    [
      'Provisioning tunnel and DNS ? this usually takes 1?3 minutes.',
      accessHint ? `${bold('hub url')}     ${colorize(accessHint, 'cyan')}` : '',
      '',
      'You can close this SSH session once provisioning completes.',
    ].filter(Boolean),
    'green',
  );

  const finalStatus = await pollRegistrationComplete(apiBase, 300_000, (tick) => {
    if (tick.phase === 'provisioning' || tick.phase === 'paired') {
      process.stdout.write(`${dim(`  ? phase ${tick.phase}`)}\n`);
    }
  });

  if (!finalStatus || !registrationComplete(finalStatus)) {
    printMessageBox(
      'Provisioning still in progress',
      [
        'Pairing succeeded but the Hub has not reached a ready phase yet.',
        `Check progress with: ${BASE_COMMAND} status ${env}`,
        'Or open the dashboard locally while tunnel DNS propagates.',
      ],
      'yellow',
    );
    return;
  }

  const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN || pairResult.domain;
  const hubUrl = accessHint || (cfDomain ? `https://${cfDomain}` : undefined);
  printMessageBox(
    'Registration complete',
    [
      `Phase: ${finalStatus.phase}`,
      hubUrl ? `${bold('access')}      ${colorize(hubUrl, 'cyan')}` : 'Tunnel is active ? see cihub status for the public URL.',
      '',
      'Port forwarding is not required. Access the Hub from the provisioned URL above.',
    ],
    'green',
  );
}

/** Force-remove every container belonging to a compose project (best-effort, never aborts). */
function removeProjectContainers(project: string): void {
  const { stdout, ok } = runCapture('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  if (!ok || !stdout) return;
  const ids = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  runBestEffort('docker', ['rm', '-f', ...ids]);
}

function removeLeftoverProjectContainers(): void {
  removeProjectContainers('ci-hub');
}

/**
 * Label/volume/network teardown for a prod install, independent of any env file or compose file.
 * Used as the appliance fallback so a broken or partially provisioned Hub can still be cleaned.
 */
function applianceDockerTeardown(removeVolumes: boolean): void {
  for (const project of ['ci-hub', 'ci-os-hub']) {
    removeProjectContainers(project);
  }
  if (!removeVolumes) return;

  const { stdout, ok } = runCapture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  if (ok && stdout) {
    for (const volume of parseNames(stdout).filter(isRelatedVolume)) {
      runBestEffort('docker', ['volume', 'rm', volume]);
    }
  }
  for (const network of ['ci_hub_network', 'ci-hub_network', 'ci_os_hub_network', 'ci-os-hub_network']) {
    runBestEffort('docker', ['network', 'rm', network]);
  }
}

/** Tear down a desktop-installed prod Hub from anywhere (canonical data dir). */
function downApplianceHub(ctx: HubContext, options?: { volumes?: boolean }) {
  const dataDir = ctx.dataDir as string;
  const composePath = ctx.composeFiles[0];
  const composeExists = composePath !== undefined && existsSync(composePath) && existsSync(ctx.envFile);
  printMessageBox(options?.volumes ? 'Resetting prod hub runtime' : 'Stopping prod hub', [`Data dir: ${dataDir}`], 'yellow');

  if (composeExists) {
    const args = composeArgsForContext(ctx);
    args.push('down');
    if (options?.volumes) args.push('-v', '--remove-orphans');
    runBestEffort('docker', args, envOverridesForContext(ctx), dataDir);
  }
  // Fallback: remove anything the compose teardown missed (or everything when no seed is present).
  applianceDockerTeardown(Boolean(options?.volumes));
}

export function downHub(env: HubEnv, options?: { volumes?: boolean }) {
  if (isApplianceMode()) {
    requireRepoOrApplianceContext('cihub down', 'allow-missing');
    downApplianceHub(resolveHubContext(env), options);
    return;
  }
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const args = composeArgsForContext(resolveHubContext(env));
  args.push('down');
  if (options?.volumes) args.push('-v', '--remove-orphans');
  printMessageBox(options?.volumes ? 'Resetting hub runtime' : 'Stopping hub', [`Environment: ${env}`], 'yellow');
  run('docker', args, envOverrides);
  removeLeftoverProjectContainers();
}

export async function restartHub(env: HubEnv, detached = false) {
  downHub(env);
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}

function pathIsWithin(base: string, target: string): boolean {
  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function removeDirectoryTarget(targetPath: string, label: string, removed: string[], skipped: string[]) {
  if (!existsSync(targetPath)) {
    skipped.push(`${label}: ${targetPath}`);
    return;
  }
  const repoRoot = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE || repoRoot;
  if (!pathIsWithin(repoRoot, targetPath) && !pathIsWithin(homeDir, targetPath)) {
    throw new Error(`Refusing to remove ${targetPath}; it is outside the repository and user home directory.`);
  }
  rmSync(targetPath, { recursive: true, force: true });
  removed.push(`${label}: ${targetPath}`);
}

/**
 * Full wipe of a canonical prod data dir (clean slate; re-registration required afterward).
 * Removes the entire `<data dir>/companion-hub` tree, which holds the seeded `.env`, compose file,
 * app/data mounts, and the Cloudflare tunnel token. Guarded so we only ever delete a folder named
 * `companion-hub` inside the user's data/home directory.
 */
function cleanApplianceHub(ctx: HubContext) {
  const dataDir = ctx.dataDir as string;
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const safe = path.basename(dataDir) === CANONICAL_DATA_DIR_NAME && pathIsWithin(homeDir, dataDir);
  if (!safe) {
    printMessageBox(
      'Refusing to wipe data dir',
      [`Unexpected canonical data dir: ${dataDir}`, `Expected a "${CANONICAL_DATA_DIR_NAME}" folder inside your user data directory.`],
      'red',
    );
    process.exit(2);
  }
  if (existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
    printMessageBox('Prod Hub data wiped', [`removed: ${dataDir}`], 'yellow');
  } else {
    printMessageBox('Prod Hub data wiped', [dim(`already absent: ${dataDir}`)], 'yellow');
  }
}

export function cleanHub(env: HubEnv) {
  if (isApplianceMode()) {
    requireRepoOrApplianceContext('cihub clean', 'allow-missing');
    cleanApplianceHub(resolveHubContext(env));
    return;
  }
  requireRepoRoot('cihub clean');
  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const tunnelDir = path.resolve(rootFolderHost, '..', 'tunnel');
  const removed: string[] = [];
  const skipped: string[] = [];
  removeDirectoryTarget(rootFolderHost, 'root folder', removed, skipped);
  removeDirectoryTarget(tunnelDir, 'tunnel dir', removed, skipped);
  printMessageBox('Environment files cleaned', [...removed, ...skipped.map((line) => dim(`skipped ${line}`))], 'yellow');
}

function confirmDestructive(actionLabel: string, force: boolean) {
  if (force) return true;
  if (!process.stdin.isTTY) {
    console.error(colorize(`  ${STEP_ICONS.fail} ${actionLabel} is destructive \u2014 requires an interactive terminal or --yes`, 'red'));
    process.exit(2);
  }
  return false;
}

export async function confirmDestructiveAction(actionLabel: string, force: boolean, prompt: string) {
  if (confirmDestructive(actionLabel, force)) return true;
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

export async function resetHub(env: HubEnv, force: boolean): Promise<boolean> {
  const appliance = isApplianceMode();
  if (appliance) {
    requireRepoOrApplianceContext('cihub reset', 'allow-missing');
  } else {
    requireRepoRoot('cihub reset');
  }
  const label = appliance ? 'prod (canonical install)' : env;
  const confirmed = await confirmDestructiveAction(
    `Resetting ${label}`,
    force,
    `Reset ${label} runtime state (containers, volumes, and host files)? [y/N]: `,
  );
  if (!confirmed) {
    printMessageBox('Reset cancelled', ['Left runtime state untouched.'], 'yellow');
    return false;
  }
  downHub(env, { volumes: true });
  verifyHubVolumesRemoved();
  try {
    cleanHub(env);
  } catch (error) {
    printMessageBox('Host cleanup reported an error', [String(error)], 'yellow');
  }
  cleanRootOwnedHubData(env);
  printMessageBox(
    'Reset complete',
    ['Hub runtime state, volumes, and host data were removed.', 'Re-launch CI Hub or run `cihub up dev` (or `cihub up prod`) to start fresh.'],
    'green',
  );
  return true;
}

function verifyHubVolumesRemoved() {
  const { stdout } = runCapture('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  const lingering = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.includes('ci_hub_pgdata') || value.includes('ci_hub_app_data') || value.includes('hub_tailscale_state'));

  if (lingering.length === 0) {
    return;
  }

  printMessageBox('Removing lingering Hub volumes', lingering, 'yellow');
  for (const volume of lingering) {
    runBestEffort('docker', ['volume', 'rm', volume]);
  }
}

function cleanRootOwnedHubData(env: HubEnv) {
  if (isApplianceMode()) return;

  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  if (!existsSync(rootFolderHost)) return;

  try {
    rmSync(rootFolderHost, { recursive: true, force: true });
    return;
  } catch {
    // Fall through to a root-owned bind mount cleanup via Docker.
  }

  if (!existsSync(rootFolderHost)) return;

  const hostPath = path.resolve(rootFolderHost);
  printMessageBox('Cleaning root-owned hub data via Docker', [`Target: ${hostPath}`], 'yellow');
  runBestEffort('docker', [
    'run',
    '--rm',
    '-v',
    `${dockerBindMountPath(hostPath)}:/d`,
    'alpine',
    'sh',
    '-c',
    'rm -rf /d/* /d/.[!.]* /d/..?* 2>/dev/null || true',
  ]);
  try {
    rmSync(rootFolderHost, { recursive: true, force: true });
  } catch {
    // Best effort \u2014 directory may still contain root-owned entries.
  }
}

export async function recreateHub(env: HubEnv, detached = false, force = false) {
  const resetComplete = await resetHub(env, force);
  if (!resetComplete) return;
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}

export function logsHub(env: HubEnv, service?: string) {
  const ctx = resolveHubContext(env);
  const envOverrides = envOverridesForContext(ctx);
  const args = composeArgsForContext(ctx);
  args.push('logs', '-f');
  if (service) args.push(service);
  run('docker', args, envOverrides, ctx.cwd);
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
  const lines = [
    `Docker               ${checkDockerAvailable() ? cliOk('available') : cliFail('unavailable')}`,
    `Docker Compose       ${runCapture('docker', ['compose', 'version']).ok ? cliOk('available') : cliFail('unavailable')}`,
    `Env file             ${existsSync(resolvePath(envFileName)) ? cliOk('found') : cliWarn('missing')}  ${envFileName}`,
    `Root folder          ${existsSync(rootFolderHost) ? cliOk('present') : cliWarn('missing')}  ${rootFolderHost}`,
    `Compose files        ${composeFiles.every((file) => existsSync(resolvePath(file))) ? cliOk('found') : cliFail('missing')}  ${composeFiles.join(', ')}`,
    `Tunnel token         ${doctorHasTunnelToken(ctx) ? cliOk('present') : colorize(`${STEP_ICONS.pending} absent`, 'dim')}`,
    ...networkSection.lines,
    ...bridgeSection.lines,
  ];
  const tone = networkSection.issueCount + bridgeSection.issueCount > 0 ? 'yellow' : 'cyan';
  printMessageBox(`Hub doctor  [${ctx.env}]`, lines, tone);
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
  printMessageBox(
    'Uninstall complete',
    [
      `removed directories: ${summary.removedDirs}`,
      `skipped directories: ${summary.skippedDirs}`,
      `directory failures: ${summary.failedDirs}`,
      `commands attempted: ${summary.attemptedCommands}`,
      `command failures: ${summary.failedCommands}`,
    ],
    summary.failedDirs > 0 || summary.failedCommands > 0 ? 'yellow' : 'green',
  );
}

function findComposeName(keyword: string): string {
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

// --- models ---

export function runModelsCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  const ollamaContainer = findComposeName('ollama');
  if (!ollamaContainer) {
    printMessageBox('Models', ['Ollama container not running. Start the hub first: cihub up'], 'yellow');
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
    run('docker', ['exec', '-it', ollamaContainer, 'ollama', 'pull', name]);
    return;
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models rm <model-name>');
    printMessageBox('Removing model', [`Removing ${bold(name)} from Ollama?`], 'yellow');
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

// --- API keys ---

const API_KEY_DB_CONTAINER = 'ci-hub-db';
const API_KEY_DB_PORT = '6543';
const API_KEY_DB_USER = 'companion';
const API_KEY_DB_NAME = 'companiondb';
const API_KEY_BYTES = 32; // 64 hex chars — mirrors KEY_BYTES in ApiKeyService
const API_KEY_PREFIX_LEN = 8; // mirrors PREFIX_LEN in ApiKeyService

/**
 * Scopes an *operator* key may carry — deliberately narrower than API_KEY_SCOPES in
 * packages/backend/src/modules/api-keys/api-key.scopes.ts, and the same line ApiKeyAdminService
 * takes for the UI (it pins operator keys to ['mcp']).
 *
 * 'app' is honoured only on a *managed* row: resolveManagedAppUrn requires `managed` and an owning
 * app URN, both of which only app provisioning sets. An operator key carrying 'app' would list as
 * correctly provisioned and authenticate nothing — the same "credential that isn't one" this
 * command exists to retire.
 */
const OPERATOR_API_KEY_SCOPES: readonly string[] = ['mcp'];

/** Scopes that exist but are only ever minted for an app, so the error can say why, not just "unknown". */
const MANAGED_ONLY_API_KEY_SCOPES: readonly string[] = ['app'];

/**
 * What a key may DO on the surfaces its scopes reach — mirrors API_KEY_CAPABILITIES in
 * packages/backend/src/modules/api-keys/api-key.capabilities.ts.
 *
 * 'read' is offered here, not just in the UI, because the headless case is where it matters most: a
 * key minted over ssh for a third-party MCP client should be mintable read-only in the same breath,
 * not created wide and tightened later in a browser.
 */
const API_KEY_CAPABILITIES: readonly string[] = ['read', 'write', 'full'];

/** Mirrors DEFAULT_API_KEY_CAPABILITY: what a key can do when nobody said. */
const DEFAULT_API_KEY_CAPABILITY = 'write';

/** Escape a value for single-quoted SQL. Names are also validated before they reach here. */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Key names are interpolated into SQL, so the character set is deliberately narrow — quoting alone
 * is not the only line of defence. `app:` is reserved for keys the Hub provisions to marketplace
 * apps; an operator key must not be able to impersonate one. A leading `-` is refused too: it is
 * never a sensible label, and it is what `--name --scopes mcp` (a flag whose value was forgotten)
 * looks like by the time it reaches here.
 */
export function isValidApiKeyName(name: string): boolean {
  return /^[\w .:@][\w .:@-]{0,63}$/.test(name) && !name.startsWith('app:');
}

/**
 * Split a `--scopes` value into the scopes an operator key may hold, the app-only ones, and the
 * unrecognised ones — the caller refuses the last two with different explanations.
 *
 * Deduped and ordered by OPERATOR_API_KEY_SCOPES, mirroring ApiKeyService.normalizeScopes: a row
 * this command writes should be indistinguishable from one the service wrote for the same grant.
 */
export function parseApiKeyScopes(input: string): { scopes: string[]; invalid: string[]; managedOnly: string[] } {
  const requested = [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const allowed = OPERATOR_API_KEY_SCOPES.filter((scope) => requested.includes(scope));
  const rejected = requested.filter((scope) => !allowed.includes(scope));

  return {
    scopes: [...allowed, ...rejected],
    managedOnly: rejected.filter((scope) => MANAGED_ONLY_API_KEY_SCOPES.includes(scope)),
    invalid: rejected.filter((scope) => !MANAGED_ONLY_API_KEY_SCOPES.includes(scope)),
  };
}

/**
 * Build the INSERT for a new key. Split out from the command so the one string that actually reaches
 * the database is unit-testable — the validation above narrows what can get here, but the quoting is
 * the last line of defence and deserves its own assertions.
 */
export function buildApiKeyInsertSql(row: {
  name: string;
  scopes: string[];
  capability: string;
  prefix: string;
  hashedKey: string;
  /** False on a Hub released before per-key capability existed. */
  withCapability?: boolean;
}): string {
  const scopeArray = `ARRAY[${row.scopes.map(sqlQuote).join(',')}]::text[]`;

  if (row.withCapability === false) {
    return (
      `INSERT INTO api_key (name, scopes, prefix, hashed_key) VALUES (${sqlQuote(row.name)}, ${scopeArray}, ` +
      `${sqlQuote(row.prefix)}, ${sqlQuote(row.hashedKey)}) RETURNING id;`
    );
  }

  return (
    `INSERT INTO api_key (name, scopes, capability, prefix, hashed_key) VALUES (${sqlQuote(row.name)}, ${scopeArray}, ` +
    `${sqlQuote(row.capability)}, ${sqlQuote(row.prefix)}, ${sqlQuote(row.hashedKey)}) RETURNING id;`
  );
}

/**
 * Does this Hub's `api_key` table carry the `capability` column?
 *
 * Per-key capability arrived after several published Hub releases, and the CLI is run
 * against whatever appliance is in front of it — an older one than the checkout is the
 * normal case, not an edge case. Verified against a live 0.2.47: without this the insert
 * dies on `column "capability" of relation "api_key" does not exist`, so the documented
 * headless key-minting route fails outright on exactly the appliances that most need a
 * CLI, since minting in the browser is what it exists to avoid.
 *
 * Unknown answers are treated as "present": that keeps the modern path first, and a
 * genuinely missing column still surfaces as the same insert error as before.
 */
export function apiKeyTableHasCapability(): boolean {
  const result = psql("SELECT 1 FROM information_schema.columns WHERE table_name='api_key' AND column_name='capability';");
  if (!result.ok) return true;
  return result.stdout.split('\n')[0]?.trim() === '1';
}

/**
 * Make an untrusted string safe to print inside a message box: whitespace runs collapse to a single
 * space (so a value cannot span rows) and every control character is dropped.
 *
 * `stripAnsi` is not enough on its own — it only removes SGR colour sequences, so `ESC[2J`, a bare
 * ESC, or any other C0 character would survive and be handed to the terminal verbatim.
 */
export function sanitizeForBox(value: string): string {
  return [...stripAnsi(value).replace(/\s+/g, ' ')]
    .filter((char) => char >= ' ' && char !== '\u007f') // >= space keeps printables; \u007f is DEL
    .join('')
    .trim();
}

/**
 * Render the `api-key list` JSON document as display rows.
 *
 * Tolerates a malformed/empty document by returning no rows rather than throwing: the caller has
 * already handled the psql failure case, and a parse error here should not crash the CLI.
 */
export function formatApiKeyRows(json: string, withCapability = true): string[] {
  let parsed: Array<{ id?: number; name?: string; scopes?: string[]; capability?: string; prefix?: string }>;

  try {
    parsed = JSON.parse(json || '[]');
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((row) => {
    const scopes = Array.isArray(row.scopes) && row.scopes.length > 0 ? row.scopes.join(',') : '-';
    // Shown for every key, including ones minted before the column existed (which read as 'write',
    // the column default) — a listing that omitted it would make a read-only key look unrestricted.
    //
    // But on a Hub with no capability column there is no per-key capability to report, and
    // defaulting to 'write' there would state a restriction the server does not enforce. Omit the
    // field entirely rather than invent one.
    const capability = withCapability
      ? ` ${typeof row.capability === 'string' && row.capability ? row.capability : DEFAULT_API_KEY_CAPABILITY} `
      : ' ';

    // Names reach this box unfiltered from the key store, and the store does not constrain them:
    // the UI's create body is `z.string().trim().min(1).max(100)`, so a name may hold ANSI escapes
    // or other control characters. Collapse whitespace first (so one key still cannot span rows),
    // then drop every remaining control character — unstripped they would be written straight to
    // the terminal, and they count toward string length, which also skews the box width.
    const name = sanitizeForBox(String(row.name ?? ''));

    return `${row.id}  ${name}  [${scopes}] ${capability} ${row.prefix ?? ''}…`;
  });
}

/**
 * Run one statement against the Hub database.
 *
 * Captures stderr as well as stdout — psql reports *every* failure there (container down, missing
 * relation, unique violation), so a stdout-only capture like {@link runCapture} would render a
 * duplicate-key error and a stopped Hub as the same blank "non-zero exit code".
 */
function psql(sql: string): { stdout: string; stderr: string; ok: boolean } {
  const result = spawnSync(
    'docker',
    ['exec', API_KEY_DB_CONTAINER, 'psql', '-U', API_KEY_DB_USER, '-d', API_KEY_DB_NAME, '-p', API_KEY_DB_PORT, '-At', '-c', sql],
    { encoding: 'utf-8', stdio: 'pipe' },
  );

  return {
    stdout: (result.stdout || '').trim(),
    // result.error covers docker itself being absent, where there is no stderr to read.
    stderr: (result.stderr || '').trim() || (result.error ? String(result.error) : ''),
    ok: result.status === 0,
  };
}

/** psql's own diagnosis, as box lines. Capped so a stack of NOTICEs can't swamp the message. */
function psqlErrorLines(result: { stdout: string; stderr: string }): string[] {
  const detail = (result.stderr || result.stdout).split('\n').filter(Boolean).slice(0, 6);

  return detail.length > 0 ? detail : ['psql returned a non-zero exit code'];
}

/**
 * Operator API keys from the terminal.
 *
 * SEC-MCP-8 made the hashed store the sole auth authority and deliberately removed the guard's env
 * fallback, so `MCP_API_KEY` authenticates nothing. Until now the only way to obtain a real key was
 * the browser UI (Settings → Security), which blocks headless and remote setup. The CLI already
 * holds appliance-level privilege (it owns the env file and drives docker), so it writes the row.
 *
 * Columns mirror `api_key` in packages/backend/src/core/database/drizzle/schema.ts; the hash mirrors
 * ApiKeyService.hash() (sha256 hex). Keep all three in step if the schema moves.
 */
export function runApiKeyCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  if (subcommand === 'create') {
    const nameFlag = args.indexOf('--name');
    const name = nameFlag >= 0 ? args[nameFlag + 1] : undefined;
    if (!name)
      usageAndExit(
        `Usage: ${BASE_COMMAND} api-key create --name <label> [--scopes ${OPERATOR_API_KEY_SCOPES.join(',')}] ` +
          `[--capability ${API_KEY_CAPABILITIES.join('|')}]`,
      );
    if (!isValidApiKeyName(name)) {
      usageAndExit(
        `Invalid key name. Use 1-64 chars of letters, digits, space, or . : @ _ - starting with anything but '-', and do not start with 'app:' (reserved for managed app keys).`,
      );
    }

    const scopesFlag = args.indexOf('--scopes');
    const { scopes, invalid, managedOnly } = parseApiKeyScopes(scopesFlag >= 0 ? (args[scopesFlag + 1] ?? '') : 'mcp');
    if (scopes.length === 0) usageAndExit(`At least one scope is required. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);
    if (managedOnly.length > 0) {
      usageAndExit(
        `The '${managedOnly.join("', '")}' scope is carried only by managed keys the Hub provisions to installed apps — the callback guard checks the key's owning app, so an operator key holding it would authenticate nothing. Use --scopes ${OPERATOR_API_KEY_SCOPES.join(',')}.`,
      );
    }
    if (invalid.length > 0) usageAndExit(`Unknown scope(s): ${invalid.join(', ')}. Valid: ${OPERATOR_API_KEY_SCOPES.join(', ')}`);

    const capabilityFlag = args.indexOf('--capability');
    const capability = capabilityFlag >= 0 ? (args[capabilityFlag + 1] ?? '') : DEFAULT_API_KEY_CAPABILITY;
    if (!API_KEY_CAPABILITIES.includes(capability)) {
      usageAndExit(
        `Unknown capability: ${capability || '(empty)'}. Valid: ${API_KEY_CAPABILITIES.join(', ')} — ` +
          "'read' calls read-only tools, 'write' also mutates (install/start/stop/reconfigure), 'full' also runs destructive tools (uninstall/reset/delete).",
      );
    }

    const rawKey = randomBytes(API_KEY_BYTES).toString('hex');
    const withCapability = apiKeyTableHasCapability();
    const sql = buildApiKeyInsertSql({
      name,
      scopes,
      capability,
      prefix: rawKey.slice(0, API_KEY_PREFIX_LEN),
      hashedKey: createHash('sha256').update(rawKey).digest('hex'),
      withCapability,
    });

    const result = psql(sql);
    const { stdout, ok } = result;
    if (!ok) {
      printMessageBox('API key creation failed', [...psqlErrorLines(result), '', `Is the Hub running? Try ${bold(`${BASE_COMMAND} up`)}.`], 'red');
      process.exit(1);
    }

    // Even with -At, psql appends its command tag ("INSERT 0 1") after the RETURNING row.
    const newId = stdout.split('\n')[0]?.trim() ?? '';

    printMessageBox(
      'API key created',
      [
        `${bold('id')}      ${newId}`,
        `${bold('name')}    ${name}`,
        `${bold('scopes')}  ${scopes.join(', ')}`,
        // Reporting the requested capability on a Hub that cannot store it would be a
        // plain untruth about how much authority the key just gained.
        ...(withCapability
          ? [`${bold('can')}     ${capability}`]
          : [
              `${bold('can')}     everything its scopes allow`,
              '',
              'This Hub predates per-key capability, so there is no read/write/full',
              `distinction to apply and ${bold(`--capability ${capability}`)} was not stored.`,
              'Update the Hub if you need capability-limited keys.',
            ]),
        '',
        `${bold('key')}     ${rawKey}`,
        '',
        'This is the only time the key is shown. Store it now.',
        'Change what it can do, or revoke it, in Settings → Security.',
      ],
      'green',
    );
    return;
  }

  if (subcommand === 'list') {
    // Aggregate to a single JSON document rather than concatenating columns: key names predate this
    // command's validation (the UI accepts any string), so a name containing a newline or the
    // separator would otherwise split into bogus rows.
    // Same schema split as `create`: selecting a column an older Hub does not have fails the whole
    // query, so `api-key list` was unusable on every published release rather than degrading.
    const withCapability = apiKeyTableHasCapability();
    const fields = ["'id', id", "'name', name", "'scopes', scopes", ...(withCapability ? ["'capability', capability"] : []), "'prefix', prefix"].join(
      ', ',
    );
    const result = psql(`SELECT COALESCE(json_agg(json_build_object(${fields}) ORDER BY id)::text, '[]') FROM api_key;`);
    if (!result.ok) {
      printMessageBox('Could not read API keys', [...psqlErrorLines(result), '', `Is the Hub running? Try ${bold(`${BASE_COMMAND} up`)}.`], 'red');
      process.exit(1);
    }
    const rows = formatApiKeyRows(result.stdout, withCapability);
    printMessageBox('API keys', rows.length > 0 ? rows : ['(none — create one with `api-key create --name <label>`)'], 'cyan');
    return;
  }

  usageAndExit(`Unknown api-key subcommand: ${subcommand}. Use: create, list`);
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
      printMessageBox(`Public Web repair  [${env}]`, lines, publicWebRepairHasFailures(lines) ? 'yellow' : 'green');
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

// --- app lifecycle ---

export function parseAppRuntimeArgs(args: string[]) {
  const ports: string[] = [];
  const envVars: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port') {
      const v = args[i + 1];
      if (!v) usageAndExit('Missing value for --port');
      ports.push(v);
      i += 1;
    } else if (arg === '--env') {
      const v = args[i + 1];
      if (!v) usageAndExit('Missing value for --env');
      envVars.push(v);
      i += 1;
    } else {
      usageAndExit(`Unknown app option: ${arg}`);
    }
  }
  return { ports, envVars };
}

export function appStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith('up')) return colorize(status, 'green');
  if (s.startsWith('exit')) return colorize(status, 'red');
  if (s.startsWith('paus')) return colorize(status, 'yellow');
  return dim(status);
}

function managedAppContainerIds(): string[] {
  const ids = new Set<string>();
  for (const filters of [
    ['label=ci-hub.managed=true', 'label=ci-hub.appurn'],
    ['label=ci-os-hub.managed=true', 'label=ci-os-hub.appurn'],
  ]) {
    const { stdout, ok } = runCapture('docker', ['ps', '-a', '--filter', filters[0], '--filter', filters[1], '--format', '{{.ID}}']);
    if (!ok || !stdout) continue;
    for (const id of stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function runAppCommand(args: string[]) {
  const subcommand = args[0];
  if (!subcommand) usageAndExit('Missing app subcommand');

  // list ??????????????????????????????????????????????????????????????????????
  if (subcommand === 'list') {
    printMessageBox('Managed Docker apps', ['Listing all containers on this machine.'], 'cyan');
    run('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    return;
  }

  // status ????????????????????????????????????????????????????????????????????
  if (subcommand === 'status') {
    const name = args[1];
    const filterArgs = name
      ? ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}']
      : ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'];
    const { stdout } = runCapture('docker', filterArgs);
    const rows = stdout.split('\n').filter(Boolean);
    if (rows.length === 0) {
      printMessageBox('App status', [name ? `Container "${name}" not found.` : 'No containers running.'], 'yellow');
      return;
    }
    const lines = rows.map((row) => {
      const [n, s, p] = row.split('\t');
      const isUp = (s || '').toLowerCase().startsWith('up');
      const dot = isUp ? colorize(STEP_ICONS.done, 'green') : colorize(STEP_ICONS.fail, 'red');
      const statusStr = appStatusColor(s || '');
      const portsStr = p ? dim(` \u2192 ${p}`) : '';
      return `${dot} ${bold(n || '')}  ${statusStr}${portsStr}`;
    });
    printMessageBox('App status', lines, 'cyan');
    return;
  }

  // logs ??????????????????????????????????????????????????????????????????????
  if (subcommand === 'logs') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app logs <name> [--tail N]');
    const tailIdx = args.indexOf('--tail');
    const tail = tailIdx !== -1 && args[tailIdx + 1] ? args[tailIdx + 1] : '50';
    printMessageBox('Container logs', [`Container: ${name}`, `Tail: ${tail} lines`], 'dim');
    run('docker', ['logs', '--tail', tail, '--timestamps', name]);
    return;
  }

  if (subcommand === 'stop-managed' || subcommand === 'remove-managed') {
    const ids = managedAppContainerIds();
    if (ids.length === 0) {
      printMessageBox('Managed app cleanup', ['No Hub-managed app containers found.'], 'yellow');
      return;
    }
    const dockerCommand = subcommand === 'stop-managed' ? 'stop' : 'rm';
    const dockerArgs = subcommand === 'stop-managed' ? ['stop', ...ids] : ['rm', '-f', ...ids];
    printMessageBox('Managed app cleanup', [`Action: ${subcommand === 'stop-managed' ? 'stop' : 'remove'}`, `Containers: ${ids.length}`], 'yellow');
    run('docker', dockerArgs);
    printMessageBox('Managed app cleanup', [`Successfully ran docker ${dockerCommand} on ${ids.length} Hub-managed app container(s).`], 'green');
    return;
  }

  // inspect ???????????????????????????????????????????????????????????????????
  if (subcommand === 'inspect') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app inspect <name>');
    const { stdout, ok } = runCapture('docker', ['inspect', name]);
    if (!ok || !stdout) {
      printMessageBox('Inspect', [`Container "${name}" not found.`], 'red');
      return;
    }
    let info: Record<string, unknown>[];
    try {
      info = JSON.parse(stdout) as Record<string, unknown>[];
    } catch {
      printMessageBox('Inspect', [stdout], 'dim');
      return;
    }
    const c = info[0] as {
      State?: { Status?: string };
      NetworkSettings?: { Ports?: Record<string, unknown> };
      Config?: { Env?: string[]; Image?: string };
      Mounts?: Array<{ Source?: string; Destination?: string }>;
    };
    const lines: string[] = [`${bold('image')}   ${c.Config?.Image || '?'}`, `${bold('status')}  ${appStatusColor(c.State?.Status || '?')}`];
    const ports = Object.entries(c.NetworkSettings?.Ports || {})
      .map(([k, v]) => {
        const binds = v as Array<{ HostPort?: string }> | null;
        const host = binds?.[0]?.HostPort;
        return host ? `${host} \u2192 ${k}` : k;
      })
      .filter(Boolean);
    if (ports.length > 0) lines.push(`${bold('ports')}   ${ports.join('  ')}`);
    const envVars = (c.Config?.Env || []).filter((e) => !e.startsWith('PATH='));
    if (envVars.length > 0) lines.push(`${bold('env')}     ${envVars.slice(0, 5).join('  ')}`);
    const mounts = (c.Mounts || []).map((m) => `${m.Source} \u2192 ${m.Destination}`);
    if (mounts.length > 0) lines.push(`${bold('mounts')} ${mounts.slice(0, 3).join('  ')}`);
    printMessageBox(`Inspect: ${name}`, lines, 'cyan');
    return;
  }

  // add / edit ????????????????????????????????????????????????????????????????
  if (subcommand === 'add' || subcommand === 'edit') {
    const name = args[1];
    const image = args[2];
    if (!name || !image) usageAndExit(`Usage: app ${subcommand} <name> <image> [--port host:container] [--env KEY=VALUE]`);
    const runtime = parseAppRuntimeArgs(args.slice(3));
    if (subcommand === 'edit') spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const runArgs = ['run', '-d', '--name', name];
    for (const p of runtime.ports) runArgs.push('-p', p);
    for (const e of runtime.envVars) runArgs.push('-e', e);
    runArgs.push(image);
    printMessageBox(
      subcommand === 'add' ? 'Adding container app' : 'Editing container app',
      [
        `${bold('name')}   ${name}`,
        `${bold('image')}  ${image}`,
        `${bold('ports')}  ${runtime.ports.length > 0 ? runtime.ports.join(', ') : '(none)'}`,
        `${bold('env')}    ${runtime.envVars.length > 0 ? runtime.envVars.join(', ') : '(none)'}`,
      ],
      'green',
    );
    run('docker', runArgs);
    return;
  }

  // start / stop / restart / delete ??????????????????????????????????????????
  const name = args[1];
  if (!name) usageAndExit(`Usage: app ${subcommand} <name>`);

  if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'restart') {
    printMessageBox('Container app lifecycle', [`${subcommand} ${name}`], 'cyan');
    run('docker', [subcommand, name]);
    return;
  }

  if (subcommand === 'delete') {
    printMessageBox('Container app lifecycle', [`Removing container: ${name}`], 'yellow');
    run('docker', ['rm', '-f', name]);
    return;
  }

  usageAndExit(`Unknown app subcommand: ${subcommand}`);
}

// --- wizard ---

export function resolveWizardEnvInput(value: string, fallback: HubEnv = 'local'): HubEnv {
  const n = value.trim().toLowerCase();
  const map: Record<string, HubEnv> = {
    '': fallback,
    '1': 'local',
    local: 'local',
    '2': 'dev',
    dev: 'dev',
    '3': 'staging',
    staging: 'staging',
    '4': 'prod',
    prod: 'prod',
  };
  const env = map[n];
  if (!env) usageAndExit(`Unknown env: ${value}`);
  return env;
}

export function resolveWizardActionInput(value: string) {
  const n = value.trim().toLowerCase();
  const map: Record<string, string> = {
    '': 'setup',
    '1': 'setup',
    setup: 'setup',
    '2': 'up',
    up: 'up',
    '3': 'register',
    register: 'register',
    '4': 'config',
    config: 'config',
    '5': 'mcp-setup',
    'mcp-setup': 'mcp-setup',
    '6': 'mcp-shutdown',
    'mcp-shutdown': 'mcp-shutdown',
    '7': 'down',
    down: 'down',
    '8': 'app-list',
    'app-list': 'app-list',
    '9': 'reset',
    reset: 'reset',
    '10': 'restart',
    restart: 'restart',
  };
  const action = map[n];
  if (!action) usageAndExit(`Unknown wizard action: ${value}`);
  return action;
}

export async function runWizard(defaultEnv: HubEnv = 'local') {
  if (!process.stdin.isTTY) throw new Error('Wizard requires an interactive TTY terminal');

  const firstRun = isFirstRun(envFileMap[defaultEnv]);
  console.log(renderWizardWelcome());

  const FTUE_STEPS = 6;

  if (firstRun) {
    console.log();
    console.log(
      box(
        'First-time setup detected',
        [
          `No ${envFileMap[defaultEnv]} found \u2014 the wizard will guide you through initial setup.`,
          '',
          renderStep(1, FTUE_STEPS, 'Choose environment', 'pending'),
          renderStep(2, FTUE_STEPS, 'Check prerequisites', 'pending'),
          renderStep(3, FTUE_STEPS, 'Initialize host & Docker config', 'pending'),
          renderStep(4, FTUE_STEPS, 'Start the Hub', 'pending'),
          renderStep(5, FTUE_STEPS, 'Register with CI Cloud', 'pending'),
          renderStep(6, FTUE_STEPS, 'Install initial model (optional)', 'pending'),
        ],
        'yellow',
      ),
    );
    console.log();
  }

  const rl = createInterface({ input, output });

  try {
    // -- Step 1: environment --
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, 'Choose environment', 'active'));
    printMessageBox(
      'Choose environment',
      [
        '1. local    \u2014 Source-based local development  (default)',
        '2. dev      \u2014 Dev appliance environment',
        '3. staging  ? Staging appliance environment',
        '4. prod     ? Production appliance environment',
      ],
      'cyan',
    );
    const envAnswer = await rl.question('  Environment [1-4, default 1]: ');
    const env = resolveWizardEnvInput(envAnswer, defaultEnv);
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, `Environment: ${bold(env)}`, 'done'));

    if (firstRun) {
      // -- Step 2: prerequisites --
      console.log();
      console.log(renderStep(2, FTUE_STEPS, 'Checking prerequisites?', 'active'));
      const dockerOk = checkDockerAvailable();
      const { stdout: dcVersion } = runCapture('docker', ['compose', 'version']);
      const { stdout: tsIp } = runCapture('tailscale', ['ip', '--4']);
      console.log(
        box(
          'Prerequisites',
          [
            `Docker:           ${dockerOk ? cliOk('available') : cliFail('not running')}`,
            `Docker Compose:   ${dcVersion ? cliOk('available') : cliFail('not found')}`,
            `Tailscale VPN:    ${tsIp.trim() ? cliOk(tsIp.trim()) : colorize(`${STEP_ICONS.pending} not connected (optional)`, 'dim')}`,
            `Env file:         ${existsSync(join(process.cwd(), envFileMap[env])) ? cliOk('found') : cliWarn('will be created')}`,
          ],
          'cyan',
        ),
      );
      if (!dockerOk) {
        printMessageBox('Docker required', ['Please start Docker Desktop and re-run the wizard.'], 'red');
        return;
      }
      console.log(renderStep(2, FTUE_STEPS, 'Prerequisites checked', 'done'));

      // -- Step 3: setup --
      console.log();
      console.log(renderStep(3, FTUE_STEPS, 'Initializing host assets?', 'active'));
      await setupHub(env);
      console.log(renderStep(3, FTUE_STEPS, 'Host initialized', 'done'));

      // -- Step 4: start --
      console.log();
      console.log(renderStep(4, FTUE_STEPS, 'Starting the Hub?', 'active'));
      const detached = (await rl.question('  Run detached (background)? [y/N]: ')).trim().toLowerCase();
      await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
      console.log(renderStep(4, FTUE_STEPS, 'Hub launched', 'done'));

      // -- Step 5: register --
      console.log();
      console.log(renderStep(5, FTUE_STEPS, 'Pairing with CI Cloud?', 'active'));
      await registerHub(env);
      console.log(renderStep(5, FTUE_STEPS, 'Registration flow complete', 'done'));

      // -- Step 6: optional model --
      console.log();
      console.log(renderStep(6, FTUE_STEPS, 'Install initial AI model (optional)', 'active'));
      printMessageBox(
        'Recommended models',
        [
          'llama3        4.7 GB \u2014 general purpose, fast',
          'mistral       4.1 GB \u2014 good reasoning, efficient',
          'phi3          2.3 GB \u2014 lightweight, great for low VRAM',
          'codestral    18.8 GB \u2014 code-focused',
          '',
          'Press Enter to skip model installation.',
        ],
        'cyan',
      );
      const modelAnswer = (await rl.question('  Model to install [llama3 / name / Enter to skip]: ')).trim();
      if (modelAnswer) {
        runModelsCommand(['install', modelAnswer]);
        console.log(renderStep(6, FTUE_STEPS, `Model ${bold(modelAnswer)} installed`, 'done'));
      } else {
        console.log(renderStep(6, FTUE_STEPS, 'Skipped \u2014 install later with: cihub models install llama3', 'pending'));
      }

      // -- completion --
      const envFileName = getEnvFileOrExit(env);
      const fileVars = parseEnvFile(envFileName);
      const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN;
      console.log();
      console.log(hr('dim'));
      console.log(colorize(`  ${STEP_ICONS.done} Setup complete! Your CI Hub is running.`, 'green'));
      console.log(dim(`  Local     http://localhost:${fileVars.FRONTEND_PORT || fileVars.BACKEND_PORT || '5002'}`));
      if (cfDomain) console.log(dim(`  Cloud     https://${cfDomain}`));
      if (tsIp.trim()) console.log(dim(`  Tailscale ${tsIp.trim()}`));
      console.log(dim(`  Manage    ${BASE_COMMAND} status \u2014 ${BASE_COMMAND} models list \u2014 ${BASE_COMMAND} --help`));
      return;
    }

    // -- returning user: action menu --
    printMessageBox(
      'Choose action',
      [
        ' 1. setup         Prepare host assets',
        ' 2. up            Start the hub stack',
        ' 3. register      Pair Hub with CI Cloud (hub must be running)',
        ' 4. config        Show resolved configuration',
        ' 5. mcp-setup     Enable MCP',
        ' 6. mcp-shutdown  Disable MCP',
        ' 7. down          Stop the hub stack',
        ' 8. app-list      List local Docker apps',
        ' 9. reset         Remove runtime state for this environment',
        '10. restart       Restart the selected environment',
      ],
      'cyan',
    );
    const actionAnswer = await rl.question('  Action [1-10, default 1]: ');
    const action = resolveWizardActionInput(actionAnswer);

    if (action === 'setup') return await setupHub(env);
    if (action === 'up') {
      const detached = (await rl.question('  Detached mode? [y/N]: ')).trim().toLowerCase();
      return await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
    }
    if (action === 'register') return await registerHub(env);
    if (action === 'config') return printConfig(env);
    if (action === 'mcp-setup') return setMcpState(env, true);
    if (action === 'mcp-shutdown') return setMcpState(env, false);
    if (action === 'down') return downHub(env);
    if (action === 'app-list') return runAppCommand(['list']);
    if (action === 'reset') return await resetHub(env, false);
    if (action === 'restart') return await restartHub(env);
  } finally {
    rl.close();
  }
}

// --- version ---

export function renderVersion(): string {
  return `${BASE_COMMAND} ${packageVersion()}`;
}

// --- error / usage ---

export function usageAndExit(message?: string, code = 2): never {
  if (message) console.error(colorize(`  ${STEP_ICONS.fail} ${message}`, 'red'));
  console.error(renderHelp());
  process.exit(code);
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
