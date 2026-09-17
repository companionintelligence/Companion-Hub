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
  private initializationStartedAt = 0;
  private reconnectPromise: Promise<Error | undefined> | null = null;
  private reconnectStartedAt = 0;
  // Bumped when the watchdog abandons a stalled recovery. A reconnect that wakes
  // under an older epoch stops, so it cannot tear down the connection the newer
  // recovery settled on.
  private recoveryEpoch = 0;
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
  // How long a reconnect burst may stay in flight before the watchdog treats it
  // as stuck and runs anyway. Every await in a burst is bounded: five backoffs
  // (2+4+8+16+32 = 62 s) plus, per attempt, a 3 s probe and a 31 s connect wait
  // come to 232 s. core-14's full five-attempt bursts measured 212 s on
  // 2026-09-17 (DNS for the broker failing, before this change added the probe).
  // Without this ceiling one await that never returns switches the watchdog off
  // for good, which is how core-14 stayed 503 until a restart.
  private static readonly RECOVERY_STALL_MS = 300_000;
  // Docker gives a stopping container 10 s before SIGKILL, and a graceful close
  // waits on consumer channels that do not close on their own.
  private static readonly SHUTDOWN_CLOSE_TIMEOUT_MS = 5_000;

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

    const epoch = this.recoveryEpoch;
    const initialization: Promise<void> = this.doInitialize()
      .catch((error) => {
        // An abandoned initialize must not mark the recovery that replaced it degraded.
        if (epoch === this.recoveryEpoch) {
          this.markDegraded(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      })
      .finally(() => {
        if (this.initializationPromise === initialization) {
          this.initializationPromise = null;
        }
      });
    this.initializationPromise = initialization;
    this.initializationStartedAt = Date.now();

    return initialization;
  }

  private async doInitialize() {
    this.discardConnection(this.rabbit);

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

  /**
   * Drop a connection without waiting on it.
   *
   * `Connection.close()` first waits for every channel to close, and the three
   * consumer channels never close on their own. On core-14 (2026-09-17) a
   * reconnect awaited close() on a connection that had already recovered; the
   * await never returned and every later channel open failed with "connection is
   * closing" until the container was restarted. `unsafeDestroy()` drops the
   * socket at once. Nothing needs this connection's channels to finish: the
   * queues rebind to the replacement when its 'connection' event fires.
   */
  private discardConnection(connection: Connection | undefined) {
    if (!connection) {
      return;
    }

    connection.removeAllListeners();
    // A channel's last-resort error is emitted on its connection, and an
    // EventEmitter with no 'error' listener rethrows it as an uncaught exception.
    connection.on('error', () => undefined);
    try {
      connection.unsafeDestroy();
    } catch {
      // Already destroyed.
    }
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
    const inFlightSince = this.recoveryInFlightSince();
    if (inFlightSince !== undefined) {
      const inFlightMs = Date.now() - inFlightSince;
      // A reconnect or (re)initialize in flight settles readiness itself, unless
      // it has outlived every bounded burst and is stuck on an await.
      if (inFlightMs < QueueFactory.RECOVERY_STALL_MS) {
        return;
      }
      this.abandonStalledRecovery(inFlightMs);
    }

    if (await this.keepConnectionIfUsable()) {
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

  /**
   * Resolve true when the current connection can open a channel. When it can but
   * the factory still has it flagged degraded (the library recovered the socket
   * without the factory seeing a fresh 'connection' event), clear the flag and
   * refresh the RPC clients so publishes stop short-circuiting on the unavailable gate.
   */
  private async keepConnectionIfUsable(): Promise<boolean> {
    if (!(await this.probeConnection())) {
      return false;
    }

    if (this.connectionStatus !== 'ready') {
      this.logger.info('Queue connection probe succeeded; refreshing queue bindings');
      this.connectionAttempts = 0;
      this.connectionStatus = 'ready';
      this.lastError = undefined;
      this.rebindQueues();
    }
    return true;
  }

  private recoveryInFlightSince(): number | undefined {
    // A reconnect drives its own initializes, so its start is the earlier one.
    if (this.reconnectPromise) {
      return this.reconnectStartedAt;
    }
    if (this.initializationPromise) {
      return this.initializationStartedAt;
    }
    return undefined;
  }

  private abandonStalledRecovery(inFlightMs: number) {
    this.logger.error(
      `Queue recovery has been in flight for ${Math.round(inFlightMs / 1000)} s, longer than a bounded reconnect burst can take; abandoning it so the watchdog can repair the connection`,
    );
    this.recoveryEpoch++;
    this.reconnectPromise = null;
    this.initializationPromise = null;
  }

  // Re-establish connection to Queue with exponential backoff
  public async reconnect(error: Error) {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    const reconnect: Promise<Error | undefined> = this.doReconnect(error, this.recoveryEpoch).finally(() => {
      if (this.reconnectPromise === reconnect) {
        this.reconnectPromise = null;
      }
    });
    this.reconnectPromise = reconnect;
    this.reconnectStartedAt = Date.now();

    return reconnect;
  }

  private async doReconnect(initialError: Error, epoch: number) {
    let currentError = initialError;

    while (this.connectionAttempts < 5) {
      if (epoch !== this.recoveryEpoch) {
        return currentError;
      }
      this.connectionAttempts++;
      const attempt = this.connectionAttempts;
      this.markDegraded(currentError);
      this.logger.warn(`Queue connection lost, attempting to reconnect... (attempt ${attempt}/5)`);

      const timeout = 2 ** attempt * 1000;
      await setTimeout(timeout);

      if (epoch !== this.recoveryEpoch) {
        return currentError;
      }

      // rabbitmq-client keeps retrying a dropped connection on its own, so the
      // connection can come back while this attempt sleeps. On core-14 the
      // connection attempt 3 built reconnected at 08:47:21 and attempt 4 woke at
      // 08:47:24 and replaced it anyway. Keep a connection that can open a channel.
      if (await this.keepConnectionIfUsable()) {
        this.logger.info(`Queue connection recovered before reconnect attempt ${attempt}/5 ran; keeping it`);
        return undefined;
      }

      if (epoch !== this.recoveryEpoch) {
        return currentError;
      }

      try {
        await this.initializeConnection();

        if (this.isReady()) {
          return;
        }
      } catch (error) {
        currentError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (epoch === this.recoveryEpoch) {
      this.logger.error('Queue connection lost, exceeded maximum reconnection attempts');
    }

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
    // Stop any reconnect in flight from building a connection after shutdown.
    this.recoveryEpoch++;

    const connection = this.rabbit;
    if (!connection) {
      return;
    }

    try {
      await this.withTimeout(connection.close(), QueueFactory.SHUTDOWN_CLOSE_TIMEOUT_MS, 'Queue connection close timed out');
    } catch (e) {
      this.logger.warn('Error closing RabbitMQ connection during shutdown; destroying it', e);
      this.discardConnection(connection);
    }
  }
}
