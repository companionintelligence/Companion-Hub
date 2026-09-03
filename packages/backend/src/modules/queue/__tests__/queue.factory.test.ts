import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { z } from 'zod';

const { Connection, connectionInstances } = vi.hoisted(() => {
  class MockConnection {
    public ready = true;
    public handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    public removeAllListeners = vi.fn(() => {
      this.handlers = {};
    });
    public close = vi.fn(async () => undefined);
    public acquire = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
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

  return { Connection: MockConnection, connectionInstances };
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

  beforeEach(() => {
    connectionInstances.splice(0, connectionInstances.length);
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

    firstConnection.ready = false;
    await firstConnection?.emit('error', new Error('socket closed'));

    expect(factory.getConnectionState()).toMatchObject({
      status: 'degraded',
      ready: false,
      lastError: 'socket closed',
    });
    expect(factory.getConnectionState().attempts).toBeGreaterThan(0);
    expect(connectionInstances.length).toBeGreaterThan(1);

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
    firstConnection.ready = false;
    await firstConnection?.emit('error', new Error('socket closed'));

    // A new connection should have been created
    expect(connectionInstances.length).toBeGreaterThan(1);
    const secondConnection = connectionInstances.at(-1);

    // Emit connection event on the new connection — this should trigger rebindQueues
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
});
