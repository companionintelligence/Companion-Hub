import { describe, expect, it } from 'vitest';
import { portalErrorTranslationKey } from './portal-auth-errors';

describe('portalErrorTranslationKey', () => {
  it('maps known portal error codes to translation keys', () => {
    expect(portalErrorTranslationKey('account_mismatch')).toBe('AUTH_PORTAL_ERROR_ACCOUNT_MISMATCH');
    expect(portalErrorTranslationKey('not_org_member')).toBe('AUTH_PORTAL_ERROR_NOT_ORG_MEMBER');
    expect(portalErrorTranslationKey('state_expired')).toBe('AUTH_PORTAL_ERROR_STATE_EXPIRED');
    expect(portalErrorTranslationKey('not_configured')).toBe('AUTH_PORTAL_ERROR_NOT_CONFIGURED');
    expect(portalErrorTranslationKey('org_check_unavailable')).toBe('AUTH_PORTAL_ERROR_ORG_CHECK_UNAVAILABLE');
  });

  it('keeps a Portal outage distinct from a genuine non-member', () => {
    // Both deny the login, but they tell the person to do opposite things: retry vs go get invited.
    expect(portalErrorTranslationKey('org_check_unavailable')).not.toBe(portalErrorTranslationKey('not_org_member'));
  });

  it('falls back to the generic callback error key', () => {
    expect(portalErrorTranslationKey('callback_error')).toBe('AUTH_PORTAL_ERROR_CALLBACK_ERROR');
    expect(portalErrorTranslationKey('unknown')).toBe('AUTH_PORTAL_ERROR_CALLBACK_ERROR');
  });
});
