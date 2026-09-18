import { POOL_REFUSAL_IDENTITY_MISMATCH } from './hub-pool-peer-auth';

/**
 * Why a peer's capabilities probe failed, from what the health poll can observe.
 *
 * - `unreachable`: nothing answered, or the answer was not about us. This covers timeouts, DNS, TLS,
 *   a refused connection, 5xx, the far side's kill switch (503), and a pairing it still holds as
 *   pending (403). All of these can clear on their own, so the probe keeps its normal cadence.
 * - `unauthorized`: the peer answered 401. It no longer accepts this node's credentials. It may have
 *   unpaired us, lost its database, or rejected our signature over clock skew. Retrying every poll
 *   does not help any of these, and nothing on the wire says which one it is.
 * - `identity_changed`: the peer answered 401 AND said the pool identity we addressed is not its
 *   own (`X-Hub-Pool-Refusal: identity-mismatch`). The machine at that name is a different pool node
 *   now. In practice its Hub database was recreated.
 *
 * `identity_changed` is kept apart from `unauthorized` because it is the one verdict with a single
 * remedy. It is also the one this node must never "fix" by itself: re-pinning a key because the far
 * end says it changed is exactly what an impostor at that name would ask for.
 */
export type PoolPeerProbeFailureKind = 'unreachable' | 'unauthorized' | 'identity_changed';

/** A peer's current run of failed probes, as `/pool/status` reports it. Absent (`null`) while probes succeed. */
export interface PoolPeerProbeFailure {
  kind: PoolPeerProbeFailureKind;
  /** The HTTP status the peer answered with, or `null` when nothing answered. */
  httpStatus: number | null;
  /** The last failure's message, bounded. */
  detail: string;
  /** When this kind was first seen in the current run. Survives the backoff, so "for 28 hours" is visible. */
  since: string;
  lastAttemptAt: string;
  /** Consecutive failed probes of this kind. Resets when the kind changes. */
  attempts: number;
  /** When the next probe is due, or `null` when the peer is probed on every poll. */
  nextProbeAt: string | null;
  /** The operator's next step, or `null` when there is none because the failure clears on its own. */
  action: string | null;
}

/** A capabilities probe that got an HTTP answer. Carries what classification needs past the `catch`. */
export class PoolProbeHttpError extends Error {
  constructor(
    readonly status: number,
    /** The peer's `X-Hub-Pool-Refusal` value, when it sent one. */
    readonly refusal: string | null,
  ) {
    super(`capabilities probe returned ${status}${refusal ? ` (${refusal})` : ''}`);
    this.name = 'PoolProbeHttpError';
  }
}

/** Bound on {@link PoolPeerProbeFailure.detail}. The text can come from a network stack, and it ends up on a status screen. */
const MAX_DETAIL_LENGTH = 300;

export function classifyProbeFailure(error: unknown): Pick<PoolPeerProbeFailure, 'kind' | 'httpStatus' | 'detail'> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, MAX_DETAIL_LENGTH);
  if (!(error instanceof PoolProbeHttpError)) {
    return { kind: 'unreachable', httpStatus: null, detail };
  }
  if (error.status === 401) {
    return { kind: error.refusal === POOL_REFUSAL_IDENTITY_MISMATCH ? 'identity_changed' : 'unauthorized', httpStatus: 401, detail };
  }
  return { kind: 'unreachable', httpStatus: error.status, detail };
}

/**
 * Ceiling on the gap between probes of a peer that refuses us.
 *
 * Not "never again". A peer's database can be restored from a backup that holds its old identity, and
 * a clock can be corrected. A quarter of an hour is at most four log lines an hour per stale peer.
 * Before the backoff it was 120 at the default 30 s poll, for as long as nobody noticed.
 */
export const PROBE_BACKOFF_MAX_MS = 15 * 60 * 1000;

/**
 * How long to wait after the `attempts`-th consecutive failure of this kind before probing again.
 *
 * `unreachable` never backs off. It is the case that heals on its own, and the docs promise such a
 * peer rejoins on the next successful probe. Waiting longer would only delay that. The two refusal
 * kinds double from two polls up to {@link PROBE_BACKOFF_MAX_MS}.
 */
export function probeBackoffMs(kind: PoolPeerProbeFailureKind, attempts: number, pollIntervalMs: number): number {
  if (kind === 'unreachable' || attempts < 1) {
    return 0;
  }
  return Math.min(pollIntervalMs * 2 ** Math.min(attempts, 20), PROBE_BACKOFF_MAX_MS);
}

/**
 * The exact commands that re-pair two Hubs after one of them lost its pairing state.
 *
 * The order matters, and the first step is the one operators skip. The stale row here has to go
 * before a new pairing can exist: `pair` answers 409 while a row for that name exists, and a PIN
 * request from the far side is silently ignored for the same reason. The fingerprint check is left to
 * the operator on purpose, because accepting a new key is exactly the decision this node will not
 * make by itself.
 */
export function rePairSteps(peerFqdn: string, selfFqdn: string | null): string {
  const self = selfFqdn ?? '<this Hub>';
  return [
    `(1) here: cihub pool unpair ${peerFqdn}`,
    `(2) on ${peerFqdn}: cihub pool pairing-pin`,
    `(3) here: cihub pool pair ${peerFqdn} --pin <digits>`,
    `(4) on ${peerFqdn}: cihub pool approve ${self}, after comparing the key fingerprint with this Hub's cihub pool status`,
  ].join('; ');
}

/** The operator-facing next step for a failure kind. `null` for `unreachable`, which needs none. */
export function probeFailureAction(kind: PoolPeerProbeFailureKind, peerFqdn: string, selfFqdn: string | null): string | null {
  switch (kind) {
    case 'identity_changed':
      return `${peerFqdn} is now a different Hub Pool identity than the one paired here, so its Hub database was probably recreated. This Hub will not trust the new key by itself. Re-pair: ${rePairSteps(peerFqdn, selfFqdn)}.`;
    case 'unauthorized':
      return `${peerFqdn} refuses this Hub's credentials. Run cihub pool status on ${peerFqdn}. If it does not list ${selfFqdn ?? 'this Hub'}, it dropped the pairing (unpaired there, or its database was reset), so re-pair: ${rePairSteps(peerFqdn, selfFqdn)}. If it does list this Hub, compare the two clocks: signed requests allow 5 minutes of skew.`;
    default:
      return null;
  }
}
