import { LoggerService } from '@/core/logger/logger.service';
import { describe, expect, it } from 'vitest';
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
});
