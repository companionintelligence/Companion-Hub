import { describe, expect, it, afterEach } from 'vitest';
import { buildHeadscaleTunnelFqdn, headscaleTunnelContainerPort, isPrivateVpnEnabled } from '../private-vpn';

describe('private-vpn helpers', () => {
  afterEach(() => {
    delete process.env.PRIVATE_VPN_ENABLED;
    delete process.env.HEADSCALE_TUNNEL_PORT;
  });

  it('isPrivateVpnEnabled defaults true', () => {
    expect(isPrivateVpnEnabled()).toBe(true);
  });

  it('isPrivateVpnEnabled false when PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isPrivateVpnEnabled()).toBe(false);
  });

  it('buildHeadscaleTunnelFqdn builds vpn device-org hostname', () => {
    expect(
      buildHeadscaleTunnelFqdn({ slug: 'myorg', hubSubdomain: 'mydevice-myorg' }, 'example.com'),
    ).toBe('vpn-mydevice-myorg.example.com');
  });

  it('buildHeadscaleTunnelFqdn returns null when VPN disabled', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(buildHeadscaleTunnelFqdn({ slug: 'myorg', hubSubdomain: 'x-myorg' }, 'example.com')).toBeNull();
  });

  it('headscaleTunnelContainerPort defaults 8080', () => {
    expect(headscaleTunnelContainerPort()).toBe(8080);
  });

  it('headscaleTunnelContainerPort reads HEADSCALE_TUNNEL_PORT', () => {
    process.env.HEADSCALE_TUNNEL_PORT = '9090';
    expect(headscaleTunnelContainerPort()).toBe(9090);
  });
});
