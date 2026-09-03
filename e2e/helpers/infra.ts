/**
 * Deterministic infrastructure readiness helper.
 *
 * Checks that Postgres and RabbitMQ are reachable before tests start.
 * Provides clear error messages when infra is missing, so E2E runs
 * fail fast with actionable guidance instead of obscure timeouts.
 */

import net from 'node:net';

interface ServiceConfig {
  name: string;
  host: string;
  port: number;
}

const POSTGRES: ServiceConfig = {
  name: 'PostgreSQL',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT || '6543', 10),
};

const RABBITMQ: ServiceConfig = {
  name: 'RabbitMQ',
  host: process.env.RABBITMQ_HOST || 'localhost',
  port: Number.parseInt(process.env.RABBITMQ_PORT || '5672', 10),
};

/** Attempt a TCP connection to verify a service is listening. */
export function probePort(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/** Check a single service with retries. */
async function waitForService(service: ServiceConfig, retries = 10, intervalMs = 2000): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    const ok = await probePort(service.host, service.port);
    if (ok) return true;
    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

export interface InfraStatus {
  postgres: boolean;
  rabbitmq: boolean;
  ready: boolean;
}

/**
 * Check that both Postgres and RabbitMQ are reachable.
 * Returns a status object. Does NOT throw — callers decide how to handle.
 */
export async function checkInfraReady(retries = 5, intervalMs = 2000): Promise<InfraStatus> {
  const [postgres, rabbitmq] = await Promise.all([waitForService(POSTGRES, retries, intervalMs), waitForService(RABBITMQ, retries, intervalMs)]);
  return { postgres, rabbitmq, ready: postgres && rabbitmq };
}

/**
 * Assert infra is ready, throwing a descriptive error if not.
 * Intended for use in globalSetup or beforeAll hooks.
 */
export async function requireInfraReady(retries = 10, intervalMs = 2000) {
  const status = await checkInfraReady(retries, intervalMs);
  if (!status.ready) {
    const missing: string[] = [];
    if (!status.postgres) missing.push(`${POSTGRES.name} (${POSTGRES.host}:${POSTGRES.port})`);
    if (!status.rabbitmq) missing.push(`${RABBITMQ.name} (${RABBITMQ.host}:${RABBITMQ.port})`);
    throw new Error(
      `E2E infrastructure not ready — missing: ${missing.join(', ')}.\n` +
        'Start infra with: docker compose -f e2e/docker-compose.e2e.yml up -d db queue\n' +
        'Or start the local development stack with: cihub up local',
    );
  }
  return status;
}
