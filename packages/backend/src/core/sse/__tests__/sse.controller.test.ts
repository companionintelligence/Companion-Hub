import { HttpStatus } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { StreamHubLogsQueryDto } from '../dto/sse.dto';
import { SSEController } from '../sse.controller';
import type { SSEService } from '../sse.service';

describe('SSEController app logs', () => {
  let sse: MockProxy<SSEService>;
  let whois: MockProxy<MarketplaceWhoIsService>;
  let controller: SSEController;
  const req = { hubPrincipal: 'session', user: { id: 7 } } as unknown as Request;

  beforeEach(() => {
    sse = mock<SSEService>();
    sse.getLogStreamObservable.mockResolvedValue(of());
    whois = mock<MarketplaceWhoIsService>();
    const moduleRef = { get: vi.fn((token: unknown) => (token === MarketplaceWhoIsService ? whois : undefined)) } as unknown as ModuleRef;
    controller = new SSEController(sse, moduleRef);
  });

  it('asks for configure on a custom app, whose logs carry what its settings hold, before opening the stream', async () => {
    await controller.appLogsEvents({ appUrn: 'log-check:_user', maxLines: 50 }, req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'log-check:_user', 'configure');
    expect(sse.getLogStreamObservable).toHaveBeenCalledWith('app-logs', 50, 'log-check:_user');
  });

  it('asks for view on a catalog app, as compose-diff does', async () => {
    await controller.appLogsEvents({ appUrn: 'immich:ci-marketplace' }, req);

    expect(whois.assertSessionAction).toHaveBeenCalledWith(req, 'immich:ci-marketplace', 'view');
    expect(sse.getLogStreamObservable).toHaveBeenCalledWith('app-logs', 300, 'immich:ci-marketplace');
  });

  it('opens no stream for someone without the grant', async () => {
    whois.assertSessionAction.mockRejectedValue(new TranslatableError('APP_ACTION_GRANT_DENIED', { action: 'configure' }, HttpStatus.FORBIDDEN));

    await expect(controller.appLogsEvents({ appUrn: 'log-check:_user' }, req)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    expect(sse.getLogStreamObservable).not.toHaveBeenCalled();
  });

  it('cuts a request for more lines to 1000, as the MCP log tool does', async () => {
    await controller.appLogsEvents({ appUrn: 'immich:ci-marketplace', maxLines: 5000 }, req);
    await controller.hubLogsEvents({ maxLines: 100000 });

    expect(sse.getLogStreamObservable).toHaveBeenNthCalledWith(1, 'app-logs', 1000, 'immich:ci-marketplace');
    expect(sse.getLogStreamObservable).toHaveBeenNthCalledWith(2, 'ci-hub-logs', 1000);
  });

  it('refuses when the grant check cannot be reached', async () => {
    const unresolved = new SSEController(sse, {
      get: vi.fn(() => {
        throw new Error('not provided');
      }),
    } as unknown as ModuleRef);

    await expect(unresolved.appLogsEvents({ appUrn: 'immich:ci-marketplace' }, req)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    expect(sse.getLogStreamObservable).not.toHaveBeenCalled();
  });
});

describe('log stream queries', () => {
  it('read the number of lines from the query string', () => {
    expect(StreamHubLogsQueryDto.schema.parse({ maxLines: '250' })).toEqual({ maxLines: 250 });
  });

  it('refuse a number of lines that is not a positive whole number', () => {
    expect(StreamHubLogsQueryDto.schema.safeParse({ maxLines: 'all' }).success).toBe(false);
    expect(StreamHubLogsQueryDto.schema.safeParse({ maxLines: '0' }).success).toBe(false);
  });
});
