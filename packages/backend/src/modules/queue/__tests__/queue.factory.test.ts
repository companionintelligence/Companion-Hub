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
    public createRPCClient = vi.fn(() => ({ send: vi.fn() }));
    public createPublisher = vi.fn(() => ({ send: vi.fn(), close: vi.fn() }));

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

    const queue = await factory.createQueue({
      queueName: 'app-events-queue',
      eventSchema: z.object({ requestId: z.string() }),
      timeout: 1000,
    });

    expect(queue).toBeDefined();
    expect(connectionInstances[0]?.createPublisher).toHaveBeenCalled();
    expect(connectionInstances[0]?.createRPCClient).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Queue connection not ready, creating queue in degraded mode.');
  });
});
