import type { LoggerService } from '@/core/logger/logger.service';
import { setTimeout as sleep } from 'node:timers/promises';
import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { AMQPConnectionError, AMQPError, type Connection, type Consumer, type RPCClient } from 'rabbitmq-client';
import { z } from 'zod';
import { HUB_QUEUE_ARGUMENTS } from './queue.constants';
import type { EventPublisher } from './event.publisher';
import type { QueueConnectionState } from './queue.factory';

export class Queue<T extends z.ZodType, R extends z.ZodType<{ success: boolean; message: string }>> {
  private static readonly TRANSIENT_QUEUE_ERROR = /channel creation failed; connection is closing|connection is closing|socket closed/i;
  private cronTasks: ScheduledTask[] = [];
  private consumerCallback?: (data: z.output<T> & { eventId: string }, reply: (response: z.input<R>) => Promise<void>) => Promise<void>;
  private activeConsumer?: Consumer;

  constructor(
    private rabbit: Connection,
    private rpcClient: RPCClient,
    private publisher: EventPublisher,
    private queueName: string,
    private workers: number,
    private eventSchema: T,
    private resultSchema: R,
    private logger: LoggerService,
    private isConnectionReady: () => boolean = () => true,
    private getConnectionState: () => QueueConnectionState = () => ({ status: 'ready', ready: true, attempts: 0 }),
  ) {}

  public onEvent(callback: (data: z.output<T> & { eventId: string }, reply: (response: z.input<R>) => Promise<void>) => Promise<void>) {
    this.consumerCallback = callback;
    this.registerConsumer(callback);
  }

  private registerConsumer(callback: (data: z.output<T> & { eventId: string }, reply: (response: z.input<R>) => Promise<void>) => Promise<void>) {
    try {
      this.activeConsumer = this.rabbit.createConsumer(
        { queue: this.queueName, concurrency: this.workers, queueOptions: { durable: true, arguments: HUB_QUEUE_ARGUMENTS } },
        async (req, reply) => {
          let rpcSuccess = false;
          let rpcResultMessage = '';

          try {
            await callback(req.body, reply);
            rpcSuccess = true;
            rpcResultMessage = 'RPC processed successfully.';
          } catch (error) {
            this.logger.error('Error in consumer callback:', error);
            await reply({ success: false, message: (error as Error)?.message });
            rpcSuccess = false;
            rpcResultMessage = error instanceof Error ? error.message : String(error);
          } finally {
            const eventToPublish = {
              queueName: this.queueName,
              requestData: req.body,
              rpcStatus: rpcSuccess ? 'success' : 'failure',
              rpcMessage: rpcResultMessage,
              requestId: req.body.requestId,
              timestamp: new Date().toISOString(),
            };

            const routingKey = `rpc.${rpcSuccess ? 'processed' : 'error'}.${this.queueName}`;
            await this.publisher.publish(routingKey, eventToPublish);
          }
        },
      );
    } catch (error) {
      this.logger.error(`Failed to create consumer for queue ${this.queueName}:`, error);
      throw error;
    }
  }

  /**
   * Re-bind this queue to a new RabbitMQ connection after the factory reconnects.
   * Replaces the stale RPC client, publisher, and consumer with fresh instances.
   */
  public rebindConnection(rabbit: Connection, rpcClient: RPCClient, publisher: EventPublisher) {
    // Always replace RPC client and publisher. Queues are often created while the
    // connection is still opening; those clients are bound to a half-open socket
    // even when the factory passes the same Connection instance after the
    // 'connection' event fires.
    if (this.rabbit === rabbit && this.rpcClient === rpcClient && this.publisher === publisher) {
      return;
    }

    // Close old resources (best-effort, old connection may be dead)
    if (this.activeConsumer) {
      this.activeConsumer.close().catch(() => {
        /* old connection may be dead */
      });
      this.activeConsumer = undefined;
    }
    if (this.rpcClient) {
      this.rpcClient.close().catch(() => {
        /* old connection may be dead */
      });
    }
    if (this.publisher) {
      this.publisher.close().catch(() => {
        /* old connection may be dead */
      });
    }

    this.rabbit = rabbit;
    this.rpcClient = rpcClient;
    this.publisher = publisher;

    if (this.consumerCallback) {
      try {
        this.registerConsumer(this.consumerCallback);
      } catch (error) {
        this.logger.error(`Failed to re-register consumer for queue ${this.queueName} after reconnect:`, error);
      }
    }
  }

  async publish(event: z.input<T>): Promise<{ success: boolean; message: string } | z.infer<R>> {
    if (!this.isConnectionReady()) {
      const result = this.unavailableResult();
      this.logger.warn(result.message);
      return result;
    }

    const eventData = this.eventSchema.safeParse(event);

    if (!eventData.success) {
      throw new Error('Invalid event data');
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.rpcClient.send(this.queueName, eventData.data);
        const response = this.resultSchema.safeParse(res.body);

        if (response.success) {
          return response.data;
        }

        throw new Error('Invalid response schema');
      } catch (err) {
        if (attempt === 0 && this.shouldRetry(err)) {
          this.logger.warn(`Transient queue error for ${this.queueName}; retrying once: ${this.getErrorMessage(err)}`);
          await sleep(250);
          continue;
        }

        return this.toFailureResult(err);
      }
    }

    return { success: false, message: 'Queue publish failed after retry' };
  }

  public publishRepeatable(data: z.input<T>, cronPattern: string) {
    if (!cron.validate(cronPattern)) {
      throw new Error('Invalid cron pattern');
    }

    const eventData = this.eventSchema.safeParse(data);

    if (!eventData.success) {
      throw new Error('Invalid event data');
    }

    const task = cron.schedule(cronPattern, async () => {
      if (!this.isConnectionReady()) {
        const { message } = this.unavailableResult();
        this.logger.warn(`Skipping cron job for queue ${this.queueName}: ${message}`);
        return;
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.rpcClient.send(this.queueName, eventData.data);
          return;
        } catch (e) {
          if (attempt === 0 && this.shouldRetry(e)) {
            this.logger.warn(`Transient cron queue error for ${this.queueName}; retrying once: ${this.getErrorMessage(e)}`);
            await sleep(250);
            continue;
          }

          this.logger.error('Error in cron job:', e);
          return;
        }
      }
    });
    this.cronTasks.push(task);
  }

  private shouldRetry(err: unknown): boolean {
    return Queue.TRANSIENT_QUEUE_ERROR.test(this.getErrorMessage(err));
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private toFailureResult(err: unknown): { success: false; message: string } {
    if (err instanceof AMQPConnectionError) {
      this.logger.error('Connection to the queue was lost. Try restarting your instance before retrying.');
    }

    if (err instanceof AMQPError) {
      if (err.code === 'RPC_TIMEOUT') {
        this.logger.error('The queue timed out while processing the request. Try restarting your instance before retrying.');
      }
      return { success: false, message: err.message };
    }

    return { success: false, message: this.getErrorMessage(err) };
  }

  private unavailableResult(): { success: false; message: string } {
    const { status, lastError } = this.getConnectionState();
    const message = `Queue '${this.queueName}' is unavailable while RabbitMQ is ${status}.${lastError ? ` Last error: ${lastError}` : ''}`;

    return { success: false, message };
  }

  public stopAllCronTasks() {
    for (const task of this.cronTasks) {
      task.stop();
    }
    this.cronTasks = [];
  }
}
