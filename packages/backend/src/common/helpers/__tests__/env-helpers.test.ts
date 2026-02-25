import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs
vi.mock('node:fs', () => {
  const existsSync = vi.fn();
  const promises = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
  };
  return {
    default: { existsSync, promises },
    existsSync,
    promises,
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
import { generateSystemEnvFile } from '../env-helpers';

const mockedFs = vi.mocked(fs);
const savedEnv: Record<string, string | undefined> = {};

describe('env-helpers — resolve() priority chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Save and set required env vars
    for (const key of ['ROOT_FOLDER_HOST', 'CI_CLOUD_URL', 'DOMAIN', 'GUEST_DASHBOARD', 'DEMO_MODE']) {
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
    expect(envMap.get('DOMAIN')).toBe('example.com');
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
});
