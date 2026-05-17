import { isPrivateVpnEnabled } from '../private-vpn';
import { describe, it, expect, afterEach } from 'vitest';

describe('private-vpn helpers', () => {
  afterEach(() => {
    delete process.env.PRIVATE_VPN_ENABLED;
  });

  it('isPrivateVpnEnabled defaults true', () => {
    expect(isPrivateVpnEnabled()).toBe(true);
  });

  it('isPrivateVpnEnabled false when PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isPrivateVpnEnabled()).toBe(false);
  });
});
