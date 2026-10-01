import path from 'node:path';
import fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { ConfigurationService } from '../config/configuration.service';
import { LoggerService } from '../logger/logger.service';
import * as schema from './drizzle/schema';

/**
 * Boot readiness gate (#933 infrastructure): how long the backend waits for Postgres before
 * giving up. Compose already gates first start on pg_isready, but `depends_on` says nothing
 * about a Hub container restarting alone while the DB is mid-restart, or Docker DNS still
 * warming after a network recreation. ~60s of patience covers those windows; a DB that is
 * still absent after that is a real outage worth crashing loudly over.
 */
const READY_MAX_ATTEMPTS = 30;
const READY_DELAY_MS = 2_000;

@Injectable()
export class DatabaseService {
  public db: NodePgDatabase<typeof schema>;
  private readonly pool: pg.Pool;

  constructor(
    private configurationService: ConfigurationService,
    private logger: LoggerService,
  ) {
    const { username, port, database, host, password } = this.configurationService.get('database');

    // An explicit pool instead of drizzle's connection-string default (#933):
    // - keepAlive: long-lived sockets survive quiet periods, so steady-state traffic stops
    //   paying a fresh `getaddrinfo ci-hub-db` on every reconnect — the exact lookup that
    //   returns EAI_AGAIN when Docker's embedded DNS is under churn.
    // - idleTimeoutMillis 60s (default 10s): warm connections stay warm across request bursts
    //   instead of being torn down and re-resolved ten seconds later.
    // - connectionTimeoutMillis 10s: the old connection string carried connect_timeout=300 —
    //   five minutes of hanging on a dead DB before a request failed.
    this.pool = new pg.Pool({
      host,
      port,
      user: username,
      password,
      database,
      max: 10,
      keepAlive: true,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
    });

    // pg.Pool emits 'error' for failures on IDLE clients (e.g. Postgres restarts and kills the
    // socket). With no listener that's an uncaught 'error' event — process exit(1) — so a DB
    // blip used to be able to take the whole Hub down with it. Log and let the pool replace
    // the client on next checkout.
    this.pool.on('error', (err) => {
      this.logger.error('Postgres pool: idle client error (connection will be re-established)', err.message);
    });

    // The timestamp columns are written as UTC and read back without a zone (see db-timestamp.ts), so
    // the session's zone decides what `now()` means. A server configured for another zone would stamp
    // its own wall clock beside the UTC the app writes. Set per connection, with a statement and not
    // the `options` startup parameter: a connection pooler in front of Postgres rejects an unknown
    // startup parameter outright, and then no connection would be made at all.
    this.pool.on('connect', (client) => {
      client.query("SET TIME ZONE 'UTC'").catch((error: unknown) => {
        this.logger.error('Postgres pool: could not set the session time zone to UTC', error instanceof Error ? error.message : String(error));
      });
    });

    this.db = drizzle(this.pool, { schema });
  }

  /**
   * Block until Postgres answers a trivial query, retrying transient failures. Called at
   * bootstrap before migrations so a Hub that comes up during a DB restart or DNS warm-up
   * waits instead of crash-looping (whose repeated exits showed up in #933 as child
   * processes dying with code 1).
   */
  async waitUntilReady(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt++) {
      try {
        await this.pool.query('SELECT 1');
        if (attempt > 1) {
          this.logger.info(`Database reachable after ${attempt} attempts`);
        }
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(`Database not reachable yet (attempt ${attempt}/${READY_MAX_ATTEMPTS}):`, err instanceof Error ? err.message : String(err));
        await new Promise((resolve) => setTimeout(resolve, READY_DELAY_MS));
      }
    }
    this.logger.error('Database never became reachable — giving up');
    throw lastError instanceof Error ? lastError : new Error('Database never became reachable');
  }

  private getMigrationsPath(): string {
    const { appDir } = this.configurationService.get('directories');

    if (process.env.NODE_ENV === 'development') {
      const devPath = path.resolve(process.cwd(), 'src/core/database/drizzle');
      const devJournal = path.join(devPath, 'meta', '_journal.json');
      if (fs.existsSync(devJournal)) {
        return devPath;
      }
    }

    return path.join(appDir, 'assets', 'migrations');
  }

  migrate = async () => {
    try {
      this.logger.debug('Starting database migration...');
      await migrate(this.db, { migrationsFolder: this.getMigrationsPath() });
      this.logger.debug('Database migration complete.');
    } catch (error) {
      this.logger.error('Error migrating database:', error);
      throw error;
    }
  };
}
