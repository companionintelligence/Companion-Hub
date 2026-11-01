import type { LoggerService } from '@/core/logger/logger.service';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { buildPortalSsoErrorRedirectUrl, resolveRequestOriginFallback } from '@/modules/auth/portal-sso';
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
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`An error occured while calling: ${request.url}`, exception);
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
