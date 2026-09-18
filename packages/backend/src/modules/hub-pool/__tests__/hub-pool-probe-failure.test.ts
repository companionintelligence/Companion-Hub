import { describe, expect, it } from 'vitest';
import {
  classifyProbeFailure,
  PROBE_BACKOFF_MAX_MS,
  PoolProbeHttpError,
  probeBackoffMs,
  probeFailureAction,
  rePairSteps,
} from '../hub-pool-probe-failure';
import { POOL_REFUSAL_IDENTITY_MISMATCH } from '../hub-pool-peer-auth';

const POLL_MS = 30_000;
// Placeholder tailnet names only — docs/README.md tip-scrub policy.
const PEER = 'beta-max.example-tailnet.ts.net';
const SELF = 'core-14.example-tailnet.ts.net';

describe('classifyProbeFailure', () => {
  it('calls a 401 that names an identity mismatch identity_changed, not unauthorized', () => {
    // beta-max after its database volume was recreated: it holds a new UUID, so every peer's signed
    // probe addressed the old one. This is the verdict that has to reach the operator.
    expect(classifyProbeFailure(new PoolProbeHttpError(401, POOL_REFUSAL_IDENTITY_MISMATCH))).toEqual({
      kind: 'identity_changed',
      httpStatus: 401,
      detail: 'capabilities probe returned 401 (identity-mismatch)',
    });
  });

  it('keeps a bare 401 as unauthorized, because clock skew and a revoked pairing look identical on the wire', () => {
    expect(classifyProbeFailure(new PoolProbeHttpError(401, null)).kind).toBe('unauthorized');
  });

  it('does not let an unknown refusal value upgrade a 401 into identity_changed', () => {
    expect(classifyProbeFailure(new PoolProbeHttpError(401, 'something-else')).kind).toBe('unauthorized');
  });

  it.each([
    ['a timeout', new Error('The operation was aborted due to timeout'), null],
    ['a refused connection', new TypeError('fetch failed'), null],
    ['the far kill switch', new PoolProbeHttpError(503, null), 503],
    ['a pairing still pending on the far side', new PoolProbeHttpError(403, null), 403],
    ['a 5xx that happens to carry the refusal header', new PoolProbeHttpError(500, POOL_REFUSAL_IDENTITY_MISMATCH), 500],
  ])('treats %s as unreachable, the kind that heals on its own', (_label, error, httpStatus) => {
    expect(classifyProbeFailure(error)).toMatchObject({ kind: 'unreachable', httpStatus });
  });

  it('bounds the detail, since a network stack wrote it and a status screen shows it', () => {
    expect(classifyProbeFailure(new Error('x'.repeat(5_000))).detail).toHaveLength(300);
  });
});

describe('probeBackoffMs', () => {
  it('never delays an unreachable peer, so a node that comes back rejoins on the next poll', () => {
    for (const attempts of [1, 5, 500]) {
      expect(probeBackoffMs('unreachable', attempts, POLL_MS)).toBe(0);
    }
  });

  it('stops a refusing peer from being probed every poll, doubling up to the ceiling', () => {
    // Before this, beta-max's peers probed it 120 times an hour for 28 hours.
    expect([1, 2, 3, 4, 5, 6].map((attempts) => probeBackoffMs('identity_changed', attempts, POLL_MS))).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      PROBE_BACKOFF_MAX_MS,
      PROBE_BACKOFF_MAX_MS,
    ]);
    expect(probeBackoffMs('unauthorized', 1, POLL_MS)).toBe(60_000);
  });

  it('still probes a refusing peer eventually, so a restored database or a fixed clock is noticed', () => {
    expect(probeBackoffMs('identity_changed', 3169, POLL_MS)).toBe(PROBE_BACKOFF_MAX_MS);
    expect(Number.isFinite(probeBackoffMs('unauthorized', Number.MAX_SAFE_INTEGER, POLL_MS))).toBe(true);
  });
});

describe('probeFailureAction', () => {
  it('gives an identity change the full re-pair, starting with the stale row here that everyone skips', () => {
    const action = probeFailureAction('identity_changed', PEER, SELF);

    expect(action).toContain(`cihub pool unpair ${PEER}`);
    expect(action).toContain(`on ${PEER}: cihub pool pairing-pin`);
    expect(action).toContain(`cihub pool pair ${PEER} --pin <digits>`);
    expect(action).toContain(`cihub pool approve ${SELF}`);
    // The unpair has to come first: `pair` answers 409 while the stale row still holds the name.
    expect(action?.indexOf('unpair')).toBeLessThan(action?.indexOf('pairing-pin') ?? -1);
    expect(action).toContain('will not trust the new key by itself');
  });

  it('gives a bare 401 both likely causes instead of sending the operator straight to a re-pair', () => {
    const action = probeFailureAction('unauthorized', PEER, SELF);

    expect(action).toContain(`cihub pool status on ${PEER}`);
    expect(action).toContain(rePairSteps(PEER, SELF));
    expect(action).toContain('5 minutes of skew');
  });

  it('asks nothing of the operator for an unreachable peer', () => {
    expect(probeFailureAction('unreachable', PEER, SELF)).toBeNull();
  });

  it('still names a usable approve step when this Hub does not know its own tailnet name', () => {
    expect(rePairSteps(PEER, null)).toContain('cihub pool approve <this Hub>');
  });
});
