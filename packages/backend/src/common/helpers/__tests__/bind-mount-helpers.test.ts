import fs from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quarantineStalePath,
  readTextFileIfExists,
  resetPosixPermissionSupportCache,
  supportsPosixPermissions,
  writeHealableTextFile,
} from '../bind-mount-helpers';

describe('bind-mount-helpers', () => {
  const tmpRoot = join(process.cwd(), '.tmp-bind-mount-helpers-test');

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes a new file in a writable directory', async () => {
    const filePath = join(tmpRoot, 'token');
    await writeHealableTextFile(filePath, 'test-token');
    expect(readTextFileIfExists(filePath)).toBe('test-token');
  });

  it('quarantines a read-only stale file and preserves content for recovery', async () => {
    const filePath = join(tmpRoot, 'hub.yml');
    fs.writeFileSync(filePath, 'stale: true\n', 'utf-8');
    fs.chmodSync(filePath, 0o400);
    vi.spyOn(fs.promises, 'chmod').mockImplementation(async (targetPath) => {
      if (String(targetPath) === filePath) {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
    });

    await writeHealableTextFile(filePath, 'http:\n  routers: {}\n');
    const names = fs.readdirSync(tmpRoot);
    expect(names.some((name) => /^hub\.yml\.stale-root-/.test(name))).toBe(true);
    expect(readTextFileIfExists(filePath)).toContain('routers');
  });

  it('quarantineStalePath preserves original file contents', () => {
    const filePath = join(tmpRoot, 'token');
    fs.writeFileSync(filePath, 'secret-token', 'utf-8');
    const quarantinePath = quarantineStalePath(filePath);
    expect(quarantinePath).toBeTruthy();
    if (!quarantinePath) return;
    expect(fs.readFileSync(quarantinePath, 'utf-8')).toBe('secret-token');
    expect(readTextFileIfExists(filePath)).toBeNull();
  });

  describe('supportsPosixPermissions', () => {
    // The mode the probe reads back is the whole signal, and it is exactly what varies by host
    // filesystem — so stat is stubbed rather than trusting the machine the suite happens to run on.
    // S_IFREG is included deliberately: a real stat returns 0o100640, not 0o640, so a stub without
    // the file-type bits would let the `& 0o777` mask be deleted with the suite still green — and
    // losing that mask reports "unsupported" on every Linux Hub, relocating every database.
    const stubObservedMode = (mode: number) =>
      vi.spyOn(fs.promises, 'stat').mockResolvedValue({ mode: 0o100000 | mode } as Awaited<ReturnType<typeof fs.promises.stat>>);

    beforeEach(() => {
      resetPosixPermissionSupportCache();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports supported when the requested mode sticks', async () => {
      stubObservedMode(0o640);

      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(true);
    });

    it('reports unsupported when the filesystem silently discards the chmod', async () => {
      // What a Windows-backed drvfs/9p mount does: chmod succeeds, mode stays 0777.
      stubObservedMode(0o777);

      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(false);
    });

    it('reports supported when a filesystem that was never measured cannot be probed', async () => {
      vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

      await expect(supportsPosixPermissions(join(tmpRoot, 'never-measured'))).resolves.toBe(true);
    });

    // The failure this guards: an app already redirected onto a named volume gets its compose
    // re-rendered with the bind mount restored, and postgres initdb's an empty directory while the
    // real database sits in a volume nothing references any more.
    it('keeps the last measured answer when a later probe cannot measure', async () => {
      stubObservedMode(0o777);
      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(false);

      vi.restoreAllMocks();
      resetPosixPermissionSupportCache();
      vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(false);
    });

    it('lets a fresh measurement overrule the recorded answer', async () => {
      stubObservedMode(0o777);
      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(false);

      vi.restoreAllMocks();
      resetPosixPermissionSupportCache();
      stubObservedMode(0o640);

      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(true);
    });

    it('never throws out of cleanup, which would abort the install that called it', async () => {
      stubObservedMode(0o640);
      // A throw from the finally block replaces the decided return value, so cleanup failing
      // must not escape — this is what a partially-stubbed fs looks like to the probe.
      vi.spyOn(fs.promises, 'unlink').mockImplementation(() => {
        throw new TypeError('unlink is not a function');
      });

      await expect(supportsPosixPermissions(tmpRoot)).resolves.toBe(true);
    });

    it('probes a directory only once', async () => {
      const stat = stubObservedMode(0o640);

      await supportsPosixPermissions(tmpRoot);
      await supportsPosixPermissions(tmpRoot);

      expect(stat).toHaveBeenCalledTimes(1);
    });

    it('gives concurrent probes distinct files so neither deletes the other mid-flight', async () => {
      // The probe files must really be created, or nothing can clobber anything and this asserts
      // only on strings the test itself recorded.
      const probeNames: string[] = [];
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (target, ...rest) => {
        const name = String(target).split(/[\\/]/).pop() ?? '';
        // The recorded-verdict file is written through here too; only probe files race.
        if (name.startsWith('.ci-hub-permission-probe-')) {
          probeNames.push(name);
        }
        // @ts-expect-error — forwarding the caller's own arguments through to the real implementation
        return realWriteFile(target, ...rest);
      });

      // Two directories, so the per-directory cache does not collapse this into a single probe.
      await Promise.all([supportsPosixPermissions(join(tmpRoot, 'a')), supportsPosixPermissions(join(tmpRoot, 'b'))]);

      expect(probeNames).toHaveLength(2);
      expect(new Set(probeNames).size).toBe(2);
      // Each probe removed its own file and nothing else's.
      for (const dir of ['a', 'b']) {
        expect(fs.readdirSync(join(tmpRoot, dir)).filter((name) => name.startsWith('.ci-hub-permission-probe-'))).toEqual([]);
      }
    });

    it('runs one probe for concurrent callers rather than one each', async () => {
      const stat = stubObservedMode(0o640);

      await Promise.all([supportsPosixPermissions(tmpRoot), supportsPosixPermissions(tmpRoot), supportsPosixPermissions(tmpRoot)]);

      expect(stat).toHaveBeenCalledTimes(1);
    });

    it('cleans up its probe file', async () => {
      stubObservedMode(0o640);

      await supportsPosixPermissions(tmpRoot);

      expect(fs.readdirSync(tmpRoot).filter((name) => name.startsWith('.ci-hub-permission-probe-'))).toEqual([]);
    });
  });
});
