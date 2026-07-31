#!/usr/bin/env tsx
/**
 * Align the RabbitMQ companion user password with RABBITMQ_PASSWORD from the env file.
 *
 * RABBITMQ_DEFAULT_PASS only applies when the queue container is first created (no durable
 * volume). If .env later gains a strong password, Hub auth fails until we change_password
 * or recreate the queue container.
 */
import { spawnSync } from 'node:child_process';
import { isDirectScriptRun } from './lib/is-direct-run';
import { parseEnvFile } from './env-file';

const QUEUE_CONTAINER = 'ci-os-hub-queue';
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
  if (result.status !== 0) return 'unknown';
  const status = result.stdout.trim();
  if (status === 'healthy' || status === 'starting' || status === 'unhealthy' || status === 'none') {
    return status;
  }
  return 'unknown';
}

async function waitForContainerHealthy(name: string): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HEALTH_WAIT_TIMEOUT_MS) {
    if (!containerIsRunning(name)) return false;
    const status = getContainerHealthStatus(name);
    if (status === 'healthy' || status === 'none') return true;
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function rabbitmqAuthWorks(password: string): boolean {
  const result = spawnSync('docker', ['exec', QUEUE_CONTAINER, 'rabbitmqctl', 'authenticate_user', 'companion', password], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function changeRabbitmqPassword(password: string): boolean {
  const result = spawnSync('docker', ['exec', QUEUE_CONTAINER, 'rabbitmqctl', 'change_password', 'companion', password], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function recreateQueue(envFile: string): boolean {
  const compose = process.env.COMPOSE_FILE || 'docker-compose.prod.yml';
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '--project-name', 'ci-hub', '-f', compose, 'up', '-d', '--force-recreate', 'ci-os-hub-queue'],
    { encoding: 'utf-8', stdio: 'pipe' },
  );
  return result.status === 0;
}

export async function syncRabbitmqPasswordFromEnv(envFile = process.env.ENV_FILE || '.env.local') {
  const vars = parseEnvFile(envFile);
  const password = process.env.RABBITMQ_PASSWORD || vars.RABBITMQ_PASSWORD;

  if (!password) {
    console.log('sync-rabbitmq-password: no RABBITMQ_PASSWORD set, skipping');
    return;
  }

  if (!containerIsRunning(QUEUE_CONTAINER)) {
    console.log(`sync-rabbitmq-password: ${QUEUE_CONTAINER} is not running, skipping`);
    return;
  }

  if (!(await waitForContainerHealthy(QUEUE_CONTAINER))) {
    throw new Error(`${QUEUE_CONTAINER} did not become healthy`);
  }

  if (rabbitmqAuthWorks(password)) {
    console.log('sync-rabbitmq-password: auth already matches RABBITMQ_PASSWORD');
    return;
  }

  console.log('sync-rabbitmq-password: auth mismatch — trying rabbitmqctl change_password');
  if (changeRabbitmqPassword(password) && rabbitmqAuthWorks(password)) {
    console.log('sync-rabbitmq-password: password synced');
    return;
  }

  console.log('sync-rabbitmq-password: recreating queue container (no durable volume)');
  if (!recreateQueue(envFile)) {
    throw new Error('Failed to recreate ci-os-hub-queue');
  }
  if (!(await waitForContainerHealthy(QUEUE_CONTAINER))) {
    throw new Error(`${QUEUE_CONTAINER} did not become healthy after recreate`);
  }
  if (!rabbitmqAuthWorks(password)) {
    throw new Error('RabbitMQ password still does not match after recreate');
  }
  console.log('sync-rabbitmq-password: queue recreated and auth matches');
}

if (isDirectScriptRun(import.meta.url)) {
  syncRabbitmqPasswordFromEnv().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
