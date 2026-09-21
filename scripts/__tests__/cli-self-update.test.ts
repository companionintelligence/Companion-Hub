/**
 * `cihub self-update` is the only code in this repo that overwrites the binary it is running from,
 * so the tests are mostly about what it REFUSES to do: a package manager's file, a Windows
 * executable it cannot replace, a download it could not identify.
 *
 * `installBinaryOverSelf` is exercised against real files in a temp directory with a fake probe.
 * Mocking the filesystem here would test the mock — the whole point is that a failed verification
 * leaves the original binary exactly where it was.
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installBinaryOverSelf, planSelfUpdate } from '../lib/cli-self-update.js';
import type { CliInstallChannel } from '../lib/cli-version-skew.js';

const standalone: CliInstallChannel = { kind: 'standalone', path: '/usr/local/bin/cihub' };
const withToken = { GH_TOKEN: 'ghp_x' } as NodeJS.ProcessEnv;

const plan = (over: Partial<Parameters<typeof planSelfUpdate>[0]> = {}) =>
  planSelfUpdate({ channel: standalone, platform: 'linux', arch: 'x64', env: withToken, ...over });

describe('planSelfUpdate refusals', () => {
  it('leaves a Homebrew or Scoop install to its package manager', () => {
    // Writing into a Cellar/app directory leaves the manifest claiming a version that is not on
    // disk, and the next `brew upgrade` silently reverts it.
    for (const channel of [
      { kind: 'homebrew' as const, path: '/opt/homebrew/Cellar/x/bin/cihub' },
      { kind: 'scoop' as const, path: 'C:/scoop/apps/x/cihub.exe' },
    ]) {
      const result = plan({ channel });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.fix.join(' ')).toMatch(/brew upgrade|scoop update/);
    }
  });

  it('leaves the copy that ships inside the desktop app to the desktop updater', () => {
    const result = plan({ channel: { kind: 'desktop', path: '/Applications/Companion Hub.app/Contents/Resources/cihub' } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.fix[0]).toContain('companion-hub update');
  });

  it('has nothing to replace in a source checkout', () => {
    const result = plan({ channel: { kind: 'source', path: '/usr/local/bin/node' } });
    expect(result.ok === false && result.why).toContain('source checkout');
  });

  it('refuses on Windows rather than half-writing a running exe', () => {
    const result = plan({ platform: 'win32', channel: { kind: 'standalone', path: 'C:/tools/cihub.exe' } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.why).toContain('running executable');
  });

  it('names the private repository as the reason a token is needed', () => {
    // A node with no token gets a bare 404 from the releases API, which reads like "no such
    // release" — the misdiagnosis that stalled a fifteen-node install on 2026-09-18.
    const result = plan({ env: {} });
    expect(result.ok === false && result.why).toContain('private');
    expect(result.ok === false && result.fix[0]).toContain('GH_TOKEN');
  });

  it('refuses a platform the release publishes no asset for', () => {
    const result = plan({ arch: 'riscv64' });
    expect(result.ok === false && result.why).toContain('riscv64');
  });
});

describe('planSelfUpdate target', () => {
  it('defaults to the release the stack runs, not the newest one', () => {
    // Pulling `latest` onto a node whose stack is pinned two releases back just inverts the skew.
    const result = plan({ stackVersion: '0.2.73' });
    expect(result).toMatchObject({ ok: true, version: '0.2.73', assetName: 'cihub-linux-x64' });
  });

  it('lets --to override the stack, including onto an older release', () => {
    expect(plan({ stackVersion: '0.2.73', requestedVersion: 'v0.2.70' })).toMatchObject({ ok: true, version: '0.2.70' });
  });

  it('asks for latest when the running stack names no release, and says that is why', () => {
    const result = plan({ stackVersion: null });
    expect(result).toMatchObject({ ok: true, version: 'latest' });
    expect(result.ok === true && result.reason).toContain('names no release to match');
  });

  it('picks the asset for the host it is running on, not just Linux', () => {
    expect(plan({ platform: 'darwin', arch: 'arm64' })).toMatchObject({ assetName: 'cihub-macos-arm64' });
  });
});

describe('installBinaryOverSelf', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function target(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cihub-self-'));
    dirs.push(dir);
    const file = join(dir, 'cihub');
    writeFileSync(file, 'OLD BINARY');
    chmodSync(file, 0o755);
    return file;
  }

  it('replaces the binary once the candidate runs and identifies itself', () => {
    const file = target();
    const result = installBinaryOverSelf({
      sourceBytes: Buffer.from('NEW BINARY'),
      targetPath: file,
      expectedVersion: '0.2.73',
      probe: () => ({ ok: true, stdout: 'cihub 0.2.73\n' }),
    });
    expect(result).toMatchObject({ ok: true, installedVersion: '0.2.73' });
    expect(readFileSync(file, 'utf-8')).toBe('NEW BINARY');
    // The staged copy is the thing most likely to be left behind, and it sits on $PATH.
    expect(readdirSync(join(file, '..'))).toEqual(['cihub']);
  });

  it('leaves the old binary in place when the download will not run here', () => {
    // A wrong-architecture asset exits 126, and installing it costs the operator their only cihub.
    const file = target();
    const result = installBinaryOverSelf({
      sourceBytes: Buffer.from('arm64 binary on an x64 box'),
      targetPath: file,
      probe: () => ({ ok: false, stdout: 'cannot execute binary file' }),
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('OLD BINARY');
    expect(readdirSync(join(file, '..'))).toEqual(['cihub']);
  });

  it('leaves the old binary in place when the asset reports a different version than asked for', () => {
    const file = target();
    const result = installBinaryOverSelf({
      sourceBytes: Buffer.from('NEW'),
      targetPath: file,
      expectedVersion: '0.2.73',
      probe: () => ({ ok: true, stdout: 'cihub 0.2.70\n' }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0.2.70');
    expect(readFileSync(file, 'utf-8')).toBe('OLD BINARY');
  });

  it('accepts a build that prints its commit beside the version', () => {
    const file = target();
    const result = installBinaryOverSelf({
      sourceBytes: Buffer.from('NEW'),
      targetPath: file,
      expectedVersion: '0.2.73',
      probe: () => ({ ok: true, stdout: 'cihub 0.2.73 (abc123def)\n' }),
    });
    expect(result).toMatchObject({ ok: true, installedVersion: '0.2.73' });
  });

  it('refuses a candidate that runs but prints nothing recognisable', () => {
    const file = target();
    const result = installBinaryOverSelf({
      sourceBytes: Buffer.from('<html>Not Found</html>'),
      targetPath: file,
      probe: () => ({ ok: true, stdout: '' }),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('OLD BINARY');
  });
});
