#!/usr/bin/env tsx
/**
 * Align the Postgres role password with POSTGRES_PASSWORD from the env file.
 *
 * Postgres only applies POSTGRES_PASSWORD when the data volume is first created.
 * If the volume was initialized with a different password (e.g. local dev `postgres`
 * while the desktop app later generated a random secret), the backend fails with
 * "password authentication failed for user companion".
 *
 * When TCP auth fails but ci-hub-db is running, we ALTER USER via local socket
 * inside the container (no old password required).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './env-file';

const DB_CONTAINER = 'ci-hub-db';
const DOCKER_NETWORK = 'ci-os-hub_network';
const HEALTH_POLL_INTERVAL_MS = 1000;
const HEALTH_WAIT_TIMEOUT_MS = 60_000;

function containerIsRunning(name: string): boolean {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function getContainerHealthStatus(name: string): 'healthy' | 'starting' | 'unhealthy' | 'none' | 'unknown' {
  const result = spawnSync('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    return 'unknown';
  }

  const status = result.stdout.trim();
  if (status === 'healthy' || status === 'starting' || status === 'unhealthy' || status === 'none') {
    return status;
  }

  return 'unknown';
}

async function waitForContainerHealthy(name: string): Promise<boolean> {
  const startedAt = Date.now();
  let lastStatus: ReturnType<typeof getContainerHealthStatus> | undefined;

  while (Date.now() - startedAt < HEALTH_WAIT_TIMEOUT_MS) {
    if (!containerIsRunning(name)) {
      return false;
    }

    const status = getContainerHealthStatus(name);
    if (status === 'healthy' || status === 'none') {
      return true;
    }

    if (status !== lastStatus) {
      console.log(`sync-postgres-password: waiting for ${name} healthcheck (${status})`);
      lastStatus = status;
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }

  const finalStatus = getContainerHealthStatus(name);
  console.error(`sync-postgres-password: ${name} did not become healthy within ${HEALTH_WAIT_TIMEOUT_MS}ms (last status: ${finalStatus})`);
  return false;
}

function postgresTcpAuthWorks(password: string): boolean {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      DOCKER_NETWORK,
      'postgres:14',
      'bash',
      '-lc',
      `PGPASSWORD='${password.replace(/'/g, `'\\''`)}' psql -h ${DB_CONTAINER} -p 6543 -U companion -d companiondb -qt -c 'SELECT 1'`,
    ],
    { encoding: 'utf-8', stdio: 'pipe' },
  );
  return result.status === 0;
}

function syncPostgresPassword(password: string): boolean {
  const sql = `ALTER USER companion WITH PASSWORD '${password.replace(/'/g, "''")}';`;
  const result = spawnSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'companion', '-d', 'companiondb', '-p', '6543', '-c', sql], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

export async function syncPostgresPasswordFromEnv(envFile = process.env.ENV_FILE || '.env.local') {
  const vars = parseEnvFile(envFile);
  const password = process.env.POSTGRES_PASSWORD || vars.POSTGRES_PASSWORD;

  if (!password) {
    console.log('sync-postgres-password: no POSTGRES_PASSWORD set, skipping');
    return;
  }

  if (!containerIsRunning(DB_CONTAINER)) {
    console.log(`sync-postgres-password: ${DB_CONTAINER} is not running, skipping`);
    return;
  }

  if (!(await waitForContainerHealthy(DB_CONTAINER))) {
    throw new Error(`${DB_CONTAINER} did not become healthy`);
  }

  if (postgresTcpAuthWorks(password)) {
    console.log('sync-postgres-password: Postgres password already matches env');
    return;
  }

  console.log('sync-postgres-password: TCP auth failed — syncing Postgres role password to match env');
  if (!syncPostgresPassword(password)) {
    throw new Error('failed to ALTER USER companion');
  }

  if (!postgresTcpAuthWorks(password)) {
    throw new Error('password sync did not fix TCP authentication');
  }

  console.log('sync-postgres-password: Postgres password synced successfully');
}

const isDirectRun = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isDirectRun) {
  void syncPostgresPasswordFromEnv(process.argv[2] || process.env.ENV_FILE || '.env.local').catch((error) => {
    console.error(`sync-postgres-password: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
