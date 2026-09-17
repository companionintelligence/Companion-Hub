import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { z } from 'zod';

const { Connection, connectionInstances, broker } = vi.hoisted(() => {
  // Whether RabbitMQ is serving. While it is down no connection can open a channel,
  // which is what the factory's probe and the real library both key off.
  const broker = { up: true };

  class MockConnection {
    public ready = true;
    public handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    public removeAllListeners = vi.fn(() => {
      this.handlers = {};
    });
    public close = vi.fn(async () => undefined);
    public unsafeDestroy = vi.fn();
    public acquire = vi.fn(async () => {
      if (!broker.up) {
        throw new Error('channel creation failed; connection is closing');
      }
      return { close: vi.fn(async () => undefined) };
    });
    public createRPCClient = vi.fn(() => ({ send: vi.fn(), close: vi.fn(async () => undefined) }));
    public createPublisher = vi.fn(() => ({ send: vi.fn(), close: vi.fn(async () => undefined) }));

    public constructor(..._args: unknown[]) {
      connectionInstances.push(this);
    }

    public on(event: string, handler: (...args: unknown[]) => unknown) {
      this.handlers[event] ??= [];
      this.handlers[event]?.push(handler);
      return this;
    }

    public async emit(event: string, ...args: unknown[]) {
      const handlers = this.handlers[event] ?? [];
      for (const handler of handlers) {
        await handler(...args);
      }
    }
  }

  const connectionInstances: MockConnection[] = [];

  return { Connection: MockConnection, connectionInstances, broker };
});

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

vi.mock('rabbitmq-client', () => ({
  Connection,
  AMQPConnectionError: class AMQPConnectionError extends Error {},
  AMQPError: class AMQPError extends Error {
    public code?: string;

    public constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { QueueFactory } from '../queue.factory';

describe('QueueFactory', () => {
  let logger: MockProxy<LoggerService>;
  let config: MockProxy<ConfigurationService>;

  // Drain pending microtasks (e.g. the constructor's fire-and-forget
  // initializeConnection) so assertions don't race the connection lifecycle.
  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  // Whether `promise` settles within `ms` of real time. A hung await reads as
  // false instead of timing the whole test out. Uses the global timer, which the
  // node:timers/promises mock above does not touch.
  const settlesWithin = (promise: Promise<unknown>, ms: number) =>
    Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => globalThis.setTimeout(() => resolve(false), ms)),
    ]);

  const watchdogTick = (factory: QueueFactory) => (factory as unknown as { runWatchdogCheck: () => Promise<void> }).runWatchdogCheck();

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };

  beforeEach(() => {
    connectionInstances.splice(0, connectionInstances.length);
    broker.up = true;
    vi.mocked(sleep).mockImplementation(async () => undefined);
    logger = mock<LoggerService>();
    config = mock<ConfigurationService>();

    config.get.calledWith('queue').mockReturnValue({
      host: 'localhost',
      password: 'guest',
      username: 'guest',
      port: 5672,
    } as never);
  });

  it('tracks queue readiness after a successful connection event', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    expect(factory.getConnectionState()).toEqual({
      status: 'connecting',
      ready: false,
      attempts: 0,
    });

    await connection?.emit('connection');

    expect(factory.isReady()).toBe(true);
    expect(factory.getConnectionState()).toEqual({
      status: 'ready',
      ready: true,
      attempts: 0,
    });
  });

  it('marks the queue as degraded and recovers on a later connection event', async () => {
    const factory = new QueueFactory(logger, config);
    const firstConnection = connectionInstances[0];

    await firstConnection?.emit('connection');
    expect(factory.getConnectionState().status).toBe('ready');

    broker.up = false;
    firstConnection.ready = false;
    await firstConnection?.emit('error', new Error('socket closed'));

    expect(factory.getConnectionState()).toMatchObject({
      status: 'degraded',
      ready: false,
      lastError: 'socket closed',
    });
    expect(factory.getConnectionState().attempts).toBeGreaterThan(0);
    expect(connectionInstances.length).toBeGreaterThan(1);

    broker.up = true;
    const secondConnection = connectionInstances.at(-1);
    await secondConnection?.emit('connection');

    expect(factory.getConnectionState()).toEqual({
      status: 'ready',
      ready: true,
      attempts: 0,
    });
  });

  it('creates queues without blocking when RabbitMQ is degraded', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    // Simulate initial connection then degradation
    await connection?.emit('connection');
    broker.up = false;
    connection.ready = false;
    await connection?.emit('error', new Error('socket closed'));

    const queue = await factory.createQueue({
      queueName: 'app-events-queue',
      eventSchema: z.object({ requestId: z.string() }),
      timeout: 1000,
    });

    expect(queue).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith('Queue connection not ready, creating queue in degraded mode.');
  });

  it('rebinds queues even when the connection instance is unchanged', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    await connection?.emit('connection');
    expect(factory.isReady()).toBe(true);

    const queue = await factory.createQueue({
      queueName: 'app-events-queue',
      eventSchema: z.object({ requestId: z.string() }),
      timeout: 1000,
    });

    const initialCreateRpcCalls = connection?.createRPCClient.mock.calls.length ?? 0;

    // Simulate the post-connect rebind that refreshes RPC clients on the same Connection
    await connection?.emit('connection');

    expect(connection?.createRPCClient.mock.calls.length).toBeGreaterThan(initialCreateRpcCalls);
    expect(logger.info).toHaveBeenCalledWith('Rebound queue app-events-queue to new connection');
    expect(queue).toBeDefined();
  });

  it('rebinds queues to the new connection after reconnect', async () => {
    const factory = new QueueFactory(logger, config);
    const firstConnection = connectionInstances[0];

    // Establish initial connection
    await firstConnection?.emit('connection');
    expect(factory.isReady()).toBe(true);

    // Create a queue while connected
    const queue = await factory.createQueue({
      queueName: 'app-events-queue',
      eventSchema: z.object({ requestId: z.string() }),
      timeout: 1000,
    });

    expect(queue).toBeDefined();

    // Simulate connection loss and reconnect
    broker.up = false;
    firstConnection.ready = false;
    await firstConnection?.emit('error', new Error('socket closed'));

    // A new connection should have been created
    expect(connectionInstances.length).toBeGreaterThan(1);
    const secondConnection = connectionInstances.at(-1);

    // Emit connection event on the new connection — this should trigger rebindQueues
    broker.up = true;
    await secondConnection?.emit('connection');

    // The new connection should have createRPCClient and createPublisher called for the rebound queue
    expect(secondConnection?.createRPCClient).toHaveBeenCalled();
    expect(secondConnection?.createPublisher).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Rebound queue app-events-queue to new connection');
  });

  it('probeConnection resolves true when a channel can be acquired', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    await connection?.emit('connection');

    await expect(factory.probeConnection()).resolves.toBe(true);
    expect(connection?.acquire).toHaveBeenCalled();
  });

  it('probeConnection resolves false when channels are dead despite a ready flag', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    await connection?.emit('connection');

    // The wedge we hit in prod: socket still "ready", but acquiring a channel fails.
    connection.acquire.mockRejectedValueOnce(new Error('channel creation failed; connection is closing'));

    expect(factory.isReady()).toBe(true); // cached flag still lies
    await expect(factory.probeConnection()).resolves.toBe(false); // the probe catches it
  });

  it('probeConnection times out on a hanging acquire and closes a channel that resolves late', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    await connection?.emit('connection');

    // acquire() hangs past the timeout, then resolves late with a channel.
    let resolveAcquire!: (channel: unknown) => void;
    const lateClose = vi.fn(async () => undefined);
    connection.acquire.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAcquire = resolve;
      }),
    );

    // Probe gives up within the (short) timeout rather than hanging.
    await expect(factory.probeConnection(50)).resolves.toBe(false);
    expect(lateClose).not.toHaveBeenCalled();

    // When the orphaned acquire finally resolves, its channel is closed (no leak).
    resolveAcquire({ close: lateClose });
    await flushAsync();
    expect(lateClose).toHaveBeenCalled();
  });

  it('watchdog forces a reconnect when the probe fails despite a ready flag', async () => {
    const factory = new QueueFactory(logger, config);
    const firstConnection = connectionInstances[0];

    await firstConnection?.emit('connection');
    // Let the constructor's initial connection fully settle — the watchdog
    // (correctly) bails while an initialize/reconnect is still in flight.
    await flushAsync();
    expect(factory.isReady()).toBe(true);

    // Simulate the wedge: ready flag is true, but every channel acquire fails.
    firstConnection.acquire.mockRejectedValue(new Error('channel creation failed; connection is closing'));
    const reconnectSpy = vi.spyOn(factory, 'reconnect').mockResolvedValue(undefined);

    await (factory as unknown as { runWatchdogCheck: () => Promise<void> }).runWatchdogCheck();

    expect(logger.warn).toHaveBeenCalledWith('Queue watchdog detected an unusable connection; forcing reconnect');
    expect(reconnectSpy).toHaveBeenCalled();
  });

  it('watchdog re-arms reconnect after the 5-attempt cap is exhausted', async () => {
    const factory = new QueueFactory(logger, config);
    const connection = connectionInstances[0];

    await connection?.emit('connection');

    // Exhaust the bounded reconnect budget (no 'connection' event on the retries).
    broker.up = false;
    connection.ready = false;
    await connection?.emit('error', new Error('socket closed'));
    expect(factory.getConnectionState().attempts).toBe(5);

    // Even though doReconnect has given up, the watchdog probe fails and re-arms it.
    await flushAsync();
    const lastConnection = connectionInstances.at(-1);
    lastConnection?.acquire.mockRejectedValue(new Error('connection is closing'));
    const connectionsBefore = connectionInstances.length;

    await (factory as unknown as { runWatchdogCheck: () => Promise<void> }).runWatchdogCheck();

    expect(connectionInstances.length).toBeGreaterThan(connectionsBefore);
  });

  describe('a reconnect racing a connection that recovered on its own (core-14, 2026-09-17)', () => {
    it('keeps the recovered connection instead of hanging forever on its close()', async () => {
      const factory = new QueueFactory(logger, config);
      const first = connectionInstances[0];
      await first.emit('connection');
      await flushAsync();

      // Hold the 4 s backoff in front of attempt 2, so the connection attempt 1
      // built can recover while attempt 2 waits.
      const attempt2Backoff = deferred();
      vi.mocked(sleep).mockImplementation((async (ms?: number) => (ms === 4_000 ? attempt2Backoff.promise : undefined)) as typeof sleep);

      broker.up = false;
      first.ready = false;
      const reconnecting = first.emit('error', new Error('socket closed'));
      await flushAsync();
      expect(connectionInstances).toHaveLength(2);
      const replacement = connectionInstances[1];

      // The broker returns and the library reconnects the replacement by itself
      // while attempt 2 still sleeps. Its consumer channels never close, so a
      // graceful close() on it never returns.
      broker.up = true;
      replacement.close.mockImplementation(() => new Promise(() => undefined));
      await replacement.emit('connection');
      attempt2Backoff.resolve();

      expect(await settlesWithin(reconnecting, 1_000)).toBe(true);
      expect(replacement.close).not.toHaveBeenCalled();
      expect(replacement.unsafeDestroy).not.toHaveBeenCalled();
      expect(connectionInstances).toHaveLength(2);
      expect(factory.getConnectionState()).toEqual({ status: 'ready', ready: true, attempts: 0 });
      await expect(factory.probeConnection()).resolves.toBe(true);
    });

    it('tears a dead connection down without waiting for channels that never close', async () => {
      const factory = new QueueFactory(logger, config);
      const first = connectionInstances[0];
      await first.emit('connection');
      await flushAsync();

      first.close.mockImplementation(() => new Promise(() => undefined));
      broker.up = false;
      first.ready = false;
      const reconnecting = first.emit('error', new Error('socket closed'));

      expect(await settlesWithin(reconnecting, 1_000)).toBe(true);
      expect(first.close).not.toHaveBeenCalled();
      expect(first.unsafeDestroy).toHaveBeenCalledTimes(1);
      expect(connectionInstances.length).toBeGreaterThan(1);
      expect(factory.getConnectionState().status).toBe('degraded');
    });
  });

  describe('a reconnect stuck on an await', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops turning the watchdog off once it outlives every bounded burst, and cannot tear down what the watchdog repaired', async () => {
      const factory = new QueueFactory(logger, config);
      const first = connectionInstances[0];
      await first.emit('connection');
      await flushAsync();

      // Attempt 1's backoff never returns on its own: a stand-in for any await
      // that hangs, as close() did on core-14.
      const stuckBackoff = deferred();
      vi.mocked(sleep).mockImplementationOnce((() => stuckBackoff.promise) as typeof sleep);
      broker.up = false;
      first.ready = false;
      void first.emit('error', new Error('socket closed'));
      await flushAsync();

      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      broker.up = true;

      // Inside the stall window the watchdog leaves the reconnect alone, even
      // though a probe would now succeed.
      vi.setSystemTime(start + 299_000);
      await watchdogTick(factory);
      expect(factory.getConnectionState().status).toBe('degraded');

      // Past it, the watchdog abandons the stuck reconnect and repairs the queue itself.
      vi.setSystemTime(start + 301_000);
      await watchdogTick(factory);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('abandoning it'));
      expect(factory.getConnectionState()).toEqual({ status: 'ready', ready: true, attempts: 0 });

      // The abandoned attempt finally wakes while a channel open happens to fail.
      // It belongs to a recovery that was replaced, so it must leave the serving
      // connection alone.
      broker.up = false;
      stuckBackoff.resolve();
      await flushAsync();
      expect(first.unsafeDestroy).not.toHaveBeenCalled();
      expect(connectionInstances).toHaveLength(1);
    });

    it('shutdown does not hang on a connection whose consumer channels never close', async () => {
      const factory = new QueueFactory(logger, config);
      const first = connectionInstances[0];
      await first.emit('connection');
      await flushAsync();
      first.close.mockImplementation(() => new Promise(() => undefined));

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let finished = false;
      void factory.onApplicationShutdown().then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(finished).toBe(true);
      expect(first.unsafeDestroy).toHaveBeenCalledTimes(1);
    });
  });
});
