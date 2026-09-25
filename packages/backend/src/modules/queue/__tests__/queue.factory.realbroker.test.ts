import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Connection } from 'rabbitmq-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { z } from 'zod';
import { QueueFactory } from '../queue.factory';

/**
 * End-to-end validation against a REAL RabbitMQ — proves the things the mocked
 * unit tests cannot: that `Connection.acquire()` is a real liveness signal, and
 * that the publish path actually recovers after the broker goes away and comes
 * back (the production incident).
 *
 * Skipped unless RABBITMQ_E2E=1, with the throwaway broker's coordinates passed
 * via RABBITMQ_E2E_* env vars (container name, port, user, pass).
 */
const RUN = process.env.RABBITMQ_E2E === '1';
const CONTAINER = process.env.RABBITMQ_E2E_CONTAINER ?? 'ci-hub-rabbitmq-e2e';
const PORT = Number(process.env.RABBITMQ_E2E_PORT ?? 5680);
const USER = process.env.RABBITMQ_E2E_USER ?? 'companion';
const PASS = process.env.RABBITMQ_E2E_PASS ?? 'companion';

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string, intervalMs = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out (${timeoutMs}ms): ${label}`);
}

// Wait until the broker is genuinely serving AMQP (full connect + open a channel),
// not just listening on the TCP port. A freshly-booted broker briefly accepts TCP
// while still rejecting channel opens, which is an artifact of the throwaway
// container — not the production incident — so we settle it before each phase.
async function waitForBrokerAmqp(label: string, timeoutMs = 40_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const probe = new Connection({ hostname: 'localhost', port: PORT, username: USER, password: PASS, connectionTimeout: 3_000 });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), 3_000);
        timer.unref?.();
        probe.on('connection', () => {
          clearTimeout(timer);
          resolve();
        });
        probe.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      const channel = await probe.acquire();
      await channel.close();
      await probe.close();
      return;
    } catch (e) {
      lastErr = e;
      try {
        probe.unsafeDestroy();
      } catch {
        /* already gone */
      }
      await sleep(500);
    }
  }
  throw new Error(`waitForBrokerAmqp timed out: ${label}: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

describe.runIf(RUN)('QueueFactory (real broker)', () => {
  let factory: QueueFactory | undefined;

  const makeFactory = () => {
    const logger = mock<LoggerService>();
    const config = mock<ConfigurationService>();
    config.get.calledWith('queue').mockReturnValue({ host: 'localhost', username: USER, password: PASS, port: PORT } as never);
    config.get.calledWith('jwtSecret').mockReturnValue('test-jwt-secret' as never);

    return new QueueFactory(logger, config);
  };

  // Stopping the broker and tearing down a live connection legitimately produces
  // background "connection is closing" rejections from in-flight fire-and-forget
  // publishes. Swallow only those during this suite so they don't fail the run.
  const onUnhandled = (reason: unknown) => {
    if (!/clos(e|ing)|ECONNRESET|ECONNREFUSED/i.test(String((reason as Error)?.message ?? reason))) {
      throw reason;
    }
  };
  beforeAll(() => process.on('unhandledRejection', onUnhandled));

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    if (!factory) {
      return;
    }
    // Graceful close() blocks on the still-open consumer channel, so bound it and
    // then hard-destroy the socket to guarantee a clean, non-hanging teardown.
    await Promise.race([factory.onApplicationShutdown(), sleep(4000)]);
    factory.getConnection()?.unsafeDestroy();
  }, 15_000);

  it('probes liveness, detects a downed broker, and self-heals the publish path after restart', async () => {
    await waitForBrokerAmqp('before initial connect');
    factory = makeFactory();
    const f = factory;
    const tick = () => (f as unknown as { runWatchdogCheck: () => Promise<void> }).runWatchdogCheck();

    // 1. Initial connection comes up and the channel probe — not just the
    //    cached flag — agrees the connection is genuinely usable.
    await waitFor(async () => f.isReady() && (await f.probeConnection()), 20_000, 'initial connection probes healthy');
    expect(await f.probeConnection()).toBe(true);

    // 2. A real RPC round-trip succeeds (this is the exact path app installs use).
    //    Retry until the freshly-established connection settles.
    const queue = await f.createQueue({
      queueName: 'e2e-queue',
      eventSchema: z.object({ requestId: z.string() }),
      timeout: 5_000,
    });
    queue.onEvent(async (_data, reply) => {
      await reply({ success: true, message: 'pong' });
    });
    await sleep(750); // let the consumer attach
    await waitFor(async () => (await queue.publish({ requestId: 'before-restart' })).success === true, 15_000, 'initial publish round-trip');

    // 3. Broker goes away — the probe must report the wedge (acquire rejects/times out).
    execFileSync('docker', ['stop', CONTAINER], { stdio: 'ignore' });
    await waitFor(async () => (await f.probeConnection()) === false, 15_000, 'probe detects downed broker');

    // 4. Broker returns; a watchdog tick must restore readiness and a usable channel.
    execFileSync('docker', ['start', CONTAINER], { stdio: 'ignore' });
    await waitForBrokerAmqp('after restart');
    await waitFor(
      async () => {
        await tick();
        return f.isReady() && (await f.probeConnection());
      },
      40_000,
      'watchdog restores a live connection',
    );
    expect(await f.probeConnection()).toBe(true);

    // 5. The publish path works again end-to-end after recovery (rebound RPC client + re-registered consumer).
    await waitFor(
      async () => {
        const res = await queue.publish({ requestId: 'after-restart' });
        return res.success === true;
      },
      20_000,
      'publish round-trip recovers',
    );
  }, 120_000);
});
