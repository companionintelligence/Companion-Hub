import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real folders, links and renames: the suite's memfs mock is not what the moves act on.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { applyAppDataMoves, AppDataMoveError } = await import('../app-data-moves');

/** Writes `files` (path → content) under `root`. */
function plant(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

/** Every file under `root`, as sorted relative paths. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

describe('applyAppDataMoves', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-moves-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (moves: { from: string; to: string }[], keepSources: string[] = []) =>
    applyAppDataMoves({ appName: 'app', appDataDir: root, moves, keepSources });

  it("moves a folder's contents into a folder inside it, leaving the new version's other mounts", async () => {
    // The countly shape: `data` was the app's own mount, with Mongo's folder inside it.
    plant(root, { 'app.env': 'K=V', 'data/countly.json': '{}', 'data/plugins/a.js': 'x', 'data/mongo/db.wt': 'db' });
    fs.mkdirSync(path.join(root, 'data/app')); // made ahead by the Hub, empty

    const moved = await run([{ from: 'data', to: 'data/app' }], ['data/app', 'data/mongo']);

    expect(moved).toEqual(['data/countly.json → data/app/countly.json', 'data/plugins → data/app/plugins']);
    expect(tree(root)).toEqual(['app.env', 'data/app/countly.json', 'data/app/plugins/a.js', 'data/mongo/db.wt']);
  });

  it('does nothing the second time', async () => {
    plant(root, { 'data/state.json': '{}', 'data/linuxbrew/bin/brew': 'b' });
    const moves = [{ from: 'data', to: 'data/app' }];
    await run(moves, ['data/app', 'data/linuxbrew']);
    expect(await run(moves, ['data/app', 'data/linuxbrew'])).toEqual([]);
    expect(tree(root)).toEqual(['data/app/state.json', 'data/linuxbrew/bin/brew']);
  });

  it('renames a folder, and treats an empty one in its place as free', async () => {
    plant(root, { 'data/inventree/data/static/app.css': 'c', 'data/inventree/data/config.yaml': 'y' });
    fs.mkdirSync(path.join(root, 'data/inventree/static'), { recursive: true });

    expect(await run([{ from: 'data/inventree/data/static', to: 'data/inventree/static' }])).toEqual([
      'data/inventree/data/static → data/inventree/static',
    ]);
    expect(tree(root)).toEqual(['data/inventree/data/config.yaml', 'data/inventree/static/app.css']);
  });

  it('moves a single file to a folder that does not exist yet', async () => {
    plant(root, { 'data/config/nats_server.conf': 'listen' });
    await run([{ from: 'data/config/nats_server.conf', to: 'data/nats/nats_server.conf' }]);
    expect(tree(root)).toEqual(['data/nats/nats_server.conf']);
  });

  it('leaves an empty old folder out of the way rather than refusing', async () => {
    fs.mkdirSync(path.join(root, 'data/old'), { recursive: true });
    plant(root, { 'data/new/x': '1' });
    expect(await run([{ from: 'data/old', to: 'data/new' }])).toEqual([]);
    expect(fs.existsSync(path.join(root, 'data/old'))).toBe(false);
    expect(tree(root)).toEqual(['data/new/x']);
  });

  it('refuses to overwrite: both places holding files stops the move and names them', async () => {
    plant(root, { 'data/postgres/PG_VERSION': '17', 'data/db/PG_VERSION': '18' });
    await expect(run([{ from: 'data/postgres', to: 'data/db' }])).rejects.toThrow(AppDataMoveError);
    await expect(run([{ from: 'data/postgres', to: 'data/db' }])).rejects.toThrow(/"data\/postgres" to "data\/db".*both places hold files/);
    expect(tree(root)).toEqual(['data/db/PG_VERSION', 'data/postgres/PG_VERSION']);
  });

  it('from the data folder itself, leaves app.env, backups and the mounts, and runs steps in order', async () => {
    // The slskd shape: its /app was the whole folder, and its own data/ was the Hub's data/.
    plant(root, {
      'app.env': 'K=V',
      'backups/b.tar': 'b',
      'slskd.yml': 'cfg',
      'logs/a.log': 'l',
      'data/slskd.db': 'db',
      'downloads/song.flac': 's',
    });
    const moved = await run(
      [
        { from: '.', to: 'data/app' },
        { from: 'data', to: 'data/app/data' },
      ],
      ['data/app', 'downloads', 'incomplete', 'shared'],
    );
    expect(moved).toEqual(['logs → data/app/logs', 'slskd.yml → data/app/slskd.yml', 'data/slskd.db → data/app/data/slskd.db']);
    expect(tree(root)).toEqual([
      'app.env',
      'backups/b.tar',
      'data/app/data/slskd.db',
      'data/app/logs/a.log',
      'data/app/slskd.yml',
      'downloads/song.flac',
    ]);
  });

  it('refuses a move whose path runs through a symbolic link', async () => {
    fs.mkdirSync(path.join(root, 'data'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'data-moves-elsewhere-'));
    try {
      fs.symlinkSync(elsewhere, path.join(root, 'data', 'db'));
      await expect(run([{ from: 'data/db', to: 'data/database' }])).rejects.toThrow(/"data\/db" in its data folder is a symbolic link/);
      await expect(run([{ from: 'data/x', to: 'data/db/x' }])).rejects.toThrow(/symbolic link/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('skips a step whose old place is not there, as on a fresh install', async () => {
    plant(root, { 'data/app/ci-wrapper.sh': '#!/bin/sh' });
    expect(
      await run(
        [
          { from: 'data', to: 'data/app' },
          { from: 'data/gone', to: 'data/here' },
        ],
        ['data/app'],
      ),
    ).toEqual([]);
    expect(tree(root)).toEqual(['data/app/ci-wrapper.sh']);
  });
});
