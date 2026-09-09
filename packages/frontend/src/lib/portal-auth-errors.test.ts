import { describe, expect, it } from 'vitest';
import { portalErrorTranslationKey } from './portal-auth-errors';

describe('portalErrorTranslationKey', () => {
  it('maps known portal error codes to translation keys', () => {
    expect(portalErrorTranslationKey('account_mismatch')).toBe('AUTH_PORTAL_ERROR_ACCOUNT_MISMATCH');
    expect(portalErrorTranslationKey('not_org_member')).toBe('AUTH_PORTAL_ERROR_NOT_ORG_MEMBER');
    expect(portalErrorTranslationKey('state_expired')).toBe('AUTH_PORTAL_ERROR_STATE_EXPIRED');
    expect(portalErrorTranslationKey('not_configured')).toBe('AUTH_PORTAL_ERROR_NOT_CONFIGURED');
  });

  it('falls back to the generic callback error key', () => {
    expect(portalErrorTranslationKey('callback_error')).toBe('AUTH_PORTAL_ERROR_CALLBACK_ERROR');
    expect(portalErrorTranslationKey('unknown')).toBe('AUTH_PORTAL_ERROR_CALLBACK_ERROR');
  });
});
