import { describe, expect, it } from 'vitest';

import type { FormField } from '@/types/app.types';

import { validateField } from './form-validators';

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
