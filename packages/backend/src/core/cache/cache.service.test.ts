import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The suite-wide `fs` mock is an in-memory volume, but CacheService opens a REAL sqlite
// file — so its data dir has to exist on disk. Build it with the unmocked fs, then point
// DATA_DIR (resolved once, when the constants module first loads) at it and re-import.
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const dataDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'ci-hub-cache-test-'));
realFs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
process.env.CI_HUB_DATA_DIR = dataDir;

vi.resetModules();
const { CacheService } = await import('./cache.service');

const cache = new CacheService();

afterAll(() => {
  cache.onApplicationShutdown();
  realFs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  cache.clear();
});

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
  });
});
