import { describe, expect, it } from 'vitest';
import { normalizeApiErrorMessage } from './normalize-api-error';

describe('normalizeApiErrorMessage', () => {
  it('passes through i18n keys unchanged', () => {
    expect(normalizeApiErrorMessage('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', 401)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
  });

  it('maps literal Unauthorized to a login message key', () => {
    expect(normalizeApiErrorMessage('Unauthorized', 401)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
  });

  it('falls back to status-based keys when message is missing', () => {
    expect(normalizeApiErrorMessage(undefined, 403)).toBe('REGISTRATION_DEVICE_NOT_OPERATIONAL');
  });
});
