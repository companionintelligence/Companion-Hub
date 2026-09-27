/**
 * Resolved execution context for a lifecycle command.
 *
 * In a CI-Hub checkout this mirrors the historical repo behavior (env arg honored,
 * repo-relative `.env.<env>` and compose files). Outside a checkout the CLI operates in
 * "appliance" mode: the environment is inferred as `prod` and every path resolves to the
 * canonical desktop data dir, so a packaged install drives the same stack the desktop app does.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnvOverrides, getComposeFiles, getEnvFileOrExit } from './cli-compose-env.js';
import { isApplianceMode, isHubRepoRoot } from './cli-repo-context.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { colorize, dim, printMessageBox } from './cli-ui.js';
import { enumerateDockerEngineCandidates, probeReachableEngines, resolveAndPinHubDockerEngine, splitBrainConflict } from './docker-engine.js';
import { resolveProdApplianceContext } from './paths.js';
import { resolvePostgresPassword, seedApplianceInstall } from './seed-appliance.js';

export function buildComposeBaseArgs(envFileName: string, files: string[]): string[] {
  const args = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) args.push('-f', f);
  return args;
}

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
export function composeArgsForContext(ctx: HubContext): string[] {
  return buildComposeBaseArgs(ctx.envFile, ctx.composeFiles);
}

/**
 * Resolve/pin the Hub Docker engine for appliance installs so CLI compose matches
 * the desktop app (`state/docker-engine.json`).
 */
export function applyDockerEnginePin(overrides: Record<string, string | undefined>, dataDir: string): Record<string, string | undefined> {
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
export function envOverridesForContext(ctx: HubContext): Record<string, string | undefined> {
  let overrides = buildEnvOverrides(ctx.envFile);
  if (ctx.appliance && ctx.dataDir) {
    overrides.ROOT_FOLDER_HOST = ctx.dataDir;
    overrides = applyDockerEnginePin(overrides, ctx.dataDir);
  }
  return overrides;
}

export function noteApplianceTarget(dataDir: string): void {
  if (applianceNoticeShown) return;
  applianceNoticeShown = true;
  printMessageBox('Targeting prod install', ['No CI-Hub checkout here \u2014 operating on the canonical prod data dir:', dim(dataDir)], 'cyan');
}

/**
 * After a reset (or first CLI start) there is no seeded `.env` + compose. Prompt for a
 * password and write a fresh appliance install instead of sending the user to the desktop app.
 */
export async function ensureApplianceInstall(): Promise<void> {
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
      [
        `Data dir: ${seeded.dataDir}`,
        `Image: ${seeded.hubImage}`,
        `  from ${seeded.hubImageFrom}`,
        `Compose: from ${seeded.composeFrom}`,
        `Next: ${BASE_COMMAND} up continues automatically.`,
      ],
      'green',
    );
    // Red and in its own box: a pin this install did not take, one a desktop app is about to
    // overwrite, or a leftover compose it passed over is invisible until the Hub it starts turns out
    // to be the wrong one.
    if (seeded.warnings.length > 0) printMessageBox('Check this Hub install', seeded.warnings, 'red');
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
export function requireRepoOrApplianceContext(action: string, gate: 'require-seed' | 'allow-missing' = 'require-seed'): void {
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
