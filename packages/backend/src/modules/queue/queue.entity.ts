import type { LoggerService } from '@/core/logger/logger.service';
import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { AMQPConnectionError, AMQPError, type Connection, type Consumer, type RPCClient } from 'rabbitmq-client';
import { z } from 'zod';
import type { EventPublisher } from './event.publisher';
import type { QueueConnectionState } from './queue.factory';

export class Queue<T extends z.ZodType, R extends z.ZodType<{ success: boolean; message: string }>> {
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
        { queue: this.queueName, concurrency: this.workers, queueOptions: { durable: true } },
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
    // Only rebind if the connection instance actually changed
    if (this.rabbit === rabbit) return;

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
    try {
      if (!this.isConnectionReady()) {
        const result = this.unavailableResult();
        this.logger.warn(result.message);
        return result;
      }

      const eventData = this.eventSchema.safeParse(event);

      if (!eventData.success) {
        throw new Error('Invalid event data');
      }

      const res = await this.rpcClient.send(this.queueName, eventData.data);
      const response = this.resultSchema.safeParse(res.body);

      if (response.success) {
        return response.data;
      }

      throw new Error('Invalid response schema');
    } catch (err) {
      if (err instanceof AMQPConnectionError) {
        this.logger.error('Connection to the queue was lost. Try restarting your instance before retrying.');
      }

      if (err instanceof AMQPError) {
        if (err.code === 'RPC_TIMEOUT') {
          this.logger.error('The queue timed out while processing the request. Try restarting your instance before retrying.');
        }
        return { success: false, message: err.message };
      }

      return { success: false, message: String(err) };
    }
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
      try {
        if (!this.isConnectionReady()) {
          const { message } = this.unavailableResult();
          this.logger.warn(`Skipping cron job for queue ${this.queueName}: ${message}`);
          return;
        }

        await this.rpcClient.send(this.queueName, eventData.data);
      } catch (e) {
        this.logger.error('Error in cron job:', e);
      }
    });
    this.cronTasks.push(task);
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
