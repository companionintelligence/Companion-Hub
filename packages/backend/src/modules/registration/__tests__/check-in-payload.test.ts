import { describe, expect, it } from 'vitest';
import { buildCheckInPayload } from '../check-in-payload';

/**
 * These tests are the wire contract, not implementation detail.
 *
 * Portal reads this body to answer "is my stuff working?" for a whole org, so the expensive
 * mistake here is not a missing field — it is a *present* field asserting something the Hub does
 * not actually know. Every case below therefore pins an omission: absent means "no report this
 * time, keep what you have", never "the value is gone".
 */
describe('buildCheckInPayload', () => {
  it('always carries the device id and the provisioning phase', () => {
    // The phase is held in memory and never unknown, so it is the one field beyond `device_id`
    // that is unconditional — and it is what turns "last seen four minutes ago" into a reason.
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'publicly_ready' })).toEqual({
      device_id: 'device-1',
      phase: 'publicly_ready',
    });
  });

  it('reports degraded reasons alongside a degraded phase', () => {
    const payload = buildCheckInPayload({
      deviceId: 'device-1',
      phase: 'degraded',
      degradedReasons: ['tunnel_token_missing'],
    });

    expect(payload.degraded_reasons).toEqual(['tunnel_token_missing']);
  });

  it('drops degraded reasons when the phase is not degraded, so a cleared fault cannot linger', () => {
    // `setPhase` already clears reasons on recovery; this mirrors `buildRegistrationStatus` so a
    // caller that hands over stale reasons cannot make a healthy Hub look broken at Portal.
    const payload = buildCheckInPayload({
      deviceId: 'device-1',
      phase: 'publicly_ready',
      degradedReasons: ['tunnel_unreachable'],
    });

    expect(payload).not.toHaveProperty('degraded_reasons');
  });

  it('omits an empty degraded-reason list rather than sending "degraded, no reason"', () => {
    const payload = buildCheckInPayload({ deviceId: 'device-1', phase: 'degraded', degradedReasons: [] });

    expect(payload).not.toHaveProperty('degraded_reasons');
  });

  it('copies the degraded reasons so a later mutation of the service array cannot reach the wire', () => {
    const reasons: ('tunnel_unreachable' | 'cloud_validation_failed')[] = ['tunnel_unreachable'];
    const payload = buildCheckInPayload({ deviceId: 'device-1', phase: 'degraded', degradedReasons: reasons });

    reasons.push('cloud_validation_failed');

    expect(payload.degraded_reasons).toEqual(['tunnel_unreachable']);
  });

  it('reports a conclusive tunnel health', () => {
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tunnelHealth: 'down' }).tunnel_health).toBe('down');
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tunnelHealth: 'disabled' }).tunnel_health).toBe('disabled');
  });

  it('omits an unknown tunnel health, because a cold Hub has not probed its own route yet', () => {
    // `getHealth()` answers `unknown` until its first background probe lands — which is exactly
    // the state of the Hub that sends the first check-in after a boot. Sending it would give
    // Portal a fourth state to render for a tunnel nobody has measured.
    const payload = buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tunnelHealth: 'unknown' });

    expect(payload).not.toHaveProperty('tunnel_health');
  });

  it('omits tunnel health entirely when nothing produced a reading', () => {
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tunnelHealth: null })).not.toHaveProperty('tunnel_health');
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready' })).not.toHaveProperty('tunnel_health');
  });

  it('reports tailscale connectivity in both directions when the daemon actually answered', () => {
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tailscaleConnected: true }).tailscale_connected).toBe(true);
    // A real `false` is a genuine fact and belongs on the wire; only a non-answer is dropped.
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tailscaleConnected: false }).tailscale_connected).toBe(false);
  });

  it('omits tailscale connectivity when the daemon gave no answer, rather than claiming disconnected', () => {
    // A Hub that does not use Tailscale at all, and a Hub whose daemon is briefly wedged, both
    // land here. Reporting `false` for either would look like a fault that does not exist.
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', tailscaleConnected: null })).not.toHaveProperty('tailscale_connected');
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready' })).not.toHaveProperty('tailscale_connected');
  });

  it('reports the Hub version, and omits it when the build never stamped one', () => {
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', hubVersion: '0.2.67' }).hub_version).toBe('0.2.67');
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', hubVersion: '' })).not.toHaveProperty('hub_version');
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready' })).not.toHaveProperty('hub_version');
  });

  it('keeps the existing tailscale_dns behaviour unchanged', () => {
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', nodeFqdn: 'hub.tailnet.ts.net' }).tailscale_dns).toBe(
      'hub.tailnet.ts.net',
    );
    expect(buildCheckInPayload({ deviceId: 'device-1', phase: 'locally_ready', nodeFqdn: null })).not.toHaveProperty('tailscale_dns');
  });

  it('sends nothing but the device id and phase when the Hub knows nothing else', () => {
    // The floor of the contract: a Portal that predates these fields strips what it does not
    // recognise, and a Hub that cannot measure anything still makes a valid check-in.
    const payload = buildCheckInPayload({
      deviceId: 'device-1',
      phase: 'locally_ready',
      nodeFqdn: null,
      tailscaleConnected: null,
      hubVersion: null,
      tunnelHealth: 'unknown',
      degradedReasons: [],
    });

    expect(payload).toEqual({ device_id: 'device-1', phase: 'locally_ready' });
  });
});
