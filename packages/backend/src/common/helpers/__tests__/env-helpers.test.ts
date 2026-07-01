import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs
vi.mock('node:fs', () => {
  const existsSync = vi.fn();
  const promises = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: { existsSync, promises, constants: { R_OK: 4, W_OK: 2 } },
    existsSync,
    promises,
    constants: { R_OK: 4, W_OK: 2 },
  };
});

vi.mock('dotenv', () => {
  const config = vi.fn();
  return { default: { config }, config };
});

vi.mock('@/modules/env/env.utils', () => {
  class MockEnvUtils {
    envStringToMap(str: string) {
      const map = new Map<string, string>();
      for (const line of str.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...rest] = trimmed.split('=');
        if (key && rest.length) map.set(key.trim(), rest.join('=').trim());
      }
      return map;
    }
    envMapToString(map: Map<string, string>) {
      return Array.from(map)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    }
    deriveEntropy() {
      return 'mock-jwt-secret';
    }
  }
  return { EnvUtils: MockEnvUtils };
});

import fs from 'node:fs';
import dotenv from 'dotenv';
import { generateSystemEnvFile, resolveRabbitmqPassword, writeResolvedEnvFile, ensureSettingsJsonReady } from '../env-helpers';

const mockedFs = vi.mocked(fs);
const savedEnv: Record<string, string | undefined> = {};

describe('env-helpers — resolve() priority chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Save and set required env vars
    for (const key of ['ROOT_FOLDER_HOST', 'CI_CLOUD_URL', 'DOMAIN', 'GUEST_DASHBOARD', 'DEMO_MODE', 'JWT_SECRET', 'MCP_API_KEY']) {
      savedEnv[key] = process.env[key];
    }
    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';

    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function setupMocks(opts: { settingsJson?: Record<string, any>; dataEnv?: string }) {
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return JSON.stringify(opts.settingsJson || {});
      if (p.includes('.env')) return opts.dataEnv || '';
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  }

  it('MUST return process.env value when set, ignoring all other sources', async () => {
    process.env.DOMAIN = 'from-env';
    setupMocks({ dataEnv: 'DOMAIN=from-data' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('DOMAIN')).toBe('from-env');
  });

  it('MUST return data .env value when process.env is not set', async () => {
    delete process.env.DOMAIN;
    setupMocks({ dataEnv: 'DOMAIN=from-data' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('DOMAIN')).toBe('from-data');
  });

  it('MUST return fallback when no other source has the value', async () => {
    delete process.env.DOMAIN;
    setupMocks({ dataEnv: '' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('DOMAIN')).toBe('companionintelligence.com');
  });

  it('MUST have process.env win over settings.json for GUEST_DASHBOARD', async () => {
    process.env.GUEST_DASHBOARD = 'true';
    setupMocks({ settingsJson: { guestDashboard: false } });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('GUEST_DASHBOARD')).toBe('true');
  });

  it('boolStr() MUST convert settings boolean to string via DEMO_MODE', async () => {
    delete process.env.DEMO_MODE;
    setupMocks({ settingsJson: { demoMode: true } });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('DEMO_MODE')).toBe('true');
  });

  it('MUST call dotenv.config with override: false', async () => {
    setupMocks({});
    await generateSystemEnvFile();
    expect(dotenv.config).toHaveBeenCalledWith(expect.objectContaining({ override: false }));
  });

  it('MUST treat empty string in process.env as unset (fall through)', async () => {
    process.env.DOMAIN = '';
    setupMocks({ dataEnv: 'DOMAIN=from-data' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('DOMAIN')).toBe('from-data');
  });

  it('MUST return settingsVal when process.env is not set but settings.json has value', async () => {
    delete process.env.GUEST_DASHBOARD;
    setupMocks({ settingsJson: { guestDashboard: true } });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('GUEST_DASHBOARD')).toBe('true');
  });

  it('MUST keep process.env JWT_SECRET when set, even if data .env differs', async () => {
    process.env.JWT_SECRET = 'runtime-jwt-secret';
    setupMocks({ dataEnv: 'JWT_SECRET=from-data' });
    await generateSystemEnvFile();
    expect(process.env.JWT_SECRET).toBe('runtime-jwt-secret');
  });

  it('MUST keep process.env MCP_API_KEY when set, even if data .env differs', async () => {
    process.env.MCP_API_KEY = 'runtime-mcp-key';
    setupMocks({ dataEnv: 'MCP_API_KEY=from-data' });
    await generateSystemEnvFile();
    expect(process.env.MCP_API_KEY).toBe('runtime-mcp-key');
  });

  it('MUST put runtime JWT_SECRET in envMap via resolve()', async () => {
    process.env.JWT_SECRET = 'runtime-jwt-secret';
    setupMocks({ dataEnv: 'JWT_SECRET=from-data' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('JWT_SECRET')).toBe('runtime-jwt-secret');
  });

  it('MUST complete bootstrap when state/.env.resolved cannot be written (EACCES)', async () => {
    setupMocks({});
    const target = '/tmp/ci-hub-env-test/state/.env.resolved';
    (mockedFs.promises.writeFile as any).mockImplementation(async (filePath: string) => {
      if (String(filePath).endsWith('.env.resolved')) {
        const error = new Error('EACCES') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
    });

    const envMap = await generateSystemEnvFile();
    expect(envMap.get('ROOT_FOLDER_HOST')).toBe('/home/user/ci-os-hub');
    expect(process.env.ROOT_FOLDER_HOST).toBe('/home/user/ci-os-hub');
    expect(mockedFs.promises.writeFile).toHaveBeenCalled();
    void target;
  });

  it.each([
    ['C:/foo/bar', 'C:/foo/bar'],
    ['C:\\foo\\bar', 'C:\\foo\\bar'],
    ['\\\\server\\share\\folder', '\\\\server\\share\\folder'],
    ['/home/user/ci-os-hub', '/home/user/ci-os-hub'],
  ])('accepts absolute host ROOT_FOLDER_HOST (%s)', async (input, expected) => {
    process.env.ROOT_FOLDER_HOST = input;
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('ROOT_FOLDER_HOST')).toBe(expected);
  });
});

describe('env-helpers — RABBITMQ_PASSWORD fail-closed in production', () => {
  const rabbitSavedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ['ROOT_FOLDER_HOST', 'CI_CLOUD_URL', 'NODE_ENV', 'RABBITMQ_PASSWORD']) {
      rabbitSavedEnv[key] = process.env[key];
    }
    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
    mockedFs.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(rabbitSavedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function setupMocks(opts: { settingsJson?: Record<string, any>; dataEnv?: string }) {
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return JSON.stringify(opts.settingsJson || {});
      if (p.includes('.env')) return opts.dataEnv || '';
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  }

  it('MUST NOT emit the weak default password in production when unset (fail closed)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RABBITMQ_PASSWORD;
    setupMocks({ dataEnv: '' });
    await expect(generateSystemEnvFile()).rejects.toThrow(/RABBITMQ_PASSWORD is not set/);
  });

  it('MUST NOT invent the weak default, but tolerates an explicit admin in production (compose still ships it)', async () => {
    // The shipped prod compose hardcodes RABBITMQ_PASSWORD=admin on both the
    // broker and the Hub, so hard-failing here would break boot. We keep the
    // explicit value (broker match) rather than silently inventing it.
    process.env.NODE_ENV = 'production';
    process.env.RABBITMQ_PASSWORD = 'admin';
    setupMocks({ dataEnv: '' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('RABBITMQ_PASSWORD')).toBe('admin');
  });

  it('MUST expose the fail-closed + warning policy via resolveRabbitmqPassword()', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.RABBITMQ_PASSWORD;
    try {
      process.env.NODE_ENV = 'production';
      // Unset in production → throw (no silent weak fallback)
      expect(() => resolveRabbitmqPassword(new Map())).toThrow(/RABBITMQ_PASSWORD is not set/);
      // Explicit weak default in production → returned but warned
      const weak = resolveRabbitmqPassword(new Map([['RABBITMQ_PASSWORD', 'admin']]));
      expect(weak.password).toBe('admin');
      expect(weak.warning).toMatch(/weak default/i);
      // Strong explicit value in production → no warning
      const strong = resolveRabbitmqPassword(new Map([['RABBITMQ_PASSWORD', 'strong-secret']]));
      expect(strong.password).toBe('strong-secret');
      expect(strong.warning).toBeUndefined();
      // Non-production → dev default, no warning
      process.env.NODE_ENV = 'development';
      const dev = resolveRabbitmqPassword(new Map());
      expect(dev.password).toBe('admin');
      expect(dev.warning).toBeUndefined();
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('MUST accept a strong explicit password in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RABBITMQ_PASSWORD = 'a-strong-unique-secret';
    setupMocks({ dataEnv: '' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('RABBITMQ_PASSWORD')).toBe('a-strong-unique-secret');
  });

  it('MUST honor an explicit production password from data .env', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RABBITMQ_PASSWORD;
    setupMocks({ dataEnv: 'RABBITMQ_PASSWORD=from-data-secret' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('RABBITMQ_PASSWORD')).toBe('from-data-secret');
  });

  it('MUST keep the fixed dev default outside production (local dev / e2e)', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.RABBITMQ_PASSWORD;
    setupMocks({ dataEnv: '' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('RABBITMQ_PASSWORD')).toBe('admin');
  });
});

describe('writeResolvedEnvFile', () => {
  it('returns false when the target path is not writable', async () => {
    (mockedFs.promises.writeFile as any).mockImplementation(async () => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    const wrote = await writeResolvedEnvFile('/data/state/.env.resolved', 'KEY=value\n');
    expect(wrote).toBe(false);
  });
});

describe('ensureSettingsJsonReady', () => {
  beforeEach(() => {
    (mockedFs.promises.writeFile as any).mockResolvedValue(undefined);
    (mockedFs.promises.access as any).mockResolvedValue(undefined);
  });

  it('creates settings.json when missing', async () => {
    mockedFs.existsSync.mockImplementation((p) => !String(p).includes('settings.json'));
    await ensureSettingsJsonReady('/data/state/settings.json');
    expect(mockedFs.promises.writeFile).toHaveBeenCalledWith('/data/state/settings.json', '{}', {
      encoding: 'utf8',
      mode: 0o666,
    });
  });

  it('retries chmod when settings.json is not writable', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.promises.access as any).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' })).mockResolvedValue(undefined);

    await ensureSettingsJsonReady('/data/state/settings.json');

    expect(mockedFs.promises.chmod).toHaveBeenCalledWith('/data/state', 0o777);
    expect(mockedFs.promises.chmod).toHaveBeenCalledWith('/data/state/settings.json', 0o666);
  });
});
