import { timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { withTransientDbRetry } from '@/core/database/transient-db-retry';
import { isTransientDbError } from '@/modules/api-keys/api-key.errors';
import { Injectable, type NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import jsonwebtoken from 'jsonwebtoken';
import { UserRepository } from '../user/user.repository';
import { SESSION_TTL_SECONDS, SessionManager } from './session.manager';
import { SessionUserCache } from '@/core/cache/session-user.cache';

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

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly config: ConfigurationService,
    private readonly userRepository: UserRepository,
    private readonly sessionUserCache: SessionUserCache,
  ) {}

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
        if (user?.accessStatus === 'revoked') {
          await this.sessionManager.destroyAllSessionsByUserId(userId);
          this.sessionUserCache.invalidate(userId);
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
        return next();
      }
    }

    return next();
  }
}
