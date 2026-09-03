import { describe, expect, it } from 'vitest';

import type { FormField } from '@/types/app.types';

import { validateAppConfig, validateField } from './form-validators';

const baseField = (type: FormField['type'], env_variable = 'TEST_VAR'): FormField =>
  ({
    env_variable,
    label: 'Test field',
    type,
    required: false,
  }) as FormField;

describe('validateField URL types', () => {
  it('accepts localhost URLs for app_base_url', () => {
    expect(validateField(baseField('app_base_url'), 'http://localhost')).toBeUndefined();
    expect(validateField(baseField('app_base_url'), 'http://localhost:3000')).toBeUndefined();
  });

  it('accepts production URLs for app_base_url', () => {
    expect(validateField(baseField('app_base_url'), 'https://n8n.example.com')).toBeUndefined();
  });

  it('rejects malformed app_base_url values', () => {
    expect(validateField(baseField('app_base_url'), 'not-a-url')?.messageKey).toBe('APP_INSTALL_FORM_ERROR_URL');
  });

  it('rejects localhost for generic url fields', () => {
    expect(validateField(baseField('url'), 'http://localhost')?.messageKey).toBe('APP_INSTALL_FORM_ERROR_URL');
  });

  it('accepts public URLs for generic url fields', () => {
    expect(validateField(baseField('url'), 'https://example.com')).toBeUndefined();
  });
});

describe('validateField password + defaults', () => {
  it('accepts long password/token values by default (up to 4096)', () => {
    const field = { ...baseField('password'), required: true } as FormField;
    const longToken = 'x'.repeat(250);
    expect(validateField(field, longToken)).toBeUndefined();
  });

  it('treats catalog defaults as satisfying required fields', () => {
    const field = {
      ...baseField('text', 'ALLOWED_PATH'),
      required: true,
      default: '/data',
    } as FormField;
    expect(validateField(field, '')).toBeUndefined();
    expect(validateField(field, undefined)).toBeUndefined();
    const errors = validateAppConfig({}, [field]);
    expect(errors.ALLOWED_PATH).toBeUndefined();
  });
});
