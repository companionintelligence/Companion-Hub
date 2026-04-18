/**
 * Unit tests for infrastructure readiness helper.
 *
 * Run with: pnpm exec tsx --test e2e/helpers/__tests__/infra.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkInfraReady, probePort } from '../infra.js';

describe('checkInfraReady', () => {
  it('returns an InfraStatus object with expected shape', async () => {
    // Quick probe with 1 retry and 100ms interval (will fail fast if infra is down)
    const status = await checkInfraReady(1, 100);
    assert.ok(typeof status.postgres === 'boolean');
    assert.ok(typeof status.rabbitmq === 'boolean');
    assert.ok(typeof status.ready === 'boolean');
    assert.strictEqual(status.ready, status.postgres && status.rabbitmq);
  });
});

describe('probePort', () => {
  it('returns false for a port that is almost certainly not listening', async () => {
    // Port 19999 is extremely unlikely to have anything listening
    const reachable = await probePort('localhost', 19999, 500);
    assert.strictEqual(reachable, false);
  });
});
