import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CONNECT_ATTEMPT_TIMEOUT_MS, raiseConnectAttemptTimeout } from '../connect-attempt-timeout';

describe('raiseConnectAttemptTimeout', () => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();

  afterEach(() => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(before);
  });

  it("sets Node's per-address connect time for every socket opened after it", () => {
    raiseConnectAttemptTimeout();

    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    // Node's own 250 ms is what failed a Portal request over a link only 300 ms slower than usual.
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(before);
  });
});
