import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real filesystem and the real `find`: the suite's memfs mock has no owners and cannot refuse a
// listing, which is how a sweep that failed on every start of a database app went unnoticed.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { execAsync } = await import('@/common/helpers/exec-helpers');
const { buildPermissionsCommand } = await import('../app-files-manager');

// root ignores permission bits and Windows has no `find` of this kind; on those the checks prove nothing.
const canEnforcePermissions = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

/*
 * Without root a test cannot make files that belong to another user, so it does the reverse: it
 * tells the sweep the Hub runs as a uid that is not the test's. The test's own files then stand
 * for the ones a database or a root container made. A folder at 700 is then one the Hub could not list,
 * as MariaDB's schema folders are to a Hub running as uid 1000.
 */
describe.skipIf(!canEnforcePermissions)('the permission sweep on a real tree', () => {
  let scratch: string;
  let appDataDir: string;
  let uid: number;

  const mode = async (relative: string) => ((await fs.promises.stat(path.join(appDataDir, relative))).mode & 0o777).toString(8);

  beforeEach(async () => {
    uid = process.getuid?.() ?? 0;
    scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sweep-'));
    appDataDir = path.join(scratch, 'app-data', 'store', 'kimai');
    for (const schema of ['kimai', 'mysql', 'performance_schema', 'sys']) {
      await fs.promises.mkdir(path.join(appDataDir, 'data', 'db', schema), { recursive: true });
      await fs.promises.writeFile(path.join(appDataDir, 'data', 'db', schema, 'table.ibd'), 'rows');
    }
    await fs.promises.writeFile(path.join(appDataDir, 'data', 'plugin.yaml'), 'plugin');
    await fs.promises.writeFile(path.join(appDataDir, 'app.env'), 'SECRET=1\n', { mode: 0o600 });
    for (const schema of ['kimai', 'mysql', 'performance_schema', 'sys']) {
      await fs.promises.chmod(path.join(appDataDir, 'data', 'db', schema), 0o700);
    }
    await fs.promises.chmod(path.join(appDataDir, 'data', 'plugin.yaml'), 0o644);
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  it('opens up what the Hub owns and keeps app.env private', async () => {
    const { stderr } = await execAsync(buildPermissionsCommand(appDataDir, [path.join(appDataDir, 'app.env')], uid));

    expect(stderr).toBe('');
    await expect(mode('data/plugin.yaml')).resolves.toBe('777');
    await expect(mode('data/db/mysql')).resolves.toBe('777');
    await expect(mode('app.env')).resolves.toBe('600');
  });

  it('leaves files of another user alone and does not walk into folders closed to the Hub, so it reports nothing', async () => {
    const { stderr } = await execAsync(buildPermissionsCommand(appDataDir, [path.join(appDataDir, 'app.env')], uid + 1));

    expect(stderr).toBe('');
    await expect(mode('data/plugin.yaml')).resolves.toBe('644');
    await expect(mode('data/db/mysql')).resolves.toBe('700');
  });

  /*
   * The test owns its 700 folders, so `find` could list them whether it pruned them or not. A folder
   * at 000 is one even its owner cannot list: the sweep for root walks into it and fails, as it did
   * into MariaDB's, and the sweep for a plain-user Hub must not.
   */
  describe('with a folder the sweep cannot list', () => {
    const locked = () => path.join(appDataDir, 'data', 'db', 'sys');

    beforeEach(async () => {
      await fs.promises.chmod(locked(), 0o000);
    });

    afterEach(async () => {
      await fs.promises.chmod(locked(), 0o700);
    });

    it('does not walk into it when it belongs to another user', async () => {
      const excluded = [path.join(appDataDir, 'app.env')];

      await expect(execAsync(buildPermissionsCommand(appDataDir, excluded))).resolves.toMatchObject({
        stderr: expect.stringContaining('Permission denied'),
      });
      await expect(execAsync(buildPermissionsCommand(appDataDir, excluded, uid + 1))).resolves.toMatchObject({ stderr: '' });
    });
  });

  // chmod follows a link named on its command line: a link left in the data made its target world-writable.
  it.each([
    ['a Hub running as a plain user', () => uid],
    ['a Hub running as root', () => undefined],
  ])('does not follow a link out of the data folder, for %s', async (_label, hubUid) => {
    const outside = path.join(scratch, 'settings.json');
    await fs.promises.writeFile(outside, '{"hubLocalKey":"x"}', { mode: 0o600 });
    await fs.promises.symlink(outside, path.join(appDataDir, 'data', 'settings-link'));

    const { stderr } = await execAsync(buildPermissionsCommand(appDataDir, [path.join(appDataDir, 'app.env')], hubUid()));

    expect(stderr).toBe('');
    expect(((await fs.promises.stat(outside)).mode & 0o777).toString(8)).toBe('600');
    await expect(mode('data/plugin.yaml')).resolves.toBe('777');
  });
});
