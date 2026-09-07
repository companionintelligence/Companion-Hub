/** Which of the two kill switches turned Hub pooling off. `null` when it is on. */
export type HubPoolDisabledBy = 'env' | 'setting';

export interface HubPoolEnabledState {
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
}

/**
 * The two halves of pooling, which an operator can now switch independently.
 *
 * They are genuinely different decisions and were only ever coupled because there was one switch:
 * "stop spending my peers' GPU" (outbound) and "stop spending mine on my peers" (inbound) are the
 * two things people actually ask for, and a node that gives without taking is the normal shape of a
 * heterogeneous fleet.
 */
export type HubPoolDirection = 'outbound' | 'inbound';

export interface HubPoolDirectionalState {
  /** Whether this node may send work TO peers. */
  outbound: HubPoolEnabledState;
  /** Whether this node may serve work FOR peers. */
  inbound: HubPoolEnabledState;
}

/**
 * Environment overrides, one per switch. Read straight from `process.env` like
 * `HUB_POOL_USER_DISABLED`: the hub `.env` is loaded wholesale into the backend container
 * (`env_file` in docker-compose.prod.yml), so no compose change is needed to add one.
 *
 * None of them may be projected into `.env` by `generateSystemEnvFile`, for the reason documented
 * on {@link resolveHubPoolEnabled}: env-first precedence would make the flag permanent and the
 * operator could never switch it back from the UI.
 */
export const HUB_POOL_DISABLED_ENV_VAR = 'HUB_POOL_USER_DISABLED';
export const HUB_POOL_OUTBOUND_DISABLED_ENV_VAR = 'HUB_POOL_OUTBOUND_DISABLED';
export const HUB_POOL_INBOUND_DISABLED_ENV_VAR = 'HUB_POOL_INBOUND_DISABLED';

/**
 * Multi-Hub inference pooling kill switch. Existing pairing state is unaffected —
 * this gates whether a connected peer is treated as usable
 * (`HubPoolPeerService.hasConnectedPeers`), whether this node still answers peer
 * capability probes, and whether it accepts new pairing requests, so a disabled
 * Hub stops routing through the pool and naturally reads as unreachable to its
 * peers.
 *
 * Two switches, and the environment wins. `HUB_POOL_USER_DISABLED=true` in the hub
 * `.env` (matching the `PRIVATE_VPN_USER_DISABLED` convention) is an operator-of-the-box
 * decision that a UI toggle must not be able to undo; the persisted `hubPoolEnabled`
 * setting is the in-product switch and is opt-out, so `undefined` means on. The two are
 * reported separately rather than collapsed into one boolean precisely so the UI can say
 * "disabled in the .env" instead of showing a toggle that silently does nothing.
 *
 * Deliberately NOT projected into `.env` by `generateSystemEnvFile`: routing the setting
 * through `HUB_POOL_USER_DISABLED` would make `resolve()`'s env-first precedence apply to
 * the Hub's own persisted value, and the operator could never turn pooling back on from
 * the UI once the flag had been written to disk.
 */
export function resolveHubPoolEnabled(persistedEnabled: boolean | undefined): HubPoolEnabledState {
  if (process.env[HUB_POOL_DISABLED_ENV_VAR] === 'true') {
    return { enabled: false, disabledBy: 'env' };
  }
  if (persistedEnabled === false) {
    return { enabled: false, disabledBy: 'setting' };
  }
  return { enabled: true, disabledBy: null };
}

/** {@link resolveHubPoolEnabled} when only the yes/no answer is wanted. */
export function isHubPoolEnabled(persistedEnabled?: boolean): boolean {
  return resolveHubPoolEnabled(persistedEnabled).enabled;
}

/**
 * The effective state of each direction, and this file is the ONLY place that decides it.
 *
 * Precedence, highest first, per direction:
 *  1. `HUB_POOL_USER_DISABLED=true` — master, both directions off, `disabledBy: 'env'`.
 *  2. persisted `poolEnabled === false` — master, both directions off, `disabledBy: 'setting'`.
 *  3. `HUB_POOL_{OUTBOUND,INBOUND}_DISABLED=true` — that direction off, `'env'`.
 *  4. persisted `pool{Outbound,Inbound}Enabled === false` — that direction off, `'setting'`.
 *  5. otherwise on.
 *
 * The master short-circuits both directions rather than being folded in per-axis, so an operator
 * who turns pooling off never has to reason about what the directional switches were left at. Every
 * new switch is opt-out (`undefined` = on), so an untouched `settings.json` and an untouched `.env`
 * resolve to exactly today's behaviour on both axes.
 *
 * Callers must not re-derive any of this: `HubPoolPeerService.directions()` and
 * `PoolProxyService` both read the answer from here, and the truth table is pinned in
 * `__tests__/hub-pool.test.ts`.
 */
export function resolveHubPoolDirections(
  prefs: Pick<HubPoolPreferences, 'poolEnabled' | 'poolOutboundEnabled' | 'poolInboundEnabled'>,
): HubPoolDirectionalState {
  const master = resolveHubPoolEnabled(prefs.poolEnabled);
  if (!master.enabled) {
    return { outbound: { ...master }, inbound: { ...master } };
  }
  return {
    outbound: resolveDirection(HUB_POOL_OUTBOUND_DISABLED_ENV_VAR, prefs.poolOutboundEnabled),
    inbound: resolveDirection(HUB_POOL_INBOUND_DISABLED_ENV_VAR, prefs.poolInboundEnabled),
  };
}

function resolveDirection(envVar: string, persisted: boolean | undefined): HubPoolEnabledState {
  if (process.env[envVar] === 'true') {
    return { enabled: false, disabledBy: 'env' };
  }
  if (persisted === false) {
    return { enabled: false, disabledBy: 'setting' };
  }
  return { enabled: true, disabledBy: null };
}

/**
 * Message for a 503 refusing a peer because pooling is off here. Names the switch that is actually
 * responsible: an operator told "set HUB_POOL_USER_DISABLED" when the real cause is the UI toggle
 * would go looking in the wrong file.
 */
export function describeHubPoolDisabled(disabledBy: HubPoolDisabledBy | null): string {
  return disabledBy === 'setting'
    ? 'Hub pooling is disabled on this node (turned off in Settings → Network → Hub Pool)'
    : `Hub pooling is disabled on this node (${HUB_POOL_DISABLED_ENV_VAR})`;
}

/**
 * Why this node is refusing a peer's *work* while still being in the pool.
 *
 * Deliberately worded apart from {@link describeHubPoolDisabled}: the master switch means "I have
 * left the pool" and answers 503 on the capability probe so peers mark this node unreachable, while
 * these two mean "I am still here, still using you, just not serving right now" — which is a live,
 * healthy node the peer must keep polling. The 503 on `/local/*` exists only so a request already
 * in flight against a cached snapshot fails over instead of hanging.
 */
export function describeHubPoolInboundRefused(reason: HubPoolInboundRefusal): string {
  return reason === 'peer_disabled'
    ? 'This node is not exchanging work with your node right now (the operator disabled this peer here)'
    : 'This node is not accepting pooled work right now (inbound pooling is switched off here)';
}

/** Which of the two finer switches is refusing a peer's work. Never the master, which 503s instead. */
export type HubPoolInboundRefusal = 'inbound_disabled' | 'peer_disabled';

/**
 * The head start the local node gets over a peer, in queued requests.
 *
 * This is a real advantage, not favouritism: a follow-up turn served here reuses the prompt prefix
 * and KV cache the previous turn left resident, while the same turn sent to a peer re-processes the
 * whole prompt cold. One queued request is roughly what that re-processing costs, so work only
 * leaves this node once a peer is at least that much emptier. Higher values make handoff rarer
 * (stickier to local).
 *
 * At 0 the pool ranks purely by queue depth, with one documented exception: an *exact* score tie
 * still goes to local, because `LOCAL_TIER_RANK` beats every peer tier. That is the right
 * behaviour — a free local node has no hop and a warm cache — but it is a tie-break, not a
 * handicap, so "0 = pure least-loaded" overstated it and this says what actually happens.
 */
export const DEFAULT_POOL_LOCAL_AFFINITY = 1;
/**
 * Stays at 0 for now, deliberately.
 *
 * A negative floor ("this node is the weak one — prefer the peer") is the one thing the scale
 * cannot express, and the formula already handles it: `peerScore = peerLoad + affinity` sorts
 * negatives correctly with no ranking change at all. What blocks it is the rollback direction. The
 * bounds are build constants, so a Hub that saved -5 and then rolls back one build would have
 * persisted a value the older build rejects, and the settings-parse hardening that degrades such a
 * value to the default fixes forwards, not backwards. Widen this one release after that degrade is
 * on every fleet node; nobody has asked to prefer peers over local, so waiting costs nothing.
 */
export const MIN_POOL_LOCAL_AFFINITY = 0;
/** Above this the local node effectively never hands off, which is indistinguishable from disabling the pool — use the kill switch for that instead. */
export const MAX_POOL_LOCAL_AFFINITY = 20;

/**
 * The GPU-pressure band a node is assumed to be at when nothing could measure it.
 *
 * Deliberately not 0, and for exactly the reason `UNKNOWN_PEER_LOAD` is not 0: the pool must never
 * be able to make a node MORE attractive by failing to report. On this fleet most nodes cannot
 * measure at all (the signal is AMD-only), so "unmeasured" is the common case, not the exception —
 * if it read as idle the default deployment would route every tie to whichever machine knows least
 * about itself. Mid-band is the only honest answer to "I don't know".
 */
export const UNKNOWN_PRESSURE = 1;

/** Bands run 0 (idle) to 3 (saturated), matching the shape NVIDIA's PAIR publishes. */
export const MAX_PRESSURE_BAND = 3;

/**
 * A peer's self-reported band, reduced to something the ranker may use, or `null` for "unmeasured".
 *
 * This runs on the READ path, not only where the value is written, because `last_capabilities` is
 * free-form jsonb a paired peer fully controls and rows can predate any write-side check. `-5`,
 * `99`, `1.5`, `'low'`, `null`, `NaN` and a missing key all land on `null` here, which every caller
 * then reads as {@link UNKNOWN_PRESSURE}. Same never-optimistic rule `tierRank` already applies to
 * an unrecognised `hardwareTier`.
 */
export function clampPressureBand(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_PRESSURE_BAND ? raw : null;
}

/**
 * Whether a peer's cached capability snapshot is recent enough to believe.
 *
 * Judged on `lastSeenAt`, stamped by OUR clock when the probe succeeded, never on the peer's own
 * `capabilities.updatedAt` — comparing another machine's clock to ours would read skew as staleness
 * (or, worse, staleness as freshness). Extracted here so the queue-depth reader and the pressure
 * reader cannot drift apart on what "stale" means; they are two fields of one snapshot.
 */
export function isCapabilitiesSnapshotFresh(lastSeenAt: string | null, freshnessMs: number, now: number = Date.now()): boolean {
  const observedAt = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  return Number.isFinite(observedAt) && now - observedAt <= freshnessMs;
}

/**
 * The pressure band this node will actually rank a peer at, or `null` when nothing is known.
 *
 * Mirrors {@link clampPressureBand} and `PoolProxyService.peerLoad` in one place so `/pool/status`
 * shows the operator the number routing actually believes, rather than the raw jsonb.
 *
 * `forwardedInFlight` is the floor, and it is the whole anti-gaming story: the band is otherwise
 * purely self-reported, so a peer that pins `gpuPressure: 0` forever would win every tie forever.
 * What we have handed it and not yet finished reading is the one part of its GPU load we can
 * observe ourselves — a peer running three of our requests is not at band 0 whatever it claims.
 * Taking the larger of the two (rather than the sum) is the same reasoning as `peerLoad`: both
 * numbers describe the same work from different vantage points.
 *
 * A stale snapshot discards the peer's claim but keeps the floor, again exactly as `peerLoad` does.
 */
export function effectivePeerPressureBand(params: { reported: unknown; snapshotFresh: boolean; forwardedInFlight: number }): number | null {
  const claimed = params.snapshotFresh ? clampPressureBand(params.reported) : null;
  const floor = Math.min(MAX_PRESSURE_BAND, Math.max(0, Math.trunc(params.forwardedInFlight) || 0));
  if (claimed === null && floor === 0) {
    return null;
  }
  return Math.max(claimed ?? 0, floor);
}

/**
 * How much the 0-3 GPU-pressure band contributes to a candidate's score.
 *
 * Zero, deliberately, and that is not timidity: at 0 the pressure key is not in the comparator at
 * all and the score term vanishes, so ranking is bit-for-bit what the previous build produced on
 * every node — measured or not. The band is unvalidated on real fleet hardware, and the honest
 * order is to ship the measurement, watch `/pool/status` for a week, then flip the default.
 *
 * At 1 this is PAIR verbatim (`pending + pressure`), which is what lets the pool move work off a
 * node whose queue is empty but whose GPU is committed to something that never came through the
 * pool — ComfyUI, a direct `ollama run`, another orchestrator on a shared host engine.
 */
export const DEFAULT_POOL_PRESSURE_WEIGHT = 0;
export const MIN_POOL_PRESSURE_WEIGHT = 0;
/** Above 3 one band outweighs the entire 0-3 scale plus a full queue, which is a kill switch spelled badly. */
export const MAX_POOL_PRESSURE_WEIGHT = 3;

/** How often each `connected`/`unreachable` peer is probed for capabilities. */
export const DEFAULT_POOL_HEALTH_POLL_SECONDS = 30;
/** Below this the probes cost more than the routing accuracy they buy, and an 8s probe timeout would start overlapping ticks. */
export const MIN_POOL_HEALTH_POLL_SECONDS = 10;
/** Above this a peer can be down for over 15 minutes (three strikes) before it stops being offered as a candidate. */
export const MAX_POOL_HEALTH_POLL_SECONDS = 300;

/**
 * How many health polls a peer's capability snapshot stays trusted for, after which its
 * self-reported load is discarded and it ranks as mid-load. Matches the three strikes that mark a
 * peer unreachable — a peer still `connected` but two polls behind is exactly the case this covers.
 * Expressed in polls rather than milliseconds so it tracks a retuned poll interval automatically.
 */
export const CAPABILITIES_FRESHNESS_POLLS = 3;

/** Operator-editable pool tuning, resolved against the DEFAULT_POOL_* constants. */
export interface HubPoolPreferences {
  /** The persisted half of the kill switch only — pass it through {@link resolveHubPoolEnabled} to get the effective state. */
  poolEnabled: boolean;
  /**
   * The persisted half of the outbound switch only. Absent in `settings.json` means on, and the
   * master switch above overrides it — resolve both through {@link resolveHubPoolDirections}.
   */
  poolOutboundEnabled: boolean;
  /** The persisted half of the inbound switch only. Same resolution rule as `poolOutboundEnabled`. */
  poolInboundEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
  /**
   * Refuse the legacy bearer-token branch outright, on the guard AND on the outbound client.
   *
   * The explicit "no downgrade path" switch, and DEFAULT FALSE because turning it on across a
   * mixed-version fleet is an outage: any peer that has not yet completed the bearer→signed upgrade
   * stops authenticating in both directions the moment it is set. Flip it once
   * `GET /inference/pool/status` shows every peer with `authMode: 'signed'`.
   */
  poolRequireSignedPeers: boolean;
  /** How heavily the GPU-pressure band counts in candidate ranking. 0 (the default) keeps ranking byte-identical to the pre-pressure build. */
  poolPressureWeight: number;
}

/**
 * How long a row that has just pinned a peer's key keeps honouring that peer's bearer token while
 * waiting for evidence the peer really did upgrade.
 *
 * Derived from the poll cadence rather than fixed, so an operator who slowed the health poll to its
 * 300s maximum still gets four polls' worth of chances before the pinning is rolled back and
 * retried. The 10-minute floor is what a default-cadence fleet gets.
 */
export function bearerUpgradeGraceMs(poolHealthPollSeconds: number): number {
  return Math.max(600_000, poolHealthPollSeconds * 1000 * 4);
}

const MAX_FQDN_LENGTH = 253;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Canonicalizes a peer node FQDN, or returns `null` when the value is anything
 * but a bare multi-label hostname.
 *
 * A peer FQDN is both the unique key of its `hub_pool_peer` row and the host
 * this Hub interpolates into `https://<fqdn>/api/inference/pool/...` on every
 * handshake and health call, and pairing requests arrive unauthenticated — so a
 * value carrying a scheme, credentials, port, path, query or fragment would let
 * the requester choose where those calls (and the token they carry) go. Only the
 * MagicDNS shape Tailscale actually hands out is accepted; IP literals are
 * refused as well, since the tailnet name is the trust anchor and an address
 * bypasses the hostname-based TLS check.
 */
export function normalizePeerFqdn(raw: string): string | null {
  // A single trailing dot is the legal absolute-DNS form of the same name; anything else
  // (empty labels, leading dots) falls out of the per-label check below.
  const candidate = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.length > MAX_FQDN_LENGTH) {
    return null;
  }

  const labels = candidate.split('.');
  if (labels.length < 2 || !labels.every((label) => HOSTNAME_LABEL.test(label))) {
    return null;
  }
  // `1.2.3.4` and `12345.67890` pass the label check but are addresses, not names.
  if (/^\d+$/.test(labels[labels.length - 1] as string)) {
    return null;
  }

  return candidate;
}

/**
 * Headers a reverse proxy in front of the Hub adds and a caller cannot remove.
 *
 * `cf-ray` is already the Hub's established "arrived through the Cloudflare tunnel" signal (see
 * `AuthController.isTunnelRequest`); the rest are the same marker under Cloudflare's other names.
 * `x-forwarded-for` is deliberately NOT in this list — it is caller-controlled, so its presence
 * proves nothing on its own and callers handle it with their own rules ({@link PoolAppGuard} walks
 * every hop; {@link callerSourceIp} treats it as one more reason not to trust `req.ip`).
 */
export const TUNNEL_MARKER_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'true-client-ip'] as const;

/**
 * The caller's own address, or `undefined` when this Hub cannot honestly say what it is.
 *
 * `request.ip` is NOT the caller behind Traefik or the Cloudflare tunnel: it is the proxy's own
 * private address, because Express `trust proxy` is left unset by default (`HUB_TRUST_PROXY`, see
 * main.ts, and the same caveat is written on `InternalNetworkGuard` and `PoolAppGuard`). A
 * "per-source" rate limit keyed on that value is keyed on ONE value for every caller in the world —
 * a global limit wearing a per-source costume. For the pairing PIN that is worse than useless: the
 * PIN's real defence is its own attempt ceiling, and a global lockout would hand any caller that
 * can reach the tunnel a way to stop the operator pairing at all, which is exactly the failure mode
 * `HubPoolPairingPinService` says it is avoiding.
 *
 * So the address is returned only in the two cases where it really is the caller's:
 *   - `HUB_TRUST_PROXY` is set — Express has resolved the forwarded chain, so `request.ip` IS the
 *     client, and this becomes the meaningful defence-in-depth the variable exists to enable.
 *   - the request carries no proxy provenance at all — nothing sat in front of it, so `request.ip`
 *     is the client. This is the LAN and tailnet case, which is how pool peers actually arrive.
 *
 * Otherwise: `undefined`, and the caller keys its limiter on whatever else it has. Refusing to
 * guess is the point — a wrong key is not a weaker limit, it is a different limit on a different
 * thing.
 */
export function callerSourceIp(
  request: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  trustProxy: string | undefined = process.env.HUB_TRUST_PROXY,
): string | undefined {
  if (!request.ip) {
    return undefined;
  }
  if (trustProxy?.trim()) {
    return request.ip;
  }
  const headers = request.headers ?? {};
  for (const header of TUNNEL_MARKER_HEADERS) {
    if (headers[header]) {
      return undefined;
    }
  }
  return headers['x-forwarded-for'] ? undefined : request.ip;
}
