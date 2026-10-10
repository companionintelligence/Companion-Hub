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
    unlink: vi.fn().mockResolvedValue(undefined),
    // Already private, so restrictStateFileMode has nothing to do here. Its behaviour against real
    // modes is covered in env-helpers.file-modes.test.ts, on a real filesystem.
    stat: vi.fn().mockResolvedValue({ mode: 0o100600 }),
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
    // Mirrors the real EnvUtils.sanitizeEnvValue. Keep it faithful: a mock that never
    // touched the value is why an undefined env value reached production undetected.
    envMapToString(map: Map<string, string>) {
      return Array.from(map)
        .map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`)
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
import { generateSystemEnvFile, resolveHubDomain, resolveRabbitmqPassword, writeResolvedEnvFile, ensureSettingsJsonReady } from '../env-helpers';

const mockedFs = vi.mocked(fs);
const savedEnv: Record<string, string | undefined> = {};

describe('env-helpers — resolve() priority chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Save and set required env vars
    for (const key of ['ROOT_FOLDER_HOST', 'CI_CLOUD_URL', 'DOMAIN', 'GUEST_DASHBOARD', 'DEMO_MODE', 'JWT_SECRET', 'MCP_API_KEY', 'LOG_LEVEL']) {
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

  it('MUST let the Log level saved in Settings win over the LOG_LEVEL every compose file sets', async () => {
    process.env.LOG_LEVEL = 'info';
    setupMocks({ settingsJson: { logLevel: 'debug' } });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('LOG_LEVEL')).toBe('debug');
    // ConfigurationService and the Hub's logger read process.env, where the compose value would stay.
    expect(process.env.LOG_LEVEL).toBe('debug');
  });

  it('MUST keep LOG_LEVEL from the environment when no Log level was saved', async () => {
    process.env.LOG_LEVEL = 'warn';
    setupMocks({ settingsJson: {} });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('LOG_LEVEL')).toBe('warn');
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

  it('MUST NOT carry MCP_API_KEY into the resolved env, even when an older .env still has one', async () => {
    // SEC-MCP-8: the value authenticates nothing (McpAuthGuard has no env fallback and nothing seeds
    // the key store), so it is no longer derived and a stale one is dropped rather than republished
    // into state/.env.resolved. Real MCP keys live in the hashed store.
    setupMocks({ dataEnv: 'MCP_API_KEY=from-data' });
    const envMap = await generateSystemEnvFile();
    expect(envMap.has('MCP_API_KEY')).toBe(false);
  });

  it('MUST boot with an out-of-range persisted hubPoolLocalAffinity instead of refusing to start', async () => {
    // settings.json used to be parsed all-or-nothing, so a value outside MIN/MAX_POOL_LOCAL_AFFINITY
    // threw `Invalid settings.json file` out of the very first line of bootstrap(). Those bounds are
    // build constants: a Hub that saved a value one build accepts and then rolls back to a build
    // that does not would crash-loop, with no UI left to correct the value from.
    delete process.env.DOMAIN;
    setupMocks({ settingsJson: { hubPoolLocalAffinity: -1, guestDashboard: true }, dataEnv: 'DOMAIN=from-data' });

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('from-data');
  });

  it('MUST apply every readable settings.json field when one unrelated field is unusable', async () => {
    // The general case: any field a future build tightens. Only the bad field is lost.
    delete process.env.GUEST_DASHBOARD;
    delete process.env.DNS_IP;
    setupMocks({ settingsJson: { dnsIp: 'not-an-ip', guestDashboard: true } });

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('GUEST_DASHBOARD')).toBe('true');
    expect(envMap.get('DNS_IP')).toBe('9.9.9.9');
  });

  it('MUST boot when settings.json holds something that is not a settings object at all', async () => {
    delete process.env.DOMAIN;
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return '[]';
      if (p.includes('.env')) return 'DOMAIN=from-data';
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('from-data');
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

describe('env-helpers — TZ resolves even when the host time zone is undeterminable', () => {
  // generateSystemEnvFile writes ~30 keys into process.env via applyEnvMapToProcess, so restore
  // the whole environment rather than an enumerated subset — an enumerated list silently leaks
  // JWT_SECRET/DOMAIN/RABBITMQ_PASSWORD into the describes that follow.
  let envSnapshot: NodeJS.ProcessEnv;
  let intlSpy: ReturnType<typeof vi.spyOn> | undefined;

  /** This machine's real zone, captured before any spy — the marker for "this is the host lookup". */
  const REAL_HOST_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * Stub what ICU reports as the *host* zone — the zero-arg `Intl.DateTimeFormat()` lookup.
   *
   * A blanket mockReturnValue on the prototype would also intercept the `resolvedOptions()` call
   * inside canonicalTimeZone(), which is what turns 'america/new_york' into 'America/New_York' —
   * canonicalization would become unobservable and its tests would pass vacuously. So delegate to
   * the real implementation and only rewrite the answer for the host lookup, which is identifiable
   * because it resolves to this machine's actual zone.
   */
  const stubHostZone = (timeZone: string | undefined) => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;

    intlSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      const options = original.call(this);
      if (options.timeZone !== REAL_HOST_ZONE) return options;
      return { ...options, timeZone } as Intl.ResolvedDateTimeFormatOptions;
    });

    return intlSpy;
  };

  /** Contents the mocked fs serves for the data .env and settings.json. */
  let dataEnv: string;
  let settingsJson: Record<string, unknown>;

  const setDataEnv = (content: string) => {
    dataEnv = content;
  };
  const setSettings = (settings: Record<string, unknown>) => {
    settingsJson = settings;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot = { ...process.env };

    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
    delete process.env.TZ;

    dataEnv = '';
    settingsJson = {};

    mockedFs.existsSync.mockReturnValue(true);
    // vi.clearAllMocks() clears calls but NOT implementations, and an earlier test in this file
    // leaves an EACCES-throwing writeFile behind. Without this reset these tests would silently
    // run the "could not write .env.resolved" degraded branch instead of the real writer path.
    (mockedFs.promises.writeFile as any).mockResolvedValue(undefined);
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return JSON.stringify(settingsJson);
      if (p.includes('.env')) return dataEnv;
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);

    // Restore only our own spy. vi.restoreAllMocks() would drain every spy registered in this
    // file and, under `restoreMocks: true` or Vitest <=3 semantics, reset the module-level
    // fs/dotenv vi.fn() implementations the later describes depend on.
    intlSpy?.mockRestore();
    intlSpy = undefined;
  });

  // Regression: ICU returns undefined — not a zone name — when it cannot map /etc/localtime back
  // to an IANA id, which is what happens on a clean install whose image lacks tzdata but whose
  // compose bind-mounts the host's /etc/localtime. That undefined reached the .env writer and
  // killed bootstrap with "Cannot read properties of undefined (reading 'replace')".
  it('MUST fall back to UTC when Intl reports no host time zone', async () => {
    stubHostZone(undefined);

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('UTC');
  });

  // ICU's OTHER failure mode. 'Etc/Unknown' is TRUTHY, so a `|| DEFAULT_TZ` guard passes it
  // straight through — and it then throws `RangeError: Invalid time zone specified` in every
  // downstream Intl consumer and lands in every app container's env.
  it("MUST fall back to UTC when Intl reports the 'Etc/Unknown' sentinel", async () => {
    stubHostZone('Etc/Unknown');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('UTC');
  });

  it('MUST prefer the real host time zone when Intl can resolve one', async () => {
    // Deliberately NOT the machine's own zone: stubbing the host zone to whatever the developer
    // already runs makes the assertion pass even if the spy never intercepts.
    const spy = stubHostZone('Pacific/Kiritimati');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('Pacific/Kiritimati');
    expect(spy).toHaveBeenCalled();
  });

  // A bad zone is delivered through the data .env / settings.json rather than process.env, because
  // an invalid process.env.TZ ALSO makes ICU report the host zone as undefined (see the dedicated
  // test below) — which would leave nothing to degrade to and mask what these cases are pinning.
  it('MUST degrade to the host zone, not UTC, when the data .env carries an invalid TZ', async () => {
    setDataEnv('TZ=Nowhere/Bogus');
    stubHostZone('Europe/Berlin');

    const envMap = await generateSystemEnvFile();

    // Degrades to the known-good host zone: a typo should not move a correctly-configured
    // appliance to UTC when we know perfectly well what zone the host is in.
    expect(envMap.get('TZ')).toBe('Europe/Berlin');
  });

  it('MUST reject an invalid TZ coming from settings.json', async () => {
    setSettings({ timeZone: 'Not/AZone' });
    stubHostZone('Europe/Berlin');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('Europe/Berlin');
  });

  it('MUST fall back to UTC for an invalid TZ when the host zone is also undeterminable', async () => {
    setDataEnv('TZ=Nowhere/Bogus');
    stubHostZone(undefined);

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('UTC');
  });

  // ICU matches zone ids case-insensitively, so 'america/new_york' passes a mere validity check.
  // Keeping the raw string is what poisons us: once a non-canonical id lands in process.env.TZ, ICU
  // reports the host zone as `undefined` — the original fault, recreated from the inside.
  it('MUST canonicalize a non-canonical zone id rather than pass it through raw', async () => {
    setDataEnv('TZ=america/new_york');
    stubHostZone('Europe/Berlin');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('America/New_York');
    expect(process.env.TZ).toBe('America/New_York');
  });

  // ICU accepts UTC-offset ids, but POSIX TZ parsing in the app containers ignores them and falls
  // back to UTC — the Hub would run on +05:00 while every container it launched ran UTC.
  it('MUST reject a UTC-offset id, which is not an IANA zone', async () => {
    setDataEnv('TZ=+05:00');
    stubHostZone('Europe/Berlin');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('Europe/Berlin');
  });

  // applyEnvMapToProcess never clobbers an existing process.env value, so a poisoned inherited TZ
  // would survive in-process — keeping ICU broken — and win in ConfigurationService, which merges
  // `{ ...envMap, ...process.env }`. Note the poison also destroys the host lookup, so UTC is the
  // only zone left to fall back to; the point of this test is that process.env.TZ gets REPAIRED.
  it('MUST repair a poisoned process.env.TZ, not just the env map', async () => {
    process.env.TZ = 'Nowhere/Bogus';

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('TZ')).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
  });

  it('MUST apply the resolved zone to process.env, not just the env file', async () => {
    stubHostZone(undefined);

    await generateSystemEnvFile();

    expect(process.env.TZ).toBe('UTC');
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

  it('MUST NOT invent the weak default, but tolerates an explicit admin in production (compose fallback)', async () => {
    // Compose interpolates ${RABBITMQ_PASSWORD:-admin}. An explicit admin still
    // matches the broker; we keep it rather than silently inventing another value.
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

describe('generateSystemEnvFile — credential files in state/ are owner-only', () => {
  // The real-filesystem behaviour of restrictStateFileMode is in env-helpers.file-modes.test.ts.
  // This pins that boot actually routes the seed and the resolved env through it.
  const modes = new Map<string, number>();
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot = { ...process.env };
    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
    modes.clear();

    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return '{}';
      if (p.includes('.env')) return '';
      throw new Error(`Unexpected readFile: ${p}`);
    });
    (mockedFs.promises.writeFile as any).mockResolvedValue(undefined);
    (mockedFs.promises.access as any).mockResolvedValue(undefined);
    (mockedFs.promises.stat as any).mockImplementation(async (filePath: string) => ({ mode: 0o100000 | (modes.get(String(filePath)) ?? 0o600) }));
    (mockedFs.promises.chmod as any).mockImplementation(async (filePath: string, mode: number) => {
      modes.set(String(filePath), mode);
    });
  });

  afterEach(() => {
    process.env = envSnapshot;
  });

  it('creates a missing seed owner-only', async () => {
    mockedFs.existsSync.mockImplementation((p) => !String(p).endsWith('/state/seed'));

    await generateSystemEnvFile();

    expect(mockedFs.promises.writeFile).toHaveBeenCalledWith('/data/state/seed', expect.stringMatching(/^[0-9a-f]{64}$/), { mode: 0o600 });
  });

  it('restricts an existing world-readable seed on boot', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    modes.set('/data/state/seed', 0o644);

    await generateSystemEnvFile();

    expect(mockedFs.promises.chmod).toHaveBeenCalledWith('/data/state/seed', 0o600);
  });

  it('writes .env.resolved owner-only', async () => {
    mockedFs.existsSync.mockReturnValue(true);

    await generateSystemEnvFile();

    expect(mockedFs.promises.writeFile).toHaveBeenCalledWith('/data/state/.env.resolved', expect.stringContaining('JWT_SECRET='), { mode: 0o600 });
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
      mode: 0o600,
    });
  });

  it('retries chmod when settings.json is not writable', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.promises.access as any).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' })).mockResolvedValue(undefined);

    await ensureSettingsJsonReady('/data/state/settings.json');

    // Owner-only for the file, and never world-writable for the directory: write on the directory
    // would let any local user rename their own settings.json over this one.
    expect(mockedFs.promises.chmod).toHaveBeenCalledWith('/data/state', 0o775);
    expect(mockedFs.promises.chmod).not.toHaveBeenCalledWith('/data/state', 0o777);
    expect(mockedFs.promises.chmod).toHaveBeenCalledWith('/data/state/settings.json', 0o600);
  });
});

describe('env-helpers — ALLOW_ERROR_MONITORING precedence', () => {
  // The audited contradiction: resolve() gave the environment precedence for this key while
  // ConfigurationService.configure() gave it to the setting, so the resolved env and the config the
  // Hub actually runs on could report opposite consent. Both now call resolveAllowErrorMonitoring,
  // which is settings-first — its docblock carries the argument for why this one key does not
  // follow resolve()'s env-first order, and why CI_TELEMETRY/CI_LOCAL_ONLY are the operator
  // switches that a dashboard toggle cannot undo.
  let envSnapshot: NodeJS.ProcessEnv;

  const setSettings = (settingsJson: Record<string, unknown>, dataEnv = '') => {
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return JSON.stringify(settingsJson);
      if (p.includes('.env')) return dataEnv;
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot = { ...process.env };

    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
    delete process.env.ALLOW_ERROR_MONITORING;

    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.promises.writeFile as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it("MUST keep the user's opt-out when the environment allows reporting", async () => {
    process.env.ALLOW_ERROR_MONITORING = 'true';
    setSettings({ allowErrorMonitoring: false });

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('ALLOW_ERROR_MONITORING')).toBe('false');
  });

  it("MUST keep the user's opt-in when the environment forbids reporting", async () => {
    process.env.ALLOW_ERROR_MONITORING = 'false';
    setSettings({ allowErrorMonitoring: true });

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('ALLOW_ERROR_MONITORING')).toBe('true');
  });

  it('MUST take the environment value when the user has never touched the switch', async () => {
    process.env.ALLOW_ERROR_MONITORING = 'false';
    setSettings({});

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('ALLOW_ERROR_MONITORING')).toBe('false');
  });

  it('MUST fall back to the opt-out default when no source has an opinion', async () => {
    setSettings({});

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('ALLOW_ERROR_MONITORING')).toBe('true');
  });
});

describe('env-helpers — legacy env aliases (RUNTIPI_* / TIPI_*)', () => {
  // #1143 (c88a83580) renamed "Runtipi" to "CIHub" by substring, turning the
  // legacy alias RUNTIPI_APP_DATA_PATH into RUNCIHUB_APP_DATA_PATH — a name no
  // appliance has ever set. CI-OS still writes RUNTIPI_* (core/lib/ci-hub.sh),
  // so the fallback silently resolved nothing. Nothing covered it, so it shipped.
  const LEGACY_KEYS = [
    'CI_HUB_APP_DATA_PATH',
    'RUNTIPI_APP_DATA_PATH',
    'RUNCIHUB_APP_DATA_PATH',
    'ROOT_FOLDER_HOST',
    'CI_CLOUD_URL',
    'DOMAIN',
    'JWT_SECRET',
    'MCP_API_KEY',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of LEGACY_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return '{}';
      if (p.includes('.env')) return '';
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('MUST resolve RUNTIPI_APP_DATA_PATH — the name CI-OS actually writes', async () => {
    process.env.RUNTIPI_APP_DATA_PATH = '/home/user/legacy-runtipi';
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('CI_HUB_APP_DATA_PATH')).toBe('/home/user/legacy-runtipi');
  });

  it('MUST still resolve RUNCIHUB_APP_DATA_PATH, shipped since v0.2.68', async () => {
    process.env.RUNCIHUB_APP_DATA_PATH = '/home/user/legacy-runcihub';
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('CI_HUB_APP_DATA_PATH')).toBe('/home/user/legacy-runcihub');
  });

  it('MUST prefer the current name over every legacy alias', async () => {
    process.env.CI_HUB_APP_DATA_PATH = '/home/user/current';
    process.env.RUNTIPI_APP_DATA_PATH = '/home/user/legacy-runtipi';
    process.env.RUNCIHUB_APP_DATA_PATH = '/home/user/legacy-runcihub';
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('CI_HUB_APP_DATA_PATH')).toBe('/home/user/current');
  });

  it('MUST prefer RUNTIPI_* over RUNCIHUB_* when both are set', async () => {
    process.env.RUNTIPI_APP_DATA_PATH = '/home/user/legacy-runtipi';
    process.env.RUNCIHUB_APP_DATA_PATH = '/home/user/legacy-runcihub';
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('CI_HUB_APP_DATA_PATH')).toBe('/home/user/legacy-runtipi');
  });

  it('MUST resolve a legacy alias out of the persisted .env, not just process.env', async () => {
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return '{}';
      if (p.includes('.env')) return 'RUNTIPI_APP_DATA_PATH=/home/user/persisted-legacy';
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
    const envMap = await generateSystemEnvFile();
    expect(envMap.get('CI_HUB_APP_DATA_PATH')).toBe('/home/user/persisted-legacy');
  });
});

describe('resolveHubDomain', () => {
  it('takes the zone Portal assigned over everything else', () => {
    expect(resolveHubDomain({ portalDomain: 'ci0.pw', paired: true, dataEnvDomain: 'ci3.pw', env: 'companionintelligence.com' })).toBe('ci0.pw');
  });

  it('on a paired Hub without one, takes the data env file over the environment', () => {
    expect(resolveHubDomain({ portalDomain: null, paired: true, dataEnvDomain: 'ci0.pw', env: 'companionintelligence.com' })).toBe('ci0.pw');
  });

  it('on a Hub that never paired, keeps the environment first', () => {
    expect(resolveHubDomain({ portalDomain: undefined, paired: false, dataEnvDomain: 'ci0.pw', env: 'companionintelligence.com' })).toBe(
      'companionintelligence.com',
    );
  });

  it('ignores blank values', () => {
    expect(resolveHubDomain({ portalDomain: '  ', paired: true, dataEnvDomain: ' ', env: 'companionintelligence.com' })).toBe(
      'companionintelligence.com',
    );
  });
});

describe('generateSystemEnvFile — DOMAIN keeps the zone Portal assigned (CI-Hub#1894)', () => {
  // A container's environment is the data env file as it was when the container was created, which
  // is before pairing. Env-first brought that DOMAIN back on every restart and broke sign-in on
  // every app, because the Hub's own address is built from it.
  let envSnapshot: NodeJS.ProcessEnv;

  const setSources = (settingsJson: Record<string, unknown>, dataEnv: string) => {
    (mockedFs.promises.readFile as any).mockImplementation(async (filePath: string) => {
      const p = String(filePath);
      if (p.includes('settings.json')) return JSON.stringify(settingsJson);
      if (p.includes('.env')) return dataEnv;
      if (p.includes('seed')) return 'a'.repeat(64);
      throw new Error(`Unexpected readFile: ${p}`);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    envSnapshot = { ...process.env };

    process.env.ROOT_FOLDER_HOST = '/home/user/ci-os-hub';
    process.env.CI_CLOUD_URL = 'https://cloud.example.com';

    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.promises.writeFile as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it('MUST take portalDomain over the DOMAIN the container inherited, in the env map and in process.env', async () => {
    process.env.DOMAIN = 'companionintelligence.com';
    setSources({ portalDomain: 'ci0.pw', ciHubApiKey: 'device-key' }, 'DOMAIN=companionintelligence.com\n');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('ci0.pw');
    expect(process.env.DOMAIN).toBe('ci0.pw');
  });

  it('MUST take the data env file over the inherited DOMAIN on a Hub paired before portalDomain existed', async () => {
    process.env.DOMAIN = 'companionintelligence.com';
    setSources({ ciHubApiKey: 'device-key' }, 'DOMAIN=ci0.pw\n');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('ci0.pw');
    expect(process.env.DOMAIN).toBe('ci0.pw');
  });

  it('keeps the environment first on a Hub that never paired', async () => {
    process.env.DOMAIN = 'companionintelligence.com';
    setSources({}, 'DOMAIN=ci0.pw\n');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('companionintelligence.com');
  });

  it('falls back to the default when no source has a value', async () => {
    delete process.env.DOMAIN;
    setSources({}, '');

    const envMap = await generateSystemEnvFile();

    expect(envMap.get('DOMAIN')).toBe('companionintelligence.com');
    expect(process.env.DOMAIN).toBe('companionintelligence.com');
  });
});
