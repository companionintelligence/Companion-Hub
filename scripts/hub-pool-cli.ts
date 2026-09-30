/**
 * `cihub pool` — API calls and pure formatters for multi-Hub inference pooling.
 *
 * Split out of `cihub-cli.ts` the way `network-diagnostics-cli.ts` is: the formatters take a payload
 * and return lines, so presentation is asserted with no mocking, and `cihub-cli.ts` keeps only the
 * arg/confirm/box plumbing. It must not import `cihub-cli.ts` for values — that file imports this
 * one, and the dispatcher imports that.
 *
 * Every response type here is hand-mirrored from
 * `packages/backend/src/modules/hub-pool/hub-pool.types.ts` and `hub-pool-routing-log.service.ts`:
 * the pool routes all declare an empty response schema in swagger.json, so the generated client types
 * them as `unknown` and there is nothing to import.
 */
import { sanitizeForBox } from './lib/cli-ui';
import { hubApiFetch } from './public-web-cli';

/** Reads are cheap and local; a hung one should surface, not wedge the CLI. Matches register-hub's GET budget. */
const POOL_GET_TIMEOUT_MS = 10_000;
/** Pairing is a two-way handshake with a peer that may be offline, so it gets the POST budget, not the GET one. */
const POOL_MUTATION_TIMEOUT_MS = 30_000;

/** 'rejected' was retired in migration 0059 — nothing ever wrote it, and it overlapped `enabled`. */
export type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';
export type PoolStatusReason = 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';

/** One side of the kill switch, as `/status` reports it. */
export interface PoolEnabledState {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
}

/** How a peer authenticates to this node. `signed` is the pinned-Ed25519 path; `bearer` is the legacy token. */
export type PoolPeerAuthMode = 'bearer' | 'signed';

/** Mirrors `PoolPeerProbeFailure` in `hub-pool-probe-failure.ts`: why a peer's health probes fail, and the operator's next step. */
export interface PoolPeerProbeFailure {
  kind: 'unreachable' | 'unauthorized' | 'identity_changed';
  httpStatus: number | null;
  detail: string;
  since: string;
  lastAttemptAt: string;
  attempts: number;
  nextProbeAt: string | null;
  action: string | null;
}

/** This node's own pool identity, as `/status` reports it. Never the private key. */
export interface PoolIdentitySummary {
  nodeUuid: string | null;
  publicKeyFingerprint: string | null;
  /** Why identity is unusable, when it is. Reported rather than thrown — see `hub-pool.types.ts`. */
  identityError: string | null;
}

/**
 * Whether a pairing PIN is outstanding on this node, and until when. Never the digits: those are
 * returned exactly once, by {@link mintPairingPin}, so polling `/status` can never re-serve them.
 */
export interface PoolPairingPinState {
  active: boolean;
  expiresAt: string | null;
}

export interface PoolBackendCapability {
  type: string;
  healthy: boolean;
  modelsLoaded: string[];
}

export interface PoolPeerRow {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: PoolPeerStatus;
  /** Per-peer kill switch. Absent on a Hub predating it, where every peer is in the pool. */
  enabled?: boolean;
  consecutiveFailures: number;
  lastSeenAt: string | null;
  lastCapabilities: { hardwareTier?: string; backends?: PoolBackendCapability[]; inFlightRequests?: number; acceptingWork?: boolean } | null;
  /** Present on `/status` rows only, and absent on a Hub predating it: why probes of this peer are failing. `null` while they succeed. */
  probeFailure?: PoolPeerProbeFailure | null;
  /** Present on `/status` rows only: what this node currently has forwarded to the peer. */
  inFlightRequests?: number;
  /**
   * How this peer authenticates to us today. Absent on a Hub predating pinned identities, which is
   * read the same way as `'bearer'`: not yet upgraded.
   */
  authMode?: PoolPeerAuthMode;
  /** A short hash of the peer's pinned public key, for an operator comparing two screens. Never the key. */
  peerKeyFingerprint?: string | null;
  /**
   * Present on `/status` rows only: the prompt ceiling the peer advertised, as this Hub's routing reads
   * it. `null` is no ceiling; absent is a Hub predating ceilings. Both mean the peer serves any prompt.
   */
  maxPromptTokens?: number | null;
  /**
   * The context cap the peer advertised, as this Hub's routing reads it — on `/status` rows and on
   * `/peers` rows alike, since a cap now decides which nodes a large window may go to.
   *
   * `null` is "no cap advertised", which routing reads as "takes any window"; absent is a Hub
   * predating caps on this route. Neither may be rendered as a number, and neither is a default.
   */
  maxNumCtx?: number | null;
  /** Present on `/status` rows only: the Ollama slot count the peer advertised, as routing reads it. `null` is not stated; absent is a Hub predating slots. */
  ollamaSlots?: number | null;
  /** Present on `/status` rows only: the peer's rates as timed here and as it reported them. Absent on a Hub predating throughput. */
  throughput?: { observed: PoolThroughputEstimate[]; advertised: PoolThroughputEstimate[] };
}

/** Mirrors `PoolThroughputEstimate` in `hub-pool.types.ts`. Rates are in estimated tokens (bytes / 4). */
export interface PoolThroughputEstimate {
  model: string;
  backend: string;
  prefill: { fromTokens: number; promptTokens: number; tokensPerSec: number; deadline: boolean; ageMs: number }[];
  decode: { tokensPerSec: number; ageMs: number } | null;
}

export interface PoolRoutingSummary {
  recorded: number;
  capacity: number;
  served: number;
  failed: number;
  /**
   * How many of `failed` ended because the CALLER hung up rather than because routing failed.
   * Absent on a Hub predating the flag, which is why nothing here infers it from `failed`.
   */
  clientClosed?: number;
  /**
   * How many of `failed` an engine refused as a bad request, so the walk returned the refusal to the
   * app. Absent on a Hub predating the field, and never inferred from `failed` for the same reason.
   */
  requestErrors?: number;
  /** How many of `failed` a node answered 200 for with output that was cut off or degenerate. Absent on a Hub predating it. */
  outputFaults?: number;
  failovers: number;
  lastAt: string | null;
}

/** A pin's reach and how hard it binds. `prefer` is the only mode: see `hub-pool.types.ts`. */
export type PoolPinScope = 'default' | 'model';
export type PoolPinTargetKind = 'local' | 'peer';

/** A pin as `/inference/pool/status` reports it, with its target resolved. Absent on a Hub predating pinning. */
export interface PoolStatusPin {
  scope: PoolPinScope;
  model?: string;
  targetKind: PoolPinTargetKind;
  peerId?: string;
  mode: 'prefer';
  nodeFqdn: string | null;
  targetAvailable: boolean;
}

export interface PoolStatusResponse {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
  directions: { outbound: PoolEnabledState; inbound: PoolEnabledState };
  reason: PoolStatusReason;
  routingActive: boolean;
  settings: {
    poolEnabled: boolean;
    poolOutboundEnabled: boolean;
    poolInboundEnabled: boolean;
    poolLocalAffinity: number;
    poolHealthPollSeconds: number;
    /** Optional so this CLI keeps parsing a Hub predating signed peers, where the key is simply absent. */
    poolRequireSignedPeers?: boolean;
    poolPressureWeight?: number;
    /** The STORED ceiling. Absent on a Hub predating ceilings, which is how `pool ceiling` detects one. */
    poolMaxPromptTokens?: number | null;
    /** Absent on a Hub predating the local health snapshot; `0` there would have meant live probes anyway. */
    poolProbeSnapshotTtlMs?: number;
    /** Absent on a Hub predating prefix affinity; `0` there would have meant off anyway. */
    poolPrefixAffinityMaxInFlight?: number;
    /** Absent on a Hub predating slot-aware placement; `0` there would have meant off anyway. */
    poolSlotAwareness?: number;
    /** LAN discovery over mDNS. Absent on a Hub predating the switch, where it was on with no way to turn it off. */
    poolMdnsEnabled?: boolean;
  };
  tailscaleAdminApiConfigured: boolean;
  localNode: {
    nodeFqdn: string | null;
    tailnet: string | null;
    tailscaleConnected: boolean;
    inFlightRequests: number;
    hardwareTier: string | null;
    backends: PoolBackendCapability[];
    capabilitiesError: string | null;
    /** This node's UUID and key fingerprint. Optional: absent on a Hub predating pinned identities. */
    identity?: PoolIdentitySummary;
    /** The EFFECTIVE ceiling (env override applied), or `null` for none. Absent on a Hub predating ceilings. */
    maxPromptTokens?: number | null;
    /** `'env'` when `HUB_POOL_MAX_PROMPT_TOKENS` set it, which no settings write can change. */
    maxPromptTokensSetBy?: 'env' | 'setting' | null;
    /** This node's context cap (`inferenceMaxNumCtx`), or `null` for none. Absent on a Hub predating caps. */
    maxNumCtx?: number | null;
    /** This node's Ollama slot count (`inferenceOllamaSlots`), or `null` for not stated. Absent on a Hub predating slots. */
    ollamaSlots?: number | null;
    /** This node's own measured rates, as it advertises them. Absent on a Hub predating throughput. */
    throughput?: PoolThroughputEstimate[];
  };
  peers: PoolPeerRow[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** Optional so this CLI keeps parsing a Hub that predates pinning, where the key is simply absent. */
  pins?: PoolStatusPin[];
  /** Optional for the same reason: a Hub predating the PIN handshake reports nothing here. */
  pairingPin?: PoolPairingPinState;
  routing: PoolRoutingSummary;
}

/**
 * An unpaired node the Hub can offer to pair with **by name**.
 *
 * Every attested entry has a tailnet name, because pairing from this list hands `nodeFqdn` to
 * `pool pair`. A Hub found by address is not in here — `/identify` discloses no name — and is paired
 * with directly: `cihub pool pair <address> --pin <digits>`.
 *
 * The exception is an UNVERIFIED row (see {@link isUnverifiedCandidate}): a Hub heard over LAN mDNS,
 * whose name and address came from an unauthenticated datagram. It is listed apart and is never
 * offered as something to `pool pair`.
 */
export interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
  source?: 'portal' | 'mdns';
  verified?: boolean;
  /** `host:port` of an unverified mDNS row — the datagram's sender. Display only. */
  address?: string;
}

/**
 * Either mark makes a row unverified. `source` alone covers a Hub on the build that introduced mDNS
 * discovery, which sent neither the flag nor any restraint on what its rows carried — this CLI ships
 * apart from the Hub image, so it meets that build.
 */
export function isUnverifiedCandidate(device: DiscoverablePoolPeer): boolean {
  return device.verified === false || device.source === 'mdns';
}

/**
 * Whether a name typed at `pool pair` is a `.local` (multicast DNS) name. Mirrors the backend's
 * `isMdnsPeerName`, which refuses the same thing with a 400; this copy lets the CLI explain before
 * anything is sent.
 *
 * No tailnet hands out a `.local` name, so one typed here was copied off an unverified LAN row — and
 * `isPlausiblePeerFqdn` accepts it, so without this check it went out as a pairing-by-name request
 * that sends this Hub's name, a new peer token and the PIN to whatever answers that name.
 */
export function isMdnsPeerName(name: string): boolean {
  const candidate = name.trim().toLowerCase().replace(/\.$/, '');
  return candidate === 'local' || candidate.endsWith('.local');
}

/** Why `pool pair <name>.local` is refused, and the two ways that do work. */
export function formatMdnsPairRefusalLines(target: string): string[] {
  return [
    `"${sanitizeForBox(target)}" is a LAN (mDNS) name. Pool pairing needs the peer's tailnet name.`,
    '',
    'A .local name comes from an unverified LAN announcement: anything on the network can claim',
    "one, and pairing by it would send this Hub's name, a new peer token and the PIN to whatever",
    'answers. Nothing was sent.',
    '',
    'Pair by its tailnet name:  cihub pool pair hub-b.your-tailnet.ts.net',
    'Or, for a Hub you can reach only on the LAN, by its address with the PIN from that Hub:',
    '  on that Hub:  cihub pool pairing-pin',
    '  then here:    cihub pool pair <address> --pin <digits>',
  ];
}

/**
 * What `POST /inference/pool/peers/probe` found at an operator-typed address.
 *
 * Reachability and protocol only. It deliberately does not name the node: `/identify` is
 * unauthenticated and reachable through the Cloudflare tunnel, so the MagicDNS name lives behind the
 * pairing PIN instead.
 */
export interface PoolProbeResult {
  address: string;
  isCiHub: boolean;
  poolProtocol: number | null;
  pairable: boolean;
  reason: 'unreachable' | 'not_a_hub' | 'protocol_too_old' | null;
}

export interface PoolRoutingRecord {
  at: string;
  direction: 'outbound' | 'inbound';
  path: string;
  model: string | null;
  node: string | null;
  peerId: string | null;
  backend: string | null;
  candidates: number;
  attempt: number;
  failedOverFrom: string[];
  outcome: 'served' | 'failed';
  status: number | null;
  durationMs: number;
  /**
   * `true` when the app closed its connection before any candidate answered. The row still names the
   * node that was working on it — absent this flag, that node and a genuine routing failure's `-`
   * were the same row. Absent on a Hub predating the flag.
   */
  clientClosed?: boolean;
  /**
   * Why the walk stopped at a node that answered with an error: its body proved the request itself
   * was bad — or, with basis `node`, the node answered 200 with output that was cut off or only
   * placeholder tokens. `null` otherwise; absent on a Hub predating the field.
   */
  requestError?: PoolRoutingRequestError | null;
  /** Why a failed row failed, in a few words: a status, a deadline, an error code, an output fault. Absent on a Hub predating it. */
  reason?: string | null;
  /** Each node passed over before the one that answered, and what it answered. Absent on a Hub predating it. */
  attempts?: PoolRoutingAttempt[];
  /** Time to the end of the response body, where `durationMs` stops at the first headers. `null` until then; absent on a Hub predating it. */
  totalMs?: number | null;
  /** Which operator pin shaped this decision, if any. Absent on a Hub predating pinning. */
  pin?: { scope: PoolPinScope; mode: 'prefer'; targetKind: PoolPinTargetKind } | null;
  /** What the prompt ceilings did to this decision, or `null` when no candidate had one. Absent on a Hub predating ceilings. */
  promptCeiling?: PoolRoutingPromptCeiling | null;
  /** What the nodes' context caps did to this decision, or `null` when no candidate had one. Absent on a Hub predating cap placement. */
  contextCap?: PoolRoutingContextCap | null;
  /** What measured prefill rates did to this decision, or `null` when nothing applicable was measured. Absent on a Hub predating throughput. */
  throughput?: PoolRoutingThroughput | null;
  /** What prefix affinity did to this decision, or `null` when it was off or did not apply. Absent on a Hub predating affinity. */
  affinity?: PoolRoutingAffinity | null;
  /**
   * What slot-aware placement did to this decision, or `null` when the knob is off or no candidate
   * stated a slot count. Absent on a Hub predating slots.
   */
  slots?: PoolRoutingSlots | null;
  /**
   * What local-engine contention did to this decision, or `null` when no local engine was busy with
   * work the request could not join. Absent on a Hub predating it.
   */
  contention?: PoolRoutingContention | null;
}

/** Mirrors `PoolRoutingContention` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingContention {
  /** The window the request asked for; `null` when it named none. */
  numCtx: number | null;
  /**
   * Local engines busy with work the request could not join — another model, or this one at another
   * window — in ranked order, each with the windows as its engine runs them (`null`: the engine
   * default, which that node does not state) and the nodes it gave way to. Never removed.
   */
  demoted: {
    node: string;
    backend: string;
    busyWith: { model: string; numCtx: number | null }[];
    runsAt: number | null;
    behind: string[];
    /** `'affinity'`: it would have given way, but holds the session's prompt prefix. Absent on a Hub predating it. */
    overriddenBy?: 'affinity' | null;
  }[];
  /** Placed on one of those anyway: nothing it gave way to answered, or it gave way to nothing. */
  overridden: boolean;
}

/** Mirrors `PoolRoutingRequestError` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingRequestError {
  /** A label for the engine's message; the message itself never leaves the Hub that read it. A string, so a newer Hub's label still prints. */
  signature: string;
  /**
   * A string beyond these from a newer Hub prints as the generic line, as `signature` does. `node` is
   * not a verdict on the request at all: the node's own output was cut off or degenerate.
   */
  basis: 'definitive' | 'confirmed' | 'last-candidate' | 'status' | 'node';
  /** For `confirmed`, the node whose answer this one agreed with. */
  confirms: string | null;
}

/** Mirrors `PoolRoutingAttempt` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingAttempt {
  node: string;
  backend: string;
  /** What it answered, or `null` when it never answered. */
  status: number | null;
  reason: string;
}

/** Mirrors `PoolRoutingSlots` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingSlots {
  /** Candidates whose known queue depth had reached their stated slots, in ranked order; `'local'` for this node. Moved behind every free one, never removed. */
  demoted: { node: string; backend: string; inFlight: number; slots: number }[];
  /** Placed on one of those anyway: every candidate was full, every free one failed first, or a ceiling put every free one behind it. */
  overridden: boolean;
}

/** Mirrors `PoolRoutingAffinity` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingAffinity {
  key: 'header' | 'hashed';
  outcome: 'hit' | 'miss' | 'skipped';
  /**
   * Whether the remembered engine passed affinity's own test (under the limit, or within the margin),
   * whether or not passing changed the order. `false` on a `hit` is the ranker doing it alone. Absent
   * on a Hub predating the field, where it is inferred from what the row carries — see
   * {@link affinityQualified}.
   */
  qualified?: boolean;
  remembered: string | null;
  inFlight: number | null;
  /** The least-loaded other candidate's queue depth, which the margin is measured from. Absent on a Hub predating it. */
  leastLoadedInFlight?: number | null;
  maxInFlight: number;
  /** Absent on a Hub predating the margin. */
  affinityMargin?: number;
}

/** Mirrors `PoolRoutingThroughput` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingThroughput {
  estimatedTokens: number;
  budgetMs: number;
  estimates: {
    node: string;
    backend: string;
    /** The rate as measured, before any growth. */
    tokensPerSec: number;
    /** The prompt size it was measured at. Absent on a Hub predating reading a measurement forward. */
    fromPromptTokens?: number;
    /** Whether `predictedMs` grew a smaller measurement to this prompt's size. */
    extrapolated?: boolean;
    predictedMs: number;
    source: 'observed' | 'advertised';
    deadline: boolean;
    slow: boolean;
  }[];
  /** Placed on a node predicted to miss the budget anyway: every candidate was, or every faster one failed first. */
  overridden: boolean;
}

/** Mirrors `PoolRoutingPromptCeiling` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingPromptCeiling {
  /** bytes / 4 of the forwarded payload — the same estimate the Hub sizes its first-byte budget from. */
  estimatedTokens: number;
  excluded: { node: string; maxPromptTokens: number }[];
  /** Placed on an over-ceiling node anyway: every candidate was over its ceiling, or every one under a ceiling failed first. */
  overridden: boolean;
}

/** Mirrors `PoolRoutingContextCap` in `hub-pool-routing-log.service.ts`. */
export interface PoolRoutingContextCap {
  /** The window the request asked for: its `options.num_ctx`, or the prompt estimate when it carried none. */
  numCtx: number;
  source: 'request' | 'estimated';
  excluded: { node: string; maxNumCtx: number }[];
  /** Placed on a node capped below the window anyway: every candidate was, or every one that could take it failed first. */
  overridden: boolean;
}

export interface PoolRoutingLogResponse {
  entries: PoolRoutingRecord[];
  summary: PoolRoutingSummary;
}

// --- API ---

export async function fetchPoolStatus(envFileName: string): Promise<PoolStatusResponse> {
  return hubApiFetch<PoolStatusResponse>(envFileName, '/inference/pool/status', { signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS) });
}

export async function fetchPoolPeers(envFileName: string): Promise<PoolPeerRow[]> {
  return hubApiFetch<PoolPeerRow[]>(envFileName, '/inference/pool/peers', { signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS) });
}

/** What `POST pairing-pin` answers with: the digits, when they expire, and this node's identity. */
export interface PoolPairingPinMint {
  pin: string;
  expiresAt: string;
  nodeUuid?: string | null;
  publicKeyFingerprint?: string | null;
  identityError?: string | null;
}

/**
 * Mint the six digits the other Hub needs to pair by address.
 *
 * The mutation budget, not the GET one: this writes the outstanding PIN. It is also the ONLY place
 * the digits are ever returned — `pool status` reports that a PIN is outstanding and when it
 * expires, never its value — so a caller that loses this output has to mint a new one.
 */
export async function mintPairingPin(envFileName: string): Promise<PoolPairingPinMint> {
  return hubApiFetch<PoolPairingPinMint>(envFileName, '/inference/pool/pairing-pin', {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Revoke the outstanding PIN before it expires on its own. */
export async function cancelPairingPin(envFileName: string): Promise<{ cancelled: boolean }> {
  return hubApiFetch<{ cancelled: boolean }>(envFileName, '/inference/pool/pairing-pin', {
    method: 'DELETE',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Renders a freshly minted PIN, including the fingerprint the far operator should be shown. */
export function formatPairingPinLines(minted: PoolPairingPinMint, localNodeFqdn?: string | null): string[] {
  const lines = [
    `${OK} Pairing PIN: ${sanitizeForBox(minted.pin)}`,
    '',
    `Expires ${formatPoolTimestamp(minted.expiresAt)}. Single-use, and only one is live at a time.`,
    '',
    'On the OTHER Hub:',
    // The caller passes this node's name when `GET status` could supply one, so the line is
    // copy-pasteable rather than a template. Any address that reaches this Hub works in its place.
    `  cihub pool pair ${sanitizeForBox(localNodeFqdn ?? '<this-node-address>')} --pin ${sanitizeForBox(minted.pin)}`,
  ];
  if (minted.publicKeyFingerprint) {
    lines.push('', `This node's key fingerprint is ${sanitizeForBox(minted.publicKeyFingerprint)} — compare it there.`);
  }
  if (minted.identityError) {
    lines.push('', `${FAIL} This node could not load its own pool identity: ${sanitizeForBox(minted.identityError)}`);
  }
  // Minting is not pre-approval: the request still lands as `pending` on this side. Worth saying,
  // because handing someone a PIN feels like the consent step and is not.
  lines.push('', 'The request still has to be approved here: cihub pool approve <id>');
  return lines;
}

/** The cancel confirmation, kept here so the status glyphs stay private to this module. */
export function formatPairingPinCancelledLines(): string[] {
  return [`${OK} Outstanding pairing PIN cancelled.`, '', 'Nothing can pair by address to this Hub until a new one is minted.'];
}

/** One HTTPS probe per tailnet device on the backend, so it gets the mutation budget rather than the GET one. */
export async function fetchDiscoverablePeers(envFileName: string): Promise<DiscoverablePoolPeer[]> {
  return hubApiFetch<DiscoverablePoolPeer[]>(envFileName, '/inference/pool/peers/discoverable', {
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function probePoolAddress(envFileName: string, address: string): Promise<PoolProbeResult> {
  return hubApiFetch<PoolProbeResult>(envFileName, '/inference/pool/peers/probe', {
    method: 'POST',
    body: JSON.stringify({ address }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function fetchPoolRoutingLog(envFileName: string, limit?: number): Promise<PoolRoutingLogResponse> {
  const query = limit === undefined ? '' : `?limit=${limit}`;
  return hubApiFetch<PoolRoutingLogResponse>(envFileName, `/inference/pool/routing-log${query}`, {
    signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS),
  });
}

/**
 * Send a pairing request, by tailnet name or by LAN address.
 *
 * `address` requires `pin`: the far Hub only discloses its tailnet name — the name the row is keyed
 * on and every later call is addressed to — to a request carrying the PIN minted on its own screen.
 */
export async function pairPoolPeer(
  envFileName: string,
  target: { nodeFqdn: string } | { address: string },
  displayName?: string,
  pin?: string,
): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, '/inference/pool/peers/pair', {
    method: 'POST',
    body: JSON.stringify({ ...target, ...(displayName ? { displayName } : {}), ...(pin ? { pin } : {}) }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function approvePoolPeer(envFileName: string, id: string): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function rejectPoolPeer(envFileName: string, id: string): Promise<void> {
  await hubApiFetch(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function unpairPoolPeer(envFileName: string, id: string): Promise<void> {
  await hubApiFetch(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/**
 * Set (or replace) a routing pin. Upsert by POST, because `(scope, model)` is the key an operator
 * edits — pins have no ids; they live in the Hub's settings.json, not in a table.
 */
export async function setPoolPin(
  envFileName: string,
  pin: { scope: PoolPinScope; model?: string; targetKind: PoolPinTargetKind; targetPeerId?: string },
): Promise<{ pins: PoolStatusPin[] }> {
  return hubApiFetch(envFileName, '/inference/pool/pins', {
    method: 'POST',
    body: JSON.stringify(pin),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Remove a routing pin. Addressed by query, not path: a model id contains `/` and `:`. */
export async function deletePoolPin(envFileName: string, scope: PoolPinScope, model?: string): Promise<{ pins: PoolStatusPin[] }> {
  const query = scope === 'model' ? `?scope=model&model=${encodeURIComponent(model as string)}` : '?scope=default';
  return hubApiFetch(envFileName, `/inference/pool/pins${query}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Which switch(es) `cihub pool enable|disable` should write. `both` is the default and is today's behaviour. */
export type PoolEnableAxis = 'both' | 'outbound' | 'inbound';

/**
 * PATCHes only the switch(es) the operator named. `both` writes the MASTER switch, not the two
 * directional ones: turning pooling off has always meant the master, and rewriting the directional
 * flags here would silently discard an operator's asymmetric setup on the next `pool enable`.
 */
export async function setPoolEnabledSetting(
  envFileName: string,
  poolEnabled: boolean,
  axis: PoolEnableAxis = 'both',
): Promise<PoolStatusResponse['settings']> {
  const body =
    axis === 'outbound' ? { poolOutboundEnabled: poolEnabled } : axis === 'inbound' ? { poolInboundEnabled: poolEnabled } : { poolEnabled };
  return hubApiFetch(envFileName, '/inference/pool/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/**
 * Set this node's prompt ceiling, or clear it with `null`. A PATCH of the one field, like the kill
 * switches above, so nothing else in the stored settings is rewritten.
 */
export async function setPoolMaxPromptTokens(envFileName: string, maxPromptTokens: number | null): Promise<PoolStatusResponse['settings']> {
  return hubApiFetch(envFileName, '/inference/pool/settings', {
    method: 'PATCH',
    body: JSON.stringify({ poolMaxPromptTokens: maxPromptTokens }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/**
 * `GET /api/inference/preferences`, the fields `pool context-cap` and `pool slots` read. `maxNumCtx`
 * is the stored cap on the `num_ctx` handed to apps (`null` for none); `ollamaSlots` the stored
 * statement of how many requests the node's Ollama runs at once (`null` for not stated). Each key is
 * absent on a Hub predating it, which is how the command tells one apart from a Hub with nothing set.
 */
export interface InferencePreferencesResponse {
  preferredBackend: string | null;
  maxNumCtx?: number | null;
  ollamaSlots?: number | null;
}

export async function fetchInferencePreferences(envFileName: string): Promise<InferencePreferencesResponse> {
  return hubApiFetch<InferencePreferencesResponse>(envFileName, '/inference/preferences', { signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS) });
}

/**
 * Set this node's context cap, or clear it with `null`, through `PATCH /api/inference/preferences`.
 *
 * That route — not `/api/user-settings` — because it is the one that can REMOVE the key, and it
 * answers with the preferences as stored. It requires `backend`, so the caller passes the one the
 * Hub already has (or Ollama, which an absent preference resolves to on the Hub). Every write here
 * sweeps the AI apps whose env it changes; the caller skips the write when the cap already reads as
 * requested.
 */
export async function setInferenceContextCap(envFileName: string, backend: string, maxNumCtx: number | null): Promise<InferencePreferencesResponse> {
  return hubApiFetch<InferencePreferencesResponse>(envFileName, '/inference/preferences', {
    method: 'PATCH',
    body: JSON.stringify({ backend, maxNumCtx }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/**
 * Set this node's Ollama slot count, or clear it with `null`, through the same route and for the same
 * reasons as the cap above: it can remove the key, and it answers with the preferences as stored.
 */
export async function setInferenceOllamaSlots(
  envFileName: string,
  backend: string,
  ollamaSlots: number | null,
): Promise<InferencePreferencesResponse> {
  return hubApiFetch<InferencePreferencesResponse>(envFileName, '/inference/preferences', {
    method: 'PATCH',
    body: JSON.stringify({ backend, ollamaSlots }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Per-peer kill switch. Reversible and symmetric: the pairing and both tokens survive. */
export async function setPoolPeerEnabled(envFileName: string, id: string, enabled: boolean): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

// --- formatting primitives ---

const OK = '✓';
const FAIL = '✗';
const PENDING = '○';

/** Every cell passes through here: `displayName` is free operator text and the rest arrives over HTTP. */
function cell(value: string, width: number): string {
  const clean = sanitizeForBox(value);
  const text = clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
  return text.padEnd(width);
}

function ruleRow(widths: readonly number[]): string {
  return widths.map((width) => '-'.repeat(width)).join(' ');
}

/** `2026-09-05 10:00:01Z`. Non-ISO input is echoed sanitized rather than rendered as `Invalid Date`. */
export function formatPoolTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return sanitizeForBox(value);
  return parsed
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

function formatEngines(backends: PoolBackendCapability[] | undefined): string {
  if (!backends || backends.length === 0) return '-';
  return backends.map((backend) => `${backend.type} ${backend.healthy ? OK : FAIL} ${backend.modelsLoaded?.length ?? 0}`).join('  ');
}

function shortId(id: string): string {
  return sanitizeForBox(id).slice(0, 8);
}

// --- context caps ---

/**
 * A peer's context cap in the three readings that must never share an encoding.
 *
 * A number is the cap routing applies. `null` is a peer that answered and named no cap — routing
 * reads that as "takes any window", so it is where large windows land, and it is NOT the same thing
 * as not knowing. `undefined` is not knowing: a peer this node has never had a capabilities snapshot
 * from, or a Hub whose peer rows predate the field. Collapsing the last two — into each other, or
 * into a number — is how an operator concludes a fleet is uniform when it is not.
 */
export function peerContextCap(peer: Pick<PoolPeerRow, 'maxNumCtx' | 'lastCapabilities'>): number | null | undefined {
  if (typeof peer.maxNumCtx === 'number') return peer.maxNumCtx;
  return peer.maxNumCtx === null && peer.lastCapabilities ? null : undefined;
}

/** `65536`, `none` or `?` — one cap, in a table cell or a list line. */
export function showContextCap(cap: number | null | undefined): string {
  return typeof cap === 'number' ? String(cap) : cap === null ? 'none' : '?';
}

/** A node and the cap it advertises, as {@link summariseContextCaps} judges the pool. */
export interface ContextCapNode {
  node: string;
  /** The cap routing applies: a number, `null` for none advertised, `undefined` for not known here. */
  cap: number | null | undefined;
}

export interface ContextCapSpread {
  /** Nodes whose cap is a number, smallest first. */
  capped: { node: string; cap: number }[];
  /** Nodes that answered and named no cap — routing sends any window at these. */
  uncapped: string[];
  /** Nodes nothing is known about; neither a finding nor a clean bill. */
  unknown: string[];
  smallest: number | null;
  largest: number | null;
  /** Two or more distinct caps: a handout sized from `largest` puts the smaller ones behind. */
  disagrees: boolean;
  /** At least one capped node and at least one uncapped one: the uncapped take every large window. */
  mixed: boolean;
}

/**
 * What the pool's caps add up to, for the one question that matters since #1555 made a cap an input
 * to placement: would a request be placed differently on one node than on another?
 *
 * Two states are worth telling an operator about, and they are different faults.
 *
 * *Disagreeing* caps: an app is handed the LARGEST cap among the nodes serving its model
 * (`poolContextCap`), and placement then keeps that window off every node capped below it
 * (`applyContextCap`). So the small-capped nodes quietly stop being eligible for the fleet's agent
 * traffic while still passing every health check.
 *
 * *Mixed* capped and uncapped: an uncapped node reads as "takes any window" in both rules, so it
 * absorbs the large windows — including windows its own `OLLAMA_CONTEXT_LENGTH` does not run, which
 * is the reload (or the CPU spill) the cap exists to prevent. An unset cap is not a safe default.
 */
export function summariseContextCaps(nodes: readonly ContextCapNode[]): ContextCapSpread {
  const capped = nodes.filter((entry): entry is { node: string; cap: number } => typeof entry.cap === 'number').sort((a, b) => a.cap - b.cap);
  const uncapped = nodes.filter((entry) => entry.cap === null).map((entry) => entry.node);
  const unknown = nodes.filter((entry) => entry.cap === undefined).map((entry) => entry.node);
  const caps = capped.map((entry) => entry.cap);
  return {
    capped,
    uncapped,
    unknown,
    smallest: caps.length ? (caps[0] as number) : null,
    largest: caps.length ? (caps[caps.length - 1] as number) : null,
    disagrees: new Set(caps).size > 1,
    mixed: capped.length > 0 && uncapped.length > 0,
  };
}

/** The fleet-wide command that sets both halves on every node. Named wherever a cap is reported as wrong. */
export const CONTEXT_CAP_FLEET_COMMAND = 'cihub fleet backends --backends ollama --ollama-context <N> --execute';

// --- peers ---

const PEER_WIDTHS = [8, 34, 4, 16, 20, 5, 7] as const;

/** The NODE column plus room for the ` (this node)` suffix the cap list adds to one row. */
const CAP_NODE_WIDTH = PEER_WIDTHS[1] + 12;

/**
 * Peer table. The ID column is the first 8 characters of the row uuid — enough to hand back to
 * `approve`/`reject`/`unpair`, which resolve a prefix (or the FQDN) against this same list.
 */
export function formatPoolPeerTable(peers: PoolPeerRow[]): string[] {
  if (peers.length === 0) {
    return ['No paired peers. Discover candidates with: cihub pool discover'];
  }

  const lines = [
    `${cell('ID', PEER_WIDTHS[0])} ${cell('NODE', PEER_WIDTHS[1])} ${cell('DIR', PEER_WIDTHS[2])} ${cell('STATUS', PEER_WIDTHS[3])} ${cell('LAST SEEN', PEER_WIDTHS[4])} ${cell('QUEUE', PEER_WIDTHS[5])} ${cell('CONTEXT', PEER_WIDTHS[6])} ENGINES`,
    ruleRow([...PEER_WIDTHS, 'ENGINES'.length]),
  ];

  for (const peer of peers) {
    // Strikes are what decide whether a peer is still offered as a candidate, so they belong next to
    // the status rather than in a footnote — "connected 2/3" is a peer about to drop out.
    //
    // `disabled` replaces the lifecycle word rather than sitting beside it: a peer the operator
    // switched off exchanges no work whatever its health poll says, and printing "connected" for it
    // is the one thing this table must not do. `!== false` so a Hub predating the column reads as in.
    const lifecycle = peer.enabled === false ? `${peer.status}/off` : peer.status;
    // A changed identity replaces the strike count too. The count only runs up (it reached 3,169 on
    // beta-max's peers), and "unreachable 3169/3" reads as a network fault on a node that answered.
    const status =
      peer.probeFailure?.kind === 'identity_changed'
        ? 'identity changed'
        : peer.consecutiveFailures > 0
          ? `${lifecycle} ${peer.consecutiveFailures}/3`
          : lifecycle;
    const queue = peer.inFlightRequests ?? peer.lastCapabilities?.inFlightRequests;
    lines.push(
      [
        cell(shortId(peer.id), PEER_WIDTHS[0]),
        cell(peer.nodeFqdn, PEER_WIDTHS[1]),
        cell(peer.direction === 'inbound' ? 'in' : 'out', PEER_WIDTHS[2]),
        cell(status, PEER_WIDTHS[3]),
        cell(formatPoolTimestamp(peer.lastSeenAt), PEER_WIDTHS[4]),
        cell(queue === undefined ? '-' : String(queue), PEER_WIDTHS[5]),
        // The cap decides which nodes a large window may be placed on, so it belongs on the row
        // rather than in a footnote: `none` and `?` are findings, not blanks. See peerContextCap.
        cell(showContextCap(peerContextCap(peer)), PEER_WIDTHS[6]),
        formatEngines(peer.lastCapabilities?.backends),
      ].join(' '),
    );
  }

  return lines;
}

const MAX_LISTED_MODELS = 8;

/** `cihub pool peers` detail: which models each peer actually holds, which the table only counts. */
export function formatPoolPeerModelLines(peers: PoolPeerRow[]): string[] {
  const lines: string[] = [];
  for (const peer of peers) {
    for (const backend of peer.lastCapabilities?.backends ?? []) {
      const models = backend.modelsLoaded ?? [];
      if (models.length === 0) continue;
      const shown = models.slice(0, MAX_LISTED_MODELS).map(sanitizeForBox).join(', ');
      const overflow = models.length > MAX_LISTED_MODELS ? ` (+${models.length - MAX_LISTED_MODELS} more)` : '';
      lines.push(`  ${shortId(peer.id)}  ${sanitizeForBox(backend.type)}: ${shown}${overflow}`);
    }
  }
  if (lines.length === 0) return [];
  // Disk inventory, not VRAM residency — a peer listing a model may still have to cold-load it.
  return ['', 'Models on each peer (on disk, not necessarily loaded)', ...lines];
}

const PENDING_INBOUND_HINT = 'Pending inbound requests: approve with `cihub pool approve <id>` or reject with `cihub pool reject <id>`.';
const DISABLED_PEER_HINT =
  'Peers marked `/off` exchange no work with this node. The pairing and both tokens are kept — put one back with `cihub pool peer-enable <id>`.';

export function formatPoolPeersLines(peers: PoolPeerRow[]): string[] {
  const lines = [...formatPoolPeerTable(peers), ...formatPeerContextCapLines(peers), ...formatPoolPeerModelLines(peers)];
  if (peers.some((peer) => peer.direction === 'inbound' && peer.status === 'pending')) {
    lines.push('', PENDING_INBOUND_HINT);
  }
  if (peers.some((peer) => peer.enabled === false)) {
    lines.push('', DISABLED_PEER_HINT);
  }
  // The far side's own decision, not this operator's — worth naming, because such a peer polls
  // healthy while advertising nothing, which otherwise reads as a broken node.
  const notAccepting = peers.filter((peer) => peer.enabled !== false && peer.lastCapabilities?.acceptingWork === false);
  if (notAccepting.length > 0) {
    lines.push('', `Not accepting work from this node: ${notAccepting.map((peer) => sanitizeForBox(peer.nodeFqdn)).join(', ')}`);
  }
  return lines;
}

/**
 * Resolve an operator-typed peer reference to exactly one row. Accepts the full uuid, the 8-character
 * prefix the table prints, or the node FQDN — an ambiguous prefix is an error rather than a guess,
 * because the commands taking one all change pairing state.
 */
export function resolvePoolPeerTarget(peers: PoolPeerRow[], target: string): { peer: PoolPeerRow } | { error: string } {
  const needle = target.trim().toLowerCase();
  if (!needle) return { error: 'Missing peer id.' };

  const exact = peers.filter((peer) => peer.id.toLowerCase() === needle || peer.nodeFqdn.toLowerCase() === needle);
  if (exact.length === 1) return { peer: exact[0] as PoolPeerRow };

  const prefixed = peers.filter((peer) => peer.id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return { peer: prefixed[0] as PoolPeerRow };
  if (prefixed.length > 1) {
    return { error: `"${sanitizeForBox(target)}" matches ${prefixed.length} peers — use the full id.` };
  }
  return { error: `No paired peer matching "${sanitizeForBox(target)}". List them with: cihub pool peers` };
}

// --- status ---

function describePoolReason(status: PoolStatusResponse): string {
  switch (status.reason) {
    case 'active':
      return `${OK} active — apps on this Hub are routed through the pool`;
    case 'no_peers':
      return `${PENDING} enabled, not routing — no connected peers, so this Hub resolves inference locally`;
    case 'partially_disabled':
      return `${PENDING} partly disabled — pooling is on, but a direction is switched off or every peer is disabled (see below)`;
    case 'disabled_by_env':
      return `${FAIL} disabled — HUB_POOL_USER_DISABLED=true in this Hub's .env (the .env wins over the setting)`;
    case 'disabled_by_setting':
      return `${FAIL} disabled — turned off in settings (re-enable with: cihub pool enable)`;
    default:
      return `${PENDING} unknown state`;
  }
}

/**
 * One direction's effective state, naming the switch actually responsible. An operator told to edit
 * the `.env` when the real cause is the stored setting goes looking in the wrong file — the same
 * reason `describeHubPoolDisabled` exists on the backend.
 */
function describeDirection(what: string, state: PoolEnabledState, envVar: string, flag: string): string {
  if (state.enabled) return `${OK} ${what}`;
  if (state.disabledBy === 'env') return `${FAIL} not ${what} — ${envVar}=true in this Hub's .env (the .env wins over the setting)`;
  return `${FAIL} not ${what} — turned off in settings (re-enable with: cihub pool enable ${flag})`;
}

export function formatPoolStatusLines(status: PoolStatusResponse): string[] {
  const counts = status.peerCounts;
  const routing = status.routing;
  const lines = [
    `Pooling      ${describePoolReason(status)}`,
    `Outbound     ${describeDirection('sending work to peers', status.directions.outbound, 'HUB_POOL_OUTBOUND_DISABLED', '--outbound')}`,
    `Inbound      ${describeDirection('serving work for peers', status.directions.inbound, 'HUB_POOL_INBOUND_DISABLED', '--inbound')}`,
    `Peers        ${counts.total} total · ${counts.connected} connected · ${counts.pending} pending · ${counts.unreachable} unreachable · ${counts.disabled} disabled`,
    // Names the one credential `GET status` reports on, and says so. The Tailscale daemon's peer map
    // also names candidates, needs no credential, and is not in this response (the `Tailscale` line
    // below and `localNode.tailnet` are as close as it gets — preconditions, not its result) — so
    // this line must not read as "discovery is on" or "discovery is off".
    //
    // It deliberately no longer mentions CI account Hubs: the Portal directory is wired in but
    // returns nothing (see `listPortalCandidates`), and promising it here sends an operator to look
    // for candidates that cannot arrive.
    `Discovery    ${
      status.tailscaleAdminApiConfigured
        ? 'Tailscale Admin API configured — cihub pool discover can enumerate the whole tailnet'
        : 'no Admin API credential — cihub pool discover still lists the tailnet peers this node can see'
    }`,
    `Settings     poolEnabled=${status.settings.poolEnabled} · outbound=${status.settings.poolOutboundEnabled} · inbound=${status.settings.poolInboundEnabled} · localAffinity=${status.settings.poolLocalAffinity} · healthPoll=${status.settings.poolHealthPollSeconds}s`,
    `Routing log  ${formatRoutingCounts(routing)}`,
    '',
    'This node',
    `  Node       ${sanitizeForBox(status.localNode.nodeFqdn ?? '(unknown)')}${status.localNode.tailnet ? `  tailnet ${sanitizeForBox(status.localNode.tailnet)}` : ''}`,
    `  Tailscale  ${status.localNode.tailscaleConnected ? `${OK} connected` : `${FAIL} not connected — pooling needs the tailnet`}`,
    `  Hardware   ${sanitizeForBox(status.localNode.hardwareTier ?? '-')}`,
    // A live gauge, process-local and zeroed by a restart. Never a request total.
    `  In flight  ${status.localNode.inFlightRequests} request(s) now`,
    `  Engines    ${formatEngines(status.localNode.backends)}`,
  ];

  // The fingerprint an operator compares against the far Hub's screen during pairing. A broken
  // identity is reported the same way `capabilitiesError` is: pooling still runs on bearer tokens,
  // so this is a degradation to name, not a failure to hide.
  if (status.localNode.identity?.publicKeyFingerprint) {
    lines.push(`  Identity   ${sanitizeForBox(status.localNode.identity.publicKeyFingerprint)}`);
  }
  if (status.localNode.identity?.identityError) {
    lines.push(`  Identity   ${FAIL} ${sanitizeForBox(status.localNode.identity.identityError)}  (peers stay on bearer tokens)`);
  }

  lines.push(...formatPairingPinStateLines(status.pairingPin));
  lines.push(...formatLocalPromptCeilingLines(status.localNode));
  lines.push(...formatLocalContextCapLines(status.localNode));
  lines.push(...formatLocalOllamaSlotsLines(status.localNode, status.settings));

  // An unreachable backend and a node with no models both show an empty inventory; only this says which.
  if (status.localNode.capabilitiesError) {
    lines.push(`  Engines    ${FAIL} ${sanitizeForBox(status.localNode.capabilitiesError)}`);
  }

  lines.push(...formatPoolPinLines(status.pins));

  lines.push('', 'Peers', ...formatPoolPeerTable(status.peers).map((line) => `  ${line}`));
  lines.push(...formatPoolContextCapLines(status));
  lines.push(...formatPeerPromptCeilingLines(status.peers));
  lines.push(...formatThroughputLines(status));

  if (status.peers.some((peer) => peer.direction === 'inbound' && peer.status === 'pending')) {
    lines.push('', PENDING_INBOUND_HINT);
  }

  lines.push(...formatPeerAuthModeLines(status.peers, status.settings.poolRequireSignedPeers));
  lines.push(...formatPeerRefusalLines(status.peers));

  return lines;
}

/**
 * This node's prompt ceiling, under "This node" in `pool status`. Nothing at all when there is none,
 * so the status of a node that never set one — or a Hub predating ceilings — reads exactly as before.
 */
export function formatLocalPromptCeilingLines(localNode: PoolStatusResponse['localNode']): string[] {
  if (typeof localNode.maxPromptTokens !== 'number') return [];
  const source =
    localNode.maxPromptTokensSetBy === 'env'
      ? '  — HUB_POOL_MAX_PROMPT_TOKENS in .env, which `pool ceiling` cannot change'
      : '  — clear with: cihub pool ceiling clear';
  return [`  Ceiling    prompts over ~${localNode.maxPromptTokens} tokens go to another node when one can serve them${source}`];
}

/**
 * This node's context cap, under "This node" in `pool status`. Nothing when there is none, like the
 * ceiling above, so a node that never set one — or a Hub predating caps — reads exactly as before.
 */
export function formatLocalContextCapLines(localNode: PoolStatusResponse['localNode']): string[] {
  if (typeof localNode.maxNumCtx !== 'number') return [];
  return [`  Context    apps are handed a num_ctx of at most ${localNode.maxNumCtx} tokens  — clear with: cihub pool context-cap clear`];
}

/**
 * This node's Ollama slot count, under "This node" in `pool status`, and whether placement reads it.
 * Nothing when none is stated, like the cap above. The knob is named because a stated count with the
 * knob off is the common state during a canary: peers may be placing against it while this node is not.
 */
export function formatLocalOllamaSlotsLines(localNode: PoolStatusResponse['localNode'], settings: PoolStatusResponse['settings']): string[] {
  if (typeof localNode.ollamaSlots !== 'number') return [];
  const placement = settings.poolSlotAwareness ? 'slot-aware placement on' : 'slot-aware placement off (poolSlotAwareness=0)';
  return [
    `  Slots      Ollama runs ${localNode.ollamaSlots} request${localNode.ollamaSlots === 1 ? '' : 's'} at once; ${placement}  — clear with: cihub pool slots clear`,
  ];
}

/**
 * Which peers this node would actually place work on. A pending, unreachable or disabled peer is not
 * a candidate, so its cap cannot change a routing decision and must not raise a cap warning.
 */
function contextCapCandidates(peers: PoolPeerRow[]): PoolPeerRow[] {
  return peers.filter((peer) => peer.status === 'connected' && peer.enabled !== false);
}

/**
 * Every routing candidate's context cap under `pool status`, and the warning when they disagree
 * enough to change where a request goes.
 *
 * The peer table's CONTEXT column already shows each number; this block exists for the comparison,
 * which is the thing an operator cannot do by reading rows — and which became a correctness question
 * rather than a tuning one when a cap became an input to placement.
 *
 * Silent on a pool where nothing is capped at all: that is the documented default (no cap anywhere,
 * every node takes any window) and it behaves exactly as the build before caps did, so warning about
 * it on every `pool status` would be noise. The moment one node is capped, the comparison matters and
 * the block appears.
 */
export function formatPoolContextCapLines(status: PoolStatusResponse): string[] {
  // Node names are sanitized once, here, because every line below interpolates them into prose the
  // `cell` helper never sees.
  const nodes: ContextCapNode[] = [
    { node: `${sanitizeForBox(status.localNode.nodeFqdn ?? '(unknown)')} (this node)`, cap: status.localNode.maxNumCtx },
    ...contextCapCandidates(status.peers).map((peer) => ({ node: sanitizeForBox(peer.nodeFqdn), cap: peerContextCap(peer) })),
  ];
  const spread = summariseContextCaps(nodes);
  // Nothing capped anywhere is the pre-cap default, and it reads identically. Say nothing.
  if (spread.capped.length === 0) return [];

  const lines = [
    '',
    'Context caps (a node capped below a request is placed behind one that can take it)',
    ...nodes.map((entry) => `  ${cell(entry.node, CAP_NODE_WIDTH)} ${showContextCap(entry.cap)}`),
  ];
  // The prose is wrapped rather than hand-broken: node names are operator-supplied and of any
  // length, so a fixed break would run off the terminal on the first real fleet.
  const note = (glyph: string, text: string) => wrapWords(text, ACTION_WRAP_WIDTH).map((line, i) => (i === 0 ? `  ${glyph} ${line}` : `    ${line}`));

  // Not a fault on its own — a small node capped low is a deliberate tier, and placement is built
  // for it. What the operator cannot see without this line is the CONSEQUENCE: those nodes stop
  // taking the fleet's agent traffic while passing every health check.
  if (spread.disagrees) {
    const smallest = spread.capped.filter((entry) => entry.cap === spread.smallest).map((entry) => entry.node);
    lines.push(
      ...note(
        PENDING,
        `caps disagree across this pool (${spread.smallest} … ${spread.largest}). An app is handed the largest cap among the nodes serving its model, so ${smallest.join(', ')} at ${spread.smallest} is placed behind for those requests.`,
      ),
    );
  }
  // This one IS a fault: no cap reads as "takes any window" in both rules, so the uncapped node
  // collects exactly the requests its own OLLAMA_CONTEXT_LENGTH may not run.
  if (spread.mixed) {
    lines.push(
      ...note(
        FAIL,
        `no cap on ${spread.uncapped.join(', ')}, so routing reads ${spread.uncapped.length === 1 ? 'it' : 'them'} as "takes any window" and places large ones there — including windows its own OLLAMA_CONTEXT_LENGTH does not run.`,
      ),
    );
  }
  if (spread.unknown.length > 0) {
    lines.push(...note(PENDING, `no cap known for ${spread.unknown.join(', ')} — never probed, or a Hub predating caps. Not read as uncapped here.`));
  }
  if (spread.disagrees || spread.mixed) {
    lines.push(`    Set every node's engine context and its Hub cap together: ${CONTEXT_CAP_FLEET_COMMAND}`);
  }
  return lines;
}

/**
 * The same comparison under `cihub pool peers`, which has the rows but not this node's own cap.
 * One line, because the CONTEXT column above it already carries the numbers.
 */
export function formatPeerContextCapLines(peers: PoolPeerRow[]): string[] {
  const spread = summariseContextCaps(
    contextCapCandidates(peers).map((peer) => ({ node: sanitizeForBox(peer.nodeFqdn), cap: peerContextCap(peer) })),
  );
  if (!spread.disagrees && !spread.mixed) return [];
  const why = spread.disagrees
    ? `peer context caps disagree (${spread.smallest} … ${spread.largest})`
    : `${spread.uncapped.join(', ')} advertises no context cap while others are capped`;
  return [
    '',
    ...wrapWords(`Context caps: ${why}. A request's num_ctx decides which of these may serve it — see cihub pool status.`, ACTION_WRAP_WIDTH),
  ];
}

/** The peers advertising a ceiling, since the peer table has no column for it. Nothing when none does. */
export function formatPeerPromptCeilingLines(peers: PoolPeerRow[]): string[] {
  const limited = peers.filter((peer) => typeof peer.maxPromptTokens === 'number');
  if (limited.length === 0) return [];
  return [
    '',
    'Prompt ceilings (a longer prompt skips that node while another can serve it)',
    ...limited.map((peer) => `  ${cell(peer.nodeFqdn, PEER_WIDTHS[1])} ~${peer.maxPromptTokens} tokens`),
  ];
}

/**
 * Measured prompt and output speed, one line per node, engine and model, under `pool status`. Nothing
 * at all until something has been timed, so an unmeasured fleet — or a Hub predating throughput —
 * reads exactly as before. A peer can appear twice: once as timed here, once as it reported itself.
 */
export function formatThroughputLines(status: PoolStatusResponse): string[] {
  const rows: string[] = [];
  const add = (node: string, estimates: PoolThroughputEstimate[] | undefined, source: string) => {
    for (const estimate of estimates ?? []) {
      const prefill = estimate.prefill.map(
        (point) =>
          `≥${Math.round(point.fromTokens / 1024)}k ${point.deadline ? '≤' : '~'}${point.tokensPerSec} tok/s${point.deadline ? ' (missed deadline)' : ''}`,
      );
      const decode = estimate.decode ? [`output ~${estimate.decode.tokensPerSec} tok/s`] : [];
      rows.push(
        `  ${cell(node, PEER_WIDTHS[1])} ${sanitizeForBox(estimate.model)} (${sanitizeForBox(estimate.backend)}) ${[...prefill.map((text) => `prompt ${text}`), ...decode].join(' · ')}${source}`,
      );
    }
  };
  add('this node', status.localNode.throughput, '');
  for (const peer of status.peers) {
    add(peer.nodeFqdn, peer.throughput?.observed, '  — timed here');
    add(peer.nodeFqdn, peer.throughput?.advertised, '  — reported');
  }
  if (rows.length === 0) return [];
  return ['', 'Measured speed (a long prompt skips a node too slow to start it within its deadline)', ...rows];
}

/**
 * An outstanding PIN is a live, unauthenticated way into this node's pairing route, so `status` says
 * when one exists — the mint is the only place it is ever shown, and an operator who walked away
 * from a terminal has nothing else to check.
 */
export function formatPairingPinStateLines(pairingPin: PoolPairingPinState | undefined): string[] {
  if (!pairingPin?.active) return [];
  return [
    `  Pairing    ${PENDING} PIN outstanding until ${formatPoolTimestamp(pairingPin.expiresAt)}`,
    '             Revoke it early with: cihub pool cancel-pin',
  ];
}

/**
 * Which peers are still on the legacy bearer token.
 *
 * This is the precondition for `poolRequireSignedPeers`, and turning that on across a fleet where a
 * peer has not upgraded takes both directions of that pairing down. The upgrade happens on a health
 * poll on its own, so the actionable output is the list of peers not there yet — and, when there are
 * none, that the switch is now safe to flip.
 */
export function formatPeerAuthModeLines(peers: PoolPeerRow[], requireSignedPeers: boolean | undefined): string[] {
  // Peers that never completed pairing have no auth mode to report yet, so they are not evidence
  // either way and must not hold back the "safe to flip" line.
  const paired = peers.filter((peer) => peer.status !== 'pending');
  if (paired.length === 0) return [];

  const bearer = paired.filter((peer) => peer.authMode !== 'signed');
  if (bearer.length === 0) {
    return requireSignedPeers
      ? ['', `Peer auth: ${OK} every peer is signed, and poolRequireSignedPeers is on.`]
      : [
          '',
          `Peer auth: ${OK} every peer has upgraded to a pinned key.`,
          '  Turning off the legacy bearer path is now safe: set poolRequireSignedPeers.',
        ];
  }

  return [
    '',
    `Peer auth: ${PENDING} still on the legacy bearer token — ${bearer.map((peer) => sanitizeForBox(peer.nodeFqdn)).join(', ')}`,
    '  The upgrade runs on a health poll by itself; no action is needed unless it stays.',
    requireSignedPeers
      ? `  ${FAIL} poolRequireSignedPeers is ON, so these peers are being refused in both directions.`
      : '  Do not set poolRequireSignedPeers until this list is empty — it would cut them off.',
  ];
}

/** Width the action text is wrapped to. The box does not wrap, and the action is the one long line an operator must read whole. */
const ACTION_WRAP_WIDTH = 96;

/** Word-wraps sanitized text. A single word longer than `width` stays whole on its own line rather than being cut mid-command. */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of sanitizeForBox(text).split(' ')) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  return current ? [...lines, current] : lines;
}

/**
 * The peers that refuse this Hub, each with the operator's next step.
 *
 * Only the two refusal kinds are listed. An unreachable peer needs nothing from the operator, and the
 * table already says so. A refusing peer used to show as `unreachable 3169/3` and nothing else, which
 * is how beta-max's recreated identity went unexplained for 28 hours.
 */
export function formatPeerRefusalLines(peers: PoolPeerRow[]): string[] {
  const refusing = peers.filter((peer) => peer.probeFailure && peer.probeFailure.kind !== 'unreachable');
  if (refusing.length === 0) return [];

  const lines = ['', 'Peers refusing this Hub'];
  for (const peer of refusing) {
    const failure = peer.probeFailure as PoolPeerProbeFailure;
    const verdict = failure.kind === 'identity_changed' ? 'identity changed' : 'credentials refused';
    const nextProbe = failure.nextProbeAt ? ` · next probe ${formatPoolTimestamp(failure.nextProbeAt)}` : '';
    lines.push(
      `  ${FAIL} ${sanitizeForBox(peer.nodeFqdn)}  ${verdict}${failure.httpStatus === null ? '' : ` (HTTP ${failure.httpStatus})`} · ${failure.attempts} probe(s) since ${formatPoolTimestamp(failure.since)}${nextProbe}`,
    );
    if (failure.action) {
      lines.push(...wrapWords(failure.action, ACTION_WRAP_WIDTH).map((line) => `    ${line}`));
    }
  }
  return lines;
}

/**
 * The Pins block of `cihub pool status`, and the only place pins are listed — status answers the
 * whole question, so there is no `pool pins` subcommand to keep in step with it.
 *
 * `targetAvailable: false` is called out rather than shown as a flag, because a pin that is quietly
 * doing nothing is the failure mode of the whole feature: `prefer` never errors, so a pin at an
 * unreachable or unpaired node is invisible everywhere else.
 */
export function formatPoolPinLines(pins: PoolStatusPin[] | undefined): string[] {
  if (!pins || pins.length === 0) {
    return [];
  }
  const lines = ['', 'Pins'];
  for (const pin of pins) {
    const target = pin.targetKind === 'local' ? 'this Hub' : (pin.nodeFqdn ?? `peer ${shortId(pin.peerId ?? '')} (no longer paired)`);
    const scope = pin.scope === 'model' ? sanitizeForBox(pin.model ?? '?') : 'all models';
    lines.push(
      `  ${pin.targetAvailable ? OK : FAIL} ${cell(scope, 34)} → ${sanitizeForBox(target)}${pin.targetAvailable ? '' : '  (not usable right now)'}`,
    );
  }
  lines.push(
    '  Pins are a preference, not a rule: if the pinned node cannot serve a request it is ranked',
    '  normally, so a pin can never take inference down. Remove one with: cihub pool unpin',
  );
  return lines;
}

/**
 * The box `cihub pool ceiling` prints once the PATCH has answered.
 *
 * `settings` is what the Hub stored, and `status` is read after the write, so the box can tell the
 * two ways the command changes nothing in effect: a Hub predating ceilings (its PATCH schema strips
 * the unknown field and answers 200 with no `poolMaxPromptTokens` in it), and an `.env` override that
 * wins over whatever was stored.
 */
export function formatPromptCeilingResultLines(
  requested: number | null,
  settings: PoolStatusResponse['settings'],
  status: PoolStatusResponse | null,
): { title: string; lines: string[]; tone: 'green' | 'yellow' | 'red' } {
  if (!('poolMaxPromptTokens' in settings)) {
    return {
      title: 'Prompt ceiling not supported',
      tone: 'red',
      lines: [
        `${FAIL} This Hub's build predates prompt ceilings, so nothing was stored and routing is unchanged.`,
        'Update it first: cihub pool update',
      ],
    };
  }
  const effective = status?.localNode.maxPromptTokens;
  if (status?.localNode.maxPromptTokensSetBy === 'env' && effective !== requested) {
    return {
      title: 'Prompt ceiling saved (override in force)',
      tone: 'yellow',
      lines: [
        `Stored  ${requested === null ? 'no ceiling' : `~${requested} tokens`}`,
        '',
        `${FAIL} HUB_POOL_MAX_PROMPT_TOKENS=${effective} in this Hub's environment wins over the stored value,`,
        'so this changed nothing in effect. Remove that line, then restart the Hub.',
      ],
    };
  }
  if (requested === null) {
    return {
      title: 'Prompt ceiling cleared',
      tone: 'yellow',
      lines: ['This node serves pooled prompts of any size again, from the next request and the next peer poll.'],
    };
  }
  return {
    title: 'Prompt ceiling set',
    tone: 'green',
    lines: [
      `Prompts estimated over ~${requested} tokens (about ${Math.round((requested * 4) / 1000)} KB of request) now go to another node.`,
      '',
      "This Hub's own apps skip it from the next request; peers learn it on their next health poll.",
      'It is a preference, not a limit: when no other node can serve a request, this one still does,',
      'and the routing log marks that request as placed over the ceiling.',
      '',
      'See the decisions: cihub pool log',
    ],
  };
}

/**
 * The box `cihub pool context-cap` prints.
 *
 * `before` is what the Hub reported before the write, and decides two of the outcomes on its own: a
 * Hub whose preferences carry no `maxNumCtx` at all predates the cap (nothing is written to it), and
 * a cap that already reads as requested is left alone (`written` false), because the write route
 * restarts every AI app whose env it changes. `after` is the read-back — the box reports the cap in
 * force, not the one requested.
 */
export function formatContextCapResultLines(
  requested: number | null,
  before: InferencePreferencesResponse,
  after: InferencePreferencesResponse | null,
  written: boolean,
): { title: string; lines: string[]; tone: 'green' | 'yellow' | 'red' | 'cyan' } {
  if (!('maxNumCtx' in before)) {
    return {
      title: 'Context cap not supported',
      tone: 'red',
      lines: [
        `${FAIL} This Hub's build predates the context cap, so nothing was written and the handout is unchanged.`,
        'Update it first: cihub pool update',
      ],
    };
  }
  if (!written) {
    return {
      title: 'Context cap unchanged',
      tone: 'cyan',
      lines:
        requested === null
          ? ['No context cap is set on this node; nothing to clear, and no app was restarted.']
          : [`The cap is already ${requested} tokens; nothing was written, and no app was restarted.`],
    };
  }
  const inForce = after?.maxNumCtx;
  if (after && inForce !== requested) {
    return {
      title: 'Context cap not in force',
      tone: 'red',
      lines: [
        `${FAIL} Asked for ${requested === null ? 'no cap' : `${requested} tokens`}, but the Hub reads back ${inForce === null || inForce === undefined ? 'no cap' : `${inForce} tokens`}.`,
        'Read the Hub log around the write: cihub logs',
      ],
    };
  }
  if (requested === null) {
    return {
      title: 'Context cap cleared',
      tone: 'yellow',
      lines: [
        "Apps on this node are sized from the model window and this node's memory alone again —",
        'the sizing before the cap existed, which can hand out a window larger than the engine runs.',
        '',
        'AI apps whose env changed are restarting now; peers learn it on their next health poll.',
      ],
    };
  }
  return {
    title: 'Context cap set',
    tone: 'green',
    lines: [
      `Apps on this node are handed a num_ctx of at most ${requested} tokens: min(model window, memory sizing, ${requested}).`,
      '',
      'AI apps whose env changed are restarting now; peers learn the cap on their next health poll, and a',
      'pooled request is capped at the smallest cap among the nodes serving its model.',
      '',
      `Match it to the engine: OLLAMA_CONTEXT_LENGTH on this node should be ${requested} too —`,
      `cihub fleet backends --ollama-context ${requested} --execute sets both, on every node.`,
      '',
      'Check it: cihub pool status',
    ],
  };
}

/**
 * The box `cihub pool slots` prints. Same three outcomes from `before` as the cap's box, for the
 * same reasons; `after` is the read-back, so the box reports the count in force, not the one requested.
 */
export function formatOllamaSlotsResultLines(
  requested: number | null,
  before: InferencePreferencesResponse,
  after: InferencePreferencesResponse | null,
  written: boolean,
): { title: string; lines: string[]; tone: 'green' | 'yellow' | 'red' | 'cyan' } {
  if (!('ollamaSlots' in before)) {
    return {
      title: 'Slot count not supported',
      tone: 'red',
      lines: [
        `${FAIL} This Hub's build predates the slot count, so nothing was written and placement is unchanged.`,
        'Update it first: cihub pool update',
      ],
    };
  }
  if (!written) {
    return {
      title: 'Slot count unchanged',
      tone: 'cyan',
      lines:
        requested === null
          ? ['No slot count is stated on this node; nothing to clear.']
          : [`The slot count is already ${requested}; nothing was written.`],
    };
  }
  const inForce = after?.ollamaSlots;
  if (after && inForce !== requested) {
    return {
      title: 'Slot count not in force',
      tone: 'red',
      lines: [
        `${FAIL} Asked for ${requested === null ? 'none' : requested}, but the Hub reads back ${inForce === null || inForce === undefined ? 'none' : inForce}.`,
        'Read the Hub log around the write: cihub logs',
      ],
    };
  }
  if (requested === null) {
    return {
      title: 'Slot count cleared',
      tone: 'yellow',
      lines: [
        'This node states no slot count again: the pool ranks it by queue depth alone, as before slots',
        'existed, and peers learn that on their next health poll.',
      ],
    };
  }
  return {
    title: 'Slot count set',
    tone: 'green',
    lines: [
      `This node states that its Ollama runs ${requested} request${requested === 1 ? '' : 's'} at once. Peers learn it on their next health poll;`,
      'with poolSlotAwareness=1 an entry node places behind every node with a free slot before this one',
      `once ${requested} ${requested === 1 ? 'is' : 'are'} in flight here.`,
      '',
      `Match it to the daemon: OLLAMA_NUM_PARALLEL on this node should be ${requested} too. Across the fleet,`,
      `cihub fleet backends --ollama-parallel ${requested} --ollama-context <n> --ollama-keep-alive <d> --execute sets both —`,
      "passed with the node's other runtime flags: that file is rendered whole from the flags on the line, so",
      `--ollama-parallel ${requested} alone would drop OLLAMA_KEEP_ALIVE and OLLAMA_CONTEXT_LENGTH from every node it touches.`,
      '',
      'Check it: cihub pool status',
    ],
  };
}

// --- discovery ---

const DISCOVER_WIDTHS = [34, 24] as const;

/**
 * The candidate table, or an empty state that names the sources and what each one needs.
 *
 * The Admin API — reported by `tailscaleAdminApiConfigured`, the one directory `GET status` speaks
 * to — is one of three on paper: the local Tailscale daemon's peer map also names candidates and
 * needs no credential, and the CI Portal device registry is wired in but returns nothing today (see
 * `HubPoolDiscoveryService.listPortalCandidates`). So the flag only selects a hint here — it is not
 * the difference between discovery having run and not having run, and the copy must not imply that
 * it is. Nor may the empty state claim a directory was consulted: a Hub off the tailnet never reads
 * a peer map.
 */
export function formatPoolDiscoverLines(allDevices: DiscoverablePoolPeer[], tailscaleAdminApiConfigured: boolean): string[] {
  const devices = allDevices.filter((device) => !isUnverifiedCandidate(device));
  const unverifiedLines = formatUnverifiedLanLines(allDevices.filter(isUnverifiedCandidate));
  if (devices.length === 0) {
    // Manual entry goes first on purpose: it works today, on this Hub, with nothing to go and create
    // in someone else's console.
    return [
      'No unpaired CI-Hub nodes found: no directory this Hub can ask named one.',
      '',
      'Find one by address:  cihub pool probe <address>',
      '  e.g. 192.168.1.42, 192.168.1.42:5002, or a hostname on this LAN. A Hub found that',
      '  way is paired with directly — it never appears in this list, because an address is',
      '  not a name: cihub pool pair <address> --pin <digits>',
      '',
      ...(tailscaleAdminApiConfigured
        ? ['Whole-tailnet enumeration is configured, and found nothing unpaired.']
        : [
            `${PENDING} Whole-tailnet enumeration is off. Set TAILSCALE_OAUTH_CLIENT_ID and`,
            '  TAILSCALE_OAUTH_CLIENT_SECRET (devices:core:read) and restart to list every device',
            '  on the tailnet at once. It is optional — this Hub pools normally without it, and',
            '  already lists the tailnet peers its own daemon can see whenever it is connected.',
          ]),
      '',
      'Already-paired nodes are excluded — see: cihub pool peers',
      'A candidate only appears once its Hub is running and answers /api/inference/pool/identify.',
      'Registering with CI Portal does not add candidates here: that directory names nodes by',
      '  MagicDNS name, and Portal stores none.',
      ...unverifiedLines,
    ];
  }

  // "DEVICE ID", not "TAILSCALE DEVICE": the id belongs to whichever directory named the node, so a
  // candidate that came from the CI Portal registry carries its Portal device id here.
  const lines = [
    `${cell('NODE', DISCOVER_WIDTHS[0])} ${cell('HOSTNAME', DISCOVER_WIDTHS[1])} DEVICE ID`,
    ruleRow([...DISCOVER_WIDTHS, 'DEVICE ID'.length]),
  ];
  for (const device of devices) {
    // Every string on this row is authored off-box, and box output is ANSI-injectable.
    lines.push(
      `${cell(device.nodeFqdn, DISCOVER_WIDTHS[0])} ${cell(device.hostname, DISCOVER_WIDTHS[1])} ${sanitizeForBox(device.tailscaleDeviceId || '-')}`,
    );
  }
  lines.push('', 'Pair one with: cihub pool pair <node>', ...unverifiedLines);
  return lines;
}

/**
 * Hubs heard over LAN mDNS, listed apart from the table above and with no pair hint. Every field was
 * chosen by whoever sent the datagram, and `pool pair <node>` with one of these names would hand this
 * Hub's name and a fresh peer token to wherever the packet pointed.
 */
function formatUnverifiedLanLines(devices: DiscoverablePoolPeer[]): string[] {
  if (devices.length === 0) return [];
  return [
    '',
    `${PENDING} Heard on the LAN, UNVERIFIED — not pairable from this list:`,
    ...devices.map((device) => `  ${cell(device.hostname, DISCOVER_WIDTHS[1])} ${sanitizeForBox(device.address ?? '-')}`),
    '  Anything on the network can announce itself, so these names and addresses are only claims.',
    '  A Hub you own appears in the table above once it is on this tailnet.',
  ];
}

/**
 * A probe result as the operator reads it.
 *
 * Every branch names what to do next, and the success branch is explicit that the node has not been
 * *named* — only found. That is the one thing about this command it would be easy and costly to
 * misunderstand: the address alone can never produce a peer, because the tailnet name a peer row is
 * keyed on is only disclosed to a pairing request carrying that Hub's PIN.
 */
export function formatPoolProbeLines(result: PoolProbeResult): string[] {
  const address = sanitizeForBox(result.address);
  switch (result.reason) {
    case 'unreachable':
      return [
        `${FAIL} Nothing answered at ${address}.`,
        '',
        'Tried the Hub API port (5002, then 3000). If that Hub publishes a different one,',
        'name it: cihub pool probe <address>:<port>',
        'The peer Hub also has to be running.',
      ];
    case 'not_a_hub':
      return [`${FAIL} Something answered at ${address}, but it is not a CI-Hub.`];
    case 'protocol_too_old':
      return [
        `${PENDING} Found a CI-Hub at ${address}, but it speaks an older pool protocol.`,
        '',
        'Pairing by address needs the far Hub to answer a PIN with its tailnet name, which',
        'that build cannot do. Upgrade it, or pair by its MagicDNS name instead:',
        '  cihub pool pair <node-fqdn>',
      ];
    default:
      break;
  }

  return [
    `${OK} There is a CI-Hub at ${address}, speaking pool protocol ${result.poolProtocol ?? '?'}.`,
    '',
    'It is not named here, and that is deliberate: /identify is unauthenticated and reachable',
    'through the public tunnel, so it reports no MagicDNS name. Pair to learn it.',
    '',
    'On THAT Hub:  cihub pool pairing-pin',
    `Then here:    cihub pool pair ${address} --pin <digits>`,
    '',
    'The PIN authenticates the request; the answer carries the tailnet name, and that is what',
    'the peer is stored as. Every pooled request then goes to https://<name> — same TLS, same',
    'credentials. The address was only ever a way to reach the handshake.',
  ];
}

// --- routing log ---

/**
 * The counts line both `pool status` and `pool log` print.
 *
 * The hang-up breakdown is the whole reason this is a function: `4 failed` on a pool whose peers are
 * all connected reads as "the pool cannot place work", and on beta-max (2026-09-21) that is exactly
 * how it was read. Every one of those four was a caller that gave up at 30 s on a turn a node was
 * still prefilling — a statement about how long the fleet takes to first byte, not about routing.
 * Only printed when the Hub reported the figure and it is non-zero: an older Hub says nothing rather
 * than implying zero, and a fleet where no caller ever left keeps the line it has always had.
 *
 * Requests an engine refused as bad are broken out beside the hang-ups for the same reason: they are
 * an app sending something no node will run, not a pool that cannot place work.
 */
function formatRoutingCounts(summary: {
  recorded: number;
  capacity: number;
  served: number;
  failed: number;
  clientClosed?: number;
  requestErrors?: number;
  outputFaults?: number;
  failovers: number;
}): string {
  const abandoned = summary.clientClosed ?? 0;
  const refused = summary.requestErrors ?? 0;
  // The opposite of a refusal, and why it is its own count: the node answered 200 with output nobody
  // could use. core-2's summary read `failed=0` over 167 of them on 2026-09-29.
  const badOutput = summary.outputFaults ?? 0;
  const reasons = [
    ...(abandoned > 0 ? [`${abandoned} abandoned by the caller`] : []),
    ...(refused > 0 ? [refused === 1 ? '1 refused as a bad request' : `${refused} refused as bad requests`] : []),
    ...(badOutput > 0 ? [badOutput === 1 ? '1 bad answer from its node' : `${badOutput} bad answers from their nodes`] : []),
  ];
  const failed = reasons.length > 0 ? `${summary.failed} failed (${reasons.join(', ')})` : `${summary.failed} failed`;
  return `${summary.recorded}/${summary.capacity} recorded · ${summary.served} served · ${failed} · ${summary.failovers} failover(s)`;
}

const LOG_WIDTHS = [20, 4, 20, 34, 5, 7, 8] as const;

/** A request-error label in the words an app's operator can act on. An unknown label prints as itself. */
function describeRequestErrorSignature(signature: string): string {
  const words: Record<string, string> = {
    'no-user-query': 'no user message for the chat template',
    'missing-messages': 'no messages in the request',
    'invalid-message': 'a malformed message',
    'context-length': 'prompt longer than the context window',
    'chat-template': 'chat template would not render',
    'client-error': 'an HTTP 4xx, relayed on its status',
    'truncated-upstream': "a response cut off before the dialect's final frame",
    'degenerate-output': 'only <unusedN> placeholder tokens',
  };
  return words[signature] ?? signature;
}

/** A failover chain with why each node was passed over, where the Hub says; the node names alone from an older one. */
function describeFailoverChain(entry: Pick<PoolRoutingRecord, 'failedOverFrom' | 'attempts'>): string {
  const attempts = entry.attempts ?? [];
  if (attempts.length === 0) {
    return entry.failedOverFrom.map(sanitizeForBox).join(', ');
  }
  return attempts.map((attempt) => `${sanitizeForBox(attempt.node)} (${sanitizeForBox(attempt.reason)})`).join(', ');
}

/** Where a routing-log row's affinity key came from, in the words an app operator can act on. Never the key itself. */
function describeAffinityKey(affinity: Pick<PoolRoutingAffinity, 'key'>): string {
  return affinity.key === 'header' ? 'session from X-Hub-Pool-Session' : 'session from prompt digest';
}

/**
 * The limit an affinity row was judged against: the in-flight limit, and with a margin set, the margin
 * and the queue it was measured from, since a margin decision cannot be checked from the limit alone.
 */
function describeAffinityLimit(affinity: PoolRoutingAffinity): string {
  const margin = affinity.affinityMargin ?? 0;
  if (margin <= 0) {
    return `limit ${affinity.maxInFlight}`;
  }
  const leastLoaded = affinity.leastLoadedInFlight;
  return `limit ${affinity.maxInFlight}, margin ${margin}${leastLoaded === null || leastLoaded === undefined ? '' : `, ${leastLoaded} on the least-loaded other node`}`;
}

/**
 * Whether the remembered engine passed affinity's test, as the row states it, or as it can be
 * worked out on a Hub predating `qualified`: under the limit passes, and a margin is judged from
 * `leastLoadedInFlight` the way the proxy judges it. `null` when it cannot be worked out: a Hub
 * that shipped the margin before `leastLoadedInFlight` states the margin but not the queue it was
 * measured from, so a row over the limit there may have qualified by it or not. Printing that row
 * as "ranking alone" would call a margin decision the ranker's.
 */
function affinityQualified(affinity: PoolRoutingAffinity): boolean | null {
  if (affinity.qualified !== undefined) {
    return affinity.qualified;
  }
  if (affinity.inFlight === null) {
    return false;
  }
  if (affinity.inFlight < affinity.maxInFlight) {
    return true;
  }
  const margin = affinity.affinityMargin ?? 0;
  if (!(margin > 0) || !(affinity.maxInFlight > 0)) {
    return false;
  }
  const leastLoaded = affinity.leastLoadedInFlight;
  if (leastLoaded === undefined || leastLoaded === null) {
    return null;
  }
  // The proxy's own test, including its hard stop at 20 in flight — see `applyPrefixAffinity`.
  return affinity.inFlight <= leastLoaded + margin && affinity.inFlight < 20;
}

/** A window from a contention record: `null` is a request that named none, on a node that states no default. */
function describeContextWindow(numCtx: number | null): string {
  return numCtx === null ? 'the engine default' : `num_ctx ${numCtx}`;
}

export function formatPoolRoutingLogLines(log: PoolRoutingLogResponse): string[] {
  const summary = log.summary;
  const header = [formatRoutingCounts(summary), `Last decision  ${formatPoolTimestamp(summary.lastAt)}`, ''];

  if (log.entries.length === 0) {
    return [
      ...header,
      'Nothing routed since the Hub started.',
      '',
      'The log is in-memory and process-local: it is empty after a restart, and it only',
      'records requests that went through the pool proxy. If apps are running and this',
      'stays empty, check `cihub pool status` — with no connected peers nothing is routed.',
    ];
  }

  const lines = [
    ...header,
    `${cell('TIME', LOG_WIDTHS[0])} ${cell('DIR', LOG_WIDTHS[1])} ${cell('MODEL', LOG_WIDTHS[2])} ${cell('NODE', LOG_WIDTHS[3])} ${cell('ATT', LOG_WIDTHS[4])} ${cell('MS', LOG_WIDTHS[5])} ${cell('TOTAL', LOG_WIDTHS[6])} OUTCOME`,
    ruleRow([...LOG_WIDTHS, 'OUTCOME'.length]),
  ];

  for (const entry of log.entries) {
    const outcome = entry.outcome === 'served' ? `${OK} served` : `${FAIL} failed`;
    const status = entry.status === null ? '' : ` ${entry.status}`;
    lines.push(
      [
        cell(formatPoolTimestamp(entry.at), LOG_WIDTHS[0]),
        cell(entry.direction === 'inbound' ? 'in' : 'out', LOG_WIDTHS[1]),
        cell(entry.model ?? '-', LOG_WIDTHS[2]),
        cell(entry.node ?? '-', LOG_WIDTHS[3]),
        cell(`${entry.attempt}/${entry.candidates}`, LOG_WIDTHS[4]),
        cell(String(entry.durationMs), LOG_WIDTHS[5]),
        cell(typeof entry.totalMs === 'number' ? String(entry.totalMs) : '-', LOG_WIDTHS[6]),
        `${outcome}${status}`,
      ].join(' '),
    );
    // First, and before every other annotation: it is the one that changes what the row MEANS. A
    // `x failed` with no status is otherwise read as the pool failing to place the request, and the
    // NODE column beside it — which now names the node that was still working — would then read as
    // the node that broke. Neither is true: nobody was waiting for the answer any more.
    if (entry.clientClosed) {
      lines.push(
        `  ↳ the app closed its connection after ${entry.durationMs} ms; ${sanitizeForBox(entry.node ?? '?')} had not answered yet — not a routing failure`,
      );
    }
    // Next, for the same reason: a `x failed 500` beside a node name reads as that node breaking,
    // and a short chain reads as the pool giving up early. Both are the request's doing.
    const requestError = entry.requestError;
    if (requestError?.basis === 'node') {
      // The opposite verdict, so the opposite sentence: a `x failed 200` IS that node breaking.
      lines.push(
        `  ↳ ${sanitizeForBox(entry.node ?? '?')} answered with ${describeRequestErrorSignature(requestError.signature)} — the node's fault, not the request's`,
      );
    } else if (requestError) {
      const node = sanitizeForBox(entry.node ?? '?');
      const agreed = requestError.basis === 'confirmed' && requestError.confirms ? `, as ${sanitizeForBox(requestError.confirms)} had` : '';
      const untried = Math.max(0, entry.candidates - entry.attempt);
      // On the last candidate there were no others to spare it: "not sent to the other 0 candidates"
      // would read as the pool stopping early, when it had asked everyone it could.
      const tail =
        requestError.basis === 'last-candidate'
          ? 'returned to the app unconfirmed, as no candidate was left to ask'
          : `returned to the app, not sent to the other ${untried} candidate${untried === 1 ? '' : 's'}`;
      lines.push(`  ↳ ${node} refused the request itself${agreed} (${describeRequestErrorSignature(requestError.signature)}); ${tail}`);
    }
    // Named on the row it shaped: an operator seeing everything land on one node cannot otherwise
    // tell a pin from the ranker having decided the same thing.
    if (entry.pin) {
      lines.push(`  ↳ pinned (${entry.pin.scope === 'model' ? 'this model' : 'all models'} → ${entry.pin.targetKind})`);
    }
    // Only when the ceiling changed something: an operator reading why fzzy got nothing needs this
    // line, and a note on every request that merely stayed under a ceiling would bury it.
    const ceiling = entry.promptCeiling;
    if (ceiling && ceiling.excluded.length > 0) {
      const nodes = ceiling.excluded.map((excluded) => `${sanitizeForBox(excluded.node)} (ceiling ${excluded.maxPromptTokens})`).join(', ');
      lines.push(
        ceiling.overridden
          ? `  ↳ ~${ceiling.estimatedTokens}-token prompt placed anyway over the ceiling of ${nodes}: no node under its ceiling could serve it`
          : `  ↳ ~${ceiling.estimatedTokens}-token prompt skipped ${nodes}`,
      );
    }
    // Only when a cap changed something, for the same reason as the ceiling line above.
    const cap = entry.contextCap;
    if (cap && cap.excluded.length > 0) {
      const nodes = cap.excluded.map((excluded) => `${sanitizeForBox(excluded.node)} (cap ${excluded.maxNumCtx})`).join(', ');
      const window = cap.source === 'request' ? `num_ctx ${cap.numCtx}` : `~${cap.numCtx}-token prompt with no num_ctx`;
      lines.push(
        cap.overridden
          ? `  ↳ ${window} placed anyway over the context cap of ${nodes}: no node whose cap could take it could serve it`
          : `  ↳ ${window} skipped ${nodes}`,
      );
    }
    // Only when a measurement changed something, for the same reason as the ceiling line above.
    const throughput = entry.throughput;
    const slow = throughput?.estimates.filter((estimate) => estimate.slow) ?? [];
    if (throughput && slow.length > 0) {
      const budget = `${Math.round(throughput.budgetMs / 1000)} s`;
      const nodes = slow
        .map(
          (estimate) =>
            `${sanitizeForBox(estimate.node)} (~${estimate.tokensPerSec} tok/s${estimate.extrapolated && estimate.fromPromptTokens ? ` measured at ~${estimate.fromPromptTokens} tokens` : ''}, ${estimate.deadline ? '≥' : '~'}${Math.round(estimate.predictedMs / 1000)} s)`,
        )
        .join(', ');
      lines.push(
        throughput.overridden
          ? `  ↳ ~${throughput.estimatedTokens}-token prompt placed anyway though ${nodes} ${slow.length === 1 ? 'is' : 'are'} expected to miss the ${budget} deadline: nothing faster could serve it`
          : `  ↳ ~${throughput.estimatedTokens}-token prompt moved ${nodes} behind nodes expected to answer within ${budget}`,
      );
    }
    // Only when a full engine was moved: the record is present, with an empty `demoted`, on every
    // request where some candidate stated a count, and a note on each of those would bury the one
    // an operator reading why a burst skipped the 2-slot node needs.
    const slots = entry.slots;
    if (slots && slots.demoted.length > 0) {
      const nodes = slots.demoted
        .map((demoted) => `${sanitizeForBox(demoted.node)} (${demoted.inFlight} in flight, ${demoted.slots} slot${demoted.slots === 1 ? '' : 's'})`)
        .join(', ');
      lines.push(
        slots.overridden
          ? `  ↳ placed anyway with every slot full on ${nodes}: no node with a free slot was ahead of it`
          : `  ↳ moved ${nodes} behind nodes with a free slot`,
      );
    }
    // Only when an engine gave way or was placed on anyway: one that kept its place while a pin or
    // affinity put another node first changed nothing an operator needs to read here.
    const contention = entry.contention;
    if (contention && contention.demoted.length > 0) {
      const describe = (demoted: PoolRoutingContention['demoted'][number]) => {
        const busy = demoted.busyWith.map((generation) => `${sanitizeForBox(generation.model)} at ${describeContextWindow(generation.numCtx)}`);
        return `${sanitizeForBox(demoted.node)} (busy with ${busy.join(', ')}; this one at ${describeContextWindow(demoted.runsAt)})`;
      };
      const placed = contention.overridden
        ? (contention.demoted.find((demoted) => demoted.node === entry.node && demoted.backend === entry.backend) ?? contention.demoted[0])
        : undefined;
      if (placed) {
        lines.push(
          placed.behind.length > 0
            ? `  ↳ placed anyway on ${describe(placed)}: nothing it gave way to answered`
            : placed.overriddenBy === 'affinity'
              ? `  ↳ kept ${describe(placed)} first: it holds this session's prompt prefix, which prefix affinity follows over contention`
              : `  ↳ kept ${describe(placed)} first: every node after it was busier, or moved behind it by a line above`,
        );
      } else {
        const moved = contention.demoted.filter((demoted) => demoted.behind.length > 0);
        if (moved.length > 0) {
          lines.push(
            `  ↳ moved ${moved.map((demoted) => `${describe(demoted)} behind ${demoted.behind.map(sanitizeForBox).join(', ')}`).join('; ')}`,
          );
        }
      }
    }
    // Only when affinity changed something or stood aside: a `hit` is the line an operator watching
    // a session stay put needs, a `skipped` says why a turn re-prefilled cold, and a `miss` on every
    // first turn would bury both. Each names where the key came from: a session the app named with
    // `X-Hub-Pool-Session` and one the proxy digested from the prompt are told apart on this line,
    // because a `hit` that sent sessions to the wrong node (core-2, 2026-09-21) was a digest that
    // named too many of them, and the first question is which kind of key it was.
    //
    // A `hit` affinity did not qualify is the ranker landing the session on its warm node by itself,
    // and is not printed as affinity following it: a fleet test on 2026-09-29 read such a row, at one
    // in flight against a limit of 1, as affinity working. A Hub predating `qualified` is read from
    // what its row carries, and a row it cannot be read from says so rather than guessing either way.
    const affinity = entry.affinity;
    if (affinity) {
      const underLimit = affinity.inFlight !== null && affinity.inFlight < affinity.maxInFlight;
      const qualified = affinityQualified(affinity);
      const node = sanitizeForBox(affinity.remembered ?? '?');
      const inFlight = affinity.inFlight ?? 0;
      const undetermined = `this Hub's row does not say whether its margin qualified it (${describeAffinityLimit(affinity)}; ${describeAffinityKey(affinity)})`;
      if (affinity.outcome === 'hit') {
        lines.push(
          qualified === null
            ? `  ↳ landed on ${node}, which holds this prompt's prefix, at ${inFlight} in flight: ${undetermined}`
            : qualified
              ? `  ↳ followed its prompt prefix to ${node} (${inFlight} in flight, ${describeAffinityLimit(affinity)}; ${describeAffinityKey(affinity)})`
              : `  ↳ landed on ${node}, which holds this prompt's prefix, by ranking alone: affinity stood aside at ${inFlight} in flight (${describeAffinityLimit(affinity)}; ${describeAffinityKey(affinity)})`,
        );
      } else if (affinity.outcome === 'skipped') {
        lines.push(
          qualified === null
            ? `  ↳ ${node} holds this prompt's prefix but had ${inFlight} in flight, and another node was placed first: ${undetermined}`
            : qualified
              ? `  ↳ ${node} holds this prompt's prefix and was ${underLimit ? 'under the limit' : 'within its margin'}, but a ceiling, a demotion or a pin placed another node first (${describeAffinityKey(affinity)})`
              : `  ↳ ${node} holds this prompt's prefix but had ${inFlight} in flight (${describeAffinityLimit(affinity)}); ranked as usual (${describeAffinityKey(affinity)})`,
        );
      }
    }
    // The chain, not a count: which nodes refused, and with what, is the whole point of reading this log.
    if (entry.failedOverFrom.length > 0) {
      lines.push(`  ↳ failed over from ${describeFailoverChain(entry)}`);
    }
    // A failure nothing above explains — a walk that ran out, an inbound 5xx, a node's bad output on
    // an inbound row — says why in the Hub's own few words.
    if (entry.outcome === 'failed' && entry.reason && !entry.clientClosed && !entry.requestError) {
      const reason = describeRequestErrorSignature(entry.reason);
      lines.push(`  ↳ ${reason === entry.reason ? sanitizeForBox(entry.reason) : `the node answered with ${reason}`}`);
    }
  }

  lines.push('', 'MS is time to response headers; TOTAL runs to the end of the response body. `in` rows are work a peer sent here.');
  return lines;
}

// --- discover orchestration ---

/**
 * Status alongside the candidate list, so the empty state can name the credential that is missing —
 * from the same boolean the UI uses.
 *
 * `found` is what the caller colours the box on, deliberately *not* `configured`: a credential-free
 * Hub that listed candidates from its daemon peer map or from Portal has nothing wrong with it, and
 * yellow means a problem state everywhere else in this CLI (`pool status` uses it for "not enabled",
 * `pool probe` for "not pairable"). The missing credential stays a line of copy inside the box.
 */
export async function runPoolDiscover(envFileName: string): Promise<{ lines: string[]; configured: boolean; found: boolean }> {
  // The candidate list is fetched unconditionally. It used to be skipped when no Tailscale Admin API
  // credential was configured, back when that credential was the only source; it is now one of
  // three. The local Tailscale daemon's peer map and the CI Portal device registry both name
  // candidates with no credential at all, so short-circuiting on the flag hid real candidates on
  // exactly the Hubs the credential-free paths exist for. `configured` still reports only the
  // credential, which is what the "how do I see the whole tailnet" hint keys on.
  const [status, devices] = await Promise.all([fetchPoolStatus(envFileName), fetchDiscoverablePeers(envFileName)]);
  return {
    lines: formatPoolDiscoverLines(devices, status.tailscaleAdminApiConfigured),
    configured: status.tailscaleAdminApiConfigured,
    // Only a row that can be paired counts: a box of unverified LAN announcements is not a success.
    found: devices.some((device) => !isUnverifiedCandidate(device)),
  };
}
