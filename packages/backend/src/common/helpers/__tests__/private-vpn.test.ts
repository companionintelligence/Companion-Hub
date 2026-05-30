import { isPrivateVpnEnabled } from '../private-vpn';
import { describe, it, expect, afterEach } from 'vitest';

describe('private-vpn helpers', () => {
  afterEach(() => {
    delete process.env.PRIVATE_VPN_ENABLED;
  });

  it('isPrivateVpnEnabled defaults false when PRIVATE_VPN_ENABLED is unset', () => {
    expect(isPrivateVpnEnabled()).toBe(false);
  });

  it('isPrivateVpnEnabled true only when PRIVATE_VPN_ENABLED=true', () => {
    process.env.PRIVATE_VPN_ENABLED = 'true';
    expect(isPrivateVpnEnabled()).toBe(true);
  });

  it('isPrivateVpnEnabled false when PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isPrivateVpnEnabled()).toBe(false);
  });
});
