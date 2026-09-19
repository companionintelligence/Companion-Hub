import { type CanActivate, type ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { type InternalOriginRefusal, type OriginCheckedRequest, internalOriginRefusal } from '@/common/helpers/request-origin';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { type ApiKeyContext, ApiKeyService, isHubApiKeyShaped } from '@/modules/api-keys/api-key.service';
import { INFERENCE_SCOPE } from '@/modules/api-keys/api-key.scopes';

/**
 * Where the guard leaves the authenticated key for a handler to pick up, on the key leg only. Typed
 * as a property on the Express request rather than a header or param so nothing downstream can forge
 * it (the same shape as `McpAuthenticatedRequest.mcpApiKey`). Deliberately NOT `hubPrincipal` and
 * NOT `user`: an inference key is not an operator, and every guard that asks "is there a person
 * here" must keep saying no for it.
 */
export interface InferenceAuthenticatedRequest extends OriginCheckedRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  inferenceApiKey?: ApiKeyContext;
}

/**
 * The refusal codes an OpenAI-compatible client reads out of `error.code`. Named so a config-file
 * mistake (no key, a key from the wrong Hub) is diagnosable from the body alone, and so the docs
 * can list what each one means.
 */
export type InferenceAuthErrorCode = 'missing_api_key' | 'invalid_api_key';

const MISSING_KEY_MESSAGE =
  'This route needs an API key when reached from outside the appliance network. Mint one on the Hub with `cihub api-key create --scope inference` and send it as `Authorization: Bearer <key>`.';
const INVALID_KEY_MESSAGE = "Invalid API key: it is not in this Hub's key store, has expired, or does not carry the inference scope.";
const STORE_UNAVAILABLE_MESSAGE = 'Authentication temporarily unavailable — API key store unreachable';

/**
 * Admit the inference surface — the OpenAI-compatible `/api/inference/v1/*` routes and the
 * app-facing pool proxy under `/api/inference/pool/*` — by origin OR by an `inference` API key.
 *
 * WHY TWO LEGS. These routes spend real GPU time, on this node and on every paired peer, and they
 * are reachable through a registered Hub's Cloudflare tunnel: `InternalNetworkGuard` alone passed
 * that traffic, because behind a proxy `request.ip` is the proxy's own private address unless
 * `HUB_TRUST_PROXY` is set, and neither the `hub-public` Traefik router nor the tunnel ingress
 * carries a middleware. Requiring a credential everywhere would have broken every app: an app that
 * only declares `hub_integration.inference` is issued no managed key (`hubTrustMaterialScopes`
 * mints one only for an MCP client or a provenance-gated first-party consumer), and the OpenAI and
 * Ollama clients it uses send `CI_LLM_API_KEY` — a backend key, or a placeholder like `ollama` — in
 * `Authorization`. So:
 *
 * 1. INTERNAL ORIGIN, no key lookup ever. `internalOriginRefusal` places the request inside the
 *    appliance (private resolved address, no tunnel marker, no public forwarded hop) and the guard
 *    returns without reading `Authorization` at all. This is what keeps an app sending
 *    `Bearer ollama`, or a desktop runner sending its own 64-hex key, working with zero SELECTs on
 *    the inference hot path — the cost `AuthMiddleware` went out of its way to avoid for `qa:read`.
 *
 * 2. BEARER `inference` KEY, reached only when leg 1 refused. Exactly `Bearer <token>`, the token
 *    shaped like a key this Hub mints (`HUB_API_KEY_SHAPE` — a placeholder bearer that arrived via
 *    a proxy is turned away before it costs a lookup), resolved against the hashed store with the
 *    `inference` scope. An `mcp`-only key is refused here: the scope is the whole of a key's
 *    authority on this surface, and a leaked editor credential must open nothing else. On a GET
 *    or HEAD this leg pays a second lookup: `AuthMiddleware` runs on every route first and its
 *    `qa:read` arm already looked the same 64-hex token up (and found no `qa:read` on it). That
 *    is accepted rather than skipped in the middleware, because the arm's own routes
 *    (`GET /api/inference/pool/status`, `routing-log`) share this prefix, so a skip would have to
 *    enumerate this guard's GET routes there; the cost is one indexed SELECT on the low-frequency
 *    catalog reads (`v1/models`, `api/tags`, `api/ps`, `api/version`), never on completions.
 *
 * REFUSAL SHAPE IS OPENAI'S. Every error the v1 handlers emit themselves is
 * `{ error: { message, type } }`, and OpenAI SDKs and editors surface `error.message` verbatim.
 * The global `MainExceptionFilter` reshapes a thrown exception to `{ statusCode, message, path }`
 * but returns early once `response.headersSent`, so the guard writes the body itself and then
 * throws the matching Nest exception, which short-circuits the pipeline without a second write.
 * A 401 also carries `WWW-Authenticate` so an SDK knows which credential it is missing. A key
 * store outage answers 503 (`type: 'server_error'`), never 401: "could not check your key" is not
 * "your key is wrong" (#933), and a 401 would have an operator rotating a good key.
 *
 * The log names the path and the reason, never the token.
 */
@Injectable()
export class InferenceAccessGuard implements CanActivate {
  constructor(
    private readonly logger: LoggerService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<InferenceAuthenticatedRequest>();

    const origin = internalOriginRefusal(request);
    if (origin === null) {
      return true;
    }

    const response = http.getResponse<Response>();
    const authHeader = request.headers?.authorization;
    if (typeof authHeader !== 'string' || !authHeader) {
      this.refuseUnauthorized(request, response, origin, 'missing_api_key', 'missing Authorization header');
    }

    const parts = authHeader.split(' ');
    const token = parts[1];
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !token) {
      this.refuseUnauthorized(request, response, origin, 'missing_api_key', 'malformed Authorization header');
    }

    if (!isHubApiKeyShaped(token)) {
      // A placeholder bearer (`ollama`, `sk-local`) that reached us through a proxy. Not a key this
      // Hub could have minted, so it costs no lookup — and no retries during a database blip.
      this.refuseUnauthorized(request, response, origin, 'invalid_api_key', 'token is not shaped like a Hub API key');
    }

    let resolved: ApiKeyContext | null;
    try {
      resolved = await this.apiKeys.resolve(token, INFERENCE_SCOPE);
    } catch (err) {
      if (err instanceof ApiKeyStoreUnavailableError) {
        this.logger.error(
          'Inference auth unavailable: API key store unreachable',
          pathOf(request),
          err.cause instanceof Error ? err.cause.message : '',
        );
        response.status(503).json({ error: { message: STORE_UNAVAILABLE_MESSAGE, type: 'server_error' } });
        throw new ServiceUnavailableException(STORE_UNAVAILABLE_MESSAGE);
      }
      throw err;
    }

    if (!resolved) {
      this.refuseUnauthorized(request, response, origin, 'invalid_api_key', 'key not found, expired, or without the inference scope');
    }

    request.inferenceApiKey = resolved;
    return true;
  }

  /**
   * Write the OpenAI-shaped 401 and then throw, so the handler never runs and the exception filter
   * (which sees `headersSent`) leaves the body alone. `never`, so TypeScript narrows the caller's
   * locals past each refusal without a redundant `return`.
   */
  private refuseUnauthorized(
    request: InferenceAuthenticatedRequest,
    response: Response,
    origin: InternalOriginRefusal,
    code: InferenceAuthErrorCode,
    reason: string,
  ): never {
    const message = code === 'missing_api_key' ? MISSING_KEY_MESSAGE : INVALID_KEY_MESSAGE;
    this.logger.warn(`Inference auth failure: ${reason}`, pathOf(request), `origin=${origin}`);
    response.setHeader('WWW-Authenticate', 'Bearer realm="ci-hub-inference"');
    response.status(401).json({ error: { message, type: 'authentication_error', code } });
    throw new UnauthorizedException(message);
  }
}

/** The path for a log line, query string dropped. `originalUrl`, because `url` is rewritten under a mount. */
function pathOf(request: InferenceAuthenticatedRequest): string {
  return `${request.method ?? ''} ${(request.originalUrl ?? request.url ?? '').split('?')[0] ?? ''}`.trim();
}
