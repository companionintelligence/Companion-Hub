#!/usr/bin/env bun
/**
 * Start the CI-OS-Hub application.
 *
 * Usage:
 *   bun run dev                          # dev mode, local env
 *   bun run start                        # start mode, local env
 *   bun run start:detached               # detached mode, local env
 *   bun run scripts/start.ts <mode> [env] # custom mode/env
 *
 * Modes: dev, start, start:detached
 * Envs:  local, dev, staging, prod (default: local)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Merge `private-vpn` into COMPOSE_PROFILES when PRIVATE_VPN_ENABLED is not `false` (default on).
 * Reads PRIVATE_VPN_ENABLED and COMPOSE_PROFILES from the env file and merges with process.env.
 */
function mergeComposeProfilesFromEnvFile(envFileName: string): string {
  const abs = join(process.cwd(), envFileName);
  let fileContent = '';
  try {
    fileContent = readFileSync(abs, 'utf-8');
  } catch {
    const fromProc = (process.env.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const set = new Set(fromProc);
    set.add('private-vpn');
    return [...set].join(',');
  }

  const vars: Record<string, string> = {};
  for (const line of fileContent.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }

  const vpnOn = vars.PRIVATE_VPN_ENABLED !== 'false';
  const fromFile = (vars.COMPOSE_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromProc = (process.env.COMPOSE_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>([...fromFile, ...fromProc]);
  if (vpnOn) set.add('private-vpn');
  else set.delete('private-vpn');
  return [...set].join(',');
}

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
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileStr);
  // Always set ENV_FILE in the spawned environments so docker-compose can mount the right file
  const envOverrides: Record<string, string | undefined> = { ENV_FILE: envFileStr };
  if (composeProfiles) {
    envOverrides.COMPOSE_PROFILES = composeProfiles;
  }

  if (mode === 'dev') {
    // Start infra (db + queue) using local compose
    run(
      'docker',
      ['compose', '--env-file', envFileStr, '--project-name', 'ci-hub', '-f', 'docker-compose.local.yml', 'up', '-d', 'ci-os-hub-queue', 'ci-hub-db'],
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
