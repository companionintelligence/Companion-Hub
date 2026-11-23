import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real folders and links: the suite's memfs mock is what the link walk must see through.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { firstLinkOnTheWay, parseComposeConfigBindMounts, segmentsInside } = await import('../bind-mount-guard');

describe('parseComposeConfigBindMounts', () => {
  it('reads Compose v2 long syntax and leaves out named volumes and tmpfs', () => {
    const config = [
      'name: app',
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - type: bind',
      '        source: /hub/app-data/store/app/data',
      '        target: /data',
      '        bind:',
      '          create_host_path: true',
      '      - type: bind',
      '        source: /hub/app-data/store/app/My Config',
      '        target: /etc/app',
      '        read_only: true',
      '      - type: volume',
      '        source: cache',
      '        target: /cache',
      '      - type: tmpfs',
      '        target: /tmp',
    ].join('\n');
    expect(parseComposeConfigBindMounts(config)).toEqual([
      { service: 'web', source: '/hub/app-data/store/app/data', readOnly: false },
      { service: 'web', source: '/hub/app-data/store/app/My Config', readOnly: true },
    ]);
  });

  it('reads the v1 short syntax, a Windows drive letter included', () => {
    const config = [
      'services:',
      '  db:',
      '    volumes:',
      '      - /hub/db:/var/lib/db:rw',
      '      - C:\\hub\\conf:/etc/conf:ro,z',
      '      - named:/data',
    ].join('\n');
    expect(parseComposeConfigBindMounts(config)).toEqual([
      { service: 'db', source: '/hub/db', readOnly: false },
      { service: 'db', source: 'C:\\hub\\conf', readOnly: true },
    ]);
  });

  it('returns nothing for a compose with no services', () => {
    expect(parseComposeConfigBindMounts('')).toEqual([]);
    expect(parseComposeConfigBindMounts('name: app\n')).toEqual([]);
  });
});

describe('segmentsInside', () => {
  it('gives the parts below the data folder, ignoring case and slashes', () => {
    expect(segmentsInside('/hub/app-data/s/app', '/hub/app-data/s/app/data/db')).toEqual(['data', 'db']);
    expect(segmentsInside('C:/Hub/app-data/s/app', 'c:\\hub\\app-data\\s\\app\\Data')).toEqual(['Data']);
    expect(segmentsInside('/hub/app-data/s/app', '/hub/app-data/s/app')).toEqual([]);
  });

  it('is null outside it, a sibling that only starts the same way included', () => {
    expect(segmentsInside('/hub/app-data/s/app', '/srv/media')).toBeNull();
    expect(segmentsInside('/hub/app-data/s/app', '/hub/app-data/s/app-two/data')).toBeNull();
  });
});

describe('firstLinkOnTheWay', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-guard-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a link at the mount itself and on the way to it', async () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.symlinkSync('/', path.join(root, 'data', 'cfg'));
    await expect(firstLinkOnTheWay(root, ['data', 'cfg'])).resolves.toBe('data/cfg');
    await expect(firstLinkOnTheWay(root, ['data', 'cfg', 'deeper'])).resolves.toBe('data/cfg');
  });

  it('finds a link to a file, as a single-file mount would follow', () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.symlinkSync('/etc/hostname', path.join(root, 'data', 'app.conf'));
    return expect(firstLinkOnTheWay(root, ['data', 'app.conf'])).resolves.toBe('data/app.conf');
  });

  it('is null for plain folders and files, and for parts not made yet', async () => {
    fs.mkdirSync(path.join(root, 'data', 'db'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'app.conf'), 'x');
    await expect(firstLinkOnTheWay(root, ['data', 'db'])).resolves.toBeNull();
    await expect(firstLinkOnTheWay(root, ['data', 'app.conf'])).resolves.toBeNull();
    await expect(firstLinkOnTheWay(root, ['data', 'new', 'folder'])).resolves.toBeNull();
  });
});
