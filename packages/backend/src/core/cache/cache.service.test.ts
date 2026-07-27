import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The suite-wide `fs` mock is an in-memory volume, but CacheService opens a REAL sqlite
// file — so its data dir has to exist on disk. Build it with the unmocked fs, then point
// DATA_DIR (resolved once, when the constants module first loads) at it and re-import.
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const dataDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-cache-test-'));
realFs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
// Restored in `afterAll`: `process.env` outlives the module registry, so a leaked value
// would point every later test file in this worker at a directory we then delete.
const previousDataDir = process.env.CI_HUB_DATA_DIR;
process.env.CI_HUB_DATA_DIR = dataDir;

vi.resetModules();
const { CacheService } = await import('./cache.service');

const cache = new CacheService();

afterAll(() => {
  cache.onApplicationShutdown();
  if (previousDataDir === undefined) {
    delete process.env.CI_HUB_DATA_DIR;
  } else {
    process.env.CI_HUB_DATA_DIR = previousDataDir;
  }
  realFs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  cache.clear();
});

/** Plant a value no reader can JSON.parse — a torn write, or a row from an older schema. */
function corruptRow(key: string) {
  const db = new DatabaseSync(path.join(dataDir, 'cache', 'cache.sqlite'));
  db.prepare('UPDATE keyv SET value = ? WHERE key = ?').run('{not json', key);
  db.close();
}

describe('CacheService', () => {
  describe('clear', () => {
    it('wipes every key by default', () => {
      cache.set('session:abc', '1');
      cache.set('buster', '0.2.46');

      cache.clear();

      expect(cache.get('session:abc')).toBeUndefined();
      expect(cache.get('buster')).toBeUndefined();
    });

    it('spares preserved prefixes, so a version bump no longer signs every user out', () => {
      cache.set('session:abc', '1');
      cache.set('session:1:abc', 'session:abc');
      cache.set('session:grace:abc', '1');
      cache.set('buster', '0.2.46');
      cache.set('browser_handoff:ticket', '{}');

      cache.clear(['session:']);

      expect(cache.get('session:abc')).toBe('1');
      expect(cache.get('session:1:abc')).toBe('session:abc');
      expect(cache.get('session:grace:abc')).toBe('1');
      expect(cache.get('buster')).toBeUndefined();
      expect(cache.get('browser_handoff:ticket')).toBeUndefined();
    });
  });

  describe('getByPrefix', () => {
    // Regression: the query looked for `cache:<prefix>%` while `set()` stores keys
    // verbatim, so it never matched — making destroyAllSessionsByUserId a no-op.
    it('matches keys exactly as they were stored', async () => {
      cache.set('session:1:aaa', 'session:aaa');
      cache.set('session:1:bbb', 'session:bbb');
      cache.set('session:2:ccc', 'session:ccc');

      const rows = await cache.getByPrefix('session:1:');

      expect(rows.map((row) => row.key).sort()).toEqual(['session:1:aaa', 'session:1:bbb']);
      expect(rows.map((row) => row.val).sort()).toEqual(['session:aaa', 'session:bbb']);
    });

    it('returns nothing for a prefix with no matches', async () => {
      cache.set('session:1:aaa', 'session:aaa');

      expect(await cache.getByPrefix('session:9:')).toEqual([]);
    });

    it('treats the prefix literally, not as a SQL LIKE pattern', async () => {
      cache.set('session:1:aaa', 'session:aaa');
      cache.set('sessionX1:aaa', 'nope');
      cache.set('SESSION:1:aaa', 'nope');

      // `_` is a single-character wildcard to LIKE, and LIKE is ASCII-case-insensitive:
      // either would have pulled the two decoys in.
      const rows = await cache.getByPrefix('session:1:');

      expect(rows.map((row) => row.key)).toEqual(['session:1:aaa']);
    });

    it('skips an unreadable row instead of abandoning the whole scan', async () => {
      cache.set('session:1:aaa', 'session:aaa');
      cache.set('session:1:bbb', 'session:bbb');
      corruptRow('session:1:aaa');

      // One bad row used to bubble to the outer catch and return [], which is exactly
      // the no-op destroyAllSessionsByUserId was just fixed out of.
      const rows = await cache.getByPrefix('session:1:');

      expect(rows.map((row) => row.key)).toEqual(['session:1:bbb']);
    });
  });
});
