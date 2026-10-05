import type { TailscaleStatusDto } from '@/api-client/types.gen';
import { type DiscoverablePoolPeer, type PoolPeer, type PoolStatus, isUnverifiedCandidate, mergePoolModels } from '../../helpers/hub-pool-shared';

/*
 * The Hub Pool setup guide's logic, with no React and no I/O so every rule is testable on its own.
 *
 * Nothing here is stored. The guide re-derives its position from the Hub's own pool status each time
 * it opens, which is what makes closing it safe and re-sending a request impossible by resuming.
 */

export type SetupStep = 'ready' | 'find' | 'connect' | 'approve';

/** How long a request waits before the guide says the other Hub may be slow to approve. */
export const PAIRING_WAIT_HINT_MS = 120_000;
/** How long the guide keeps polling for approval before it stops and offers Check again. */
export const PAIRING_WAIT_MAX_MS = 600_000;

/**
 * A literal shell command, so it is shown in `<code>` and deliberately not a translation key; the
 * sentence around it is. `<address>` and `<digits>` are for the operator to replace.
 */
export const PAIR_BY_ADDRESS_COMMAND = 'cihub pool pair <address> --pin <digits>';

/** The Tailscale admin console page that holds the MagicDNS and HTTPS certificate switches. */
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';

/** How many tailnet devices the empty state names before it says "and N more". */
export const MAX_NAMED_DEVICES = 8;

/* ── Readiness ──────────────────────────────────────────────────────────────────────────── */

/**
 * The slice of `GET /api/tailscale/status` the guide reads. Every field is optional because the Hub
 * reports a partial object while Tailscale is starting, and the generated type promises more than
 * that moment delivers.
 */
export type TailscaleSetupStatus = Partial<Pick<TailscaleStatusDto, 'installed' | 'connected' | 'nodeFqdn' | 'hostname' | 'httpsAvailable'>> & {
  servePermission?: Partial<TailscaleStatusDto['servePermission']>;
  peers?: TailscaleStatusDto['peers'];
};

export type ReadinessCheckId = 'pooling' | 'tailscale' | 'https' | 'serve' | 'direction';
export type ReadinessState = 'ok' | 'warn' | 'blocked';
export type ReadinessLevel = ReadinessState;
export type ReadinessAction = 'turn-on-pooling' | 'connect-tailscale' | 'open-tailscale-dns';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  state: ReadinessState;
  /** Translation key for the sentence under the check, when there is something to say. */
  detailKey?: string;
  detailParams?: Record<string, string>;
  /** The one fix the guide can perform or point at. Absent when the fix is outside this page. */
  action?: ReadinessAction;
  /** A command the operator runs on the Hub's computer. Carried only by the `serve` check. */
  remedy?: string;
}

export interface Readiness {
  checks: ReadinessCheck[];
  level: ReadinessLevel;
}

/**
 * What stands between this Hub and a pairing that works.
 *
 * `blocked` is reserved for what the guide cannot get past: pooling off, no Tailscale, no tailnet
 * name. HTTPS and Serve are `warn`, not `blocked`: they are read from this Hub's side of the tailnet,
 * so they cannot prove that the OTHER Hub publishes itself, and a wrong "blocked" would lock out a
 * pairing that would have worked.
 *
 * `ts` is `undefined` when the Tailscale query failed. That is an unknown, not a pass.
 */
export function assessReadiness({ ts, pool }: { ts: TailscaleSetupStatus | undefined; pool: PoolStatus }): Readiness {
  const checks: ReadinessCheck[] = [];

  if (pool.disabledBy === 'env') {
    checks.push({ id: 'pooling', state: 'blocked', detailKey: 'HUB_POOL_SETUP_POOLING_ENV' });
  } else if (pool.disabledBy === 'setting' || !pool.settings.poolEnabled) {
    checks.push({ id: 'pooling', state: 'blocked', detailKey: 'HUB_POOL_SETUP_POOLING_OFF', action: 'turn-on-pooling' });
  } else {
    checks.push({ id: 'pooling', state: 'ok' });
  }

  const tailscale = assessTailscale(ts);
  checks.push(tailscale);

  // Judged only once Tailscale is up: with it down, "HTTPS is off" would be a claim about a
  // connection that does not exist, and the list would show two problems for one cause.
  if (tailscale.state === 'ok' && ts) {
    if (ts.httpsAvailable === false) {
      checks.push({ id: 'https', state: 'warn', detailKey: 'HUB_POOL_SETUP_HTTPS_OFF', action: 'open-tailscale-dns' });
    } else {
      checks.push({ id: 'https', state: 'ok' });
    }

    if (ts.servePermission?.denied) {
      checks.push({ id: 'serve', state: 'warn', detailKey: 'HUB_POOL_SETUP_SERVE_DENIED', remedy: ts.servePermission.remedy || undefined });
    } else {
      checks.push({ id: 'serve', state: 'ok' });
    }
  }

  if (pool.directions.outbound.enabled) {
    checks.push({ id: 'direction', state: 'ok' });
  } else {
    checks.push({ id: 'direction', state: 'warn', detailKey: 'HUB_POOL_SETUP_DIRECTION_OFF' });
  }

  const level: ReadinessLevel = checks.some((check) => check.state === 'blocked')
    ? 'blocked'
    : checks.some((check) => check.state === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, level };
}

function assessTailscale(ts: TailscaleSetupStatus | undefined): ReadinessCheck {
  if (!ts) {
    return { id: 'tailscale', state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_UNKNOWN' };
  }
  if (!ts.installed) {
    return { id: 'tailscale', state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_MISSING' };
  }
  if (!ts.connected) {
    return { id: 'tailscale', state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_DISCONNECTED', action: 'connect-tailscale' };
  }
  if (!ts.nodeFqdn) {
    return { id: 'tailscale', state: 'blocked', detailKey: 'HUB_POOL_SETUP_TAILSCALE_NO_NAME' };
  }
  return { id: 'tailscale', state: 'ok', detailKey: 'HUB_POOL_SETUP_TAILSCALE_CONNECTED_AS', detailParams: { name: ts.nodeFqdn } };
}

/**
 * Where the guide opens. A Hub that already has any peer row opens on Approve and verify, even when
 * readiness is blocked: a connected Hub with Tailscale down still deserves to see its status, and
 * landing on Find or Connect would invite a second request to a Hub that already has one.
 */
export function chooseInitialStep({ peerCount, readiness }: { peerCount: number; readiness: Readiness }): SetupStep {
  if (peerCount > 0) return 'approve';
  return readiness.level === 'ok' ? 'find' : 'ready';
}

/* ── Discovery ──────────────────────────────────────────────────────────────────────────── */

/**
 * The scan result split into rows that can be paired and a count of those that cannot.
 *
 * An unverified row (heard over LAN mDNS) never gets a checkbox: every field of it came from an
 * unauthenticated datagram, and pairing would send this Hub's name, a fresh token and any typed PIN
 * to whatever host the packet named. This is the same rule the panel applies.
 */
export function selectPairable<T extends DiscoverablePoolPeer>(list: readonly T[]): { pairable: T[]; unverifiedCount: number } {
  const pairable: T[] = [];
  let unverifiedCount = 0;
  for (const device of list) {
    if (isUnverifiedCandidate(device)) {
      unverifiedCount += 1;
    } else {
      pairable.push(device);
    }
  }
  return { pairable, unverifiedCount };
}

/** Tailnet names compare case-insensitively and Tailscale writes them with a trailing dot in places. */
export const normalizeNodeName = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

export interface UnansweredDevice {
  name: string;
  /** The tailnet name, which is unique. `name` is the OS-reported hostname, and two devices can share it. */
  nodeFqdn: string;
  online: boolean;
}

/**
 * Devices the tailnet lists that did not answer the scan as a Hub, for the empty state. A device
 * that already has a peer row is left out (it answered once, it is just not "unpaired"), and so is
 * this Hub itself. `online` defaults to true: Tailscale omits the flag on some builds, and calling an
 * unknown device offline would be a claim the data does not support.
 */
export function unansweredTailnetDevices({
  ts,
  pool,
  limit = MAX_NAMED_DEVICES,
}: {
  ts: TailscaleSetupStatus | undefined;
  pool: PoolStatus;
  limit?: number;
}): { total: number; shown: UnansweredDevice[]; more: number } {
  const known = new Set(pool.peers.map((peer) => normalizeNodeName(peer.nodeFqdn)));
  if (ts?.nodeFqdn) known.add(normalizeNodeName(ts.nodeFqdn));
  if (pool.localNode.nodeFqdn) known.add(normalizeNodeName(pool.localNode.nodeFqdn));

  const devices = (ts?.peers ?? [])
    .filter((peer) => !known.has(normalizeNodeName(peer.nodeFqdn)))
    .map((peer) => ({ name: peer.hostname || peer.nodeFqdn, nodeFqdn: peer.nodeFqdn, online: peer.online !== false }));

  return { total: devices.length, shown: devices.slice(0, limit), more: Math.max(0, devices.length - limit) };
}

/* ── Sending ────────────────────────────────────────────────────────────────────────────── */

export type PairFailure = 'already' | 'invalid' | 'generic' | 'unreachable';

/**
 * What a failed `POST peers/pair` means, as far as the API lets anyone know.
 *
 * The backend throws a plain `Error` for a wrong PIN, a declined request, a TLS failure, a timeout, a
 * full pending queue and pairing with itself, and the exception filter turns every one of them into
 * the same 500. So 500 is read as "could not reach it, or it said no", and the copy lists causes
 * rather than naming one it cannot know. 409 is the one precise answer: a row for that Hub exists.
 */
export function classifyPairFailure(status: number | undefined): PairFailure {
  if (status === 409) return 'already';
  if (status === 400) return 'invalid';
  if (status === 401 || status === 403 || status === 404) return 'generic';
  return 'unreachable';
}

/**
 * The HTTP status of a failed SDK call. The app's response interceptor (`root.tsx`) throws a
 * `TranslatableError` carrying `http.status` for anything at 400 or above; a client without it (tests,
 * the desktop probes) hands back the parsed body and the raw `Response`, so the status comes from there.
 */
export function statusOf(error: unknown, response?: { status?: number } | null): number | undefined {
  const http = (error as { http?: { status?: unknown } } | null | undefined)?.http;
  if (typeof http?.status === 'number') return http.status;
  return typeof response?.status === 'number' ? response.status : undefined;
}

/* ── Waiting and verifying ──────────────────────────────────────────────────────────────── */

export type PeerProgress =
  | 'incoming'
  | 'waiting'
  | 'verifying'
  | 'verified'
  | 'disabled'
  | 'unreachable'
  | 'needs_repair'
  | 'needs_credentials'
  | 'half_paired';

/**
 * The states that waiting never clears, so the guide offers Unpair on them. `unreachable` is left out
 * on purpose: it heals by itself on the next probe that works.
 */
const UNPAIR_PROGRESS: readonly PeerProgress[] = ['needs_repair', 'needs_credentials', 'half_paired'];

export const canUnpair = (progress: PeerProgress): boolean => UNPAIR_PROGRESS.includes(progress);

/** Consecutive 403s on a never-read row before it is called half paired without waiting for the third strike. */
const HALF_PAIRED_EARLY_STRIKES = 2;

/**
 * This Hub approved an inbound request, but its probes of the requester are answered 403: the requester
 * still holds the request as pending, so the approval never reached it. That is how `capabilities`
 * answers an incomplete pairing; the guard's own refusals are 401.
 *
 * An `unreachable` row is already past three strikes, so the 403 alone settles it. A row still marked
 * `connected` that has never been read is called half paired after two, not three: the approve callback
 * takes up to ten seconds, so one 403 can be the probe racing it, but two probes a poll apart cannot.
 */
function isHalfPaired(peer: PoolPeer): boolean {
  if (peer.direction !== 'inbound' || peer.probeFailure?.kind !== 'unreachable' || peer.probeFailure.httpStatus !== 403) return false;
  return peer.status === 'unreachable' || (!peer.lastSeenAt && peer.consecutiveFailures >= HALF_PAIRED_EARLY_STRIKES);
}

/**
 * Where one peer row stands in the pairing, from the point of view of someone setting up a pool.
 *
 * `verified` needs both `lastSeenAt` and `lastCapabilities`: a row flips to `connected` the moment
 * the approval lands, before the first health probe has read what the Hub can serve. Calling it done
 * then would show "Connected" next to an empty model count.
 *
 * Three states need the operator to act, because the backend says waiting never clears them:
 * - `half_paired`: see {@link isHalfPaired}. Unpair here, then clean up the OTHER Hub.
 * - `needs_repair`: the Hub at that name is a different pool identity now (its database was recreated).
 * - `needs_credentials`: the peer answers 401 and refuses this Hub's credentials. It unpaired this Hub,
 *   lost its data, or disagrees about the time. It backs off up to 15 minutes and never recovers on its own.
 */
export function peerProgress(peer: PoolPeer): PeerProgress {
  if (peer.status === 'pending') return peer.direction === 'inbound' ? 'incoming' : 'waiting';
  if (!peer.enabled) return 'disabled';
  if (isHalfPaired(peer)) return 'half_paired';
  if (peer.status === 'connected') return peer.lastSeenAt && peer.lastCapabilities ? 'verified' : 'verifying';
  if (peer.probeFailure?.kind === 'identity_changed') return 'needs_repair';
  if (peer.probeFailure?.kind === 'unauthorized') return 'needs_credentials';
  return 'unreachable';
}

/**
 * Whether the approval step has anything to poll for: a request waiting on a human, or a connected
 * Hub whose models are not read yet. An empty or settled pool, or one with only unreachable peers,
 * does not poll: an unreachable peer heals on its own schedule, and watching it would never end.
 */
export function needsPolling(status: PoolStatus | undefined): boolean {
  if (!status) return false;
  return status.peers.some((peer) => {
    const progress = peerProgress(peer);
    return progress === 'incoming' || progress === 'waiting' || progress === 'verifying';
  });
}

/** Distinct models a peer reports as loaded on healthy backends. */
export function peerModelCount(peer: PoolPeer): number {
  const models = new Set<string>();
  for (const backend of peer.lastCapabilities?.backends ?? []) {
    if (!backend.healthy) continue;
    for (const model of backend.modelsLoaded) models.add(model);
  }
  return models.size;
}

/** Distinct models the whole pool can serve, this Hub included. Unreachable peers' cached models are left out. */
export function countPoolModels(status: PoolStatus): number {
  return mergePoolModels(status, 'local').length;
}

/* ── Home-page invitation ───────────────────────────────────────────────────────────────── */

export type PoolInvitation = { kind: 'none' } | { kind: 'invite' } | { kind: 'review'; requests: { id: string; label: string }[] };

/**
 * Which card, if any, the Home page shows.
 *
 * `review` is for the Hub on the RECEIVING end: a pairing request lands there as an inbound pending
 * row, and nothing else on that Hub says so. It ignores dismissal, registration and peer count on
 * purpose, because a request that needs a decision must not be hideable by an earlier "not now".
 * Its label is the requester's tailnet name, not the display name, for the reason the panel gives:
 * the display name is whatever an unauthenticated requester chose to call itself.
 *
 * `invite` is the first-run nudge: a registered Hub with Tailscale up and not one peer row, paired or
 * pending. `peerCounts.total` counts every row, so "zero" is exactly `total === 0`.
 */
export function poolInvitation({
  registered,
  demoMode,
  dismissed,
  status,
}: {
  registered: boolean;
  demoMode: boolean;
  dismissed: boolean;
  status: PoolStatus | undefined;
}): PoolInvitation {
  if (!status || demoMode) return { kind: 'none' };

  if (status.enabled) {
    const requests = status.peers
      .filter((peer) => peer.direction === 'inbound' && peer.status === 'pending')
      .map((peer) => ({ id: peer.id, label: peer.nodeFqdn }));
    if (requests.length > 0) return { kind: 'review', requests };
  }

  if (registered && status.enabled && status.localNode.tailscaleConnected && status.peerCounts.total === 0 && !dismissed) {
    return { kind: 'invite' };
  }
  return { kind: 'none' };
}

/* ── What a Hub card says about a machine ───────────────────────────────────────────────── */

export type HubOs = 'linux' | 'macos' | 'windows' | 'other';

/** Tailscale spells the OS several ways (`linux`, `macOS`, `windows`, `iOS`...). Unknown stays `other`, never a guess. */
export function normalizeOs(os: string | null | undefined): HubOs {
  const value = (os ?? '').trim().toLowerCase();
  if (value === 'linux') return 'linux';
  if (value === 'macos' || value === 'darwin') return 'macos';
  if (value === 'windows') return 'windows';
  return 'other';
}

export type HubTier = 'high' | 'medium' | 'cpu-only';

/** The pool's own hardware tiers. Anything else a newer peer reports is dropped rather than shown as a raw string. */
export function normalizeTier(tier: string | null | undefined): HubTier | null {
  return tier === 'high' || tier === 'medium' || tier === 'cpu-only' ? tier : null;
}

export interface PeerEngine {
  type: string;
  healthy: boolean;
}

/** The engines a connected Hub reported, in a stable order: healthy first, then by name. Empty when it reported none. */
export function peerEngines(peer: PoolPeer): PeerEngine[] {
  const backends = peer.lastCapabilities?.backends ?? [];
  return backends
    .map((backend) => ({ type: backend.type, healthy: backend.healthy }))
    .sort((a, b) => Number(b.healthy) - Number(a.healthy) || a.type.localeCompare(b.type));
}
