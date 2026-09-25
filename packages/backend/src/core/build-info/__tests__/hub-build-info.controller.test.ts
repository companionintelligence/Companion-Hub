import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { HubPoolOllamaCompatController } from '@/modules/hub-pool/hub-pool-ollama-compat.controller';
import { PoolProxyService } from '@/modules/hub-pool/hub-pool-proxy.service';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HubBuildInfoController } from '../hub-build-info.controller';
import { HubBuildInfoService } from '../hub-build-info.service';
import { resolveHubBuildInfo } from '../hub-build-info';

/**
 * Real HTTP dispatch, for the same reason `hub-pool-ollama-compat.controller.test.ts` uses it:
 * calling the handler directly proves the method body and nothing about whether Nest's router
 * reaches it. This suite mounts the build endpoint ALONGSIDE the Ollama-compatibility controller,
 * because the thing most worth proving is that the two coexist.
 *
 * `/api/version` is a pre-existing external convention — an app handed `OLLAMA_HOST=<hub>` probes
 * it, and CI-Hermes' `native_root()` calls it — so it must keep returning Ollama's version while
 * the Hub's own build answers somewhere else entirely.
 */
describe('HubBuildInfoController — GET /api/hub/build, real HTTP dispatch', () => {
  let app: INestApplication;
  let baseUrl: string;
  let buildInfo: MockProxy<HubBuildInfoService>;

  const STAMPED = {
    ...resolveHubBuildInfo({
      CI_HUB_BUILD_VERSION: '0.2.73',
      CI_HUB_BUILD_CHANNEL: 'latest',
      CI_HUB_BUILD_SHA: 'dac546bcffe0f105539615d94c8139e4522c050a',
      CI_HUB_BUILD_IMAGE_REF: 'ghcr.io/companionintelligence/ci-hub:0.2.73',
      CI_HUB_VERSION: 'v0.2.22',
    }),
    imageDigest: `sha256:${'14a090870a75'.padEnd(64, '0')}`,
  };

  beforeAll(async () => {
    buildInfo = mock<HubBuildInfoService>();
    buildInfo.getBuildInfoWithDigest.mockResolvedValue(STAMPED);

    const proxyService = mock<PoolProxyService>();
    proxyService.proxyLocalOnlyRequest.mockImplementation(async (path, _method, _body, res) => {
      res.status(200).json(path === '/api/version' ? { version: '0.34.0' } : { models: [] });
    });
    const apiKeys = mock<ApiKeyService>();
    apiKeys.resolve.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      controllers: [HubBuildInfoController, HubPoolOllamaCompatController],
      providers: [
        { provide: HubBuildInfoService, useValue: buildInfo },
        { provide: PoolProxyService, useValue: proxyService },
        { provide: ApiKeyService, useValue: apiKeys },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        InferenceAccessGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts. Without it this suite would test a path no live client ever sends.
    app.setGlobalPrefix('/api');
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the running build at /api/hub/build', async () => {
    const res = await fetch(`${baseUrl}/api/hub/build`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      version: '0.2.73',
      channel: 'latest',
      gitShaShort: 'dac546bcf',
      imageRef: 'ghcr.io/companionintelligence/ci-hub:0.2.73',
      imageDigest: STAMPED.imageDigest,
      source: 'image',
      summary: '0.2.73 (dac546bcf)',
    });
  });

  it('answers without credentials', async () => {
    // "Which build is this?" is asked by an operator who often cannot log in — a wedged JWT_SECRET,
    // an unpaired Hub, a sweep across 17 appliances. Behind AuthGuard the endpoint would be
    // unavailable in exactly the cases it exists for.
    const res = await fetch(`${baseUrl}/api/hub/build`);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('reports the env file version as a separate field, never as the running build', async () => {
    // The original bug: `CI_HUB_VERSION` from the install's env file reported AS the running
    // version. Here it says v0.2.22 while the image is 0.2.73, and both facts survive the response.
    const body = (await (await fetch(`${baseUrl}/api/hub/build`)).json()) as Record<string, unknown>;

    expect(body.version).toBe('0.2.73');
    expect(body.declaredVersion).toBe('v0.2.22');
  });

  it('leaves GET /api/version returning the Ollama version', async () => {
    // The compatibility constraint. An app pointed at OLLAMA_HOST=<hub> expects {"version":"0.34.0"}
    // here; the Hub build must not leak into it.
    const res = await fetch(`${baseUrl}/api/version`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ version: '0.34.0' });
  });

  it('does not answer the Hub build under any of the Ollama version paths', async () => {
    for (const path of ['/api/version', '/api/inference/pool/api/version']) {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) continue;
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('imageRef');
      expect(body).not.toHaveProperty('gitSha');
      expect(body).not.toHaveProperty('declaredVersion');
    }
  });
});
