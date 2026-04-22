/**
 * Unit tests for portal client helpers.
 *
 * Run with: pnpm exec tsx --test e2e/helpers/__tests__/portal-client.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PortalApiClient } from '../../cross-domain/portal-api.js';

describe('PortalApiClient', () => {
  it('can be constructed with a base URL', () => {
    const client = new PortalApiClient('http://localhost:8012');
    assert.ok(client);
  });

  it('healthCheck returns false when server is unreachable', async () => {
    const client = new PortalApiClient('http://localhost:19999');
    const healthy = await client.healthCheck();
    assert.strictEqual(healthy, false);
  });
});
