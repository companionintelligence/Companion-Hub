import { describe, expect, it } from 'vitest';
import type { FormField } from '../../schemas/app-info.js';
import { isAppFormValid, mergeFormFieldDefaults, validateAppFormFields, validateField } from '../form-fields.js';

const baseField = (type: FormField['type'], env_variable = 'TEST_VAR'): FormField =>
  ({
    env_variable,
    label: 'Test field',
    type,
    required: false,
  }) as FormField;

describe('localSubdomain', () => {
  // The Hub's own hostname is `hub-<device>-<org>`, and the desktop app opens any `hub…` host as the Hub.
  it.each(['hub-admin', 'HUB-x'])('refuses %s, which names the Hub', (localSubdomain) => {
    expect(validateAppFormFields({ exposedLocal: true, localSubdomain }, [])).toEqual([
      expect.objectContaining({ env_variable: 'localSubdomain', messageKey: 'APP_INSTALL_FORM_ERROR_LOCAL_SUBDOMAIN_HUB' }),
    ]);
  });

  // The lifecycle refuses exactly `hub` itself, as the Hub's own address (APP_SUBDOMAIN_RESERVED_FOR_HUB).
  it('leaves exactly hub to the lifecycle check', () => {
    expect(validateAppFormFields({ exposedLocal: true, localSubdomain: 'Hub' }, [])).toEqual([]);
  });

  it.each(['hubitat', 'my-hub'])('accepts %s', (localSubdomain) => {
    expect(validateAppFormFields({ exposedLocal: true, localSubdomain }, [])).toEqual([]);
  });
});

describe('validateField URL types', () => {
  it('accepts localhost URLs for app_base_url', () => {
    expect(validateField(baseField('app_base_url'), 'http://localhost')).toBeUndefined();
    expect(validateField(baseField('app_base_url'), 'http://localhost:3000')).toBeUndefined();
  });

  it('rejects malformed app_base_url values', () => {
    expect(validateField(baseField('app_base_url'), 'not-a-url')?.messageKey).toBe('APP_INSTALL_FORM_ERROR_URL');
  });

  it('rejects localhost for generic url fields', () => {
    expect(validateField(baseField('url'), 'http://localhost')?.messageKey).toBe('APP_INSTALL_FORM_ERROR_URL');
  });
});

describe('optional fields + defaults', () => {
  it('treats catalog defaults as satisfying required fields', () => {
    const field = {
      ...baseField('text', 'ALLOWED_PATH'),
      required: true,
      default: '/data',
    } as FormField;
    expect(validateField(field, '')).toBeUndefined();
    expect(validateAppFormFields({}, [field])).toHaveLength(0);
  });

  it('skips validation for optional empty fields even when default is invalid', () => {
    const field = {
      ...baseField('url', 'OPTIONAL_URL'),
      required: false,
      default: 'not-a-url',
    } as FormField;
    expect(validateField(field, '')).toBeUndefined();
    expect(validateField(field, undefined)).toBeUndefined();
  });

  it('validates optional fields when the user supplies a value', () => {
    const field = {
      ...baseField('url', 'OPTIONAL_URL'),
      required: false,
      default: 'https://example.com',
    } as FormField;
    expect(validateField(field, 'bad')?.messageKey).toBe('APP_INSTALL_FORM_ERROR_URL');
  });

  it('merges defaults into form values map', () => {
    const fields = [{ ...baseField('text', 'N8N_API_URL'), default: 'http://n8n:5678' }, { ...baseField('password', 'N8N_API_KEY') }] as FormField[];
    const merged = mergeFormFieldDefaults({}, fields);
    expect(merged.N8N_API_URL).toBe('http://n8n:5678');
    expect(merged.N8N_API_KEY).toBeUndefined();
  });

  it('accepts n8n-mcp style optional-only install with empty form', () => {
    const fields = [
      { ...baseField('text', 'N8N_API_URL'), default: 'http://n8n:5678' },
      { ...baseField('password', 'N8N_API_KEY'), max: 4096 },
    ] as FormField[];
    expect(isAppFormValid({}, fields)).toBe(true);
  });
});
