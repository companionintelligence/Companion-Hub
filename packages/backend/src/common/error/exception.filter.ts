import type { LoggerService } from '@/core/logger/logger.service';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { buildPortalSsoErrorRedirectUrl, resolveRequestOriginFallback } from '@/modules/auth/portal-sso';
import { ApiKeyStoreUnavailableError, isDatabaseCredentialError, isTransientDbError } from '@/modules/api-keys/api-key.errors';
import { TranslatableError } from './translatable-error';

/** The error a stream raises when its client hangs up before the stream has finished. */
function isClientDisconnect(exception: unknown): boolean {
  return (
    exception instanceof Error && ((exception as { code?: unknown }).code === 'ERR_STREAM_PREMATURE_CLOSE' || exception.message === 'Premature close')
  );
}

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

    if (response.headersSent) {
      return true;
    }

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

  catch(exception: unknown, host: ArgumentsHost) {
    // A client that hangs up mid-response ends the stream with "Premature close". Nothing is broken and there
    // is no one left to answer, so it is neither captured by Sentry nor logged as an error.
    if (isClientDisconnect(exception)) {
      this.logger.debug(`Client disconnected before the response finished: ${host.switchToHttp().getRequest<Request>().url}`);
      return;
    }

    this.captureAndRespond(exception, host);
  }

  /** The decorator captures every exception that reaches it, so only exceptions past `catch`'s disconnect check get here. */
  @SentryExceptionCaptured()
  private captureAndRespond(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    // A database the Hub cannot reach, or a login Postgres refuses, is a 503 the client can retry
    // (#933), not a 500 that reads as a Hub defect. Its raw message stays out of the body.
    const databaseUnavailable =
      !(exception instanceof HttpException) &&
      (exception instanceof ApiKeyStoreUnavailableError || isTransientDbError(exception) || isDatabaseCredentialError(exception));
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : databaseUnavailable
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`An error occured while calling: ${request.url}`, exception);
    } else if (databaseUnavailable) {
      this.logger.warn(`Database unavailable while calling: ${request.url}`);
    }

    if (this.tryRedirectPortalSsoError(request, response)) {
      return;
    }

    if (response.headersSent) {
      return;
    }

    let message: string | undefined;
    let cause: unknown;

    // @ts-expect-error
    const error = exception?.error;
    if (error instanceof ZodError) {
      this.logger.error('Schema validation failed: ', request.path, JSON.stringify(error, null, 2));
    }

    if (exception instanceof Error && status !== HttpStatus.INTERNAL_SERVER_ERROR && !databaseUnavailable) {
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
    if (databaseUnavailable) {
      message = 'DATABASE_UNAVAILABLE';
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
