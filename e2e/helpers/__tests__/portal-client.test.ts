/**
 * Unit tests for mock portal client helpers.
 *
 * Run with: pnpm exec tsx --test e2e/helpers/__tests__/portal-client.test.ts
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { getPortalScenario } from '../portal-client.js';

afterEach(() => {
  mock.restoreAll();
});

describe('getPortalScenario', () => {
  it('returns the current scenario when the payload is valid', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify({ scenario: 'registered' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await assert.doesNotReject(async () => {
      const scenario = await getPortalScenario();
      assert.strictEqual(scenario, 'registered');
    });
  });

  it('throws a descriptive error when the control endpoint returns a non-OK response', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('portal unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
        }),
    );

    await assert.rejects(() => getPortalScenario(), /Failed to get portal scenario: 503 Service Unavailable — portal unavailable/);
  });

  it('throws when the control payload contains an unknown scenario', async () => {
    mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify({ scenario: 'mystery-mode' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    await assert.rejects(
      () => getPortalScenario(),
      /Mock portal returned invalid scenario payload: {"scenario":"mystery-mode"}. Expected one of: registered, unregistered, delayed, degraded/,
    );
  });
});
