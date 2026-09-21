import { describe, expect, it } from 'vitest';
import { normalizeReadinessBody, unknownReadiness } from '../app-readiness.helpers';

const SAMPLED_AT = '2026-09-21T12:00:00.000Z';

/** Verbatim from CI-Hub#1556: hermes-agent v0.21.3 `GET /health/detailed` against the real APIServerAdapter. */
const HERMES_DETAILED_BODY = {
  status: 'degraded',
  readiness: {
    status: 'degraded',
    checks: {
      state_db: { status: 'ok' },
      session_store: { status: 'ok' },
      config: { status: 'ok', detail: 'using defaults' },
      model: { status: 'degraded' },
      disk: { status: 'ok', used_percent: 51.4, free_bytes: 8085114880 },
      gateway: { status: 'degraded', state: 'unknown', connected_platforms: 0, platforms: 0 },
      background_queues: { status: 'ok', active_api_runs: 0, process_completions: 0, active_delegations: 0 },
    },
  },
  platform: 'hermes-agent',
  version: '0.21.3',
  gateway_state: null,
  platforms: {},
  active_agents: 0,
  gateway_busy: false,
  gateway_drainable: false,
  exit_reason: null,
  updated_at: null,
  pid: 1003787,
};

/** Hermes's unauthenticated `/health`: `{status, platform, version}` and nothing else. */
const HERMES_BARE_BODY = { status: 'ok', platform: 'hermes-agent', version: '0.21.3' };

describe('normalizeReadinessBody', () => {
  it('maps the Hermes /health/detailed body onto the normalised shape, keeping only status and detail per check', () => {
    expect(normalizeReadinessBody(HERMES_DETAILED_BODY, SAMPLED_AT)).toEqual({
      status: 'degraded',
      checks: {
        state_db: { status: 'ok' },
        session_store: { status: 'ok' },
        config: { status: 'ok', detail: 'using defaults' },
        model: { status: 'degraded' },
        disk: { status: 'ok' },
        gateway: { status: 'degraded' },
        background_queues: { status: 'ok' },
      },
      busy: false,
      drainable: false,
      sampledAt: SAMPLED_AT,
    });
  });

  it('passes gateway_busy / gateway_drainable through as booleans', () => {
    const body = { ...HERMES_DETAILED_BODY, gateway_busy: true, gateway_drainable: true };
    const result = normalizeReadinessBody(body, SAMPLED_AT);
    expect(result.busy).toBe(true);
    expect(result.drainable).toBe(true);
  });

  it('reads a bare /health body as ok with no checks, and busy/drainable as unsaid', () => {
    expect(normalizeReadinessBody(HERMES_BARE_BODY, SAMPLED_AT)).toEqual({
      status: 'ok',
      checks: {},
      busy: null,
      drainable: null,
      sampledAt: SAMPLED_AT,
    });
  });

  it('reads a body with no readiness block and no top-level ok as unknown', () => {
    expect(normalizeReadinessBody({ platform: 'something' }, SAMPLED_AT).status).toBe('unknown');
    expect(normalizeReadinessBody({ status: 'degraded' }, SAMPLED_AT).status).toBe('unknown');
    expect(normalizeReadinessBody({ status: 'OK' }, SAMPLED_AT).status).toBe('unknown');
  });

  it('reads garbage as unknown instead of throwing', () => {
    for (const garbage of [null, undefined, 'ok', 42, true, [], ['ok'], { readiness: 'ok' }, { readiness: ['ok'] }, { readiness: null }]) {
      expect(normalizeReadinessBody(garbage, SAMPLED_AT)).toEqual(unknownReadiness(SAMPLED_AT));
    }
  });

  it('does not guess degraded from a readiness status this build does not know', () => {
    // A future `starting` must not raise a false alarm; the checks still come through.
    const result = normalizeReadinessBody(
      { readiness: { status: 'starting', checks: { model: { status: 'degraded' }, disk: { status: 'ok' } } } },
      SAMPLED_AT,
    );
    expect(result.status).toBe('unknown');
    expect(result.checks).toEqual({ model: { status: 'degraded' }, disk: { status: 'ok' } });
  });

  it('skips checks that are not objects with a string status, and blank details', () => {
    const result = normalizeReadinessBody(
      {
        readiness: {
          status: 'ok',
          checks: {
            fine: { status: 'ok', detail: '   ' },
            numeric: { status: 1 },
            text: 'ok',
            missing: {},
            nested: { status: 'unavailable', detail: 'session store gone' },
          },
        },
      },
      SAMPLED_AT,
    );
    expect(result.checks).toEqual({ fine: { status: 'ok' }, nested: { status: 'unavailable', detail: 'session store gone' } });
  });

  it('treats a readiness block with no checks as having none, not as malformed', () => {
    const result = normalizeReadinessBody({ readiness: { status: 'ok' }, gateway_busy: 'yes' }, SAMPLED_AT);
    expect(result).toEqual({ status: 'ok', checks: {}, busy: null, drainable: null, sampledAt: SAMPLED_AT });
  });
});
