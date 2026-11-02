import { describe, expect, it } from 'vitest';

import { TRUSTED_APP_SECURITY_ALLOWLIST } from '@ci-hub/common/schemas';
import { securityGrantsFor } from '../security-grants';

describe('securityGrantsFor', () => {
  it('hands an official store app the grant the allowlist names for it', () => {
    expect(securityGrantsFor('falco:ci-marketplace')).toBe(TRUSTED_APP_SECURITY_ALLOWLIST.falco);
  });

  it('gives a user-added store that reuses an allowlisted name nothing', () => {
    expect(securityGrantsFor('falco:my-own-store')).toBeUndefined();
  });

  it('gives an official app with no allowlist entry nothing', () => {
    expect(securityGrantsFor('dozzle:ci-marketplace')).toBeUndefined();
  });

  it('gives a malformed URN nothing', () => {
    expect(securityGrantsFor('falco')).toBeUndefined();
  });
});
