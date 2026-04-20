#!/usr/bin/env tsx
/**
 * Start the CI-OS-Hub application.
 *
 * Usage:
 *   pnpm run dev                          # dev mode, local env
 *   pnpm run start                        # start mode, local env
 *   pnpm run start:detached               # detached mode, local env
 *   pnpm exec tsx scripts/start.ts <mode> [env] # custom mode/env
 *
 * Modes: dev, start, start:detached
 * Envs:  local, dev, staging, prod (default: local)
 */
import { spawnSync } from 'node:child_process';

const allowedModes = ['dev', 'start', 'start:detached'];
const allowedEnvs = ['local', 'dev', 'staging', 'prod'];

function usageAndExit(msg?: string) {
  if (msg) console.error(msg);
  console.error(`Usage: pnpm exec tsx scripts/start.ts <mode> [env]\n
modes: ${allowedModes.join(', ')}\nenvs: ${allowedEnvs.join(', ')} (default: local)`);
  process.exit(2);
}

const mode = process.argv[2] || 'dev';
const env = process.argv[3] || 'local';

if (!allowedModes.includes(mode)) usageAndExit(`Unknown mode: ${mode}`);
if (!allowedEnvs.includes(env)) usageAndExit(`Unknown env: ${env}`);

const envFileMap: Record<string, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

const envFile = envFileMap[env];
if (!envFile) {
  console.error('Missing env file mapping for env:', env);
  process.exit(2);
}
const envFileStr = envFile;

function run(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}) {
  console.log(`> ${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    cwd: process.cwd(),
  });
  if (res.error) {
    console.error('Failed to run', cmd, res.error);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

/**
 * Derive the TARGETARCH build arg and DOCKER_PLATFORM runtime var from the
 * current host architecture. docker-compose.prod.yml uses both, and Tauri
 * derives DOCKER_PLATFORM the same way for its generated .env (see
 * packages/desktop/src-tauri/src/hub_manager.rs::initialize_hub). Keeping the
 * CLI path in sync means `pnpm start` on Apple Silicon builds the ARM64 image
 * natively instead of silently falling back to the slower AMD64 emulation.
 *
 * Respects pre-set values so CI or cross-arch builds can still override.
 */
function resolvePlatformOverrides(): Record<string, string> {
  const overrides: Record<string, string> = {};
  const archMap: Record<string, { targetarch: string; platform: string }> = {
    x64: { targetarch: 'amd64', platform: 'linux/amd64' },
    arm64: { targetarch: 'arm64', platform: 'linux/arm64' },
  };
  const resolved = archMap[process.arch];
  if (!resolved) {
    console.warn(
      `Unknown host architecture "${process.arch}"; leaving TARGETARCH/DOCKER_PLATFORM unset and relying on compose defaults.`,
    );
    return overrides;
  }
  if (!process.env.TARGETARCH) overrides.TARGETARCH = resolved.targetarch;
  if (!process.env.DOCKER_PLATFORM) overrides.DOCKER_PLATFORM = resolved.platform;
  return overrides;
}

async function main() {
  // Always set ENV_FILE in the spawned environments so docker-compose can mount the right file.
  // Also derive TARGETARCH/DOCKER_PLATFORM from the current host so Mac/ARM dev doesn't
  // silently fall back to slow AMD64 emulation when the .env file omits them.
  const envOverrides = { ENV_FILE: envFileStr, ...resolvePlatformOverrides() };

  if (mode === 'dev') {
    // Start infra (db + queue) using local compose
    run(
      'docker',
      ['compose', '--env-file', envFileStr, '--project-name', 'ci-hub', '-f', 'docker-compose.local.yml', 'up', '-d', 'ci-os-hub-queue', 'ci-hub-db'],
      envOverrides,
    );

    // Run the app in dev/HMR mode. Use dotenv to load the env file into the process
    // and let the existing dev:app script set POSTGRES_HOST and RABBITMQ_HOST to localhost.
    run('dotenv', ['-e', envFileStr, '--', 'pnpm', 'run', 'dev:app'], envOverrides);
    return;
  }

  // start / start:detached
  if (env !== 'local') {
    // initialize traefik first (matches previous behavior)
    run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  }

  // Compose files selection
  const files: string[] = [];
  if (env === 'local') {
    files.push('docker-compose.local.yml');
  } else {
    files.push('docker-compose.prod.yml');
    if (env === 'staging') files.push('docker-compose.staging.yml');
  }

  const upArgs = ['compose', '--env-file', envFileStr, '--project-name', 'ci-hub'];
  for (const f of files) {
    upArgs.push('-f', f);
  }
  upArgs.push('up');
  if (mode === 'start:detached') upArgs.push('-d');
  upArgs.push('--build');

  run('docker', upArgs, envOverrides);
}

main().catch((err) => {
  console.error('start script failed', err);
  process.exit(1);
});
