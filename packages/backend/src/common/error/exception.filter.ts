import type { LoggerService } from '@/core/logger/logger.service';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { buildPortalSsoErrorRedirectUrl, resolveRequestOriginFallback } from '@/modules/auth/portal-sso';
import { TranslatableError } from './translatable-error';

@Catch()
export class MainExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  private tryRedirectPortalSsoError(request: Request, response: Response): boolean {
    if (request.method !== 'GET') {
      return false;
    }

    const path = request.path;
    // Browser OAuth navigation only — desktop/Tauri calls desktop-exchange and
    // session-hint via fetch and must receive JSON errors, not login redirects.
    if (path.endsWith('/portal/desktop-exchange') || path.endsWith('/portal/session-hint')) {
      return false;
    }

    if (!path.startsWith('/api/auth/portal/')) {
      return false;
    }

    const isDesktopStart = path.endsWith('/portal/start') && (request.query.desktop === '1' || request.query.desktop === 'true');

    response.redirect(
      buildPortalSsoErrorRedirectUrl({
        hubOrigin: null,
        desktop: isDesktopStart,
        errorCode: 'callback_error',
        fallbackOrigin: resolveRequestOriginFallback(request),
      }),
    );
    return true;
  }

  @SentryExceptionCaptured()
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (this.tryRedirectPortalSsoError(request, response)) {
      return;
    }

    let message: string | undefined;
    let cause: unknown;

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`An error occured while calling: ${request.url}`, exception);
    }

    // @ts-expect-error
    const error = exception?.error;
    if (error instanceof ZodError) {
      this.logger.error('Schema validation failed: ', request.path, JSON.stringify(error, null, 2));
    }

    if (exception instanceof Error && status !== HttpStatus.INTERNAL_SERVER_ERROR) {
      message = exception.message;
    }

    let intlParams: Record<string, string | undefined> | undefined;
    if (exception instanceof TranslatableError) {
      const response = exception.getResponse();
      cause = exception.cause;

      if (typeof response === 'string') {
        message = response;
      } else {
        // @ts-expect-error
        message = response.message;
        // @ts-expect-error
        intlParams = response.intlParams;
      }
    }

    // If no message was set and it's a 500 error, use the translation key
    if (!message && status === HttpStatus.INTERNAL_SERVER_ERROR) {
      message = 'INTERNAL_SERVER_ERROR';
    }

    response.status(status).json({
      statusCode: status,
      message,
      path: request.url,
      intlParams,
      cause,
    });
  }
}
