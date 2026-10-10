import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileSync = vi.fn();
const envFileVars = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('node:child_process', () => ({ spawnSync: () => ({ status: 1, stdout: '', stderr: '' }) }));

vi.mock('node:fs', () => ({
  existsSync: () => false,
  mkdirSync: vi.fn(),
  readFileSync: () => '',
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
}));

vi.mock('systeminformation', () => ({
  default: {
    mem: async () => ({ total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 }),
    cpu: async () => ({ cores: 8, manufacturer: 'Test', brand: 'CPU' }),
    fsSize: async () => [{ fs: 'C:', mount: 'C:', size: 512 * 1024 ** 3, available: 256 * 1024 ** 3 }],
  },
}));

vi.mock('../env-file', () => ({ parseEnvFile: () => envFileVars.value }));

const { initHostProbe } = await import('../init-host-probe');

/**
 * The desktop app's env file on Windows names the data dir in Docker's form. Read as a Windows path,
 * `/mnt/c/Users/...` is `C:\mnt\c\Users\...`, where `cihub up` left a host_metrics.json the Hub never
 * reads.
 */
describe('initHostProbe on a Windows install', () => {
  const ENV_KEYS = ['ENV_FILE', 'ROOT_FOLDER_HOST', 'CI_HUB_STATE_PATH', 'STATE_PATH'] as const;
  const saved = new Map<string, string | undefined>();
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    writeFileSync.mockReset();
    process.env.ENV_FILE = 'C:\\Users\\hub\\AppData\\Roaming\\companion-hub\\.env';
    envFileVars.value = { ROOT_FOLDER_HOST: '/mnt/c/Users/hub/AppData/Roaming/companion-hub' };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  it('writes host_metrics.json under the data dir the env file names, not under C:\\mnt', async () => {
    await initHostProbe();

    const written = String(writeFileSync.mock.calls[0]?.[0]);
    expect(written.startsWith('C:\\Users\\hub\\AppData\\Roaming\\companion-hub')).toBe(true);
  });
});
