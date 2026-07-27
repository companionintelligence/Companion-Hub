import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { DATA_DIR } from '@/common/constants';

export const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

@Injectable()
export class CacheService implements OnApplicationShutdown {
  private db: DatabaseSync;
  private evictionInterval: NodeJS.Timeout | null = null;
  private static readonly SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  constructor() {
    const cacheDir = path.join(DATA_DIR, 'cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.db = new DatabaseSync(path.join(cacheDir, 'cache.sqlite'));

    const tableCheck = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get();

    if (!tableCheck) {
      this.db.exec('CREATE TABLE keyv (key TEXT PRIMARY KEY, value TEXT)');
    }

    this.evictExpired();
    this.evictionInterval = setInterval(() => this.evictExpired(), CacheService.SIX_HOURS_MS);
  }

  onApplicationShutdown() {
    if (this.evictionInterval) {
      clearInterval(this.evictionInterval);
      this.evictionInterval = null;
    }
  }

  public set(key: string, value: string, expiration = ONE_DAY_IN_SECONDS) {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO keyv (key, value) VALUES (?, ?)');
    stmt.run(key, JSON.stringify({ value, expiration: Math.max(Date.now() + expiration * 1000, expiration) }));
  }

  public get(key: string) {
    const query = this.db.prepare('SELECT * FROM keyv WHERE key = ?');
    const row = query.get(key) as { value: string } | undefined;

    if (!row) {
      return undefined;
    }

    const { value, expiration = 0 } = JSON.parse(row.value) as { value: string; expiration: number };
    if (expiration < Date.now()) {
      this.del(key);
      return undefined;
    }

    return value;
  }

  /** Returns the absolute expiry timestamp (ms) for a key, or null when missing/expired. */
  public getExpirationAt(key: string): number | null {
    const query = this.db.prepare('SELECT * FROM keyv WHERE key = ?');
    const row = query.get(key) as { value: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      const { expiration = 0 } = JSON.parse(row.value) as { value: string; expiration: number };
      if (expiration < Date.now()) {
        this.del(key);
        return null;
      }

      return expiration;
    } catch {
      this.del(key);
      return null;
    }
  }

  public del(key: string) {
    const stmt = this.db.prepare('DELETE FROM keyv WHERE key = ?');
    stmt.run(key);
  }

  public async getByPrefix(prefix: string) {
    try {
      const query = this.db.prepare('SELECT * FROM keyv WHERE key LIKE ?');
      // Match the prefix as written. This used to look for `cache:<prefix>%` while
      // `set()` stores keys verbatim, so it never matched a row — silently turning
      // its only caller, `SessionManager.destroyAllSessionsByUserId`, into a no-op.
      const rows = query.all(`${prefix}%`) as { key: string; value: string }[];

      return rows.map((row) => ({ key: row.key, val: JSON.parse(row.value).value }));
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  /**
   * Wipe the store. `preservePrefixes` spares keys that are not really cache entries:
   * the session store shares this table, so the version-bump wipe in `AppService`
   * would otherwise sign every user out of every device on each upgrade (#944).
   */
  public clear(preservePrefixes: string[] = []) {
    if (preservePrefixes.length === 0) {
      this.db.prepare('DELETE FROM keyv').run();
      return;
    }

    const where = preservePrefixes.map(() => 'key NOT LIKE ?').join(' AND ');
    this.db.prepare(`DELETE FROM keyv WHERE ${where}`).run(...preservePrefixes.map((prefix) => `${prefix}%`));
  }

  private evictExpired() {
    try {
      const now = Date.now();
      const rows = this.db.prepare('SELECT key, value FROM keyv').all() as { key: string; value: string }[];
      const deleteStmt = this.db.prepare('DELETE FROM keyv WHERE key = ?');

      for (const row of rows) {
        try {
          const { expiration = 0 } = JSON.parse(row.value) as { expiration: number };
          if (expiration > 0 && expiration < now) {
            deleteStmt.run(row.key);
          }
        } catch {
          deleteStmt.run(row.key);
        }
      }
    } catch {
      // Eviction is best-effort; failures are non-fatal
    }
  }
}
