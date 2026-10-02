/**
 * `hubOperatorKeyShell`: which credential a fleet script presents to the Hub it runs beside.
 *
 * The regression this pins: after #1612 the Hub refuses the Portal device key (`ciHubApiKey`) as an
 * operator bearer once Portal has confirmed its push key — a read AND a write answer 401 — so a script
 * that read only that key reported `failed` on every current Hub while its tests, which fed it a device
 * key, stayed green. `hubLocalKey` must win whenever it exists; the device key is only the fallback for
 * a Hub that predates it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hubOperatorKeyShell } from '../lib/hub-operator-key.js';

const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p));
const node = process.execPath;

describe('hubOperatorKeyShell', () => {
  it('reads hubLocalKey before ciHubApiKey in both the container and the host-file lookups', () => {
    const script = hubOperatorKeyShell('k', '/srv/hub/state/settings.json').join('\n');
    expect(script).toContain('s.hubLocalKey||s.ciHubApiKey');
    expect(script.indexOf('"hubLocalKey"')).toBeGreaterThan(-1);
    expect(script.indexOf('"hubLocalKey"')).toBeLessThan(script.indexOf('"ciHubApiKey"'));
  });

  it('never prints the key', () => {
    expect(hubOperatorKeyShell('k', '/x').join('\n')).not.toMatch(/echo[^\n]*\$k\b/);
  });
});

describe.skipIf(!bash)('hubOperatorKeyShell (sandboxed)', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sandbox(settings: Record<string, unknown> | null) {
    const root = mkdtempSync(path.join(tmpdir(), 'cihub-opkey-'));
    sandboxes.push(root);
    const bin = path.join(root, 'bin');
    const state = path.join(root, 'state');
    mkdirSync(bin);
    mkdirSync(state);
    const file = path.join(state, 'settings.json');
    if (settings) writeFileSync(file, JSON.stringify(settings));
    // No container: the key must come from the host data dir.
    writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(bin, 'docker'), 0o755);
    return { root, file, bin };
  }

  const resolve = (s: ReturnType<typeof sandbox>) =>
    spawnSync(bash as string, ['-c', `${hubOperatorKeyShell('k', s.file).join('\n')}\nprintf '%s' "$k"`], {
      env: { PATH: `${s.bin}:/usr/bin:/bin`, HOME: '/tmp' },
      encoding: 'utf-8',
    }).stdout;

  it('prefers hubLocalKey when the file carries both', () => {
    expect(resolve(sandbox({ ciHubApiKey: 'device-key-1', hubLocalKey: 'local-key-2' }))).toBe('local-key-2');
  });

  it('falls back to the device key on a Hub that predates hubLocalKey', () => {
    expect(resolve(sandbox({ ciHubApiKey: 'device-key-1' }))).toBe('device-key-1');
  });

  it('resolves to nothing when neither exists, or the file is missing', () => {
    expect(resolve(sandbox({ unrelated: 'x' }))).toBe('');
    expect(resolve(sandbox(null))).toBe('');
  });

  it('handles a pretty-printed settings file', () => {
    const s = sandbox(null);
    writeFileSync(s.file, '{\n  "ciHubApiKey": "device-key-1",\n  "hubLocalKey": "local-key-2"\n}\n');
    expect(resolve(s)).toBe('local-key-2');
  });

  it("the container-side one-liner prefers hubLocalKey too (run with this process's node)", () => {
    const line = hubOperatorKeyShell('k', '/x').find((l) => l.includes('docker exec')) as string;
    const js = /node -e '([^']*)'/.exec(line)?.[1] as string;
    expect(js).toBeTruthy();
    const s = sandbox({ ciHubApiKey: 'device-key-1', hubLocalKey: 'local-key-2' });
    const run = (file: string) => spawnSync(node, ['-e', js.replace('/data/state/settings.json', file)], { encoding: 'utf-8' }).stdout;
    expect(run(s.file)).toBe('local-key-2');
    const old = sandbox({ ciHubApiKey: 'device-key-1' });
    expect(run(old.file)).toBe('device-key-1');
  });
});
