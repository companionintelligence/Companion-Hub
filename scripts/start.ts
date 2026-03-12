#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';

const allowedModes = ['dev', 'start', 'start:detached'];
const allowedEnvs = ['local', 'dev', 'staging', 'prod'];

function usageAndExit(msg?: string) {
  if (msg) console.error(msg);
  console.error(`Usage: bun scripts/start.ts <mode> [env]\n
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

async function main() {
  // Always set ENV_FILE in the spawned environments so docker-compose can mount the right file
  const envOverrides = { ENV_FILE: envFileStr };

  if (mode === 'dev') {
    // Start infra (db + queue) using local compose
    run(
      'docker',
      [
        'compose',
        '--env-file',
        envFileStr,
        '--project-name',
        'runtipi',
        '-f',
        'docker-compose.local.yml',
        'up',
        '-d',
        'ci-os-hub-queue',
        'ci-hub-db',
      ],
      envOverrides,
    );

    // Run the app in dev/HMR mode. Use dotenv to load the env file into the process
    // and let the existing dev:app script set POSTGRES_HOST and RABBITMQ_HOST to localhost.
    run('dotenv', ['-e', envFileStr, '--', 'bun', 'run', 'dev:app'], envOverrides);
    return;
  }

  // start / start:detached
  if (env !== 'local') {
    // initialize traefik first (matches previous behavior)
    run('bun', ['scripts/init-traefik.ts'], envOverrides);
  }

  // Compose files selection
  const files: string[] = [];
  if (env === 'local') {
    files.push('docker-compose.local.yml');
  } else {
    files.push('docker-compose.prod.yml');
    if (env === 'staging') files.push('docker-compose.staging.yml');
  }

  const upArgs = ['compose', '--env-file', envFileStr, '--project-name', 'runtipi'];
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
