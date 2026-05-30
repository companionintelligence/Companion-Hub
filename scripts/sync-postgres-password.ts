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
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DB_CONTAINER = 'ci-hub-db';
const DOCKER_NETWORK = 'ci-os-hub_network';

function parseEnvFile(envFileName: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const envPath = isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);

  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    // Missing env file — nothing to sync.
  }

  return vars;
}

function containerIsRunning(name: string): boolean {
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return result.status === 0 && result.stdout.trim() === 'true';
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

function main() {
  const envFile = process.argv[2] || process.env.ENV_FILE || '.env.local';
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

  if (postgresTcpAuthWorks(password)) {
    console.log('sync-postgres-password: Postgres password already matches env');
    return;
  }

  console.log('sync-postgres-password: TCP auth failed — syncing Postgres role password to match env');
  if (!syncPostgresPassword(password)) {
    console.error('sync-postgres-password: failed to ALTER USER companion');
    process.exit(1);
  }

  if (!postgresTcpAuthWorks(password)) {
    console.error('sync-postgres-password: password sync did not fix TCP authentication');
    process.exit(1);
  }

  console.log('sync-postgres-password: Postgres password synced successfully');
}

main();
