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
 */
export const API_KEY_SCOPES = ['mcp', 'app', 'qa:read'] as const;

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
