import { isPrivateVpnEnabled } from '../private-vpn';
import { describe, it, expect, afterEach } from 'vitest';

describe('private-vpn helpers', () => {
  afterEach(() => {
    delete process.env.PRIVATE_VPN_ENABLED;
    delete process.env.PRIVATE_VPN_USER_DISABLED;
  });

  it('isPrivateVpnEnabled defaults true when unset', () => {
    expect(isPrivateVpnEnabled()).toBe(true);
  });

  it('isPrivateVpnEnabled false when PRIVATE_VPN_USER_DISABLED=true', () => {
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    expect(isPrivateVpnEnabled()).toBe(false);
  });

  it('isPrivateVpnEnabled false when PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isPrivateVpnEnabled()).toBe(false);
  });

  it('isPrivateVpnEnabled true when PRIVATE_VPN_ENABLED=true', () => {
    process.env.PRIVATE_VPN_ENABLED = 'true';
    expect(isPrivateVpnEnabled()).toBe(true);
  });
});
