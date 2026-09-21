import { timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { withTransientDbRetry } from '@/core/database/transient-db-retry';
import { isTransientDbError } from '@/modules/api-keys/api-key.errors';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { INFERENCE_SCOPE, QA_READ_SCOPE } from '@/modules/api-keys/api-key.scopes';
import { Injectable, type NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import jsonwebtoken from 'jsonwebtoken';
import type { UserDto } from '../user/dto/user.dto';
import { UserRepository } from '../user/user.repository';
import { SESSION_TTL_SECONDS, SessionManager } from './session.manager';
import { SessionUserCache } from '@/core/cache/session-user.cache';
import { OBSERVABILITY_READ_METHODS } from './observability-read.guard';
import { isInferenceApiRoute } from './inference-api-routes';

/**
 * Constant-time secret comparison, length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the secret's length, so
 * the lengths are compared first and a mismatch returns before it is called.
 */
function secretEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The raw form of a key `ApiKeyService.create` mints: 32 random bytes as hex. */
const HUB_API_KEY_SHAPE = /^[0-9a-f]{64}$/;

/** The MCP endpoint, whose own guard resolves the key it is sent. `originalUrl`, because `url` is rewritten under a mount. */
function isMcpRoute(req: Request): boolean {
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  return path === '/api/mcp' || path.startsWith('/api/mcp/');
}

function addSessionId(ids: string[], seen: Set<string>, value: unknown) {
  if (typeof value !== 'string' || !value || seen.has(value)) {
    return;
  }
  seen.add(value);
  ids.push(value);
}

/**
 * Session ids the client presented. Preference among *valid* ids is the newest
 * expiry (see `AuthMiddleware`): a stale `ci-hub-sid` must not hide a live
 * `X-CI-Hub-Session` from the login response body.
 */
export function sessionIdsFromRequest(req: Request): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  addSessionId(ids, seen, req.cookies?.[SESSION_COOKIE_NAME]);
  addSessionId(ids, seen, typeof req.get === 'function' ? req.get('x-ci-hub-session') : undefined);
  addSessionId(ids, seen, req.query?.session_id);
  return ids;
}

/** Among live session ids, the one that expires last is the one just minted. */
export function pickNewestSessionId(
  ids: string[],
  resolve: { resolveSessionUserId: (id: string) => number | null; getSessionExpiresAt: (id: string) => number | null },
): string | null {
  let bestId: string | null = null;
  let bestExpiry = Number.NEGATIVE_INFINITY;

  for (const id of ids) {
    if (!resolve.resolveSessionUserId(id)) {
      continue;
    }
    const expiresAt = resolve.getSessionExpiresAt(id) ?? 0;
    if (expiresAt >= bestExpiry) {
      bestExpiry = expiresAt;
      bestId = id;
    }
  }

  return bestId;
}

/**
 * Session/API-key auth looks up the user on every request. A Docker DNS blip
 * (`EAI_AGAIN ci-hub-db`) used to fail the whole request as a 500 and flood
 * Sentry (NODE-NESTJS-HUB-BACKEND-EC). Retry briefly, then answer 503 so the
 * client can retry instead of treating the session as invalid.
 */
async function loadUserResilient<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await withTransientDbRetry(load);
  } catch (err) {
    if (isTransientDbError(err)) {
      throw new ServiceUnavailableException('Database temporarily unavailable');
    }
    throw err;
  }
}

/**
 * The user a session authenticates, loaded by the same rules for a Hub session here and for an
 * edge-SSO app session in Traefik forward auth: the short-lived DTO cache, then the row, retried
 * through a DB blip and answered 503 if it stays down.
 */
export async function loadSessionUser(sessionUserCache: SessionUserCache, userRepository: Pick<UserRepository, 'getUserDtoById'>, userId: number) {
  const cached = sessionUserCache.get(userId);
  if (cached) {
    return cached;
  }
  // Stamp the read: a write that invalidates while this SELECT is in flight would otherwise
  // be undone here, re-caching the pre-write DTO for a fresh TTL. Stamped inside the retry
  // closure so each attempt is judged against the SELECT it actually issued — a token taken
  // before the backoff would discard the correct post-write row a later attempt just read.
  return loadUserResilient(async () => {
    const readToken = sessionUserCache.beginRead(userId);
    const user = await userRepository.getUserDtoById(userId);
    if (user) {
      sessionUserCache.set(userId, user, readToken);
    }
    return user;
  });
}

/**
 * The row is the appliance ACL: a `revoked` operator authenticates nothing, whatever session they
 * still hold. True when this person is refused — and then every session they have is swept on the
 * spot and the cached DTO dropped with it, so the refusal is not what `loadSessionUser` remembers
 * for its TTL once the row is set back to `active`.
 *
 * `revokeOperator` sweeps as it flips the row, so a Portal removal rarely reaches here; this is for
 * the session that would otherwise outlive the verdict — a row flipped without `revokeOperator`
 * (a CLI or DB edit, a restored backup), or a read that landed between the row update and the sweep.
 * Both callers must apply it: a Hub session in `AuthMiddleware`, and the app session edge SSO
 * derives from it in Traefik forward auth, which is otherwise the one credential that would keep
 * answering for a person the row refuses.
 */
export async function refuseRevokedSessionUser(
  user: Pick<UserDto, 'accessStatus'> | undefined,
  sessionManager: Pick<SessionManager, 'destroyAllSessionsByUserId'>,
  sessionUserCache: Pick<SessionUserCache, 'invalidate'>,
  userId: number,
): Promise<boolean> {
  if (user?.accessStatus !== 'revoked') {
    return false;
  }
  await sessionManager.destroyAllSessionsByUserId(userId);
  sessionUserCache.invalidate(userId);
  return true;
}

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly config: ConfigurationService,
    private readonly userRepository: UserRepository,
    private readonly sessionUserCache: SessionUserCache,
    // Appended, and optional only to TypeScript: every middleware test constructs this positionally,
    // and only the `qa:read` arm needs the key store. NOT `@Optional()` to Nest — AppModule imports
    // ApiKeyModule, and if that ever stops resolving the Hub should fail to boot rather than start
    // answering every `qa:read` key 401 with nothing in the log to say why.
    private readonly apiKeys?: ApiKeyService,
  ) {}

  /**
   * Name a `qa:read` API key as the `qa-read` principal — and install NO user.
   *
   * No user is the whole design: every guard that asks "is there an operator here" still says no, so
   * `AuthGuard` refuses the key on every other GET with 403, and only `ObservabilityReadGuard` admits it,
   * on the GET handlers marked `@ObservabilityRead()`. The grant gate likewise sees a principal that is not
   * exempt and not a person.
   *
   * Reached only after the device key and the CLI JWT have both failed to match, and only for a token
   * shaped like a key this Hub mints (64 hex characters — `KEY_BYTES` in `ApiKeyService`), so a session
   * or a JWT never costs a key-store lookup here. `/api/mcp` is skipped too: every MCP call presents an
   * `mcp` key, `McpAuthGuard` already looks it up, and a second SELECT per tool call on the one
   * high-frequency key surface would buy nothing — a `qa:read` key has no business there and gets that
   * guard's 401.
   *
   * Only a GET or HEAD is looked up, because only a read can ever admit the key. The shape check alone
   * does not keep this off the inference hot path: a pool peer still on the bearer path authenticates
   * `POST /api/inference/pool/local/*` with a 64-hex token (`randomBytes(32).toString('hex')` in
   * `HubPoolPeerService`), and so do app callbacks with their managed key. Each of those would pay a
   * SELECT per forward, and during a database blip `ApiKeyService`'s retries (150 + 400 ms) and two warn
   * lines per request, for a principal no POST route accepts. The cost is that a `qa:read` key sent
   * with a write gets `AuthGuard`'s 401 instead of its 403 — it could not have done anything either way.
   *
   * A key store that cannot answer leaves the request unauthenticated rather than failing it: this
   * runs on every route, and a database blip must not turn an unrelated caller's request into a 503.
   */
  private async attachQaReadKey(req: Request, token: string): Promise<void> {
    if (!this.apiKeys || !OBSERVABILITY_READ_METHODS.has(req.method) || !HUB_API_KEY_SHAPE.test(token) || isMcpRoute(req)) {
      return;
    }
    try {
      if (await this.apiKeys.resolve(token, QA_READ_SCOPE)) {
        req.hubPrincipal = 'qa-read';
      }
    } catch {
      // Unauthenticated, as above. `ApiKeyService` has already retried transient failures and logged them.
    }
  }

  /**
   * Name an `inference` API key as the `inference` principal — and, like `qa:read`, install NO user.
   *
   * No user is again the whole design. An editor extension holding this key must be able to run a
   * completion and nothing else, so every guard that asks "is there an operator here" has to keep
   * saying no. What the principal buys is narrower: `InternalNetworkGuard` and `PoolAppGuard` stop
   * asking *where the request came from* once they can see a credential, which is what lets the key
   * work from the operator's laptop over the tailnet or the tunnel instead of only from a container
   * on the appliance bridge.
   *
   * Looked up only on {@link isInferenceApiRoute}, which is the allow-list — see that function for
   * why the allow-list lives at the lookup rather than at a later check, and why peer forwarding
   * (`/api/inference/pool/local/*`) is excluded from it.
   *
   * Unlike `attachQaReadKey` this runs on POST, because a completion is a POST. The cost is one
   * indexed key-store SELECT per inference request that carries a 64-hex bearer — which on this
   * surface is mostly Hub-managed apps sending `CI_LLM_API_KEY`, a *backend* key that will not
   * match a row. That is a real cost and a deliberate one: it is a single lookup in front of a
   * request that occupies a GPU for seconds to minutes, and the peer-forwarding path that actually
   * runs hot is excluded above.
   *
   * A key store that cannot answer leaves the request unauthenticated rather than failing it, for
   * the same reason as `attachQaReadKey`: a database blip must not turn an app's inference — which
   * the origin guards would have admitted on their own — into a 503.
   */
  private async attachInferenceKey(req: Request, token: string): Promise<void> {
    if (!this.apiKeys || !HUB_API_KEY_SHAPE.test(token) || !isInferenceApiRoute(req)) {
      return;
    }
    try {
      if (await this.apiKeys.resolve(token, INFERENCE_SCOPE)) {
        req.hubPrincipal = 'inference';
      }
    } catch {
      // Unauthenticated, as above. `ApiKeyService` has already retried transient failures and logged them.
    }
  }

  /**
   * Speak as the first operator on behalf of a host-local credential — or, when there is no
   * operator to speak as, refuse to install a principal and record WHY.
   *
   * Both host-local arms (the Portal device key and the CLI JWT) used to assign the result of
   * `getFirstOperator()` to `req.user` unconditionally and call `next()`. On a Hub that had been
   * registered with `cihub register` but never claimed by a browser login, the `user` table is
   * empty, so that assignment was `undefined` and `AuthGuard` answered SYSTEM_ERROR_YOU_MUST_BE
   * _LOGGED_IN — a 401 on a *valid* key. Correlation was 12/12 across the Hub Pool fleet, and the
   * whole fleet was diagnosed as having bad or missing device keys for it.
   *
   * The fix is to fail closed and say the true thing: no principal is installed (so nothing
   * downstream can mistake `undefined` for an authenticated caller), and `hubUnclaimed` tells
   * `AuthGuard` to answer AUTH_ERROR_HUB_NOT_CLAIMED / 409 instead.
   *
   * The diagnosis is carried on the request rather than thrown from here on purpose: this
   * middleware runs on `*all` routes, including ones that need no user at all (`/api/health`,
   * the OIDC returns, the Traefik forward-auth handler, and `POST /api/auth/hub/claim` — the one
   * route whose entire job is to clear this condition, and which is reached with this very key).
   * Throwing here would turn all of them into 409s and lock the Hub out of its own remedy.
   */
  private async attachFirstOperator(req: Request, principal: 'portal-device' | 'cli') {
    const user = await loadUserResilient(() => this.userRepository.getFirstOperator());
    req.hubPrincipal = principal;

    if (!user) {
      req.hubUnclaimed = true;
      return;
    }

    req.user = user;
  }

  async use(req: Request, _: Response, next: NextFunction) {
    const bearerToken = req.headers.authorization;

    const presentedIds = sessionIdsFromRequest(req);
    const preferredSessionId = pickNewestSessionId(presentedIds, this.sessionManager);
    const orderedIds = preferredSessionId ? [preferredSessionId, ...presentedIds.filter((id) => id !== preferredSessionId)] : presentedIds;

    for (const sessionId of orderedIds) {
      const userId = this.sessionManager.resolveSessionUserId(sessionId);
      if (!userId) {
        continue;
      }

      const expiresAt = this.sessionManager.getSessionExpiresAt(sessionId);
      if (expiresAt) {
        const remainingMs = expiresAt - Date.now();
        if (remainingMs < (SESSION_TTL_SECONDS * 1000) / 2) {
          this.sessionManager.touchSession(sessionId);
        }
      }

      try {
        const user = await loadSessionUser(this.sessionUserCache, this.userRepository, userId);
        if (await refuseRevokedSessionUser(user, this.sessionManager, this.sessionUserCache, userId)) {
          continue;
        }
        req.user = user;
        req.hubSessionId = sessionId;
        req.hubPrincipal = 'session';
        return next();
      } catch (err) {
        if (err instanceof ServiceUnavailableException) {
          throw err;
        }
        // A broken DB lookup must not turn GET / (OIDC returns, static pages)
        // into a JSON 500 — continue without a user so the route can run.
      }
    }

    if (bearerToken) {
      const token = bearerToken.split(' ')[1];

      if (!token) {
        return next();
      }

      // The Hub's Portal device credential, accepted here as an operator bearer.
      //
      // This is a HOST-LOCAL credential: it lives in `state/settings.json`, so presenting it means
      // the caller could already read that file, which is the same access `cihub` itself needs. It
      // must therefore never be distributed to anything with a smaller blast radius than the host —
      // it was previously injected into every app container as `HUB_API_KEY`, which handed every
      // installed app operator authority on this API (see the delete in `AppHelpers.generateEnvFile`).
      //
      // Compared in constant time because it is a secret, not an identifier. The durable fix is a
      // hashed, scoped, revocable api-key row resolved the way `McpAuthGuard` resolves the `mcp`
      // scope; until then this branch stays deliberately narrow.
      const ciHubApiKey = this.config.get('ciHubApiKey');
      if (ciHubApiKey && secretEquals(token, ciHubApiKey)) {
        // Named, so the org-grant gate exempts this deliberately rather than by
        // accident — the exemption used to follow from having no `hubSessionId`,
        // which covered every arm that forgot to set one. Portal's own
        // GRANT_DENIED gate is what authorises a push, and that answer holds only
        // while the exemption stays this narrow.
        await this.attachFirstOperator(req, 'portal-device');
        return next();
      }

      const jwtSecret = this.config.get('jwtSecret');

      try {
        const { sub } = jsonwebtoken.verify(token, jwtSecret) as { sub: string };
        if (sub === 'cli') {
          // Host-local by construction: the JWT is signed with `jwtSecret`, which
          // lives in the same state file as the device key — so it has the same
          // empty-`user` hole, and gets the same honest refusal.
          await this.attachFirstOperator(req, 'cli');
        }

        return next();
      } catch (error) {
        if (error instanceof ServiceUnavailableException) {
          throw error;
        }
        // Not a JWT this Hub signed; the last arms are the two scoped API keys that carry no
        // operator. Both scopes are standalone (see api-key.scopes.ts), so no key this Hub mints
        // can satisfy them both — but the second lookup is skipped once the first named a
        // principal regardless, so a row hand-written into the database can never have one arm
        // silently overwrite the other's answer. It also saves the SELECT.
        await this.attachQaReadKey(req, token);
        if (!req.hubPrincipal) {
          await this.attachInferenceKey(req, token);
        }
        return next();
      }
    }

    return next();
  }
}
