import { SESSION_COOKIE_NAME } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { withTransientDbRetry } from '@/core/database/transient-db-retry';
import { isTransientDbError } from '@/modules/api-keys/api-key.errors';
import { Injectable, type NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import jsonwebtoken from 'jsonwebtoken';
import { UserRepository } from '../user/user.repository';
import { SESSION_TTL_SECONDS, SessionManager } from './session.manager';

function addSessionId(ids: string[], seen: Set<string>, value: unknown) {
  if (typeof value !== 'string' || !value || seen.has(value)) {
    return;
  }
  seen.add(value);
  ids.push(value);
}

/**
 * Session ids in preference order. A stale `ci-hub-sid` cookie must not hide a
 * live `X-CI-Hub-Session` from the login response body — that is the race that
 * 401s app install right after a successful login.
 */
export function sessionIdsFromRequest(req: Request): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  addSessionId(ids, seen, req.cookies?.[SESSION_COOKIE_NAME]);
  addSessionId(ids, seen, req.get('x-ci-hub-session'));
  addSessionId(ids, seen, req.query?.session_id);
  return ids;
}

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly config: ConfigurationService,
    private readonly userRepository: UserRepository,
  ) {}

  /**
   * Session/API-key auth looks up the user on every request. A Docker DNS blip
   * (`EAI_AGAIN ci-hub-db`) used to fail the whole request as a 500 and flood
   * Sentry (NODE-NESTJS-HUB-BACKEND-EC). Retry briefly, then answer 503 so the
   * client can retry instead of treating the session as invalid.
   */
  private async loadUserResilient<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await withTransientDbRetry(load);
    } catch (err) {
      if (isTransientDbError(err)) {
        throw new ServiceUnavailableException('Database temporarily unavailable');
      }
      throw err;
    }
  }

  async use(req: Request, _: Response, next: NextFunction) {
    const bearerToken = req.headers.authorization;

    for (const sessionId of sessionIdsFromRequest(req)) {
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

      const user = await this.loadUserResilient(() => this.userRepository.getUserDtoById(userId));
      req.user = user;
      req.hubSessionId = sessionId;
      return next();
    }

    if (bearerToken) {
      const token = bearerToken.split(' ')[1];

      if (!token) {
        return next();
      }

      const ciHubApiKey = this.config.get('ciHubApiKey');
      if (ciHubApiKey && token === ciHubApiKey) {
        const user = await this.loadUserResilient(() => this.userRepository.getFirstOperator());
        req.user = user;
        return next();
      }

      const jwtSecret = this.config.get('jwtSecret');

      try {
        const { sub } = jsonwebtoken.verify(token, jwtSecret) as { sub: string };
        if (sub === 'cli') {
          const user = await this.loadUserResilient(() => this.userRepository.getFirstOperator());
          req.user = user;
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
