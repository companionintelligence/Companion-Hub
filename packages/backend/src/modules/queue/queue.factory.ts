import { setTimeout } from 'node:timers/promises';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Connection } from 'rabbitmq-client';
import { z } from 'zod';
import { HUB_QUEUE_ARGUMENTS } from './queue.constants';
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
  private initializationPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<Error | undefined> | null = null;
  private connectionStatus: QueueConnectionStatus = 'connecting';
  private lastError?: string;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous queue schemas
  private createdQueues: { queue: Queue<any, any>; queueName: string; timeout?: number }[] = [];

  private healthWatchdog?: ReturnType<typeof globalThis.setInterval>;
  // How often the watchdog actively probes the connection. The per-attempt
  // reconnect budget (doReconnect) gives up after 5 tries; the watchdog re-arms
  // recovery indefinitely so a long broker outage can never permanently wedge
  // the queue once RabbitMQ comes back.
  private static readonly WATCHDOG_INTERVAL_MS = 30_000;
  // Upper bound on a single channel-acquire probe so the health endpoint always
  // answers well within Docker's 5s healthcheck timeout.
  private static readonly PROBE_TIMEOUT_MS = 3_000;

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

    this.startHealthWatchdog();
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
      acquireTimeout: 60000,
      retryLow: 2000,
      retryHigh: 30000,
      heartbeat: 60,
      frameMax: 8192,
    });

    this.connectionStatus = this.connectionAttempts > 0 || this.lastError ? 'degraded' : 'connecting';

    this.rabbit.on('connection', () => {
      this.connectionAttempts = 0;
      this.connectionStatus = 'ready';
      this.lastError = undefined;
      this.logger.info('Connected to the queue');
      this.rebindQueues();
    });

    this.rabbit.on('error', async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const isDnsTransient = /EAI_AGAIN|EAI_NODATA|ENOTFOUND/i.test(message);

      if (isDnsTransient && !this.rabbit?.ready) {
        this.logger.warn(`Queue broker not reachable yet (${message})`);
      } else {
        this.logger.error('Queue connection error', error);
      }

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

  private isConnectionEstablished(): boolean {
    // Either signal proves the connection is up: the 'connection' event (connectionStatus)
    // or the library's socket-level `ready` flag. Checking both avoids waiting out the full
    // timeout when one signal lags the other (and keeps the connect gate from busy-waiting).
    return this.connectionStatus === 'ready' || Boolean(this.rabbit?.ready);
  }

  private async waitForConnection(maxWaitTime = 30000) {
    const startTime = Date.now();

    while (!this.isConnectionEstablished() && Date.now() - startTime < maxWaitTime) {
      await setTimeout(1000);
    }

    if (!this.isConnectionEstablished()) {
      throw new Error('Failed to connect to RabbitMQ within timeout period');
    }
  }

  private markDegraded(error: Error) {
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
          queues: [{ autoDelete: false, durable: true, queue: queueName, arguments: HUB_QUEUE_ARGUMENTS }],
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
    // `rabbit.ready` checks internal socket state (readyState === OPEN && !writableCorked)
    // which can be falsely stuck after a RabbitMQ restart + reconnect even when the AMQP
    // connection is fully re-established. `connectionStatus` is the reliable signal here:
    // it's set to 'ready' only after the 'connection' event fires and to 'degraded' on error.
    return this.connectionStatus === 'ready';
  }

  public getConnectionState(): QueueConnectionState {
    return {
      status: this.connectionStatus,
      ready: this.isReady(),
      attempts: this.connectionAttempts,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Actively verify the connection can still open a channel.
   *
   * The cached `connectionStatus` flag is necessary but not sufficient: after a
   * RabbitMQ restart the factory can report 'ready' while the per-queue RPC
   * clients are still bound to a connection that is closing — every publish then
   * fails with "channel creation failed; connection is closing" even though
   * `isReady()` is true. Acquiring (and immediately closing) a real channel is
   * the only reliable liveness signal. Resolves false instead of throwing.
   */
  public async probeConnection(timeoutMs = QueueFactory.PROBE_TIMEOUT_MS): Promise<boolean> {
    if (!this.rabbit) {
      return false;
    }

    const acquired = this.rabbit.acquire();
    try {
      const channel = await this.withTimeout(acquired, timeoutMs, 'Queue connection probe timed out');
      await channel.close().catch(() => {
        /* channel may already be gone; the acquire succeeding is the signal we need */
      });
      return true;
    } catch {
      // If the timeout won the race, acquire() may still resolve later — close that
      // orphaned channel so health probes can't slowly leak channels, and swallow
      // any late rejection so it never surfaces as an unhandledRejection.
      acquired.then(
        (channel) => channel.close().catch(() => undefined),
        () => undefined,
      );
      return false;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    // Use the global (callback) timer explicitly — this module imports the
    // promise-based `setTimeout` from node:timers/promises, which would shadow it.
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        globalThis.clearTimeout(timer);
      }
    }
  }

  /**
   * Periodically probe the connection and force recovery if it is wedged. This
   * is the safety net beyond doReconnect's bounded retry: doReconnect gives up
   * after 5 attempts, but the watchdog keeps re-arming reconnect for as long as
   * the broker stays unreachable, and also heals the "ready flag but dead
   * channels" state that no socket-level signal catches.
   */
  private startHealthWatchdog() {
    if (this.healthWatchdog) {
      return;
    }

    this.healthWatchdog = globalThis.setInterval(() => {
      void this.runWatchdogCheck();
    }, QueueFactory.WATCHDOG_INTERVAL_MS);
    // Never hold the event loop open just for the watchdog.
    this.healthWatchdog.unref?.();
  }

  private async runWatchdogCheck() {
    // A reconnect or (re)initialize already in flight will settle readiness itself.
    if (this.reconnectPromise || this.initializationPromise) {
      return;
    }

    if (await this.probeConnection()) {
      // Connection is genuinely usable. If we were still flagged degraded (e.g.
      // the library recovered the socket without a fresh 'connection' event),
      // clear the flag and refresh the RPC clients so publishes stop short-
      // circuiting on the unavailable gate.
      if (this.connectionStatus !== 'ready') {
        this.logger.info('Queue watchdog: connection probe succeeded; refreshing queue bindings');
        this.connectionAttempts = 0;
        this.connectionStatus = 'ready';
        this.lastError = undefined;
        this.rebindQueues();
      }
      return;
    }

    this.logger.warn('Queue watchdog detected an unusable connection; forcing reconnect');
    const error = new Error('Queue watchdog: connection probe failed');
    this.markDegraded(error);
    // Reset the attempt budget so doReconnect's 5-try cap can't permanently wedge
    // the queue — each watchdog tick is allowed a fresh reconnect burst.
    this.connectionAttempts = 0;
    await this.reconnect(error);
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

  public async createQueue<T extends z.ZodType>(params: {
    queueName: string;
    workers?: number;
    eventSchema: T;
    timeout?: number;
    /**
     * The queue's result schema. MUST match the R of the Queue<T, R> class the
     * caller binds this queue to: publish() validates the RPC reply with
     * `resultSchema.safeParse`, and zod strips unknown keys — so a narrower
     * runtime schema silently drops result fields (errorCode, warningCode, …)
     * that the type claims are there. Defaults to the minimal {success, message}.
     */
    resultSchema?: z.ZodType<{ success: boolean; message: string }>;
  }) {
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
    const resultSchema = params.resultSchema ?? z.object({ success: z.boolean(), message: z.string() });
    publisher.initialize();

    const { queueName, workers = 3, eventSchema, timeout } = params;

    const rpcClient = this.rabbit.createRPCClient({
      timeout,
      confirm: true,
      maxAttempts: 3,
      queues: [{ autoDelete: false, durable: true, queue: queueName, arguments: HUB_QUEUE_ARGUMENTS }],
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
    if (this.healthWatchdog) {
      globalThis.clearInterval(this.healthWatchdog);
      this.healthWatchdog = undefined;
    }

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
