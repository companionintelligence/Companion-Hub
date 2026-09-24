import { LoggerService } from '@/core/logger/logger.service';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AMQPError, type Connection, type RPCClient } from 'rabbitmq-client';
import { z } from 'zod';
import { appEventResultSchema } from '../entities/app-events';
import { EventPublisher } from '../event.publisher';
import { QUEUE_UNAVAILABLE_CODE } from '../queue.constants';
import { deriveQueueSigningKey, signQueueMessage } from '../message-signing';
import { Queue } from '../queue.entity';

describe('Queue', () => {
  it('preserves optional result fields (e.g. warningCode) with the real app-events result schema', async () => {
    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    // Regression: publish() validates the RPC reply with resultSchema.safeParse and
    // zod strips unknown keys — a runtime schema narrower than appEventResultSchema
    // silently drops fields like warningCode before the publisher-side handler runs.
    const queue = new Queue(rabbit, rpcClient, publisher, 'app-events-queue', 1, z.object({ requestId: z.string() }), appEventResultSchema, logger);

    rpcClient.send.mockResolvedValue({
      body: { success: true, message: 'partial', warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT', errorCode: 'x', cancelled: false },
    } as never);

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toMatchObject({ success: true, warningCode: 'APP_UNINSTALL_PARTIAL_REMNANT', errorCode: 'x', cancelled: false });
  });
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
      errorCode: QUEUE_UNAVAILABLE_CODE,
    });
    expect(rpcClient.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("Queue 'app-events-queue' is unavailable while RabbitMQ is degraded. Last error: socket closed");
  });

  it('names why a publish would be refused, so a caller can refuse before recording anything', () => {
    const logger = mock<LoggerService>();
    let ready = false;
    const queue = new Queue(
      mock<Connection>(),
      mock<RPCClient>(),
      mock<EventPublisher>(),
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
      () => ready,
      () => ({ status: 'degraded', ready, attempts: 3, lastError: 'getaddrinfo EAI_AGAIN ci-os-hub-queue' }),
    );

    expect(queue.unavailableReason()).toBe(
      "Queue 'app-events-queue' is unavailable while RabbitMQ is degraded. Last error: getaddrinfo EAI_AGAIN ci-os-hub-queue",
    );

    ready = true;
    expect(queue.unavailableReason()).toBeUndefined();
  });

  // core-14 (2026-09-17): the factory reported ready while its connection was
  // closing, so the gate let the publish through and every channel open failed.
  // No frame was written, so the caller must be able to tell nothing ran.
  it('marks a publish that could not open a channel as never dispatched', async () => {
    const logger = mock<LoggerService>();
    const rpcClient = mock<RPCClient>();
    const queue = new Queue(
      mock<Connection>(),
      rpcClient,
      mock<EventPublisher>(),
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
    );

    rpcClient.send.mockRejectedValue(new Error('channel creation failed; connection is closing') as never);

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toEqual({ success: false, message: 'channel creation failed; connection is closing', errorCode: QUEUE_UNAVAILABLE_CODE });
  });

  it('does not mark an RPC timeout as never dispatched, because the command may still be running', async () => {
    const logger = mock<LoggerService>();
    const rpcClient = mock<RPCClient>();
    const queue = new Queue(
      mock<Connection>(),
      rpcClient,
      mock<EventPublisher>(),
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
    );
    // The library marks this constructor internal; it is the error RPCClient.send raises.
    const RealAMQPError = AMQPError as unknown as new (code: string, message: string) => AMQPError;
    const timeout = new RealAMQPError('RPC_TIMEOUT', 'RPC response timed out');

    rpcClient.send.mockRejectedValue(timeout as never);

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toEqual({ success: false, message: 'RPC response timed out' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('The queue timed out'));
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

  it('retries once when the queue is briefly closing channels during reconnect', async () => {
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

    rpcClient.send
      .mockRejectedValueOnce(new Error('channel creation failed; connection is closing') as never)
      .mockResolvedValueOnce({ body: { success: true, message: 'ok-after-retry' } } as never);

    const result = await queue.publish({ requestId: 'req-1' });

    expect(result).toEqual({ success: true, message: 'ok-after-retry' });
    expect(rpcClient.send).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Transient queue error for app-events-queue; retrying once'));
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

  it('refreshes RPC client when rebound on the same connection instance', async () => {
    const logger = mock<LoggerService>();
    const rabbit = mock<Connection>();
    const staleRpcClient = mock<RPCClient>();
    const stalePublisher = mock<EventPublisher>();
    staleRpcClient.close.mockResolvedValue(undefined);
    stalePublisher.close.mockResolvedValue(undefined);

    const queue = new Queue(
      rabbit,
      staleRpcClient,
      stalePublisher,
      'app-events-queue',
      1,
      z.object({ requestId: z.string() }),
      z.object({ success: z.boolean(), message: z.string() }),
      logger,
    );

    const freshRpcClient = mock<RPCClient>();
    const freshPublisher = mock<EventPublisher>();
    freshRpcClient.send.mockResolvedValue({ body: { success: true, message: 'fresh client' } } as never);

    queue.rebindConnection(rabbit, freshRpcClient, freshPublisher);

    const result = await queue.publish({ requestId: 'req-same-conn' });

    expect(result).toEqual({ success: true, message: 'fresh client' });
    expect(freshRpcClient.send).toHaveBeenCalledWith('app-events-queue', { requestId: 'req-same-conn' });
    expect(staleRpcClient.send).not.toHaveBeenCalled();
    expect(staleRpcClient.close).toHaveBeenCalled();
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

  it('registers a consumer error handler so setup failures do not crash the process', () => {
    const logger = mock<LoggerService>();
    const consumer = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const rabbit = mock<Connection>();
    rabbit.createConsumer.mockReturnValue(consumer as never);
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

    queue.onEvent(async () => {
      /* no-op */
    });

    expect(rabbit.createConsumer).toHaveBeenCalled();
    expect(consumer.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});

describe('Queue — per-message authentication', () => {
  const KEY = deriveQueueSigningKey('hub-jwt-secret');
  const schema = z.object({ requestId: z.string(), command: z.string().optional() });
  const result = z.object({ success: z.boolean(), message: z.string() });

  function signedQueue() {
    const logger = mock<LoggerService>();
    const consumer = { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const rabbit = mock<Connection>();
    let handler: ((req: { body: unknown }, reply: (r: unknown) => Promise<void>) => Promise<void>) | undefined;
    rabbit.createConsumer.mockImplementation(((_opts: unknown, cb: typeof handler) => {
      handler = cb;
      return consumer;
    }) as never);
    const rpcClient = mock<RPCClient>();
    const publisher = mock<EventPublisher>();
    publisher.publish.mockResolvedValue(undefined);
    const queue = new Queue(rabbit, rpcClient, publisher, 'app-events-queue', 1, schema, result, logger, () => true, undefined, KEY);
    const callback = vi.fn().mockResolvedValue(undefined);
    queue.onEvent(callback);
    if (!handler) throw new Error('consumer handler was not registered');
    return { queue, rpcClient, publisher, logger, callback, deliver: handler };
  }

  it('signs what it publishes, and the signed body still carries the validated payload', async () => {
    const { queue, rpcClient } = signedQueue();
    rpcClient.send.mockResolvedValue({ body: { success: true, message: 'ok' } } as never);

    await queue.publish({ requestId: 'req-1', command: 'restart' });

    const [, body] = rpcClient.send.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({ requestId: 'req-1', command: 'restart' });
    expect(body.__hub).toMatchObject({ v: 1, sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('dispatches a validly signed message with the envelope stripped', async () => {
    const { deliver, callback } = signedQueue();
    const reply = vi.fn().mockResolvedValue(undefined);
    const wire = signQueueMessage(KEY, 'app-events-queue', { requestId: 'req-2', command: 'restart' });

    await deliver({ body: wire }, reply);

    expect(callback).toHaveBeenCalledWith({ requestId: 'req-2', command: 'restart' }, reply);
  });

  it('SECURITY: refuses an unsigned command — the shape anyone holding the broker password can send', async () => {
    const { deliver, callback, publisher, logger } = signedQueue();
    const reply = vi.fn().mockResolvedValue(undefined);

    await deliver({ body: { requestId: 'req-3', command: 'uninstall' } }, reply);

    expect(callback).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ success: false, message: expect.stringMatching(/unauthenticated.*missing_envelope/) });
    expect(publisher.publish).toHaveBeenCalledWith(
      'rpc.rejected.app-events-queue',
      expect.objectContaining({ reason: 'missing_envelope', requestId: 'req-3' }),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('SECURITY: refuses a tampered or replayed command', async () => {
    const { deliver, callback } = signedQueue();
    const reply = vi.fn().mockResolvedValue(undefined);
    const wire = signQueueMessage(KEY, 'app-events-queue', { requestId: 'req-4', command: 'restart' });

    await deliver({ body: { ...wire, command: 'uninstall' } }, reply);
    expect(callback).not.toHaveBeenCalled();

    await deliver({ body: wire }, reply);
    expect(callback).toHaveBeenCalledTimes(1);

    await deliver({ body: wire }, reply);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith({ success: false, message: expect.stringMatching(/replayed/) });
  });

  it('signs cron-scheduled publishes at fire time', async () => {
    vi.useFakeTimers();
    try {
      const { queue, rpcClient } = signedQueue();
      rpcClient.send.mockResolvedValue({ body: { success: true, message: 'ok' } } as never);

      queue.publishRepeatable({ requestId: 'cron-1' }, '* * * * *');
      await vi.advanceTimersByTimeAsync(61_000);

      const [, body] = rpcClient.send.mock.calls[0] as [string, Record<string, unknown>];
      expect(body).toMatchObject({ requestId: 'cron-1' });
      expect(body.__hub).toMatchObject({ v: 1 });
      queue.stopAllCronTasks();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so, loudly, when constructed without a key (test-only mode)', () => {
    const logger = mock<LoggerService>();
    new Queue(mock<Connection>(), mock<RPCClient>(), mock<EventPublisher>(), 'app-events-queue', 1, schema, result, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no message signing key/));
  });
});
