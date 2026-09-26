import { OPERATOR_MINTABLE_SCOPES as SHARED_OPERATOR_MINTABLE_SCOPES, type OperatorMintableScope } from '@ci-hub/common/types';

/**
 * Scopes a locally-minted API key can carry. One key row may hold several scopes — e.g. a
 * companion app that both consumes Hub MCP tools and calls the Hub's app-facing REST endpoints
 * holds a single key with ['mcp', 'app'] — so provisioning never mints parallel credentials for
 * one app, and upgrading an app's scopes never rotates the secret it already holds.
 *
 * - 'mcp': accepted by the agent-facing MCP endpoint (/api/mcp). Operator keys carry this scope.
 * - 'app': accepted by app→Hub callback surfaces (memory-connect /apps/:urn/state|skip). Only
 *   ever minted as a managed key owned by an installed first-party app; an operator-created key
 *   never carries it because those have no owning app URN to satisfy the guard's identity check.
 * - 'qa:read': accepted ONLY on the GET routes marked `@ObservabilityRead()` — pool status, the
 *   routing log, one app's status and the install queue — and refused everywhere else: 403 on any
 *   other GET, 401 on a write (`AuthMiddleware` only resolves it on a read).
 *   See {@link QA_READ_SCOPE}.
 * - 'inference': accepted ONLY by `InferenceAccessGuard`, on the OpenAI-compatible
 *   `/api/inference/v1/*` routes and the app-facing pool proxy under `/api/inference/pool/*`, and
 *   only when the request did not originate inside the appliance (an internal caller is admitted by
 *   origin and its key is never read). Every other route refuses it. See {@link INFERENCE_SCOPE}.
 *
 * Append new scopes LAST: `normalizeScopes` orders a stored set by this list, so inserting one in
 * the middle would re-order every existing row's scopes the next time it is reconciled.
 */
export const API_KEY_SCOPES = ['mcp', 'app', 'qa:read', 'inference', 'portal'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const MCP_SCOPE: ApiKeyScope = 'mcp';
export const APP_SCOPE: ApiKeyScope = 'app';

/**
 * The credential a test harness or a monitoring script should hold instead of an operator one.
 *
 * Fleet QA read the routing log with the Hub's Portal device key, which is grant-exempt operator
 * authority: the same string that could read a routing row could also pair a peer, rotate the pool
 * identity or uninstall an app, and it is shared with Portal. A read-only test needs none of that, so
 * this scope opens a named list of GET routes and nothing else.
 *
 * The name is one opaque surface identifier, not `surface:verb` — nothing splits it, and
 * `api-key.capabilities.ts` explains why verbs do not live in the scope list. `:read` is in the name
 * so that `cihub api-key list` says what a leaked key can do without anyone looking it up. A key's
 * `capability` is inert here, like on an 'app' key: the route list is the whole of its authority.
 *
 * Minted by `cihub api-key create --scope qa:read`; the Settings UI only mints 'mcp' keys. The CLI
 * refuses to combine it with another scope: `AuthMiddleware` resolves it as a principal with no
 * operator behind it, and a key that also carried 'mcp' would be one credential with two unrelated
 * blast radii.
 */
export const QA_READ_SCOPE: ApiKeyScope = 'qa:read';

/**
 * The credential an editor or an SDK holds to use a Hub as its OpenAI-compatible endpoint.
 *
 * An editor or SDK needs exactly three values — base URL, API key, model id — and the key sits in
 * editor config files that sync to clouds (Continue's `config.yaml`, Zed's `settings.json`, a
 * shell profile). A leaked one must therefore spend GPU time and nothing else: it never opens the
 * MCP tool surface, Settings, or Portal. Like {@link QA_READ_SCOPE}, the CLI refuses to combine it
 * with another scope — a key that also carried 'mcp' would be one credential with two unrelated
 * blast radii — and the backend does not enforce that on its own.
 *
 * A key's `capability` is inert here: the inference routes have no verbs to gate, and
 * `api-key.capabilities.ts` says capability gates MCP tools only. The CLI stores `read` for it.
 *
 * Minted by `cihub api-key create --scope inference`, or from Settings → Security, which offers it
 * beside 'mcp' (see {@link OPERATOR_MINTABLE_SCOPES}) and lists it under its own badge. Checked by `InferenceAccessGuard`, and only on its second leg:
 * a request from inside the appliance is admitted by origin before any header is read, which is why
 * apps sending a placeholder bearer keep working with zero key-store lookups.
 */
export const INFERENCE_SCOPE: ApiKeyScope = 'inference';

/**
 * The key Companion Portal presents when it pushes to this Hub (an app install it brokered). Minted
 * by the Hub itself, handed to Portal over the check-in, never to an operator or an app — see
 * `PortalPushKeyService`. It replaced the Portal DEVICE key as the bearer for those pushes: that key
 * also lives in first-party Memory's container, so accepting it here made Memory a Hub operator.
 */
export const PORTAL_SCOPE: ApiKeyScope = 'portal';

/**
 * Scopes an operator may mint for themselves, re-exported from `@ci-hub/common` — see the docblock
 * there for why it lives in the shared package (the Settings picker renders the same list the DTO
 * validates) and why 'app' and 'qa:read' are not on it.
 *
 * The `satisfies` is the tripwire that keeps the two files honest: a scope named there but removed
 * from {@link API_KEY_SCOPES} here is a build error rather than a credential nothing accepts.
 */
export const OPERATOR_MINTABLE_SCOPES = SHARED_OPERATOR_MINTABLE_SCOPES satisfies readonly ApiKeyScope[];

export type { OperatorMintableScope };
