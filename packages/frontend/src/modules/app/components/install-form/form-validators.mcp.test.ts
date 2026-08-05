import { describe, expect, it, vi } from 'vitest';
import { validateAppConfig, isInstallFormValid } from './form-validators';

describe('n8n-mcp optional-only install validation', () => {
  const n8nFields = [
    { env_variable: 'N8N_API_URL', label: 'n8n API URL', type: 'text' as const, required: false, default: 'http://n8n:5678' },
    { env_variable: 'N8N_API_KEY', label: 'n8n API key', type: 'password' as const, required: false, max: 4096 },
  ];

  it('accepts empty form with catalog defaults', () => {
    expect(isInstallFormValid({}, n8nFields)).toBe(true);
    expect(Object.keys(validateAppConfig({}, n8nFields))).toHaveLength(0);
  });

  it('accepts explicit default values visible in the install dialog', () => {
    expect(
      isInstallFormValid(
        {
          N8N_API_URL: 'http://n8n:5678',
          N8N_API_KEY: '',
        },
        n8nFields,
      ),
    ).toBe(true);
  });
});

describe('filesystem-mcp required field with default', () => {
  const fields = [{ env_variable: 'ALLOWED_PATH', label: 'Allowed path', type: 'text' as const, required: true, default: '/data' }];

  it('installs cleanly with empty form', () => {
    expect(isInstallFormValid({}, fields)).toBe(true);
  });
});
