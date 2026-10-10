import type { FormField } from '@/types/app.types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildInstallConfigExport,
  installConfigFilename,
  isSecretFieldType,
  MAX_LAST_USED_CONFIGS,
  parseInstallConfigJson,
  readLastUsedConfigs,
  recordLastUsedConfig,
  serializeInstallConfig,
  stripSecretFields,
} from './install-config-storage';

const FORM_FIELDS: FormField[] = [
  { type: 'text', label: 'Username', env_variable: 'USERNAME', required: true },
  { type: 'password', label: 'Admin Password', env_variable: 'ADMIN_PASSWORD', required: true },
  { type: 'password', label: 'API Key', env_variable: 'API_KEY', required: false },
  // Auto-generated credential, like nextcloud's NEXTCLOUD_DB_PASSWORD or keila's
  // SECRET_KEY_BASE — hidden from the form (hiddenTypes in form-validators.ts), not a literal
  // `password` type. Regression coverage for CI-Hub #972.
  { type: 'random', label: 'DB Password', env_variable: 'DB_PASSWORD', required: false },
  { type: 'boolean', label: 'Enable Feature', env_variable: 'ENABLE_FEATURE', required: false },
];

const VALUES = {
  USERNAME: 'admin',
  ADMIN_PASSWORD: 'super-secret',
  API_KEY: 'sk-abc123',
  DB_PASSWORD: 'auto-generated-db-secret',
  ENABLE_FEATURE: true,
  port: '8080',
};

describe('isSecretFieldType', () => {
  it('flags password as secret', () => {
    expect(isSecretFieldType('password')).toBe(true);
  });

  it('flags random as secret (auto-generated credentials, e.g. NEXTCLOUD_DB_PASSWORD) — CI-Hub #972', () => {
    // `random` is the catalog schema's type for auto-generated secrets. It's excluded from the
    // CREATE form via `hiddenTypes` in form-validators.ts, and must be treated as a secret here
    // too so it can never reach an export file or the "recently used" localStorage cache.
    expect(isSecretFieldType('random')).toBe(true);
  });

  it('does not flag ordinary field types as secret', () => {
    expect(isSecretFieldType('text')).toBe(false);
    expect(isSecretFieldType('number')).toBe(false);
    expect(isSecretFieldType('boolean')).toBe(false);
  });
});

describe('stripSecretFields', () => {
  it('removes every field declared as password type', () => {
    const result = stripSecretFields(VALUES, FORM_FIELDS);

    expect(result).not.toHaveProperty('ADMIN_PASSWORD');
    expect(result).not.toHaveProperty('API_KEY');
    expect(result).toMatchObject({ USERNAME: 'admin', ENABLE_FEATURE: true, port: '8080' });
  });

  it('removes every field declared as random type (auto-generated credentials) — CI-Hub #972', () => {
    const result = stripSecretFields(VALUES, FORM_FIELDS);

    expect(result).not.toHaveProperty('DB_PASSWORD');
    expect(JSON.stringify(result)).not.toContain('auto-generated-db-secret');
  });

  it('leaves values untouched when no field is a secret', () => {
    const nonSecretFields = FORM_FIELDS.filter((f) => !isSecretFieldType(f.type));
    const result = stripSecretFields(VALUES, nonSecretFields);

    // Stripping is schema-driven, not name-pattern-driven: only fields present in the passed-in
    // formFields are considered. With every secret-typed field excluded from the schema here,
    // even ADMIN_PASSWORD/DB_PASSWORD's raw values pass through untouched — unrelated keys (like
    // `port`) always did.
    expect(result.USERNAME).toBe('admin');
    expect(result.port).toBe('8080');
    expect(result.ADMIN_PASSWORD).toBe('super-secret');
    expect(result.DB_PASSWORD).toBe('auto-generated-db-secret');
  });
});

describe('installConfigFilename', () => {
  it('names the file after the app id', () => {
    expect(installConfigFilename('nextcloud')).toBe('nextcloud-install-config.json');
  });

  it('sanitizes characters that are unsafe in filenames', () => {
    expect(installConfigFilename('my app/weird:id')).toBe('my-app-weird-id-install-config.json');
  });
});

describe('export / import round-trip', () => {
  it('round-trips non-secret values through serialize + parse', () => {
    const json = serializeInstallConfig('nextcloud', VALUES, FORM_FIELDS);
    const result = parseInstallConfigJson(json, FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.values).toMatchObject({ USERNAME: 'admin', ENABLE_FEATURE: true, port: '8080' });
    expect(result.recognizedKeys.sort()).toEqual(['ENABLE_FEATURE', 'USERNAME', 'port']);
  });

  it('never includes password-type fields in the exported payload', () => {
    const exported = buildInstallConfigExport('nextcloud', VALUES, FORM_FIELDS);

    expect(exported.values).not.toHaveProperty('ADMIN_PASSWORD');
    expect(exported.values).not.toHaveProperty('API_KEY');
    expect(JSON.stringify(exported)).not.toContain('super-secret');
    expect(JSON.stringify(exported)).not.toContain('sk-abc123');
  });

  it('never includes random-type (auto-generated credential) fields in the exported payload — CI-Hub #972', () => {
    const exported = buildInstallConfigExport('nextcloud', VALUES, FORM_FIELDS);

    expect(exported.values).not.toHaveProperty('DB_PASSWORD');
    expect(JSON.stringify(exported)).not.toContain('auto-generated-db-secret');
  });

  it('reports keys that do not match the current app form_fields instead of applying them', () => {
    const foreignConfigJson = JSON.stringify({
      schemaVersion: 1,
      appId: 'some-other-app',
      exportedAt: new Date().toISOString(),
      values: { USERNAME: 'carried-over', SOME_OTHER_APPS_FIELD: 'nope', OTHER_APP_PORT: '9999' },
    });

    const result = parseInstallConfigJson(foreignConfigJson, FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.values).toEqual({ USERNAME: 'carried-over' });
    expect(result.recognizedKeys).toEqual(['USERNAME']);
    expect(result.unrecognizedKeys.sort()).toEqual(['OTHER_APP_PORT', 'SOME_OTHER_APPS_FIELD']);
  });

  it('returns an error result for malformed JSON instead of throwing', () => {
    const result = parseInstallConfigJson('{ not valid json', FORM_FIELDS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error result');
    expect(result.error).toBe('INVALID_JSON');
  });

  it('returns an error result for a JSON value that is not an object', () => {
    const result = parseInstallConfigJson('[1,2,3]', FORM_FIELDS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error result');
    expect(result.error).toBe('INVALID_SHAPE');
  });
});

/** The access settings every exposable app's dialog has, besides its own form_fields. */
const HUB_SETTINGS = {
  exposureMode: 'local',
  localSubdomain: 'chef',
  publicDomain: 'example.org',
  enableAuth: false,
  exposedLocal: false,
  openPort: true,
  port: '8090',
};

describe('access settings in an exported config', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips exposure mode, subdomain, public domain, sign-in, local exposure, open port and port', () => {
    const json = serializeInstallConfig('cyberchef', { ...VALUES, ...HUB_SETTINGS }, FORM_FIELDS);
    const result = parseInstallConfigJson(json, FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.values).toMatchObject(HUB_SETTINGS);
    expect(result.unrecognizedKeys).toEqual([]);
  });

  it('imports everything it just exported, whatever else the dialog held', () => {
    // What getValues() holds with Advanced Mode on, a custom domain picked and a reinstall's guard.
    const dialogValues = {
      ...VALUES,
      ...HUB_SETTINGS,
      customDomainExpected: 'shop.example.org',
      customDomain: 'shop.example.org',
      customDomainTakeover: true,
      autoRestartOnDomainChange: true,
      isVisibleOnGuestDashboard: true,
      maxBackups: 3,
      cpuLimit: '1.5',
    };

    const result = parseInstallConfigJson(serializeInstallConfig('cyberchef', dialogValues, FORM_FIELDS), FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.unrecognizedKeys).toEqual([]);
  });

  it('keeps customDomainExpected out of the exported file', () => {
    const exported = buildInstallConfigExport('cyberchef', { ...VALUES, customDomainExpected: 'shop.example.org' }, FORM_FIELDS);

    expect(exported.values).not.toHaveProperty('customDomainExpected');
  });

  it('never applies customDomainExpected from a file, and does not call it foreign', () => {
    // A file exported before this fix carries the guard.
    const olderExport = JSON.stringify({
      schemaVersion: 1,
      appId: 'cyberchef',
      exportedAt: new Date().toISOString(),
      values: { USERNAME: 'admin', customDomainExpected: 'shop.example.org' },
    });

    const result = parseInstallConfigJson(olderExport, FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.values).toEqual({ USERNAME: 'admin' });
    expect(result.unrecognizedKeys).toEqual([]);
  });

  it('keeps customDomainExpected out of the recently used list', () => {
    const stored = recordLastUsedConfig('cyberchef', { ...VALUES, customDomainExpected: '' }, FORM_FIELDS);

    expect(stored[0]?.values).not.toHaveProperty('customDomainExpected');
    expect(localStorage.getItem('ci-hub:last-install-configs:cyberchef')).not.toContain('customDomainExpected');
  });

  it('drops customDomainExpected from a recently used entry saved before this fix', () => {
    localStorage.setItem(
      'ci-hub:last-install-configs:cyberchef',
      JSON.stringify([{ id: 'older', savedAt: '2026-10-01T10:00:00.000Z', values: { USERNAME: 'admin', customDomainExpected: 'shop.example.org' } }]),
    );

    expect(readLastUsedConfigs('cyberchef')[0]?.values).toEqual({ USERNAME: 'admin' });
  });
});

describe('last-used config cache', () => {
  const SLUG = 'nextcloud';

  beforeEach(() => {
    localStorage.clear();
  });

  it('persists a submitted config and excludes password-type fields', () => {
    const stored = recordLastUsedConfig(SLUG, VALUES, FORM_FIELDS);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.values).not.toHaveProperty('ADMIN_PASSWORD');
    expect(stored[0]?.values).not.toHaveProperty('API_KEY');
    expect(stored[0]?.values).toMatchObject({ USERNAME: 'admin' });

    const raw = localStorage.getItem('ci-hub:last-install-configs:nextcloud');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('sk-abc123');
  });

  it('persists a submitted config and excludes random-type (auto-generated credential) fields — CI-Hub #972', () => {
    const stored = recordLastUsedConfig(SLUG, VALUES, FORM_FIELDS);

    expect(stored[0]?.values).not.toHaveProperty('DB_PASSWORD');

    const raw = localStorage.getItem('ci-hub:last-install-configs:nextcloud');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('auto-generated-db-secret');
  });

  it('reads back what was recorded', () => {
    recordLastUsedConfig(SLUG, VALUES, FORM_FIELDS);

    const list = readLastUsedConfigs(SLUG);
    expect(list).toHaveLength(1);
    expect(list[0]?.values.USERNAME).toBe('admin');
  });

  it('caps the list at MAX_LAST_USED_CONFIGS entries, newest first', () => {
    for (let i = 0; i < 8; i++) {
      recordLastUsedConfig(SLUG, { ...VALUES, USERNAME: `user-${i}` }, FORM_FIELDS);
    }

    const list = readLastUsedConfigs(SLUG);
    expect(list).toHaveLength(MAX_LAST_USED_CONFIGS);
    expect(list.length).toBeLessThanOrEqual(5);
    // Newest entry (the last one recorded) should be first.
    expect(list[0]?.values.USERNAME).toBe('user-7');
    // Oldest three should have been evicted.
    expect(list.some((entry) => entry.values.USERNAME === 'user-0')).toBe(false);
    expect(list.some((entry) => entry.values.USERNAME === 'user-2')).toBe(false);
  });

  it('keeps different app-store slugs in separate caches', () => {
    recordLastUsedConfig('app-a', { USERNAME: 'a' }, FORM_FIELDS);
    recordLastUsedConfig('app-b', { USERNAME: 'b' }, FORM_FIELDS);

    expect(readLastUsedConfigs('app-a')).toHaveLength(1);
    expect(readLastUsedConfigs('app-b')).toHaveLength(1);
    expect(readLastUsedConfigs('app-a')[0]?.values.USERNAME).toBe('a');
  });
});
