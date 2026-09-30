import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// File modes are the whole point here, and the suite's memfs mock neither applies a umask nor has
// owners, so these run against a real temp directory.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, default: actual };
});

import {
  PRIVATE_STATE_FILE_MODE,
  type StateFileLog,
  ensureSettingsJsonReady,
  restrictStateFileMode,
  writeResolvedEnvFile,
  writeSettingsJsonFile,
} from '../env-helpers';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'hub-state-modes-'));
  dirs.push(root);
  const dir = join(root, 'state');
  fs.mkdirSync(dir);
  return dir;
}

function existingFile(dir: string, name: string, mode: number, content = '{}'): string {
  const filePath = join(dir, name);
  fs.writeFileSync(filePath, content);
  // chmod, not writeFile's mode: that one is masked by the umask, and 0666 is the point.
  fs.chmodSync(filePath, mode);
  return filePath;
}

const modeOf = (filePath: string) => fs.statSync(filePath).mode & 0o777;

function recordingLog(): StateFileLog & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return { infos, warns, info: (message) => infos.push(message), warn: (message) => warns.push(message) };
}

describe('settings.json mode', () => {
  it('is owner read/write only', () => {
    expect(PRIVATE_STATE_FILE_MODE).toBe(0o600);
  });

  it('creates a missing settings.json owner-only', async () => {
    const settingsPath = join(stateDir(), 'settings.json');

    await ensureSettingsJsonReady(settingsPath, recordingLog());

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{}');
    expect(modeOf(settingsPath)).toBe(0o600);
  });

  it('restricts an existing world-writable settings.json when it is written, which writeFile alone never did', async () => {
    // core-2: 0666, holding hubLocalKey, ciHubApiKey and ciHubMoveKey.
    const settingsPath = existingFile(stateDir(), 'settings.json', 0o666);
    const log = recordingLog();

    await writeSettingsJsonFile(settingsPath, '{"hubLocalKey":"k"}', log);

    expect(modeOf(settingsPath)).toBe(0o600);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"hubLocalKey":"k"}');
    expect(log.infos).toEqual([expect.stringContaining('from 0666 to 0600')]);
    expect(log.warns).toEqual([]);
  });

  it('restricts an existing world-readable settings.json at boot, before anything is written', async () => {
    const settingsPath = existingFile(stateDir(), 'settings.json', 0o644);

    await ensureSettingsJsonReady(settingsPath, recordingLog());

    expect(modeOf(settingsPath)).toBe(0o600);
  });

  it('leaves an already-private settings.json alone and says nothing', async () => {
    const settingsPath = existingFile(stateDir(), 'settings.json', 0o600);
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const log = recordingLog();

    await ensureSettingsJsonReady(settingsPath, log);

    expect(modeOf(settingsPath)).toBe(0o600);
    expect(chmod).not.toHaveBeenCalledWith(settingsPath, expect.anything());
    expect(log.infos).toEqual([]);
  });

  it('never opens the state directory to other users while repairing access', async () => {
    const dir = stateDir();
    const settingsPath = existingFile(dir, 'settings.json', 0o600);
    // Force the EACCES repair path, the one that used to chmod the directory 0777.
    vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    await ensureSettingsJsonReady(settingsPath, recordingLog());

    expect(modeOf(dir) & 0o002).toBe(0);
    expect(modeOf(settingsPath)).toBe(0o600);
  });
});

describe('restrictStateFileMode', () => {
  it('only ever clears bits: a stricter mode than 0600 is kept', async () => {
    const dir = stateDir();
    const readOnly = existingFile(dir, 'seed', 0o400, 'a'.repeat(64));
    const log = recordingLog();

    await restrictStateFileMode(readOnly, log);

    expect(modeOf(readOnly)).toBe(0o400);
    expect(log.infos).toEqual([]);
    expect(log.warns).toEqual([]);
  });

  it('clears group and other bits without touching the owner bits it finds', async () => {
    const dir = stateDir();
    const groupReadable = existingFile(dir, 'seed', 0o640, 'a'.repeat(64));
    const ownerReadOnlyWorldWritable = existingFile(dir, 'settings.json', 0o422);

    await restrictStateFileMode(groupReadable, recordingLog());
    await restrictStateFileMode(ownerReadOnlyWorldWritable, recordingLog());

    expect(modeOf(groupReadable)).toBe(0o600);
    // 0422 & 0600 = 0400: restricting must not hand the owner a write bit it did not have.
    expect(modeOf(ownerReadOnlyWorldWritable)).toBe(0o400);
  });

  it('is a no-op for a file that does not exist yet', async () => {
    const log = recordingLog();

    await expect(restrictStateFileMode(join(stateDir(), 'seed'), log)).resolves.toBeUndefined();

    expect(log.warns).toEqual([]);
  });

  it('logs a chmod failure once and does not throw, so a Hub that does not own the file still boots', async () => {
    const settingsPath = existingFile(stateDir(), 'settings.json', 0o666);
    const realChmod = fs.promises.chmod.bind(fs.promises);
    vi.spyOn(fs.promises, 'chmod').mockImplementation(async (target, mode) => {
      if (String(target) === settingsPath) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return realChmod(target, mode);
    });
    const log = recordingLog();

    await expect(ensureSettingsJsonReady(settingsPath, log)).resolves.toBeUndefined();
    await expect(writeSettingsJsonFile(settingsPath, '{"themeColor":"blue"}', log)).resolves.toBeUndefined();

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"themeColor":"blue"}');
    expect(modeOf(settingsPath)).toBe(0o666);
    // Once per file per process: a settings write every few seconds must not repeat it.
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain(settingsPath);
    expect(log.warns[0]).toContain('EPERM');
    // Someone else owns it, so chmod alone would lock this Hub out of its own settings: the advice
    // gives it to the Hub first.
    const uid = (process.getuid as () => number)();
    const owner = uid === 0 ? '<hub-uid>:<hub-gid>' : `${uid}:${(process.getgid as () => number)()}`;
    expect(log.warns[0]).toContain(
      `sudo chown ${owner} "$ROOT_FOLDER_HOST/state/settings.json" && sudo chmod 600 "$ROOT_FOLDER_HOST/state/settings.json"`,
    );
    expect(log.infos).toEqual([]);
  });

  it('warns rather than reporting success when the mount accepts chmod and changes nothing, once for the directory', async () => {
    const dir = stateDir();
    const settingsPath = existingFile(dir, 'settings.json', 0o666);
    const seedPath = existingFile(dir, 'seed', 0o666, 'a'.repeat(64));
    vi.spyOn(fs.promises, 'chmod').mockResolvedValue(undefined);
    const log = recordingLog();

    await restrictStateFileMode(settingsPath, log);
    await restrictStateFileMode(seedPath, log);

    expect(log.infos).toEqual([]);
    // A fact about the mount, not the file: one line, not one per credential file per boot.
    expect(log.warns).toEqual([expect.stringContaining('ignores chmod: settings.json stays 0666')]);
  });
});

describe('.env.resolved mode', () => {
  it('writes the resolved secrets owner-only, replacing a world-readable copy', async () => {
    const resolvedPath = existingFile(stateDir(), '.env.resolved', 0o644, 'JWT_SECRET=old\n');

    const wrote = await writeResolvedEnvFile(resolvedPath, 'JWT_SECRET=new\n', recordingLog());

    expect(wrote).toBe(true);
    expect(fs.readFileSync(resolvedPath, 'utf8')).toBe('JWT_SECRET=new\n');
    expect(modeOf(resolvedPath)).toBe(0o600);
  });

  it('restricts a copy it could not unlink before writing the secrets into it', async () => {
    const resolvedPath = existingFile(stateDir(), '.env.resolved', 0o666, 'JWT_SECRET=old\n');
    vi.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    const wrote = await writeResolvedEnvFile(resolvedPath, 'JWT_SECRET=new\n', recordingLog());

    expect(wrote).toBe(true);
    expect(fs.readFileSync(resolvedPath, 'utf8')).toBe('JWT_SECRET=new\n');
    expect(modeOf(resolvedPath)).toBe(0o600);
  });
});
