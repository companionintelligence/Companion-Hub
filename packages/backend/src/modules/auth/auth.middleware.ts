import { SESSION_COOKIE_NAME } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import jsonwebtoken from 'jsonwebtoken';
import { UserRepository } from '../user/user.repository';
import { SESSION_TTL_SECONDS, SessionManager } from './session.manager';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly config: ConfigurationService,
    private readonly userRepository: UserRepository,
  ) {}

  async use(req: Request, _: Response, next: NextFunction) {
    const sessionId = req.cookies[SESSION_COOKIE_NAME] || (req.headers['x-ci-hub-session'] as string) || (req.query.session_id as string);
    const bearerToken = req.headers.authorization;

    if (sessionId) {
      const userId = this.sessionManager.resolveSessionUserId(sessionId);
      if (userId) {
        const expiresAt = this.sessionManager.getSessionExpiresAt(sessionId);
        if (expiresAt) {
          const remainingMs = expiresAt - Date.now();
          if (remainingMs < (SESSION_TTL_SECONDS * 1000) / 2) {
            this.sessionManager.touchSession(sessionId);
          }
        }

        const user = await this.userRepository.getUserDtoById(userId);
        req.user = user;
      }

      return next();
    }

    if (bearerToken) {
      const token = bearerToken.split(' ')[1];

      if (!token) {
        return next();
      }

      const ciHubApiKey = this.config.get('ciHubApiKey');
      if (ciHubApiKey && token === ciHubApiKey) {
        const user = await this.userRepository.getFirstOperator();
        req.user = user;
        return next();
      }

      const jwtSecret = this.config.get('jwtSecret');

      try {
        const { sub } = jsonwebtoken.verify(token, jwtSecret) as { sub: string };
        if (sub === 'cli') {
          const user = await this.userRepository.getFirstOperator();
          req.user = user;
        }

        return next();
      } catch (_error) {
        return next();
      }
    }

    return next();
  }
}
