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
 * - 'inference': accepted ONLY on the OpenAI-compatible and Ollama-native inference surfaces marked
 *   `@InferenceApi()`, and refused everywhere else. It carries no operator authority at all — see
 *   {@link INFERENCE_SCOPE}.
 */
export const API_KEY_SCOPES = ['mcp', 'app', 'qa:read', 'inference'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const MCP_SCOPE = 'mcp' satisfies ApiKeyScope;
export const APP_SCOPE = 'app' satisfies ApiKeyScope;

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
export const QA_READ_SCOPE = 'qa:read' satisfies ApiKeyScope;

/**
 * The credential an *external* OpenAI-compatible client holds — an editor assistant, a coding
 * agent, a script on the operator's laptop — so that it can send inference to this Hub without
 * holding operator authority and without being on the appliance's own network.
 *
 * Why it exists. Until now the Hub's `/v1` surface was guarded by `InternalNetworkGuard` alone,
 * whose own docblock says it is "NOT a real trust boundary": it admits any caller whose source IP
 * is loopback or RFC1918, which behind Traefik or the Cloudflare tunnel is the proxy's own address.
 * So the surface was simultaneously too narrow for the caller it should serve (an operator's
 * laptop on the tailnet is not RFC1918 to this container) and too wide for the one it should not.
 * A scope fixes both ends: the key is the credential, the network is no longer the argument.
 *
 * What it reaches: the handlers marked `@InferenceApi()` — chat completions, completions,
 * embeddings, the model listing, audio, and the Ollama-native equivalents, on both the direct
 * (`/api/inference/v1/*`) and pooled (`/api/inference/pool/*`) paths. Nothing else. `AuthGuard`
 * refuses it everywhere else exactly as it refuses a `qa:read` key, and for the same reason: the
 * middleware installs no `user`, so every guard that asks "is there an operator here" still says no.
 *
 * Capability is inert on this key, as on an 'app' key. `read`/`write`/`full` describe the MCP tool
 * surface; running a completion is neither a read nor a write of appliance state, and there is no
 * third thing on this surface for a capability to choose between. The route list is the whole of
 * its authority.
 *
 * Standalone, like {@link QA_READ_SCOPE}, and for a sharper reason. This key is pasted into
 * third-party software — an editor extension, an agent harness, a `.env` that gets committed by
 * accident — which is a materially worse place for a secret to live than an operator's shell. One
 * row that also carried 'mcp' would put the whole tool surface (install, start, uninstall) behind a
 * string the operator handed to their IDE.
 *
 * Minted by `cihub api-key create --scope inference`, or in Settings → Security.
 */
export const INFERENCE_SCOPE = 'inference' satisfies ApiKeyScope;

/**
 * Scopes an operator may mint for themselves, through Settings → Security or `cihub api-key create`.
 *
 * Narrower than {@link API_KEY_SCOPES} by exactly the two that cannot work as an operator key:
 * - 'app' needs an owning app URN to satisfy the callback guard's identity check, so an
 *   operator-minted one would list as a credential and authenticate nothing.
 * - 'qa:read' stays CLI-only: it is minted over ssh on the node under test, where a browser usually
 *   is not, and putting it in the UI beside 'mcp' would invite it as a "safer MCP key", which it is
 *   not — it is a different surface.
 *
 * A tuple rather than an array so `z.enum` can consume it directly; 'mcp' is first because it is the
 * default this list's DTO applies.
 */
export const OPERATOR_MINTABLE_SCOPES = ['mcp', 'inference'] as const satisfies readonly ApiKeyScope[];

export type OperatorMintableScope = (typeof OPERATOR_MINTABLE_SCOPES)[number];

/**
 * Scopes that must be the only scope on their key.
 *
 * Both are credentials whose whole point is that they do NOT carry operator authority — a test
 * harness's read-only key, an editor's inference key. One row that also carried 'mcp' would hand
 * that holder the entire tool surface under a name saying otherwise, which is the exact mistake
 * each scope exists to prevent. Mirrored in `scripts/lib/cli-api-key.ts`.
 */
export const STANDALONE_SCOPES: readonly ApiKeyScope[] = [QA_READ_SCOPE, INFERENCE_SCOPE];
