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
  { type: 'boolean', label: 'Enable Feature', env_variable: 'ENABLE_FEATURE', required: false },
];

const VALUES = {
  USERNAME: 'admin',
  ADMIN_PASSWORD: 'super-secret',
  API_KEY: 'sk-abc123',
  ENABLE_FEATURE: true,
  port: '8080',
};

describe('isSecretFieldType', () => {
  it('flags password as secret', () => {
    expect(isSecretFieldType('password')).toBe(true);
  });

  it('does not flag ordinary field types as secret', () => {
    expect(isSecretFieldType('text')).toBe(false);
    expect(isSecretFieldType('number')).toBe(false);
    expect(isSecretFieldType('boolean')).toBe(false);
    expect(isSecretFieldType('random')).toBe(false);
  });
});

describe('stripSecretFields', () => {
  it('removes every field declared as password type', () => {
    const result = stripSecretFields(VALUES, FORM_FIELDS);

    expect(result).not.toHaveProperty('ADMIN_PASSWORD');
    expect(result).not.toHaveProperty('API_KEY');
    expect(result).toMatchObject({ USERNAME: 'admin', ENABLE_FEATURE: true, port: '8080' });
  });

  it('leaves values untouched when no field is a secret', () => {
    const nonSecretFields = FORM_FIELDS.filter((f) => f.type !== 'password');
    const result = stripSecretFields(VALUES, nonSecretFields);

    // Only fields present in the schema are relevant to stripping — unrelated keys (like `port`)
    // are never secrets and always pass through untouched.
    expect(result.USERNAME).toBe('admin');
    expect(result.port).toBe('8080');
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

    expect(result.values).toMatchObject({ USERNAME: 'admin', ENABLE_FEATURE: true });
    expect(result.recognizedKeys.sort()).toEqual(['ENABLE_FEATURE', 'USERNAME']);
  });

  it('never includes password-type fields in the exported payload', () => {
    const exported = buildInstallConfigExport('nextcloud', VALUES, FORM_FIELDS);

    expect(exported.values).not.toHaveProperty('ADMIN_PASSWORD');
    expect(exported.values).not.toHaveProperty('API_KEY');
    expect(JSON.stringify(exported)).not.toContain('super-secret');
    expect(JSON.stringify(exported)).not.toContain('sk-abc123');
  });

  it('reports keys that do not match the current app form_fields instead of applying them', () => {
    const foreignConfigJson = JSON.stringify({
      schemaVersion: 1,
      appId: 'some-other-app',
      exportedAt: new Date().toISOString(),
      values: { USERNAME: 'carried-over', SOME_OTHER_APPS_FIELD: 'nope', port: '9999' },
    });

    const result = parseInstallConfigJson(foreignConfigJson, FORM_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.values).toEqual({ USERNAME: 'carried-over' });
    expect(result.recognizedKeys).toEqual(['USERNAME']);
    expect(result.unrecognizedKeys.sort()).toEqual(['SOME_OTHER_APPS_FIELD', 'port']);
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
