import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The backend test setup swaps fs for an in-memory volume, so read the real journal and SQL folder.
const { existsSync, readdirSync, readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

// Drizzle's migrator reads SQL only through the journal, and applies an entry only when its `when` is later
// than the last entry it applied. So the journal must number its entries in order, keep the timestamps
// increasing, point at a real SQL file, and list every SQL file in the folder. Breaking any of these leaves
// some Hubs without a migration that other Hubs run.

const drizzleDir = path.join(__dirname, '..', 'drizzle');

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const journal = JSON.parse(readFileSync(path.join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};

describe('drizzle migration journal', () => {
  it('numbers its entries in order from zero', () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(journal.entries.map((_, index) => index));
  });

  it('has strictly increasing timestamps, so the migrator never skips an entry', () => {
    const outOfOrder = journal.entries.flatMap((entry, index) => {
      const previous = journal.entries[index - 1];
      return previous && entry.when <= previous.when ? [entry.tag] : [];
    });
    expect(outOfOrder).toEqual([]);
  });

  it('has a SQL file for every entry', () => {
    const missing = journal.entries.filter((entry) => !existsSync(path.join(drizzleDir, `${entry.tag}.sql`))).map((entry) => entry.tag);
    expect(missing).toEqual([]);
  });

  it('lists every SQL file in the folder', () => {
    const listed = new Set(journal.entries.map((entry) => entry.tag));
    const unlisted = readdirSync(drizzleDir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.replace(/\.sql$/, ''))
      .filter((tag) => !listed.has(tag));
    expect(unlisted).toEqual([]);
  });
});
