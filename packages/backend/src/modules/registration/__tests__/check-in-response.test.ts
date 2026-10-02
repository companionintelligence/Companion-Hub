import { describe, expect, it } from 'vitest';
import { buildRoutes } from '../../../../../../e2e/mock-portal/scenarios';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import { classifyCheckInResponse, describeCheckInTransportError } from '../check-in-response';

/**
 * The bodies below are the ones CI-Portal `dev` actually sends, copied from `respond()` calls in
 * `deviceAuthMiddleware.ts` and `CheckIn.ts`. Each case is named for the fleet damage a wrong
 * classification does, because both directions have happened: a removal read as transient left
 * five Hubs retrying a dead key, and a schema refusal read as removal deletes a healthy Hub's
 * tunnel token.
 */
describe('classifyCheckInResponse', () => {
  it('accepts a 2xx, and reports no error for it', () => {
    expect(classifyCheckInResponse(200, { status: 'OK' })).toEqual({ kind: 'accepted', code: null, error: null });
  });

  it('rejects the 401 Portal sends for a removed or re-registered device, so the Hub stops retrying a dead key', () => {
    expect(classifyCheckInResponse(401, { error: 'Invalid Device Key', code: 'UNAUTHORIZED' })).toEqual({
      kind: 'rejected',
      code: 'UNAUTHORIZED',
      error: 'HTTP 401: Invalid Device Key',
    });
  });

  it('rejects the 401 for a Hub that sent no key at all', () => {
    expect(classifyCheckInResponse(401, { error: 'Unauthorized', code: 'UNAUTHORIZED' }).kind).toBe('rejected');
  });

  it('rejects a key that authenticates as a different device', () => {
    expect(classifyCheckInResponse(403, { error: 'Device ID does not match authenticated device' }).kind).toBe('rejected');
  });

  it("does not read a proxy's 401 or 403 page as Portal's verdict on this device", () => {
    // Cloudflare's Bot Fight Mode answered the e2e runner with an HTML 403. A string body carries no
    // verdict, so it must stay a transient failure rather than tell an owner to pair again.
    expect(classifyCheckInResponse(403, '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>').kind).toBe('failed');
    expect(classifyCheckInResponse(401, '<html>401 Authorization Required</html>').kind).toBe('failed');
    expect(classifyCheckInResponse(403, { message: 'no error field' }).kind).toBe('failed');
  });

  it('rejects the coded DEVICE_NOT_ACTIVE 400, which is a removal', () => {
    expect(classifyCheckInResponse(400, { error: 'Device not active', code: 'DEVICE_NOT_ACTIVE' })).toMatchObject({
      kind: 'rejected',
      code: 'DEVICE_NOT_ACTIVE',
    });
  });

  it('never reads a schema refusal 400 as a removal, which used to delete the tunnel token of a healthy Hub', () => {
    const zodRefusal = { success: false, error: { issues: [{ path: ['tunnel_health'], message: 'Invalid enum value' }], name: 'ZodError' } };

    expect(classifyCheckInResponse(400, zodRefusal)).toMatchObject({ kind: 'refused_body', code: null, error: 'HTTP 400' });
    expect(classifyCheckInResponse(400, { error: 'Device not found' }).kind).toBe('refused_body');
    expect(classifyCheckInResponse(400, undefined).kind).toBe('refused_body');
  });

  it.each([429, 500, 502, 503])('counts %s as transient', (status) => {
    expect(classifyCheckInResponse(status, { error: 'Service unavailable' }).kind).toBe('failed');
  });

  it('bounds and scrubs what it keeps from a Portal error, since it is served unauthenticated', () => {
    const verdict = classifyCheckInResponse(500, { error: `x${'y'.repeat(500)}` });

    expect(verdict.error?.length).toBeLessThanOrEqual(200);
  });

  it('describes a request that got no response', () => {
    expect(describeCheckInTransportError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe('connect ECONNREFUSED 127.0.0.1:443');
  });

  it('names each address when none of the Portal accepted the connection', () => {
    // That error's message is empty, and the check-in record used to read "request failed".
    expect(describeCheckInTransportError(axiosEveryAddressFailed())).toBe(EVERY_ADDRESS_FAILED);
  });
});

/**
 * The mock Portal is only useful if the Hub classifies its answers the way it classifies the real
 * one. It used to send 400 "Device not found" for an unknown key where Portal sends 401, so the
 * e2e stage exercised a reset path production never reached and never exercised the one it did.
 */
describe('mock Portal check-in answers', () => {
  const checkIn = (scenario: Parameters<typeof buildRoutes>[0]) => {
    const handler = buildRoutes(scenario)['POST /api/devices/check-in'];
    const result = handler?.(new URL('http://localhost:4444/api/devices/check-in'), { device_id: 'test-device' });

    if (!result) {
      throw new Error(`scenario ${scenario} has no check-in route`);
    }

    return classifyCheckInResponse(result.status, result.body);
  };

  it('refuses a removed device the way CI-Portal does', () => {
    expect(checkIn('removed')).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED' });
  });

  it('refuses an unregistered Hub the way CI-Portal does', () => {
    expect(checkIn('unregistered')).toMatchObject({ kind: 'rejected', code: 'UNAUTHORIZED' });
  });

  it('accepts a registered Hub, and reads an unhealthy Portal as transient', () => {
    expect(checkIn('registered').kind).toBe('accepted');
    expect(checkIn('degraded').kind).toBe('failed');
  });
});
