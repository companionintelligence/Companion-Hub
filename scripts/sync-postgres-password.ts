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
 *
 * The TCP check signs in from inside ci-hub-db itself, as the desktop app does. A throwaway client on
 * `ci-hub_internal` can't join it: that network's `ip_range` holds only the network address and the
 * gateway, so nothing joins at an address Docker picks and no container can take the addresses the
 * Hub pins ci-hub-db and ci-hub-queue to.
 */
import { spawnSync } from 'node:child_process';
import { readContainerOutput } from './lib/docker-exec-output';
import { isDirectScriptRun } from './lib/is-direct-run';
import { parseEnvFile } from './env-file';

const DB_CONTAINER = 'ci-hub-db';
/**
 * Networks to try when the database container's own attachments cannot be read. Since #1597 a
 * stack built from the current compose file puts ci-hub-db on `ci-hub_internal` ONLY, so this list
 * is a fallback for older stacks, never the whole answer.
 */
const FALLBACK_DOCKER_NETWORKS = ['ci-hub_internal', 'ci-hub_network', 'ci-os-hub_network'] as const;
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

/** The networks ci-hub-db is attached to right now, as Docker reports them; empty when unreadable. */
function dbContainerNetworks(): string[] {
  const result = spawnSync('docker', ['inspect', '-f', '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}', DB_CONTAINER], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Where to run a TCP client from when the check inside ci-hub-db can't run: every network the
 * database is actually on, then the known names.
 *
 * The probe joins a throwaway client to a network and connects to `ci-hub-db` by name, so it can only
 * succeed on a network the database is attached to. Probing fixed names alone reported a correct
 * password as wrong on every stack built from the post-#1597 compose file (database on
 * `ci-hub_internal` only): `docker run --network ci-hub_network` failed because that network did not
 * exist yet, the sync then "fixed" a password that was already right, and the re-check failed the
 * same way — `password sync did not fix TCP authentication`, blocking `cihub up` on a fresh install
 * (seen on a fleet node, 2026-09-26).
 */
export function tcpProbeNetworks(attached: readonly string[]): string[] {
  return [...new Set([...attached, ...FALLBACK_DOCKER_NETWORKS])];
}

/** Signs in to ci-hub-db by name over TCP and prints `1`; the password comes in as PGPASSWORD. */
const PSQL_SIGN_IN = ['psql', '-h', DB_CONTAINER, '-p', '6543', '-U', 'companion', '-d', 'companiondb', '-qt', '-c', 'SELECT 1'];

/**
 * Signs in from inside ci-hub-db to its own name, which resolves to its address on its network, not to
 * loopback: the postgres image trusts loopback connections (`host all all 127.0.0.1/32 trust`), so a
 * loopback check would sign in whatever the password. True or false when Postgres answered, undefined
 * when the check could not run. The password reaches psql through `docker exec -e`, never an argument.
 * The reader copies the result out on an engine that loses `docker exec` output (the desktop app's
 * WSL2 engine, where a plain `docker exec` exits 0 whatever psql did).
 */
function signInFromDatabaseContainer(password: string): { answer: boolean | undefined; stderr: string } {
  const result = readContainerOutput(DB_CONTAINER, PSQL_SIGN_IN, { env: { PGPASSWORD: password } });
  if (result.status === 0 && result.stdout.split('\n').some((line) => line.trim() === '1')) return { answer: true, stderr: result.stderr };
  if (/password authentication failed/i.test(result.stderr)) return { answer: false, stderr: result.stderr };
  return { answer: undefined, stderr: result.stderr };
}

/**
 * Postgres not taking TCP connections yet. The healthcheck's `pg_isready` uses the local socket, so it
 * passes while the image's first-run server listens on the socket only, and during the restart after.
 */
const POSTGRES_NOT_LISTENING = /connection refused|could not connect to server|the database system is (starting up|shutting down)/i;
const SIGN_IN_ATTEMPTS = 5;
const SIGN_IN_RETRY_DELAY_MS = 1000;

async function postgresTcpAuthWorks(password: string): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const { answer, stderr } = signInFromDatabaseContainer(password);
    if (answer !== undefined) return answer;
    if (attempt >= SIGN_IN_ATTEMPTS || !POSTGRES_NOT_LISTENING.test(stderr)) break;
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_RETRY_DELAY_MS));
  }
  // The check inside could not run. A client on the database's networks still works on a stack whose
  // database is on a network that takes new members (one built before `ci-hub_internal` had a range).
  for (const network of tcpProbeNetworks(dbContainerNetworks())) {
    // As inside, the password goes in through the environment (`-e PGPASSWORD`), not an argument.
    const result = spawnSync('docker', ['run', '--rm', '-e', 'PGPASSWORD', '--network', network, 'postgres:14', ...PSQL_SIGN_IN], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, PGPASSWORD: password },
    });
    if (result.status === 0) return true;
  }
  return false;
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

  if (await postgresTcpAuthWorks(password)) {
    console.log('sync-postgres-password: Postgres password already matches env');
    return;
  }

  console.log('sync-postgres-password: TCP auth failed — syncing Postgres role password to match env');

  if (!containerIsRunning(DB_CONTAINER)) {
    console.log(`sync-postgres-password: ${DB_CONTAINER} stopped before password sync; skipping`);
    return;
  }

  if (!syncPostgresPassword(password)) {
    if (!containerIsRunning(DB_CONTAINER)) {
      console.log(`sync-postgres-password: ${DB_CONTAINER} stopped during password sync; skipping`);
      return;
    }
    throw new Error('failed to ALTER USER companion');
  }

  if (!(await postgresTcpAuthWorks(password))) {
    throw new Error('password sync did not fix TCP authentication');
  }

  console.log('sync-postgres-password: Postgres password synced successfully');
}

const isDirectRun = isDirectScriptRun(import.meta.url, import.meta.main);

if (isDirectRun) {
  void syncPostgresPasswordFromEnv(process.argv[2] || process.env.ENV_FILE || '.env.local').catch((error) => {
    console.error(`sync-postgres-password: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
