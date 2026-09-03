import { HttpStatus } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import { MainExceptionFilter } from './exception.filter';

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
});
