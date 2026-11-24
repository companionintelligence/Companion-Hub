import { HttpStatus } from '@nestjs/common';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import { MainExceptionFilter } from './exception.filter';
import { TranslatableError } from './translatable-error';

describe('MainExceptionFilter', () => {
  let filter: MainExceptionFilter;
  let logger: MockProxy<LoggerService>;
  let response: MockProxy<Response>;
  let request: Partial<Request>;

  beforeEach(() => {
    logger = mock<LoggerService>();
    filter = new MainExceptionFilter(logger);
    response = mock<Response>();
    response.headersSent = false;
    response.status.mockReturnThis();
    request = {
      method: 'GET',
      path: '/api/auth/portal/desktop-exchange',
      url: '/api/auth/portal/desktop-exchange?token=expired',
      query: { token: 'expired' },
      protocol: 'http',
      get: (header: string) => (header.toLowerCase() === 'host' ? 'localhost:5002' : undefined),
    };
  });

  function createHost(): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getRequest: () => request as Request,
        getResponse: () => response as Response,
      }),
    } as ArgumentsHost;
  }

  it('answers 503 DATABASE_UNAVAILABLE, not the driver message, when the database cannot be reached', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN ci-hub-db'), { code: 'EAI_AGAIN' });

    filter.catch(new Error('Failed query: select "id" from "api_keys" where "hashed_key" = $1', { cause }), createHost());

    expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, message: 'DATABASE_UNAVAILABLE' }),
    );
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('api_keys');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers 503 for a login Postgres refuses, since that also leaves the store unusable', () => {
    const cause = Object.assign(new Error('password authentication failed for user "companion"'), { code: '28P01' });

    filter.catch(new Error('Failed query: select 1', { cause }), createHost());

    expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('keeps a 500 for a query bug that is not a database outage', () => {
    filter.catch(new Error('column "owner_app_urn" does not exist'), createHost());

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'INTERNAL_SERVER_ERROR' }));
  });

  it('returns JSON for desktop-exchange errors instead of redirecting to login', () => {
    filter.catch(new BadRequestException('Invalid or expired desktop exchange token'), createHost());

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid or expired desktop exchange token',
      }),
    );
  });

  it('still redirects browser portal callback errors to the login page', () => {
    request.path = '/api/auth/portal/callback';
    request.url = '/api/auth/portal/callback';

    filter.catch(new BadRequestException('callback failed'), createHost());

    expect(response.redirect).toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('does not redirect or JSON-write when the portal handler already sent headers', () => {
    request.path = '/api/auth/portal/start';
    request.url = '/api/auth/portal/start?desktop=1';
    request.query = { desktop: '1' };
    response.headersSent = true;

    filter.catch(new Error('headers already sent'), createHost());

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  /**
   * The case the portal test above never reaches: an ordinary route, where the only thing between a
   * body a guard already wrote and this filter's `{statusCode, message}` envelope is the generic
   * `headersSent` return. `InferenceAccessGuard` writes its OpenAI-shaped 401 and then throws on the
   * strength of it; a filter that wrote anyway would raise `ERR_HTTP_HEADERS_SENT` on every refusal.
   */
  it('leaves a body a guard already wrote alone on an ordinary route', () => {
    request.method = 'POST';
    request.path = '/api/inference/v1/chat/completions';
    request.url = '/api/inference/v1/chat/completions';
    response.headersSent = true;

    filter.catch(new UnauthorizedException('missing key'), createHost());

    expect(response.redirect).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    { how: 'by its stream error code', error: Object.assign(new Error('aborted'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }) },
    { how: 'by its message', error: new Error('Premature close') },
  ])('does not capture or log as an error a client that hung up mid-response, recognised $how', ({ error }) => {
    const captureAndRespond = vi.spyOn(filter as unknown as { captureAndRespond: () => void }, 'captureAndRespond');
    request.method = 'POST';
    request.path = '/api/inference/pool/local/api/chat';
    request.url = '/api/inference/pool/local/api/chat';
    response.headersSent = true;

    filter.catch(error, createHost());

    expect(captureAndRespond).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('/api/inference/pool/local/api/chat'));
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('answers a refusal the person caused with its key and writes no error line', () => {
    request.method = 'PATCH';
    request.path = '/api/auth/password';
    request.url = '/api/auth/password';

    filter.catch(new TranslatableError('AUTH_ERROR_INVALID_PASSWORD', {}, HttpStatus.BAD_REQUEST), createHost());

    expect(logger.error).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: HttpStatus.BAD_REQUEST, message: 'AUTH_ERROR_INVALID_PASSWORD' }),
    );
  });

  it('still reports and answers any other error', () => {
    const captureAndRespond = vi.spyOn(filter as unknown as { captureAndRespond: () => void }, 'captureAndRespond');

    filter.catch(new Error('boom'), createHost());

    expect(captureAndRespond).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('/api/auth/portal/desktop-exchange'), expect.any(Error));
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
