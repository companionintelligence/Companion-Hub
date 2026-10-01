import http from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { AppRuntimeMonitorService } from '../app-runtime-monitor.service';
import { APP_STARTING_PAGE_PATH } from '../app-starting-page';
import { AppStartingPageService } from '../app-starting-page.service';
import { AppsReadService } from '../apps-read.service';
import { AppsController } from '../apps.controller';
import { AppsService } from '../apps.service';
import { InferenceEnvStalenessService } from '../inference-env-staleness.service';

/**
 * Real HTTP dispatch, as Traefik's errors middleware makes it: no session, the visitor's `Host`.
 * Calling the handler directly would prove nothing about the two things most likely to break — that
 * `GET /api/apps/:urn`, declared on the same controller, never takes `starting` for an app, and that
 * no guard stands in front of a page Traefik fetches without signing in.
 */
describe('AppsController — GET /api/apps/starting, real HTTP dispatch', () => {
  let app: INestApplication;
  let port: number;
  let page: MockProxy<AppStartingPageService>;
  let read: MockProxy<AppsReadService>;

  /** `fetch` will not send a `Host` of our choosing; Traefik does. */
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  beforeAll(async () => {
    page = mock<AppStartingPageService>();
    read = mock<AppsReadService>();

    const moduleRef = await Test.createTestingModule({
      controllers: [AppsController],
      providers: [
        { provide: AppsReadService, useValue: read },
        { provide: AppsService, useValue: mock<AppsService>() },
        { provide: AppRuntimeMonitorService, useValue: mock<AppRuntimeMonitorService>() },
        { provide: MarketplaceWhoIsService, useValue: mock<MarketplaceWhoIsService>() },
        { provide: InferenceEnvStalenessService, useValue: mock<InferenceEnvStalenessService>() },
        { provide: AppStartingPageService, useValue: page },
        // For the guards on the controller's other routes.
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts, and the path the middleware's `query` names.
    app.setGlobalPrefix('/api');
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    port = typeof address === 'object' && address ? address.port : 0;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    page.describe.mockReset();
    page.describe.mockResolvedValue({ state: 'starting', appName: 'Hermes', hubUrl: 'https://hub1-acme.ci0.pw/apps/ci-marketplace/ci-hermes' });
    read.getApp.mockClear();
  });

  it('answers without a session, for the app named by the Host header', async () => {
    const res = await get(`${APP_STARTING_PAGE_PATH}?status=502`, { Host: 'ci-hermes-hub1-acme.ci.lan', Cookie: 'other-app=1' });

    expect(res.status).toBe(502);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('<h1>Hermes is starting…</h1>');
    expect(page.describe).toHaveBeenCalledWith('ci-hermes-hub1-acme.ci.lan');
    // `:urn` never saw it.
    expect(read.getApp).not.toHaveBeenCalled();
  });

  it('answers with the status Traefik caught, and 503 for anything else', async () => {
    expect((await get(`${APP_STARTING_PAGE_PATH}?status=504`)).status).toBe(504);
    expect((await get(`${APP_STARTING_PAGE_PATH}?status=503`)).status).toBe(503);
    expect((await get(`${APP_STARTING_PAGE_PATH}?status=200`)).status).toBe(503);
    expect((await get(APP_STARTING_PAGE_PATH)).status).toBe(503);
  });

  it('sends the page’s headers, which Traefik copies onto the visitor’s response', async () => {
    const res = await get(`${APP_STARTING_PAGE_PATH}?status=502`);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('serves the stopped and not-responding pages the same way', async () => {
    page.describe.mockResolvedValue({ state: 'stopped', appName: 'Hermes', hubUrl: 'https://hub1-acme.ci0.pw/apps/ci-marketplace/ci-hermes' });
    const stopped = await get(`${APP_STARTING_PAGE_PATH}?status=502`);
    expect(stopped.body).toContain('<h1>Hermes is stopped</h1>');
    expect(stopped.headers['retry-after']).toBeUndefined();

    page.describe.mockResolvedValue({ state: 'unknown', hubUrl: null });
    const unknown = await get(`${APP_STARTING_PAGE_PATH}?status=503`);
    expect(unknown.status).toBe(503);
    expect(unknown.body).toContain('<h1>This app isn&#39;t responding</h1>');
  });

  it('leaves the app routes beside it guarded as before', async () => {
    const res = await get('/api/apps/ci-hermes:ci-marketplace');

    expect(res.status).toBe(401);
    expect(read.getApp).not.toHaveBeenCalled();
  });
});
