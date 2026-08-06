import { LoggerService } from '@/core/logger/logger.service';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AppStoreService } from '../../app-stores/app-store.service';
import { AuthGuard } from '../../auth/auth.guard';
import { RegistrationGuard } from '../../registration/registration.guard';
import { ImageSizeService } from '../image-size.service';
import { MarketplaceController } from '../marketplace.controller';
import { MarketplaceService } from '../marketplace.service';

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(),
}));

const DEMO_FILE = {
  path: '/data/apps/ci-marketplace/ci-memory/metadata/media/ci-memory-landscape.mp4',
  size: 52_428_800,
  etag: '"3200000-18f"',
  contentType: 'video/mp4',
};

describe('MarketplaceController demo video', () => {
  let controller: MarketplaceController;
  let marketplaceService: MockProxy<MarketplaceService>;
  let res: Response & { set: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let headers: Record<string, string>;

  const makeReq = (reqHeaders: Record<string, string> = {}) => ({ headers: reqHeaders }) as unknown as Request;

  beforeEach(async () => {
    vi.mocked(pipeline).mockReset();
    vi.mocked(pipeline).mockResolvedValue(undefined as never);

    const moduleRef = await Test.createTestingModule({
      controllers: [MarketplaceController],
      providers: [
        { provide: MarketplaceService, useValue: mock<MarketplaceService>() },
        { provide: AppStoreService, useValue: mock<AppStoreService>() },
        { provide: ImageSizeService, useValue: mock<ImageSizeService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .overrideGuard(RegistrationGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .compile();

    controller = moduleRef.get(MarketplaceController);
    marketplaceService = moduleRef.get(MarketplaceService);
    marketplaceService.createDemoVideoStream.mockReturnValue({ kind: 'stream' } as never);

    headers = {};
    res = {
      set: vi.fn((next: Record<string, string>) => {
        Object.assign(headers, next);
        return res;
      }),
      status: vi.fn(() => res),
      end: vi.fn(() => res),
      headersSent: false,
      writableEnded: true,
    } as never;
  });

  it('404s when no local demo video exists', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(null);

    await expect(controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('streams the whole file with Accept-Ranges when no Range is requested', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);

    await controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq());

    expect(headers['Accept-Ranges']).toBe('bytes');
    expect(headers['Content-Length']).toBe('52428800');
    expect(headers['Content-Range']).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
    // The bytes are streamed, never buffered into the response.
    expect(marketplaceService.createDemoVideoStream).toHaveBeenCalledWith(DEMO_FILE, 0, 52_428_799);
    expect(pipeline).toHaveBeenCalledWith({ kind: 'stream' }, res);
  });

  it('answers a Range request with 206 and a bounded stream', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);

    await controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq({ range: 'bytes=1048576-2097151' }));

    expect(res.status).toHaveBeenCalledWith(206);
    expect(headers['Content-Range']).toBe('bytes 1048576-2097151/52428800');
    expect(headers['Content-Length']).toBe('1048576');
    expect(marketplaceService.createDemoVideoStream).toHaveBeenCalledWith(DEMO_FILE, 1_048_576, 2_097_151);
  });

  it('answers an unsatisfiable Range with 416', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);

    await controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq({ range: 'bytes=99999999-' }));

    expect(res.status).toHaveBeenCalledWith(416);
    expect(headers['Content-Range']).toBe('bytes */52428800');
    expect(marketplaceService.createDemoVideoStream).not.toHaveBeenCalled();
  });

  it('short-circuits to 304 on a matching ETag', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);

    await controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq({ 'if-none-match': DEMO_FILE.etag }));

    expect(res.status).toHaveBeenCalledWith(304);
    expect(marketplaceService.createDemoVideoStream).not.toHaveBeenCalled();
  });

  it('stays quiet when the client aborts mid-stream', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);
    const abort = Object.assign(new Error('aborted'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    vi.mocked(pipeline).mockRejectedValue(abort);
    const logger = vi.mocked(controller as unknown as { logger: LoggerService }).logger;

    await expect(controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq())).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a genuine stream failure', async () => {
    marketplaceService.getAppDemoVideo.mockResolvedValue(DEMO_FILE);
    vi.mocked(pipeline).mockRejectedValue(Object.assign(new Error('disk exploded'), { code: 'EIO' }));
    const logger = vi.mocked(controller as unknown as { logger: LoggerService }).logger;

    await controller.getAppDemoVideo('ci-memory:ci-marketplace', res, makeReq());

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Demo video stream failed'));
  });
});
