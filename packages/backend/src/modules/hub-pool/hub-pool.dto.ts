import { createZodDto } from '@/common/zod-dto';
import {
  MAX_POOL_HEALTH_POLL_SECONDS,
  MAX_POOL_LOCAL_AFFINITY,
  MAX_POOL_MAX_PROMPT_TOKENS,
  MAX_POOL_PRESSURE_WEIGHT,
  MIN_POOL_HEALTH_POLL_SECONDS,
  MIN_POOL_LOCAL_AFFINITY,
  MIN_POOL_MAX_PROMPT_TOKENS,
  MIN_POOL_PRESSURE_WEIGHT,
  MAX_PINNED_MODEL_LENGTH,
  POOL_PIN_MODES,
  POOL_PIN_SCOPES,
  POOL_PIN_TARGET_KINDS,
  normalizePeerFqdn,
} from '@/common/helpers/hub-pool';
import { MAX_ROUTING_LOG_CAPACITY } from './hub-pool-routing-log.service';
import { z } from 'zod';

/**
 * A peer FQDN is interpolated into `https://<fqdn>/api/...` on every handshake
 * call, so the shape is validated at the edge rather than only where it is used.
 * `HubPoolPeerService` re-checks it — this is the 400, not the trust boundary.
 */
const peerFqdnSchema = z
  .string()
  .trim()
  .refine((value) => normalizePeerFqdn(value) !== null, { message: 'Must be a bare hostname (no scheme, credentials, port, path or IP literal)' });

/**
 * An operator-typed peer address, for the discovery probe and for pairing by address.
 *
 * Deliberately NOT `peerFqdnSchema`: that schema exists to reject exactly these shapes, because an
 * address must never be *stored* as a peer name. This value is used to reach one handshake and then
 * discarded — the real parse and the private-address check are `parseProbeTarget` and
 * `isPoolProbeTarget`, which produce messages naming the specific problem. This is the length bound,
 * not the grammar.
 */
const probeAddressSchema = z.string().trim().min(1).max(300);

/** Exactly six digits. Never trimmed to a number: a PIN can legitimately start with a zero. */
const pairingPinSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { message: 'A pairing PIN is six digits' });

/**
 * A peer's Ed25519 public key on the wire: base64 SPKI DER, which for Ed25519 is always 44 base64
 * characters. Bounded here so a caller cannot post a megabyte of "key" at an unauthenticated route.
 */
const peerPublicKeySchema = z.string().trim().min(32).max(256);

/** A pool node UUID as it appears in a body. `.uuid()` because the column is `uuid`, and a non-UUID could never match a row. */
const peerNodeUuidSchema = z.uuid();

/**
 * Two ways to name what to pair with, and exactly one of them per request.
 *
 * `nodeFqdn` is the original: a MagicDNS name, from a discovery directory — the tailnet or the CI
 * Portal device registry, whose rows carry a MagicDNS name too — or typed by the operator.
 * `address` is for a Hub found with `POST peers/probe`, which cannot report a name — `/identify` is
 * unauthenticated and no longer discloses one — so the name is learned from the far side's reply to
 * a PIN-authenticated pairing request. That is why `pin` is *required* with `address` and optional
 * with `nodeFqdn`: without it there is no answer carrying a name, and nothing to key the row on.
 *
 * `address` is deliberately NOT `peerFqdnSchema`, which exists to reject exactly these shapes. It is
 * parsed by `parseProbeTarget` and never stored — see `HubPoolDiscoveryService`.
 */
const pairPeerSchema = z
  .object({
    nodeFqdn: peerFqdnSchema.optional(),
    address: probeAddressSchema.optional(),
    displayName: z.string().trim().min(1).optional(),
    /**
     * The PIN minted on the peer's own screen. Optional with `nodeFqdn`: without it that is the
     * pre-existing request/approve flow, unchanged, which is what keeps a mixed-version fleet
     * pairing at all. Mandatory with `address`.
     */
    pin: pairingPinSchema.optional(),
  })
  .refine((body) => (body.nodeFqdn === undefined) !== (body.address === undefined), {
    message: "Send either nodeFqdn (a peer's tailnet name) or address (a LAN address to pair with), not both and not neither",
  })
  .refine((body) => body.address === undefined || body.pin !== undefined, {
    message: 'Pairing by address needs the six-digit PIN minted on the other Hub — its tailnet name is only disclosed to a caller that presents one',
  });
export class PairPeerBody extends createZodDto(pairPeerSchema) {}

// ── Peer-to-peer wire bodies (no operator auth on `request` — trust isn't established yet) ──

const incomingPairingRequestSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  fromDisplayName: z.string().trim().min(1).optional(),
  token: z.string().trim().min(32),
  /**
   * The identity fields are `.optional()` and must stay that way: a byte-for-byte protocol-1 body
   * carries none of them and has to keep parsing into today's pending row. They are only ever
   * stored when `pin` came with them and verified — an unauthenticated identity claim is exactly
   * the anonymous write the PIN closes.
   */
  fromNodeUuid: peerNodeUuidSchema.optional(),
  fromPublicKey: peerPublicKeySchema.optional(),
  pin: pairingPinSchema.optional(),
});
export class IncomingPairingRequestBody extends createZodDto(incomingPairingRequestSchema) {}

const pairingConfirmSchema = z.object({
  fromNodeFqdn: peerFqdnSchema,
  token: z.string().trim().min(32),
  /** Optional for the same reason as above — a protocol-1 peer's confirm body has neither field. */
  fromNodeUuid: peerNodeUuidSchema.optional(),
  fromPublicKey: peerPublicKeySchema.optional(),
});
export class PairingConfirmBody extends createZodDto(pairingConfirmSchema) {}

/**
 * `POST /pair/upgrade`: the bearer→signed exchange, authenticated by `PoolPeerGuard` with the very
 * credential it retires. Both fields are required here — unlike the two bodies above, this route
 * exists only to carry them.
 */
const pairingUpgradeSchema = z.object({
  nodeUuid: peerNodeUuidSchema,
  publicKey: peerPublicKeySchema,
});
export class PairingUpgradeBody extends createZodDto(pairingUpgradeSchema) {}

// ── Operator-editable pool settings ──

/**
 * Every field is optional and omitting one leaves it unchanged, so the settings card can PATCH a
 * single toggle without having to round-trip and resend the rest. Bounds are enforced here, on the
 * write path, rather than on `settingsSchema` — that schema also parses settings.json at boot,
 * where an out-of-range persisted value must degrade to the default instead of failing the parse.
 */
const hubPoolPreferencesSchema = z.object({
  /**
   * The in-product kill switch. `HUB_POOL_USER_DISABLED=true` in the environment still overrides
   * it, and `GET /inference/pool/status` reports which of the two is in force.
   */
  poolEnabled: z.boolean().optional(),
  /**
   * Stop sending work TO peers. Apps here are then served by this node's own engines, and get the
   * existing actionable 502 when it cannot serve the model — the request is never shipped out.
   * `HUB_POOL_OUTBOUND_DISABLED=true` in the environment still overrides it.
   */
  poolOutboundEnabled: z.boolean().optional(),
  /**
   * Stop serving work FOR peers, while still using them. Peers see a healthy node advertising an
   * empty inventory and `acceptingWork: false`, not an unreachable one — this is "not right now",
   * not "I have left the pool", which is what the master switch means.
   * `HUB_POOL_INBOUND_DISABLED=true` in the environment still overrides it.
   */
  poolInboundEnabled: z.boolean().optional(),
  /** Queued-request head start the local node gets over a peer. 0 = least-loaded (local still wins an exact tie); higher = stickier to local. */
  poolLocalAffinity: z.number().int().min(MIN_POOL_LOCAL_AFFINITY).max(MAX_POOL_LOCAL_AFFINITY).optional(),
  /** Seconds between peer capability probes. Also sets how long a peer's snapshot stays trusted (three polls). */
  poolHealthPollSeconds: z.number().int().min(MIN_POOL_HEALTH_POLL_SECONDS).max(MAX_POOL_HEALTH_POLL_SECONDS).optional(),
  /**
   * Refuse the legacy bearer token outright, in both directions. The explicit no-downgrade switch;
   * turning it on before every peer reports `authMode: 'signed'` is an outage, which is why it is
   * the one pool flag that defaults off rather than on.
   */
  poolRequireSignedPeers: z.boolean().optional(),
  /**
   * Publish aggregate container counts and resource totals to paired peers. Counts and totals only —
   * never a container name — so a peer learns how loaded this box is and not what it runs.
   *
   * On by default, which is why this is the opt-OUT and not the opt-in: peers are machines the
   * operator approved into a pairing and they already receive this node's tier, queue depth and
   * full model list. Turning it off omits the key entirely, which is what a peer on an older build
   * sends too, and reads there as "not reported" — never as an idle machine.
   */
  poolShareContainerStats: z.boolean().optional(),
  /**
   * How heavily the 0-3 GPU-pressure band counts when ranking candidates. 0 (the default) removes it
   * from ranking entirely and is byte-identical to the pre-pressure build; 1 is PAIR's
   * `pending + pressure`, which is what lets the pool move work off a node whose queue is empty but
   * whose GPU is committed to something that never came through the pool.
   *
   * `.optional()`, never `.default()`: `zodSchemaToOpenApiComponent` promotes a defaulted field into
   * `required`, which would make every PATCH have to send it. The default is applied in the service.
   */
  poolPressureWeight: z.number().int().min(MIN_POOL_PRESSURE_WEIGHT).max(MAX_POOL_PRESSURE_WEIGHT).optional(),
  /**
   * The largest estimated prompt, in tokens, this node should serve for the pool while another
   * candidate can take it. `null` clears the ceiling; omitting the field leaves it as it is, like
   * every other field here. `HUB_POOL_MAX_PROMPT_TOKENS` in the environment still overrides it.
   *
   * `.nullable()` because "no ceiling" is a value an operator sets, not a default to fall back to —
   * there is no number that means it. The floor is `MIN_POOL_MAX_PROMPT_TOKENS`, which says why a
   * tiny ceiling is refused rather than stored.
   */
  poolMaxPromptTokens: z.number().int().min(MIN_POOL_MAX_PROMPT_TOKENS).max(MAX_POOL_MAX_PROMPT_TOKENS).nullable().optional(),
  /**
   * Point every app at this Hub's proxy even with no peer paired, so one place sees all inference
   * on the node and can keep the resident model resident. On by default; off returns apps to the
   * engine's direct URL unless a peer is connected. Applies when an app's env is next generated.
   */
  poolRouteAppsAlways: z.boolean().optional(),
});
export class UpdateHubPoolPreferencesBody extends createZodDto(hubPoolPreferencesSchema) {}

const probePeerAddressSchema = z.object({
  address: probeAddressSchema,
});
export class ProbePeerAddressBody extends createZodDto(probePeerAddressSchema) {}

const routingLogQuerySchema = z.object({
  /**
   * Page size, newest first. Bounded by the largest ring `HUB_POOL_ROUTING_LOG_SIZE` can configure
   * rather than by this process's ring: a limit above the ring is simply the whole ring, and a 400
   * for asking about a setting the caller cannot see would break a runner that polls a mixed fleet.
   */
  limit: z.coerce.number().int().min(1).max(MAX_ROUTING_LOG_CAPACITY).optional(),
  /**
   * Only rows placed or changed at or after this instant — the `nextSince` a previous call returned.
   * Validated as ISO 8601 with a zone, because `Date.parse` alone accepts forms like "Sep 17 2026"
   * whose zone is whatever the Hub's is, and a cursor that shifts by the Hub's UTC offset silently
   * skips hours of rows.
   */
  since: z.iso.datetime({ offset: true }).optional(),
});
export class RoutingLogQueryDto extends createZodDto(routingLogQuerySchema) {}

// ── Manual routing pins ──

/**
 * Bounded, but deliberately not validated against a grammar: a model id is whatever the engine
 * calls it (`llama3.2:3b`, `hf.co/org/repo:Q4_K_M`), and it is compared verbatim and case-sensitively
 * against `modelsLoaded` on the request path. Any normalization here would produce pins that look
 * correct on the settings card and silently never match.
 */
const pinnedModelSchema = z.string().trim().min(1).max(MAX_PINNED_MODEL_LENGTH);

/**
 * Upsert a pin. POST rather than PUT-with-an-id because `(scope, model)` IS the key — an operator
 * edits "the pin for this model", not a row — and pins have no ids: they live in `HubPoolPreferences`
 * (settings.json), not in a table.
 *
 * `mode` is `.optional()`, never `.default()`: `zodSchemaToOpenApiComponent` promotes a defaulted
 * field into `required` in the generated client, which would make every caller send a value that has
 * exactly one legal setting. The default is applied in `HubPoolPinService`.
 */
const upsertPoolPinSchema = z
  .object({
    scope: z.enum(POOL_PIN_SCOPES),
    /** Required iff `scope === 'model'`, and forbidden otherwise — the pool-wide pin names no model. */
    model: pinnedModelSchema.optional(),
    targetKind: z.enum(POOL_PIN_TARGET_KINDS),
    /** Required iff `targetKind === 'peer'`. A `local` pin has no id to give: this node has no peer row. */
    targetPeerId: z.uuid().optional(),
    mode: z.enum(POOL_PIN_MODES).optional(),
  })
  .refine((body) => (body.scope === 'model') === (body.model !== undefined), {
    message: 'model is required for a model pin and must be omitted for the pool-wide default pin',
    path: ['model'],
  })
  .refine((body) => (body.targetKind === 'peer') === (body.targetPeerId !== undefined), {
    message: 'targetPeerId is required when pinning to a peer and must be omitted when pinning to this Hub',
    path: ['targetPeerId'],
  });
export class UpsertPoolPinBody extends createZodDto(upsertPoolPinSchema) {}

/**
 * Which pin to remove, in the query string rather than a path parameter.
 *
 * A model id contains `:` and `/` (`hf.co/org/repo:Q4_K_M`), and Nest splits a path param on the
 * slash — so `DELETE /pins/:model` could never address the pins operators actually set.
 */
/**
 * A plain object, deliberately un-`.refine`d: `zodObjectToQueryParameters` only walks a bare
 * `ZodObject`, so a refinement here would silently strip both parameters from the OpenAPI document
 * and the generated client would take no arguments at all. The `scope`/`model` pairing is enforced
 * in `HubPoolPinService.remove`, which returns the same 400.
 */
const deletePoolPinQuerySchema = z.object({
  scope: z.enum(POOL_PIN_SCOPES),
  model: pinnedModelSchema.optional(),
});
export class DeletePoolPinQuery extends createZodDto(deletePoolPinQuerySchema) {}
