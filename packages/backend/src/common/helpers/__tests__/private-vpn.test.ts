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

  it('isPrivateVpnEnabled false only when PRIVATE_VPN_USER_DISABLED=true', () => {
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    expect(isPrivateVpnEnabled()).toBe(false);
  });

  it('ignores legacy PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isPrivateVpnEnabled()).toBe(true);
  });

  it('ignores legacy PRIVATE_VPN_ENABLED=true when user opted out', () => {
    process.env.PRIVATE_VPN_ENABLED = 'true';
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    expect(isPrivateVpnEnabled()).toBe(false);
  });
});
