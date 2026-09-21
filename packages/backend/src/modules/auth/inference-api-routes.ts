import type { Request } from 'express';

/**
 * The client-facing inference surfaces an `inference`-scoped API key may reach.
 *
 * This list is the allow-list — there is no decorator counterpart, deliberately. `AuthMiddleware`
 * runs before Nest has resolved a handler, so it cannot read handler metadata the way
 * `ObservabilityReadGuard` reads `@ObservabilityRead()`; the path predicate has to do that job
 * instead. Making the *lookup* the allow-list rather than a later check is the stronger shape
 * anyway: on every other route the key is never resolved at all, so `hubPrincipal` is never
 * `'inference'` there and no guard can be talked into honouring it. A key presented to, say,
 * `DELETE /api/apps/:urn` is simply an unauthenticated request.
 *
 * Both front doors are here. `/api/inference/v1/*` is the direct surface, `/api/inference/pool/*`
 * the pooled one, and an app or an editor may be pointed at either (see `InferenceEndpointService`,
 * which picks between them). `/api/version` and `/api/tags` at the Hub's own root are the
 * Ollama-native probe pair — the address an operator reaches for after being told "point
 * `OLLAMA_HOST` at the Hub" (see `HubPoolOllamaCompatController`).
 */
const INFERENCE_API_PREFIXES = ['/api/inference/v1/', '/api/inference/pool/v1/', '/api/inference/pool/api/'] as const;

/** Ollama-native probes served at the Hub's own root, which have no prefix to match on. */
const INFERENCE_API_EXACT_PATHS = new Set(['/api/version', '/api/tags']);

/**
 * Peer-to-peer forwarding, which this predicate must NOT match.
 *
 * `/api/inference/pool/local/*` is how one Hub hands a request to another's engines. It is
 * authenticated by `PoolPeerGuard` — an Ed25519 signature, or the legacy bearer token — and it is
 * the pool's hot path: every forwarded turn crosses it. Resolving an API key there would buy a
 * key-store SELECT per hop for a credential that route never accepts. `/api/inference/pool/local/`
 * starts with neither prefix above, so it is already excluded; this constant exists to say that the
 * exclusion is intended rather than an accident of how the prefixes were spelled.
 */
export const POOL_PEER_FORWARD_PREFIX = '/api/inference/pool/local/';

/** The request path, query stripped. `originalUrl`, because `url` is rewritten under a mount. */
function requestPath(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * True when this request is addressed to a surface an `inference` key may authenticate.
 *
 * Path-only: the method is not consulted, because this surface has both (POST completions, GET
 * listings) and a key that works for one and silently not the other would be the worst of the
 * available behaviours.
 */
export function isInferenceApiRoute(req: Request): boolean {
  const path = requestPath(req);
  if (path.startsWith(POOL_PEER_FORWARD_PREFIX)) {
    return false;
  }
  return INFERENCE_API_EXACT_PATHS.has(path) || INFERENCE_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}
