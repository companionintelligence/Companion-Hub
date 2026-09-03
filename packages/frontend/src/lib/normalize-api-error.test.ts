import { describe, expect, it } from 'vitest';
import { normalizeApiErrorMessage } from './normalize-api-error';

describe('normalizeApiErrorMessage', () => {
  it('passes through i18n keys unchanged', () => {
    expect(normalizeApiErrorMessage('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', 401)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
  });

  it('maps literal Unauthorized to a login message key', () => {
    expect(normalizeApiErrorMessage('Unauthorized', 401)).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
  });

  it('falls back to a generic forbidden key when message is missing', () => {
    expect(normalizeApiErrorMessage(undefined, 403)).toBe('SYSTEM_ERROR_FORBIDDEN');
  });

  it('maps legacy Forbidden text via the 403 status fallback', () => {
    expect(normalizeApiErrorMessage('Forbidden', 403)).toBe('SYSTEM_ERROR_FORBIDDEN');
  });
});
