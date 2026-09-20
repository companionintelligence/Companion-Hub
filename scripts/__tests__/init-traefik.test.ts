import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTraefik } from '../init-traefik';

/**
 * A fresh appliance data dir has no `state/traefik/`. Both `config/traefik.yml` and
 * `acme_storage.json` are FILE bind mounts in docker-compose.prod.yml, so if this script does not
 * write them under the same root compose reads (`ROOT_FOLDER_HOST`), traefik never starts. These
 * tests pin where the files land for the two ways `cihub up` roots an install.
 */
describe('initTraefik roots itself where compose will mount from', () => {
  const ENV_KEYS = ['ENV_FILE', 'ROOT_FOLDER_HOST', 'CI_HUB_STATE_PATH', 'STATE_PATH'] as const;
  const saved = new Map<string, string | undefined>();
  const cwd = process.cwd();
  let scratch: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    scratch = mkdtempSync(join(tmpdir(), 'cihub-init-traefik-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function expectTraefikState(root: string) {
    const traefikDir = join(root, 'state', 'traefik');
    expect(existsSync(join(traefikDir, 'config', 'traefik.yml'))).toBe(true);
    expect(existsSync(join(traefikDir, 'dynamic', 'dynamic.yml'))).toBe(true);
    expect(existsSync(join(traefikDir, 'tls'))).toBe(true);
    const acme = join(traefikDir, 'acme_storage.json');
    expect(readFileSync(acme, 'utf8')).toBe('{}');
    expect(statSync(acme).mode & 0o777).toBe(0o600);
  }

  it('appliance: writes under ROOT_FOLDER_HOST (the canonical data dir), not `.internal` under the cwd', async () => {
    // What startApplianceHub passes through runScript: ENV_FILE inside the data dir, ROOT_FOLDER_HOST
    // = the data dir, cwd = the data dir. The seeded env file names the same root.
    const dataDir = join(scratch, 'companion-hub');
    writeFileSync(join(scratch, 'placeholder'), '');
    process.chdir(scratch);
    const envFile = join(scratch, '.env.dev');
    writeFileSync(envFile, `ROOT_FOLDER_HOST=${dataDir}\n`);
    process.env.ENV_FILE = envFile;
    process.env.ROOT_FOLDER_HOST = dataDir;

    await initTraefik();

    expectTraefikState(dataDir);
    expect(existsSync(join(scratch, '.internal'))).toBe(false);
  });

  it('checkout: with no env-file root it still lands in `.internal` under the cwd, as it always has', async () => {
    process.chdir(scratch);
    process.env.ENV_FILE = join(scratch, 'does-not-exist.env');

    await initTraefik();

    expectTraefikState(join(scratch, '.internal'));
  });

  it('reads the root at call time, so a root set after import is honoured', async () => {
    // The module is imported once at CLI startup; runScript sets the overrides much later. A
    // module-level constant would have frozen `.internal` here.
    process.chdir(scratch);
    process.env.ENV_FILE = join(scratch, 'does-not-exist.env');
    const late = join(scratch, 'late-root');
    process.env.ROOT_FOLDER_HOST = late;

    await initTraefik();

    expectTraefikState(late);
  });
});
