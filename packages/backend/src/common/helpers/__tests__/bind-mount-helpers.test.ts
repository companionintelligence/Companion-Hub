import fs from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  quarantineStalePath,
  readTextFileIfExists,
  removeLeftoverTemporaries,
  resetPosixPermissionSupportCache,
  supportsPosixPermissions,
  writeHealableTextFile,
} from '../bind-mount-helpers';

describe('bind-mount-helpers', () => {
  const tmpRoot = join(process.cwd(), '.tmp-bind-mount-helpers-test');

  beforeEach(() => {
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  // Traefik reads its dynamic folder whenever a file in it changes. A write that empties the file
  // before filling it let Traefik read apps.yml with no routes in it during an app restart (#2541).
  describe('replacing a file someone else reads', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Records what a reader sees while each write runs, the way the OS shows a file opened for writing: empty first. */
    function watchReads(filePath: string): string[] {
      const seen: string[] = [];
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (target, ...rest) => {
        if (String(target) === filePath) {
          fs.writeFileSync(filePath, '');
        }
        seen.push(fs.readFileSync(filePath, 'utf-8'));
        // @ts-expect-error forwarding the caller's own arguments to the real implementation
        return realWriteFile(target, ...rest);
      });
      return seen;
    }

    it('never shows a reader an empty file while it writes', async () => {
      const filePath = join(tmpRoot, 'apps.yml');
      fs.writeFileSync(filePath, 'http:\n  routers:\n    old: {}\n', 'utf-8');
      const seen = watchReads(filePath);

      await writeHealableTextFile(filePath, 'http:\n  routers:\n    new: {}\n');

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((content) => content.includes('old'))).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('new');
    });

    it('leaves no file behind that Traefik would load', async () => {
      const dir = join(tmpRoot, 'dynamic');
      fs.mkdirSync(dir, { recursive: true });
      const names: string[] = [];
      const realRename = fs.promises.rename.bind(fs.promises);
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        names.push(...fs.readdirSync(dir).map(String));
        return realRename(from, to);
      });

      await writeHealableTextFile(join(dir, 'apps.yml'), 'http: {}\n');

      // While the new content waits beside the file, Traefik's directory read skips it.
      expect(names.filter((name) => name !== 'apps.yml').every((name) => !/\.(ya?ml|toml)$/.test(name))).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(['apps.yml']);
    });

    it('writes in place where the folder refuses the rename and cleans up', async () => {
      const filePath = join(tmpRoot, 'token');
      fs.writeFileSync(filePath, 'old-token', 'utf-8');
      vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

      await writeHealableTextFile(filePath, 'new-token');

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new-token');
      expect(fs.readdirSync(tmpRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('leaves the folder mode alone when only the rename is refused', async () => {
      const filePath = join(tmpRoot, 'token');
      fs.writeFileSync(filePath, 'old-token', 'utf-8');
      vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      const chmod = vi.spyOn(fs.promises, 'chmod');

      await writeHealableTextFile(filePath, 'new-token');

      expect(chmod).not.toHaveBeenCalledWith(tmpRoot, 0o777);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new-token');
    });

    it('passes on a failure that is not a refusal and keeps the old content', async () => {
      const filePath = join(tmpRoot, 'apps.yml');
      fs.writeFileSync(filePath, 'old', 'utf-8');
      vi.spyOn(fs.promises, 'rename').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

      await expect(writeHealableTextFile(filePath, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('old');
      expect(fs.readdirSync(tmpRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('removes the copy a killed write left beside the token', async () => {
      const dir = join(tmpRoot, 'tunnel');
      fs.mkdirSync(dir, { recursive: true });
      const leftover = `.token.7-${Date.now() - 120_000}-1.tmp`;
      const someoneElses = '.token.notes.tmp';
      fs.writeFileSync(join(dir, leftover), 'old-secret');
      fs.writeFileSync(join(dir, someoneElses), 'keep');

      await writeHealableTextFile(join(dir, 'token'), 'new-token');

      expect(fs.readdirSync(dir).sort()).toEqual([someoneElses, 'token'].sort());
    });

    it('removes a fresh leftover when asked to clear everything', async () => {
      const dir = join(tmpRoot, 'tunnel');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, `.token.7-${Date.now()}-1.tmp`), 'secret');

      await removeLeftoverTemporaries(join(dir, 'token'), 0);

      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('writes through a symlinked file instead of replacing the link', async () => {
      const realPath = join(tmpRoot, 'real-token');
      const linkPath = join(tmpRoot, 'token');
      fs.writeFileSync(realPath, 'old-token', 'utf-8');
      fs.symlinkSync(realPath, linkPath);

      await writeHealableTextFile(linkPath, 'new-token');

      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(realPath, 'utf-8')).toBe('new-token');
    });

    it('finishes two writes to one file in the order they were asked for', async () => {
      const filePath = join(tmpRoot, 'apps.yml');
      fs.writeFileSync(filePath, 'old', 'utf-8');
      const realRename = fs.promises.rename.bind(fs.promises);
      let renames = 0;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        renames += 1;
        // The first write is the slow one; without the queue the second would land first.
        if (renames === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        return realRename(from, to);
      });

      await Promise.all([writeHealableTextFile(filePath, 'first'), writeHealableTextFile(filePath, 'second')]);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('second');
    });
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
