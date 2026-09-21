import type { InferenceBackendType } from '@ci-hub/common/types';
import type { HubPoolPeer } from '@/core/database/drizzle/types';
import type { HubPoolDirectionalState, HubPoolDisabledBy, HubPoolPin, HubPoolPreferences, PoolContainerRollup } from '@/common/helpers/hub-pool';
import type { PoolPeerProbeFailure } from './hub-pool-probe-failure';

/** One backend's live model availability on a node, as reported by `GET /inference/pool/capabilities`. */
export interface PoolPeerBackendCapability {
  type: InferenceBackendType;
  healthy: boolean;
  modelsLoaded: string[];
}

/** Body returned by `GET /inference/pool/capabilities` and cached as `hub_pool_peer.last_capabilities`. */
export interface PoolPeerCapabilities {
  hardwareTier: string;
  backends: PoolPeerBackendCapability[];
  /**
   * Requests the node's own engines were serving when the snapshot was taken — the only load signal
   * the Hub can actually measure, since it has no live GPU-utilization telemetry anywhere (see
   * `HardwareInspectorService`, which reports a static hardware profile, not counters).
   *
   * Optional because a peer on a pre-pooling-rank build omits it, and because the field arrives over
   * the wire: an absent or stale value must read as "unknown", never as "idle".
   */
  inFlightRequests?: number;
  /**
   * Whether the answering node will actually take work from the caller right now.
   *
   * `false` is what inbound-off and a per-peer disable look like on the wire, and it is the flag
   * `peerCandidates` skips on — explicitly, rather than inferring it from `backends: []`, which is
   * pixel-identical to a node whose engines are simply down. Optional because a peer on an older
   * build omits it; absent must read as "yes", since that is what every pre-switch build meant.
   */
  acceptingWork?: boolean;
  /**
   * Smoothed 0-3 band of the answering node's real GPU busy-ness.
   *
   * ABSENT means unmeasured, and a reader must turn that into `UNKNOWN_PRESSURE` (mid-band), never
   * into 0. The distinction is the whole contract: the signal is AMD-only, so most nodes on a real
   * fleet legitimately omit it, and if silence read as "idle" every tie would go to whichever
   * machine knows least about itself. A node that cannot measure omits the key rather than sending
   * 0 for exactly that reason — absence and idleness do not share an encoding on the wire.
   */
  gpuPressure?: number;
  /** Which measurement produced {@link gpuPressure}. For the operator surfaces only; never read by the ranker. */
  gpuPressureSource?: PoolPressureSource;
  /**
   * The answering node's stable pool UUID — the one row of `hub_pool_identity` — learned only from
   * this authenticated response and never from the unauthenticated `/identify` probe. Absent from a
   * node whose identity could not be established, which is also every pre-identity build.
   */
  nodeUuid?: string;
  /**
   * Aggregate container counts and resource totals for the containers the answering node manages.
   * Numbers only — no names, no per-container rows: see {@link PoolContainerRollup} for why the
   * disclosure stops there and what population it covers.
   *
   * ABSENT means "not reported", and a reader must render it that way, never as zeros. Four states
   * share three encodings here, and two of them are deliberately identical:
   *
   *   - a peer on a pre-container build   -> key absent  -> not reported
   *   - a peer whose operator opted out   -> key absent  -> not reported
   *   - reporting, nothing running        -> `{ running: 0, ... }` -> 0 containers
   *   - reporting, busy                   -> real numbers
   *
   * The first two being indistinguishable is correct: both mean "we cannot tell you", and neither
   * may ever be drawn as an idle machine. Same rule {@link gpuPressure} states at length — absence
   * and idleness do not share an encoding on the wire. A node whose own sampler has no recent
   * sample omits the key for exactly that reason rather than publishing zeros it did not measure.
   *
   * `acceptingWork: false` does NOT blank this. It is a HEALTH signal, not an offer of work, so it
   * follows {@link inFlightRequests} and not `backends`: a node that has stopped taking work is
   * precisely when an operator needs to see whether it is still busy, and blanking it would draw a
   * loaded machine as an idle one at that moment.
   */
  containers?: PoolContainerRollup;
  /**
   * The answering node's prompt ceiling: the largest estimated prompt, in tokens, it wants to serve
   * while the caller has somewhere else to send it. A caller moves this node to the back of the
   * failover walk for a prompt whose estimate exceeds it — see `applyPromptCeiling`.
   *
   * ABSENT means no ceiling, and that is the only encoding of it: a node with none omits the key, and
   * so does every build predating the field, which is exactly the "serve anything" both of them mean.
   * Read through `clampPromptCeiling`, never raw — a value this build cannot believe is no ceiling.
   */
  maxPromptTokens?: number;
  /**
   * The answering node's ceiling on the context window it hands its apps (`inferenceMaxNumCtx`),
   * which its operator set to the engine's own context (`OLLAMA_CONTEXT_LENGTH`). An entry node
   * reads it twice: placing a request, it moves this node behind every candidate whose cap can take
   * the window the request asks for (`applyContextCap`), so a pooled request never asks this engine
   * for a window that reloads its model while another node can take it; and handing an app its
   * `num_ctx`, it uses the largest cap among the candidates that serve the model
   * (`poolContextCap`), since placement keeps that window off the smaller ones.
   *
   * ABSENT means no cap, and that is the only encoding of it: a node with none omits the key, and
   * so does every build predating the field — both read as "takes any window". Read through
   * `clampContextCap`, never raw.
   */
  maxNumCtx?: number;
  /**
   * How many requests the answering node's Ollama runs at once (`inferenceOllamaSlots`), which its
   * operator set to the daemon's `OLLAMA_NUM_PARALLEL`. With `poolSlotAwareness` on, an entry node
   * puts this node behind every candidate with a free slot once its known queue depth reaches this
   * figure — see `applySlotPlacement` — because past it Ollama queues the request behind the engine
   * rather than serving it.
   *
   * ABSENT means not stated, and that is the only encoding of it: a node with none omits the key,
   * and so does every build predating the field; both rank by queue depth alone, as before. Read
   * through `clampOllamaSlots`, never raw.
   */
  ollamaSlots?: number;
  /**
   * How fast the answering node's own engines have been reading prompts and writing tokens, per
   * (backend, model), as it measured them serving its apps and its peers. A caller treats it as a
   * second opinion next to what it timed itself, and believes whichever is slower — see
   * `hub-pool-throughput.service.ts`.
   *
   * ABSENT means unmeasured, and so does every build predating the field; an unmeasured node ranks
   * exactly as it did before throughput existed. Read through `readAdvertisedThroughput`, never raw.
   */
  throughput?: PoolThroughputEstimate[];
  updatedAt: string;
}

/**
 * What is known about how fast one engine serves one model. Rates are in the pool's own token
 * estimate (`bytes / 4` of the forwarded body) because that is the unit the first-byte budget is
 * sized in, so they can differ from an engine's own tokens-per-second figure.
 */
export interface PoolThroughputEstimate {
  model: string;
  backend: InferenceBackendType;
  /** One point per prompt-size band with live evidence, smallest band first. Empty when only decode has been seen. */
  prefill: PoolPrefillEstimate[];
  /** Decayed mean generation rate in engine tokens, or `null` when unmeasured. Reported only; ranking does not read it. */
  decode: PoolDecodeEstimate | null;
}

export interface PoolPrefillEstimate {
  /** The band's lower edge in estimated tokens: this point is applied to prompts of this size and larger. */
  fromTokens: number;
  /** The estimated size of the prompt behind the evidence. */
  promptTokens: number;
  /** Estimated prompt tokens per second to the first byte, rounded down. */
  tokensPerSec: number;
  /** `true` when the evidence is a request that ran out of its deadline with no first byte: the node is at least this slow. */
  deadline: boolean;
  /** How old the evidence is. An age rather than a timestamp, so two nodes' clocks never have to agree. */
  ageMs: number;
}

export interface PoolDecodeEstimate {
  tokensPerSec: number;
  ageMs: number;
}

/** A peer's throughput as `/pool/status` shows it: what this node timed, and what the peer said about itself, both as routing reads them. */
export interface PoolStatusPeerThroughput {
  observed: PoolThroughputEstimate[];
  advertised: PoolThroughputEstimate[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reserved contract surface.
//
// The types below describe state this build does not produce. They live here, and ship now,
// because five features land on this one module in sequence and each needs the shape of the next
// one's payload to compose with it — a status field that appears and changes shape three times is
// how the hand-mirrored frontend and CLI copies of `PoolStatus` silently drift. Everything is
// optional wherever it touches a live payload, so nothing has to populate it and no default moves.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which measurement produced a node's GPU-pressure band.
 *
 * AMD-only, and that is a decision rather than a gap. `amd-drm` reads the amdgpu driver's own
 * duty-cycle counter, which is the one number the Hub container can reach that actually answers "is
 * this GPU committed right now". `host-file` is the extension seam for everything else — nothing in
 * this repo writes it, so NVIDIA and Apple nodes report no source at all and rank neutral, which is
 * honest. The reviewed design also carried an engine-VRAM-residency source; it was cut because
 * residency reads the same whether an engine is generating or idling out its `keep_alive`, so it
 * would have ranked the COLDEST node as the least busy one.
 */
export type PoolPressureSource = 'host-file' | 'amd-drm';

/**
 * The pin types themselves live in `common/helpers/hub-pool.ts`, next to `HubPoolPreferences`,
 * because that is where a pin is actually stored — settings.json, not a table. Re-exported here so
 * the module's consumers keep one import for the pool contract.
 */
export type { HubPoolPin, PoolPinMode, PoolPinScope, PoolPinTargetKind } from '@/common/helpers/hub-pool';

/** A pin as `/pool/status` reports it: the stored pin plus whether its target can serve right now. */
export interface PoolStatusPin extends HubPoolPin {
  /** The peer's FQDN, or `null` for a local pin — so the UI never has to resolve an id itself. */
  nodeFqdn: string | null;
  /** `false` when the pinned node is gone, disabled, unreachable, or lacks the model: a pin that is silently doing nothing must say so. */
  targetAvailable: boolean;
}

/** How a peer authenticates to this node. `bearer` is the original token; `signed` is a pinned Ed25519 key. */
export type PoolPeerAuthMode = 'bearer' | 'signed';

/** This node's own pool identity, as the operator surfaces show it. Never the private key. */
export interface PoolIdentitySummary {
  nodeUuid: string | null;
  /** A short hash of the public key, for the operator to compare across two screens. Never the key itself. */
  publicKeyFingerprint: string | null;
  /**
   * Why the identity is unusable, when it is. Surfaced exactly as `capabilitiesError` already is:
   * identity bootstrap must degrade and report, never throw at its caller — the encryption key is
   * derived from an env secret, so a regenerated `.env` over a retained volume would otherwise take
   * down whatever touched pooling first, on every appliance, peerless ones included.
   */
  identityError: string | null;
}

/** An outstanding pairing PIN, as `/pool/status` reports it. The digits are returned exactly once, at mint time, and never here. */
export interface PoolPairingPinState {
  active: boolean;
  expiresAt: string | null;
}

/** What a backend's supervision watcher has observed. Observe-and-report only: the Hub never restarts an inference backend. */
export interface BackendSupervisionSummary {
  backend: InferenceBackendType;
  /** How the backend is actually running, which decides what can be observed about it at all. */
  targetKind: 'container' | 'host-process' | 'remote' | 'absent';
  state: 'healthy' | 'unhealthy' | 'restart-looping' | 'unknown';
  /** dockerd's own `RestartCount`, when the target is a container — the only signal that survives a Hub restart. */
  observedRestartCount: number | null;
  diagnosisCode: string | null;
}

/** A candidate node the proxy can route a request to for a given model. */
export interface PoolCandidate {
  /** `null` for the local node; the peer's `hub_pool_peer.id` otherwise. */
  peerId: string | null;
  nodeFqdn: string | null;
  backend: InferenceBackendType;
}

/**
 * A node that identified itself as a CI-Hub and isn't paired yet.
 *
 * Every entry here is *named*, and the name comes from a directory that authenticates this Hub
 * before answering: the tailnet control plane (Tailscale Admin API and the local daemon's peer map),
 * or the CI Portal device registry. That is the whole contract — a candidate the operator can hand
 * straight to `POST peers/pair` as a `nodeFqdn`.
 *
 * An address found by `POST peers/probe` is deliberately NOT one of these. `/identify` discloses no
 * name, so a probed address has nothing to put in this shape, and inventing an unnamed candidate
 * would be a second identity space next to `node_fqdn` — keyed on something an unauthenticated
 * responder chose. Pairing by address goes through the PIN-gated exchange instead; see
 * {@link PoolProbeResult}.
 */
export interface DiscoverablePoolPeer {
  /**
   * The naming directory's own id for this device: a Tailscale device id on a tailnet entry, the
   * Portal device id on a Portal one. It is a display value and nothing more — `hub_pool_peer` is
   * keyed on `nodeFqdn`, and every write of `tailscale_device_id` passes `null`.
   *
   * Empty string, never absent, so a consumer has a value to render without a null check. The CLI's
   * discover table is the only surface that renders it at all (`sanitizeForBox(id || '-')`); the
   * settings list shows the hostname and keys on the FQDN.
   */
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
  /**
   * `'portal'` on a candidate the CI Portal device registry named. Absent means the tailnet — the
   * local Tailscale daemon's peer map, the Tailscale Admin API, or both — and absence is the *only*
   * encoding of that: `listDiscoverableDevices` tags nothing, and the frontend and CLI copies of
   * this shape carry no `source` field at all.
   *
   * Narrowed from `'tailscale' | 'lan-probe' | 'portal'` to the one member a producer can emit.
   * `'tailscale'` was a second spelling of what absence already says, and a union that can state one
   * fact two ways is eventually stated both ways by two different callers. `'lan-probe'` could never
   * be produced at all: `/identify` discloses no name, so an address has nothing to put in this
   * shape — the same reason {@link claimedNodeUuid} has no producer. Keeping the broader union would
   * have meant tagging every tailnet entry to make it honest, which adds a field to a wire response
   * that no reader has asked for.
   *
   * Nothing reads it yet. It is here for an operator surface that wants to say which directory named
   * a node, and it is a badge of its own rather than something inferred from `tailscaleDeviceId`
   * because that id is a display value both directories supply — an absent id would mean "this
   * directory had no id for the node", never "the tailnet named this".
   */
  source?: 'portal';
  /**
   * A UUID the candidate *claims*, from an unauthenticated probe. Typed distinctly from
   * `hub_pool_peer.peer_node_uuid` on purpose — an externally-sourced UUID is a hint for the
   * operator, never an identity key to match a pinned row against.
   *
   * Reserved, in the sense the section header above describes: nothing populates it in this build.
   * Its only producer was the LAN candidate cache, which went when `/identify` stopped disclosing a
   * name — an unnamed responder cannot author a row here at all now. It stays because
   * `mergePoolCandidates` is pinned against it: the rule that a claimed UUID is never a merge key
   * has to remain testable, or the next source added here can quietly reintroduce the
   * peer-suppression primitive it exists to forbid.
   */
  claimedNodeUuid?: string;
}

/**
 * Why a manually probed address cannot be paired with. `null` when it can.
 *
 * There is deliberately no `self`, `already_paired` or `no_tailnet_fqdn` value here: all three are
 * answers about *which node* is at the address, and the unauthenticated probe is not told. They are
 * decided at pairing time, in `HubPoolPeerService.initiatePairingAtAddress`, which does learn the
 * name.
 */
export type PoolProbeReason = 'unreachable' | 'not_a_hub' | 'protocol_too_old';

/**
 * What `POST /inference/pool/peers/probe` found at an operator-typed address.
 *
 * It answers one question — "is there a CI-Hub here, and does it speak a protocol this node can
 * pair with" — and that is all `GET /identify` will tell an unauthenticated caller. It does NOT
 * name the node: the MagicDNS name was removed from that endpoint because it is published through
 * the Cloudflare tunnel, and it is disclosed instead in the reply to a pairing request that carried
 * the PIN minted on the far Hub's own screen.
 *
 * So the operator flow is: probe to confirm something is there, mint a PIN on that Hub, then
 * `POST peers/pair {address, pin}` — which is where the name is learned and the row is keyed.
 */
export interface PoolProbeResult {
  /** The address as probed, echoed back so a UI can label the row without re-parsing what was typed. */
  address: string;
  isCiHub: boolean;
  /** The pool protocol version the node answered with, or `null` when nothing answered. */
  poolProtocol: number | null;
  /** Whether `POST peers/pair {address, pin}` can be used against this address. */
  pairable: boolean;
  reason: PoolProbeReason | null;
}

/**
 * The reply to a `POST /pair/request` that carried a valid PIN.
 *
 * `nodeFqdn` is the field that makes pairing-by-address possible at all, and the PIN is exactly what
 * gates it: a caller that proved it read six digits off this Hub's screen may learn its MagicDNS
 * name; an anonymous caller on `/identify` may not. Every field is optional — a protocol-1 peer
 * answers a bare `{ received: true }`, and a Hub with no tailnet or no usable identity answers with
 * whichever halves it has.
 */
export interface PoolPairingAnswer {
  nodeFqdn?: string;
  nodeUuid?: string;
  publicKey?: string;
}

/**
 * `hub_pool_peer` shape safe to send to the operator UI — everything except the
 * token material (`verifyTokenHash`, `presentTokenEncrypted`). Neither value
 * should ever leave the backend process: the hash is only useful for local
 * verification, and the encrypted token exists solely so THIS Hub can decrypt
 * and present it on its own outbound calls.
 */
export type PublicHubPoolPeer = Omit<HubPoolPeer, 'verifyTokenHash' | 'presentTokenEncrypted'>;

export function toPublicPeer(peer: HubPoolPeer): PublicHubPoolPeer {
  const { verifyTokenHash: _verifyTokenHash, presentTokenEncrypted: _presentTokenEncrypted, ...publicFields } = peer;
  return publicFields;
}

/**
 * The lifecycle values `hub_pool_peer.status` may hold.
 *
 * `'rejected'` was retired in migration 0059 — nothing ever wrote it, and keeping it alongside the
 * `enabled` column would have shipped two overlapping "not in play" concepts. Rejecting a pairing
 * request deletes the row; taking a live peer out of routing sets `enabled = false`. The column
 * itself is a `varchar`, so this union is the contract the hand-mirrored frontend and CLI copies
 * are kept honest against, not a database constraint.
 */
export type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';

/**
 * Whether a peer row is still short of established trust — the only thing an INBOUND request may be
 * judged on.
 *
 * `'pending'` is that state, and it is the only one: the operator has not approved the pairing, so
 * there is nothing to serve. `'unreachable'` is the opposite — a fully established pairing whose
 * OUTBOUND health view has gone stale. The two must not be conflated, because refusing an
 * unreachable peer's inbound requests wedges the pair permanently:
 *
 *   The sole way out of `'unreachable'` is a successful capabilities probe (`refreshOnePeer`). If
 *   both nodes strike out on each other — one partition both sides notice, or one node briefly slow
 *   enough to blow three probe timeouts — then both rows read `'unreachable'` at once, each answers
 *   the other's recovery probe 403, and every probe from then on fails *because of the refusal
 *   rather than the network*. Neither side can ever return, the failure counters run away past the
 *   threshold, and Unpair becomes the operator's only move on a pairing that was never broken.
 *
 * A peer that is talking to us is, self-evidently, reachable. Our own opinion that it was down is
 * the stalest possible input to that question, so it is not consulted.
 *
 * Fail closed on anything outside the union: `status` is a `varchar`, not a database constraint, so
 * a value written by a future build is treated as not-yet-trusted rather than admitted by default.
 */
export function isPairingIncomplete(status: string | null | undefined): boolean {
  return status !== 'connected' && status !== 'unreachable';
}

/** A peer row plus what this node currently has in flight to it. Built from {@link toPublicPeer}, so the token columns cannot reach it. */
export interface PoolStatusPeer extends PublicHubPoolPeer {
  /**
   * Why this peer's health probes are failing, and what to do about it, or `null` while they succeed.
   * Process-local, so it is `null` after a restart until the next probe fails again.
   */
  probeFailure?: PoolPeerProbeFailure | null;
  /** Requests this node has forwarded to the peer and not yet finished reading. A live gauge reset by a restart, never a total. */
  inFlightRequests: number;
  /** How this peer authenticates to us today. */
  authMode?: PoolPeerAuthMode;
  /** A short hash of the peer's pinned public key, for the operator to compare across two screens. Never the key. */
  peerKeyFingerprint?: string | null;
  /**
   * The peer's EFFECTIVE 0-3 band — freshness applied, hostile values clamped, and floored by what
   * this node has forwarded there — or `null` when nothing about its GPU is known. Deliberately not
   * the raw jsonb: a status card showing a number routing does not believe is a liability during an
   * incident, which is when it is read.
   */
  gpuPressure?: number | null;
  /**
   * The peer's container rollup as this node is willing to believe it — freshness applied, hostile
   * values rejected — or `null` for "not reported". Deliberately not the raw jsonb, for the same
   * reason {@link PoolStatusPeer.gpuPressure} is not: `last_capabilities` is free-form and the peer
   * writes it, so an unclamped number would be a hostile machine drawing on the operator's screen.
   *
   * `null` covers every way we can fail to know — old build, opted out, sampler quiet, snapshot too
   * old, value rejected — and a renderer must say "not reported" for all of them. Never 0.
   */
  containers?: PoolContainerRollup | null;
  /**
   * The ceiling this node's routing believes the peer advertised, or `null` for none — clamped the
   * way the ranker reads it, so the number shown is the number that excludes the peer. Deliberately
   * NOT freshness-gated, unlike the two fields above: it is policy rather than a measurement, and the
   * ranker applies it for as long as it still trusts the same snapshot's inventory.
   */
  maxPromptTokens?: number | null;
  /** The context cap the peer advertised, clamped the way a handout reads it, or `null` for none. Policy, like the ceiling; not freshness-gated. */
  maxNumCtx?: number | null;
  /** The Ollama slot count the peer advertised, clamped the way the ranker reads it, or `null` for not stated. Policy, like the two above; not freshness-gated. */
  ollamaSlots?: number | null;
  /** The peer's prefill and decode rates, timed here and self-reported, after the same validation and decay the ranker applies. */
  throughput?: PoolStatusPeerThroughput;
}

export interface PoolStatusLocalNode {
  nodeFqdn: string | null;
  tailnet: string | null;
  tailscaleConnected: boolean;
  /** Requests this node's own engines are serving — its apps' and its peers' alike. */
  inFlightRequests: number;
  hardwareTier: string | null;
  backends: PoolPeerBackendCapability[];
  /** Why the local inventory is empty, when it is — a down backend must read differently from a node with no models. */
  capabilitiesError: string | null;
  /** This node's UUID, key fingerprint, and why identity is unusable when it is. */
  identity?: PoolIdentitySummary;
  /** This node's own smoothed 0-3 pressure band, or `null` when nothing here could measure it. */
  gpuPressure?: number | null;
  /** Which source produced {@link gpuPressure}, or `null` when it is unmeasured. */
  gpuPressureSource?: PoolPressureSource | null;
  /** Reserved for backend supervision: what the observer has seen, per backend. Observe-only. */
  supervision?: BackendSupervisionSummary[];
  /** This node's EFFECTIVE prompt ceiling (env override applied), or `null` for none. What peers are told, and what local routing applies. */
  maxPromptTokens?: number | null;
  /** Which source set {@link maxPromptTokens}: `'env'` is `HUB_POOL_MAX_PROMPT_TOKENS`, which a settings PATCH cannot change. */
  maxPromptTokensSetBy?: 'env' | 'setting' | null;
  /** This node's context cap (`inferenceMaxNumCtx`), or `null` for none. What peers are told, and what caps this node's own handouts. */
  maxNumCtx?: number | null;
  /** This node's Ollama slot count (`inferenceOllamaSlots`), or `null` for not stated. What peers are told, and what local slot-aware placement reads. */
  ollamaSlots?: number | null;
  /** This node's own engines' measured rates: exactly what it advertises to peers. */
  throughput?: PoolThroughputEstimate[];
}

/**
 * Why pooling is or isn't routing right now.
 *
 * `disabled_by_env` and `disabled_by_setting` are kept apart on purpose: the UI must be able to say
 * "your .env overrides this" rather than showing a toggle that appears to do nothing.
 *
 * `partially_disabled` covers every state where pooling is nominally on but one half of it is not
 * running — a direction switched off, or every connected peer individually disabled. It exists so
 * that a node which currently serves nothing cannot report `active`; without it, switching inbound
 * off would leave the badge, the state banner and the CLI all saying "routing normally".
 */
export type PoolStatusReason = 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';

export interface PoolStatus {
  /** Effective kill-switch state (env override applied). Not the same as `settings.poolEnabled`. */
  enabled: boolean;
  disabledBy: HubPoolDisabledBy | null;
  /**
   * Each half of pooling and what is holding it off. `enabled`/`disabledBy` above stay the MASTER
   * switch, unchanged, so their existing consumers keep their meaning; this is the finer state.
   */
  directions: HubPoolDirectionalState;
  reason: PoolStatusReason;
  /** Whether apps are actually being routed through the pool: outbound on AND at least one connected, enabled peer. */
  routingActive: boolean;
  /** The persisted settings as stored, before the env override — what a settings form should render. */
  settings: HubPoolPreferences;
  /**
   * Whether TAILSCALE_OAUTH_CLIENT_ID/SECRET are set, i.e. whether this Hub can enumerate the
   * *whole* tailnet through the Tailscale Admin API. Never the credentials themselves.
   *
   * It is **not** a report on whether peer discovery works. The Admin API is one of three candidate
   * directories, and the other two need no credential: the local Tailscale daemon's peer map, and
   * the CI Portal device registry. Neither result is reported here. Two fields come close, and both
   * are preconditions rather than results: {@link PoolStatusLocalNode.tailscaleConnected} for the
   * daemon leg, and {@link PoolStatusLocalNode.tailnet} for this one — the Admin API leg runs only
   * when a credential is set *and* that tailnet name is known. Nothing reports the Portal leg.
   * A Hub reading `false` here may still be discovering peers; a Hub reading `true` with no tailnet
   * enumerates nothing, since the Admin API is queried with the tailnet name the local daemon
   * reports.
   */
  tailscaleAdminApiConfigured: boolean;
  localNode: PoolStatusLocalNode;
  peers: PoolStatusPeer[];
  /** `disabled` counts rows the operator switched off, at any status — it is a routing decision, not a lifecycle one, so it overlaps the others. */
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** The operator's routing preferences, with each target resolved to a name and to whether it can serve right now. */
  pins: PoolStatusPin[];
  /** Whether a pairing PIN is outstanding, and until when. Never the digits. */
  pairingPin?: PoolPairingPinState;
}

/**
 * Resolve stored pins for `/pool/status`: each one's target named, and whether it can actually take
 * work right now.
 *
 * `targetAvailable` is the whole reason this is computed rather than echoing settings.json. A pin is
 * set once and forgotten, and every way it can quietly stop applying is invisible from the stored
 * value alone — the peer went unreachable, the operator disabled it, the far side switched inbound
 * off, someone unpaired it while the pin still names it, or the pinned node simply does not have the
 * model any more. `prefer` makes all of those a silent no-op on the request path (see `applyPin`),
 * which is the right behaviour for inference and the wrong behaviour for an operator with no
 * explanation. This is the explanation.
 *
 * Same predicates the ranker uses, on purpose: `status === 'connected'`, `enabled !== false`,
 * `acceptingWork !== false`, a healthy backend holding the model. A status card that answers a
 * different question from the one routing asks is worse than no status card.
 */
export function resolveStatusPins(
  pins: readonly HubPoolPin[],
  peers: readonly HubPoolPeer[],
  localBackends: readonly PoolPeerBackendCapability[],
): PoolStatusPin[] {
  const hasModel = (backends: readonly PoolPeerBackendCapability[], model: string | undefined) =>
    // A default-scope pin names no model, so there is nothing to check: any healthy backend will do.
    backends.some((backend) => backend.healthy && (model === undefined || backend.modelsLoaded.includes(model)));

  return pins.map((pin) => {
    if (pin.targetKind === 'local') {
      return { ...pin, nodeFqdn: null, targetAvailable: hasModel(localBackends, pin.model) };
    }
    const peer = peers.find((row) => row.id === pin.peerId);
    const capabilities = (peer?.lastCapabilities as unknown as PoolPeerCapabilities | null) ?? null;
    return {
      ...pin,
      // `null` when the peer is gone: the UI renders "no longer paired" rather than a bare uuid.
      nodeFqdn: peer?.nodeFqdn ?? null,
      targetAvailable:
        peer !== undefined &&
        peer.status === 'connected' &&
        peer.enabled !== false &&
        capabilities !== null &&
        capabilities.acceptingWork !== false &&
        hasModel(capabilities.backends, pin.model),
    };
  });
}
