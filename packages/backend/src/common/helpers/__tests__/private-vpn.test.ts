import { isTailscaleServeEnabled } from '../private-vpn';
import { describe, it, expect, afterEach } from 'vitest';

describe('private-vpn helpers', () => {
  afterEach(() => {
    delete process.env.PRIVATE_VPN_ENABLED;
    delete process.env.PRIVATE_VPN_USER_DISABLED;
    delete process.env.TAILSCALE_SERVE_USER_DISABLED;
  });

  it('isTailscaleServeEnabled defaults true when unset', () => {
    expect(isTailscaleServeEnabled()).toBe(true);
  });

  it('isTailscaleServeEnabled false only when TAILSCALE_SERVE_USER_DISABLED=true', () => {
    process.env.TAILSCALE_SERVE_USER_DISABLED = 'true';
    expect(isTailscaleServeEnabled()).toBe(false);

    process.env.TAILSCALE_SERVE_USER_DISABLED = 'false';
    expect(isTailscaleServeEnabled()).toBe(true);
  });

  it('ignores PRIVATE_VPN_USER_DISABLED, which only keeps the sidecar from starting', () => {
    // Desktop installs wrote this on their own, without anyone opting out (CI-Hub#1757).
    process.env.PRIVATE_VPN_USER_DISABLED = 'true';
    expect(isTailscaleServeEnabled()).toBe(true);
  });

  it('ignores legacy PRIVATE_VPN_ENABLED=false', () => {
    process.env.PRIVATE_VPN_ENABLED = 'false';
    expect(isTailscaleServeEnabled()).toBe(true);
  });
});
