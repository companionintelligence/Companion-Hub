import { describe, expect, it } from 'vitest';
import {
  appCompatibilitySchema,
  checkAppCompatibility,
  extractAppCompatibility,
  meetsMinVersion,
  LEGACY_TIPI_VERSION_KEY,
} from '../compatibility.js';
import type { AppCompatibility, HubCompatibility } from '../compatibility.js';

// ─── appCompatibilitySchema ───────────────────────────────────────────────────

describe('appCompatibilitySchema', () => {
  it('parses a minimal valid input', () => {
    const result = appCompatibilitySchema.parse({ hub_version: 3 });
    expect(result.hub_version).toBe(3);
    expect(result.supported_architectures).toEqual(['amd64', 'arm64']);
    expect(result.min_hub_version).toBeUndefined();
  });

  it('parses a fully-specified input', () => {
    const result = appCompatibilitySchema.parse({
      hub_version: 5,
      supported_architectures: ['arm64'],
      min_hub_version: '1.2.0',
    });
    expect(result.hub_version).toBe(5);
    expect(result.supported_architectures).toEqual(['arm64']);
    expect(result.min_hub_version).toBe('1.2.0');
  });

  it('rejects non-positive hub_version', () => {
    expect(() => appCompatibilitySchema.parse({ hub_version: 0 })).toThrow();
    expect(() => appCompatibilitySchema.parse({ hub_version: -1 })).toThrow();
  });

  it('rejects non-integer hub_version', () => {
    expect(() => appCompatibilitySchema.parse({ hub_version: 1.5 })).toThrow();
  });

  it('rejects an empty architecture list', () => {
    expect(() => appCompatibilitySchema.parse({ hub_version: 1, supported_architectures: [] })).toThrow();
  });
});

// ─── meetsMinVersion ─────────────────────────────────────────────────────────

describe('meetsMinVersion', () => {
  it('returns true when versions are equal', () => {
    expect(meetsMinVersion('1.2.3', '1.2.3')).toBe(true);
  });

  it('returns true when running is greater', () => {
    expect(meetsMinVersion('2.0.0', '1.9.9')).toBe(true);
    expect(meetsMinVersion('1.3.0', '1.2.9')).toBe(true);
    expect(meetsMinVersion('1.2.4', '1.2.3')).toBe(true);
  });

  it('returns false when running is less', () => {
    expect(meetsMinVersion('1.0.0', '2.0.0')).toBe(false);
    expect(meetsMinVersion('1.2.0', '1.3.0')).toBe(false);
    expect(meetsMinVersion('1.2.3', '1.2.4')).toBe(false);
  });

  it('handles the "v" prefix', () => {
    expect(meetsMinVersion('v1.2.3', 'v1.2.3')).toBe(true);
    expect(meetsMinVersion('v2.0.0', '1.9.0')).toBe(true);
  });

  it('handles versions with missing patch component', () => {
    expect(meetsMinVersion('1.2', '1.2.0')).toBe(true);
    expect(meetsMinVersion('1.2', '1.2.1')).toBe(false);
  });
});

// ─── checkAppCompatibility ───────────────────────────────────────────────────

describe('checkAppCompatibility', () => {
  const hub: HubCompatibility = { hub_version: '1.5.0', architectures: ['amd64'] };

  function app(overrides: Partial<AppCompatibility> = {}): AppCompatibility {
    return appCompatibilitySchema.parse({ hub_version: 1, ...overrides });
  }

  it('returns null when all constraints are satisfied', () => {
    expect(checkAppCompatibility(app(), hub)).toBeNull();
  });

  it('returns an error when no matching architecture', () => {
    const reason = checkAppCompatibility(app({ supported_architectures: ['arm64'] }), hub);
    expect(reason).toMatch(/arm64/);
    expect(reason).toMatch(/amd64/);
  });

  it('returns null when app supports amd64 and hub is amd64', () => {
    expect(checkAppCompatibility(app({ supported_architectures: ['amd64'] }), hub)).toBeNull();
  });

  it('returns null when app supports both arches and hub is amd64', () => {
    expect(checkAppCompatibility(app({ supported_architectures: ['amd64', 'arm64'] }), hub)).toBeNull();
  });

  it('returns an error when hub version is below min_hub_version', () => {
    const reason = checkAppCompatibility(app({ min_hub_version: '2.0.0' }), hub);
    expect(reason).toMatch(/2\.0\.0/);
    expect(reason).toMatch(/1\.5\.0/);
  });

  it('returns null when hub version meets min_hub_version exactly', () => {
    expect(checkAppCompatibility(app({ min_hub_version: '1.5.0' }), hub)).toBeNull();
  });

  it('returns null when min_hub_version is absent', () => {
    expect(checkAppCompatibility(app({ min_hub_version: undefined }), hub)).toBeNull();
  });
});

// ─── extractAppCompatibility ─────────────────────────────────────────────────

describe('extractAppCompatibility', () => {
  it('uses hub_version when present (canonical key)', () => {
    const result = extractAppCompatibility({ hub_version: 7, tipi_version: 3 });
    expect(result.hub_version).toBe(7); // canonical takes precedence
  });

  it('falls back to tipi_version when hub_version is absent (legacy on-disk format)', () => {
    const result = extractAppCompatibility({ [LEGACY_TIPI_VERSION_KEY]: 4 });
    expect(result.hub_version).toBe(4);
  });

  it('defaults to 1 when neither key is present', () => {
    const result = extractAppCompatibility({});
    expect(result.hub_version).toBe(1);
  });

  it('extracts supported_architectures when present', () => {
    const result = extractAppCompatibility({ hub_version: 1, supported_architectures: ['arm64'] });
    expect(result.supported_architectures).toEqual(['arm64']);
  });

  it('extracts min_hub_version when present', () => {
    const result = extractAppCompatibility({ hub_version: 1, min_hub_version: '1.3.0' });
    expect(result.min_hub_version).toBe('1.3.0');
  });

  it('produces output that passes appCompatibilitySchema.parse()', () => {
    const raw = { [LEGACY_TIPI_VERSION_KEY]: 2, supported_architectures: ['amd64'], min_hub_version: '0.9.0' };
    const extracted = extractAppCompatibility(raw);
    const parsed = appCompatibilitySchema.parse(extracted);
    expect(parsed.hub_version).toBe(2);
    expect(parsed.supported_architectures).toEqual(['amd64']);
    expect(parsed.min_hub_version).toBe('0.9.0');
  });
});
