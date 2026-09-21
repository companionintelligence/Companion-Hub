import { describe, expect, it } from 'vitest';
import { parsePortalPhase, portalStanding, renderPortalCell, summariseNode, type DiscoveredNode } from '../lib/fleet-discover.js';

/**
 * The axis a healthy-looking Hub hides. On 2026-09-18 `fleet status` read `tier high, 6 backends`
 * for fifteen Hubs of which seven were unregistered and five had a device key Portal rejected.
 * `GET /api/registration/phase` is the route that says so without sending a check-in.
 */
describe('parsePortalPhase', () => {
  it('reads phase, registered and the last check-in', () => {
    expect(parsePortalPhase({ phase: 'locally_ready', registered: true, lastCheckIn: { httpStatus: 200, error: null } })).toEqual({
      phase: 'locally_ready',
      registered: true,
      checkIn: 200,
      error: undefined,
    });
    expect(
      parsePortalPhase({
        phase: 'degraded',
        degradedReasons: ['portal_rejected'],
        registered: true,
        lastCheckIn: { httpStatus: 401, error: 'HTTP 401: Invalid Device Key' },
      }),
    ).toMatchObject({
      checkIn: 401,
      error: 'HTTP 401: Invalid Device Key',
    });
    expect(parsePortalPhase({ phase: 'unregistered', registered: false, lastCheckIn: null })).toMatchObject({ registered: false, checkIn: null });
  });

  it('is undefined for anything that is not the phase document', () => {
    expect(parsePortalPhase(null)).toBeUndefined();
    expect(parsePortalPhase({ statusCode: 401, message: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN' })).toBeUndefined();
  });
});

describe('portalStanding and the cell', () => {
  const ok = { phase: 'locally_ready', registered: true, checkIn: 200 };
  const rejected = { phase: 'degraded', registered: true, checkIn: 401, error: 'HTTP 401: Invalid Device Key' };
  const unregistered = { phase: 'unregistered', registered: false, checkIn: null };
  const pending = { phase: 'locally_ready', registered: true, checkIn: null };

  it('separates the four states a Hub can be in with Portal, and no Hub at all', () => {
    expect(portalStanding(ok)).toBe('ok');
    expect(portalStanding(rejected)).toBe('rejected');
    expect(portalStanding(unregistered)).toBe('unregistered');
    expect(portalStanding(pending)).toBe('pending');
    expect(portalStanding(undefined)).toBe('none');
  });

  it('renders each one so the table reads at a glance', () => {
    expect(renderPortalCell(ok)).toEqual({ text: 'ok 200', tone: 'green' });
    expect(renderPortalCell(rejected)).toEqual({ text: '401 rejected', tone: 'yellow' });
    expect(renderPortalCell(unregistered)).toEqual({ text: 'unregistered', tone: 'yellow' });
    expect(renderPortalCell(undefined)).toEqual({ text: '—', tone: 'dim' });
  });

  it('the scan verdict names the Portal problem instead of calling the Hub administrable and done', () => {
    const base = { name: 'core-4', ip: '10.0.0.4', source: 'roster' as const };
    const probe = {
      ssh: true,
      sshFailure: 'ok' as const,
      hub: true,
      hubProbe: 'ok' as const,
      hubDetail: 'tier high, 6 backends',
      engines: ['ollama:11434'],
    };
    expect(summariseNode({ ...base, probe: { ...probe, portal: ok } } as DiscoveredNode)).toBe('Hub reachable and administrable');
    expect(summariseNode({ ...base, probe: { ...probe, portal: rejected } } as DiscoveredNode)).toMatch(/Portal rejects it \(401\)/);
    expect(summariseNode({ ...base, probe: { ...probe, portal: unregistered } } as DiscoveredNode)).toMatch(/not registered with Portal/);
  });
});
