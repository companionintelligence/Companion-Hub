import { LoggerService } from '@/core/logger/logger.service';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Connection, RPCClient } from 'rabbitmq-client';
import { z } from 'zod';
import { EventPublisher } from '../event.publisher';
import { Queue } from '../queue.entity';

describe('Queue', () => {
  it('fails fast when RabbitMQ is degraded', async () => {
    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    const queue = new Queue(
      rabbit,
      rpcClient,
      publisher,
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
      () => false,
      () => ({ status: 'degraded', ready: false, attempts: 2, lastError: 'socket closed' }),
    );

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toEqual({
      success: false,
      message: "Queue 'app-events-queue' is unavailable while RabbitMQ is degraded. Last error: socket closed",
    });
    expect(rpcClient.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Queue 'app-events-queue' is unavailable while RabbitMQ is degraded. Last error: socket closed");
  });

  it('publishes through RPC when the queue connection is ready', async () => {
    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    const queue = new Queue(
      rabbit,
      rpcClient,
      publisher,
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
    );

    rpcClient.send.mockResolvedValue({ body: { success: true, message: 'ok' } } as never);

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toEqual({ success: true, message: 'ok' });
    expect(rpcClient.send).toHaveBeenCalledWith('app-events-queue', { requestId: 'req-1' });
  });

  it('skips cron execution when the queue connection is not ready', async () => {
    vi.useFakeTimers();

    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    const queue = new Queue(
      rabbit,
      rpcClient,
      publisher,
      'cron-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
      () => false,
      () => ({ status: 'degraded', ready: false, attempts: 1, lastError: 'connection lost' }),
    );

    queue.publishRepeatable({ requestId: 'cron-1' }, '* * * * * *');

    // Advance past cron tick
    await vi.advanceTimersByTimeAsync(1500);

    expect(rpcClient.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping cron job for queue cron-queue'));

    queue.stopAllCronTasks();
    vi.useRealTimers();
  });

  it('uses new RPC client and publisher after rebindConnection', async () => {
    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    rpcClient.close.mockResolvedValue(undefined);
    publisher.close.mockResolvedValue(undefined);
    const queue = new Queue(
      rabbit,
      rpcClient,
      publisher,
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
    );

    // Rebind to a new connection with new RPC client
    const newRabbit = mock<Connection>();
    const newRpcClient = mock<RPCClient>();
    const newPublisher = mock<EventPublisher>();
    newRpcClient.send.mockResolvedValue({ body: { success: true, message: 'rebound' } } as never);

    queue.rebindConnection(newRabbit, newRpcClient, newPublisher);

    const result = await queue.publish({ requestId: 'req-2' });

    expect(result).toEqual({ success: true, message: 'rebound' });
    expect(newRpcClient.send).toHaveBeenCalledWith('app-events-queue', { requestId: 'req-2' });
    expect(rpcClient.send).not.toHaveBeenCalled();
  });
});
