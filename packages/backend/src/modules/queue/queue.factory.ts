import { setTimeout } from 'node:timers/promises';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Connection } from 'rabbitmq-client';
import { z } from 'zod';
import { EventPublisher } from './event.publisher';
import { Queue } from './queue.entity';

export type QueueConnectionStatus = 'connecting' | 'ready' | 'degraded';

export interface QueueConnectionState {
  status: QueueConnectionStatus;
  ready: boolean;
  attempts: number;
  lastError?: string;
}

@Injectable()
export class QueueFactory implements OnApplicationShutdown {
  private rabbit: Connection;
  private connectionAttempts = 0;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<Error | undefined> | null = null;
  private connectionStatus: QueueConnectionStatus = 'connecting';
  private lastError?: string;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous queue schemas
  private createdQueues: { queue: Queue<any, any>; queueName: string; timeout?: number }[] = [];

  public constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
  ) {
    if (process.env.CI_HUB_OPENAPI_GENERATE === '1') {
      this.connectionStatus = 'degraded';
      this.lastError = 'skipped for OpenAPI generation';
      return;
    }

    void this.initializeConnection().catch(async (error) => {
      this.logger.error('Initial queue connection failed', error);
      await this.reconnect(error instanceof Error ? error : new Error(String(error)));
    });
  }

  public async initializeConnection() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize()
      .catch((error) => {
        this.markDegraded(error instanceof Error ? error : new Error(String(error)));
        throw error;
      })
      .finally(() => {
        this.initializationPromise = null;
      });

    return this.initializationPromise;
  }

  private async doInitialize() {
    if (this.rabbit) {
      try {
        this.rabbit.removeAllListeners();
        await this.rabbit.close();
      } catch {
        // Old connection may already be dead
      }
    }

    const { host, password, username, port } = this.config.get('queue');

    this.rabbit = new Connection({
      hostname: host,
      username,
      password,
      port,
      connectionTimeout: 30000,
      heartbeat: 60,
      frameMax: 8192,
    });

    this.connectionStatus = this.connectionAttempts > 0 || this.lastError ? 'degraded' : 'connecting';

    this.rabbit.on('connection', () => {
      this.connectionAttempts = 0;
      this.isInitialized = true;
      this.connectionStatus = 'ready';
      this.lastError = undefined;
      this.logger.info('Connected to the queue');
      this.rebindQueues();
    });

    this.rabbit.on('error', async (error) => {
      this.logger.error('Queue connection error', error);

      // The library's Connection class handles reconnection internally.
      // Only trigger manual reconnect if the connection is truly dead and
      // the library hasn't already recovered.
      if (this.rabbit?.ready) {
        this.logger.warn('Queue connection recovered automatically, skipping manual reconnect');
        return;
      }

      this.markDegraded(error);
      await this.reconnect(error);
    });

    await this.waitForConnection();
  }

  private async waitForConnection(maxWaitTime = 30000) {
    const startTime = Date.now();

    while (!this.rabbit.ready && Date.now() - startTime < maxWaitTime) {
      await setTimeout(1000);
    }

    if (!this.rabbit.ready) {
      throw new Error('Failed to connect to RabbitMQ within timeout period');
    }
  }

  private markDegraded(error: Error) {
    this.isInitialized = false;
    this.connectionStatus = 'degraded';
    this.lastError = error.message;
  }

  /**
   * Re-bind all existing queues to the current connection after a reconnect.
   * Creates fresh RPC clients, publishers, and consumers for each queue.
   */
  private rebindQueues() {
    for (const { queue, queueName, timeout } of this.createdQueues) {
      try {
        const rpcClient = this.rabbit.createRPCClient({
          timeout,
          confirm: true,
          maxAttempts: 3,
          queues: [{ autoDelete: false, durable: true, queue: queueName }],
        });
        const publisher = new EventPublisher(this.rabbit, this.logger, queueName);
        publisher.initialize();
        queue.rebindConnection(this.rabbit, rpcClient, publisher);
        this.logger.info(`Rebound queue ${queueName} to new connection`);
      } catch (e) {
        this.logger.error(`Failed to rebind queue ${queueName} after reconnect`, e);
      }
    }
  }

  public getConnection() {
    return this.rabbit;
  }

  public isReady() {
    return this.isInitialized && this.rabbit?.ready;
  }

  public getConnectionState(): QueueConnectionState {
    return {
      status: this.connectionStatus,
      ready: this.isReady(),
      attempts: this.connectionAttempts,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  // Re-establish connection to Queue with exponential backoff
  public async reconnect(error: Error) {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.reconnectPromise = this.doReconnect(error).finally(() => {
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  private async doReconnect(initialError: Error) {
    let currentError = initialError;

    while (this.connectionAttempts < 5) {
      this.connectionAttempts++;
      this.markDegraded(currentError);
      this.logger.warn(`Queue connection lost, attempting to reconnect... (attempt ${this.connectionAttempts}/5)`);

      const timeout = 2 ** this.connectionAttempts * 1000;
      await setTimeout(timeout);

      try {
        await this.initializeConnection();

        if (this.isReady()) {
          return;
        }
      } catch (error) {
        currentError = error instanceof Error ? error : new Error(String(error));
      }
    }

    this.logger.error('Queue connection lost, exceeded maximum reconnection attempts');

    return currentError;
  }

  public async createQueue<T extends z.ZodType>(params: { queueName: string; workers?: number; eventSchema: T; timeout?: number }) {
    if (process.env.CI_HUB_OPENAPI_GENERATE === '1') {
      return {
        onEvent: () => {
          /* OpenAPI generation: queue unused */
        },
        publish: async () => ({ success: true, message: 'openapi-stub' }),
        publishRepeatable: () => {
          /* no-op */
        },
        stopAllCronTasks: () => {
          /* no-op */
        },
        rebindConnection: () => {
          /* no-op */
        },
      } as unknown as Queue<T, z.ZodType<{ success: boolean; message: string }>>;
    }

    if (!this.rabbit) {
      try {
        await this.initializeConnection();
      } catch {
        this.logger.warn('Queue connection not ready, creating queue in degraded mode.');
      }
    } else if (!this.isReady()) {
      if (this.getConnectionState().status === 'degraded') {
        this.logger.warn('Queue connection not ready, creating queue in degraded mode.');
      }
    }

    const publisher = new EventPublisher(this.rabbit, this.logger, params.queueName);
    const resultSchema = z.object({ success: z.boolean(), message: z.string() });
    publisher.initialize();

    const { queueName, workers = 3, eventSchema, timeout } = params;

    const rpcClient = this.rabbit.createRPCClient({
      timeout,
      confirm: true,
      maxAttempts: 3,
      queues: [{ autoDelete: false, durable: true, queue: queueName }],
    });

    const queue = new Queue(
      this.rabbit,
      rpcClient,
      publisher,
      queueName,
      workers,
      eventSchema,
      resultSchema,
      this.logger,
      () => this.isReady(),
      () => this.getConnectionState(),
    );
    this.createdQueues.push({ queue, queueName, timeout });
    return queue;
  }

  async onApplicationShutdown() {
    for (const { queue } of this.createdQueues) {
      queue.stopAllCronTasks();
    }
    this.createdQueues = [];

    try {
      await this.rabbit?.close();
    } catch (e) {
      this.logger.warn('Error closing RabbitMQ connection during shutdown', e);
    }
  }
}
