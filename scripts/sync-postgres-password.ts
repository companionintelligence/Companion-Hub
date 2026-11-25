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
import { type ContainerReader, containerReader } from './lib/docker-exec-output';
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
const AUTH_FAILED = /password authentication failed/i;

/** What a sign-in check found. `answer` is undefined when no check could run, and `detail` says why. */
interface SignInCheck {
  answer: boolean | undefined;
  detail: string;
}

/**
 * Signs in from inside ci-hub-db to its own name, which resolves to its address on its network, not to
 * loopback: the postgres image trusts loopback connections (`host all all 127.0.0.1/32 trust`), so a
 * loopback check would sign in whatever the password. The password reaches psql through
 * `docker exec -e`, never an argument. The reader copies the result out on an engine that loses
 * `docker exec` output (the desktop app's WSL2 engine, where a plain `docker exec` exits 0 whatever
 * psql did).
 */
function signInFromDatabaseContainer(db: ContainerReader, password: string): SignInCheck {
  const result = db(PSQL_SIGN_IN, { env: { PGPASSWORD: password } });
  if (result.status === 0 && result.stdout.split('\n').some((line) => line.trim() === '1')) return { answer: true, detail: '' };
  if (AUTH_FAILED.test(result.stderr)) return { answer: false, detail: result.stderr };
  const detail = result.stderr || (result.lost ? `no result came back from ${DB_CONTAINER}` : `psql exited ${result.status ?? 'without a status'}`);
  return { answer: undefined, detail };
}

/**
 * Postgres not letting anyone sign in yet. Docker refreshes the health status only every few seconds,
 * so ci-hub-db can still read as healthy while Postgres restarts or recovers from a crash.
 */
const POSTGRES_NOT_READY =
  /connection refused|could not connect to server|the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)/i;
const SIGN_IN_ATTEMPTS = 5;
const SIGN_IN_RETRY_DELAY_MS = 1000;

async function checkPostgresSignIn(db: ContainerReader, password: string): Promise<SignInCheck> {
  let inside = signInFromDatabaseContainer(db, password);
  for (let attempt = 1; inside.answer === undefined && attempt < SIGN_IN_ATTEMPTS && POSTGRES_NOT_READY.test(inside.detail); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_RETRY_DELAY_MS));
    inside = signInFromDatabaseContainer(db, password);
  }
  if (inside.answer !== undefined) return inside;

  // The check inside could not run. A client on the database's networks still works on a stack whose
  // database is on a network that takes new members (one built before `ci-hub_internal` had a range).
  let refused: SignInCheck | undefined;
  for (const network of tcpProbeNetworks(dbContainerNetworks())) {
    // As inside, the password goes in through the environment (`-e PGPASSWORD`), not an argument.
    const result = spawnSync('docker', ['run', '--rm', '-e', 'PGPASSWORD', '--network', network, 'postgres:14', ...PSQL_SIGN_IN], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, PGPASSWORD: password },
    });
    if (result.status === 0) return { answer: true, detail: '' };
    const stderr = (result.stderr ?? '').trim();
    if (!refused && AUTH_FAILED.test(stderr)) refused = { answer: false, detail: stderr };
  }
  // No client reached Postgres either, so say why the check inside failed rather than call the password wrong.
  return refused ?? inside;
}

/**
 * Sets the role's password over the local socket, which needs no old password. The new one reaches
 * the container through `docker exec -e` and psql reads it from there with a backtick `\set`, so it
 * never appears in an argument that `ps` on the host shows. psql quotes it with `:'pw'`.
 */
const NEW_PASSWORD_VARIABLE = 'CIHUB_POSTGRES_PASSWORD';
const SET_PASSWORD_INPUT = `\\set pw \`printf '%s' "$${NEW_PASSWORD_VARIABLE}"\`\nALTER USER companion WITH PASSWORD :'pw';`;
const SET_PASSWORD = ['sh', '-c', `printf '%s\\n' "$1" | psql -X -v ON_ERROR_STOP=1 -U companion -d companiondb -p 6543`, 'sh', SET_PASSWORD_INPUT];

/**
 * Goes through the reader as the check does: psql prints `ALTER ROLE` once the change is made, and
 * through the WSL2 engine a plain `docker exec` exits 0 before psql has finished, so the check after
 * could run before the change.
 */
function syncPostgresPassword(db: ContainerReader, password: string): boolean {
  return db(SET_PASSWORD, { env: { [NEW_PASSWORD_VARIABLE]: password } }).status === 0;
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

  // One reader for the whole run: once it finds an engine that loses `docker exec` output, every later
  // command goes straight through the copy route.
  const db = containerReader(DB_CONTAINER);
  const before = await checkPostgresSignIn(db, password);
  if (before.answer) {
    console.log('sync-postgres-password: Postgres password already matches env');
    return;
  }

  if (before.answer === false) {
    console.log('sync-postgres-password: TCP auth failed — syncing Postgres role password to match env');
  } else {
    console.log(`sync-postgres-password: could not check the password over TCP (${before.detail}); setting it to match env`);
  }

  if (!containerIsRunning(DB_CONTAINER)) {
    console.log(`sync-postgres-password: ${DB_CONTAINER} stopped before password sync; skipping`);
    return;
  }

  if (!syncPostgresPassword(db, password)) {
    if (!containerIsRunning(DB_CONTAINER)) {
      console.log(`sync-postgres-password: ${DB_CONTAINER} stopped during password sync; skipping`);
      return;
    }
    throw new Error('failed to ALTER USER companion');
  }

  const after = await checkPostgresSignIn(db, password);
  if (after.answer === false) {
    throw new Error('password sync did not fix TCP authentication');
  }
  if (after.answer === undefined) {
    throw new Error(`could not sign in over TCP to check the new Postgres password: ${after.detail}`);
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
