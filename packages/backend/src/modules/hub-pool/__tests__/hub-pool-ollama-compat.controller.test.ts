import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { MainExceptionFilter } from '@/common/error/exception.filter';
import { LoggerService } from '@/core/logger/logger.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { HubPoolOllamaCompatController } from '../hub-pool-ollama-compat.controller';
import { PoolProxyService } from '../hub-pool-proxy.service';

const INFERENCE_KEY = 'a'.repeat(64);

/**
 * Unlike every other `hub-pool` controller test, this one boots a real Nest HTTP server and issues
 * real requests against it, global prefix included. That is deliberate: `HubPoolController`'s own
 * tests (see `hub-pool.controller.test.ts`) instantiate the controller directly and call handler
 * methods, which proves the method body is correct but proves NOTHING about whether Nest's router
 * actually reaches it — a `@Controller()` never added to a module's `controllers: []`, a guard
 * misconfigured for the module, or (this bug) a route that only exists under a prefix a real
 * caller never uses, all pass that style of test while 404ing for every live client. This suite
 * hits the literal path a client (or `curl`) sends over the wire, through Nest's actual routing —
 * global prefix, guards, and all — so a reachability regression like #1460 fails here even when
 * every other layer's unit tests stay green.
 */
describe('HubPoolOllamaCompatController — top-level /api/version and /api/tags, real HTTP dispatch', () => {
  let app: INestApplication;
  let proxyService: MockProxy<PoolProxyService>;
  let apiKeys: MockProxy<ApiKeyService>;
  let logger: MockProxy<LoggerService>;
  let baseUrl: string;

  beforeAll(async () => {
    proxyService = mock<PoolProxyService>();
    logger = mock<LoggerService>();
    // The guard's key leg, faked at the service so this suite stays about routing: one key that
    // resolves with the `inference` scope, and nothing else does.
    apiKeys = mock<ApiKeyService>();
    apiKeys.resolve.mockImplementation(async (rawKey, scope) =>
      rawKey === INFERENCE_KEY && scope === 'inference'
        ? { id: 1, name: 'laptop', capability: 'read', ownerAppUrn: null, createdByUserId: null }
        : null,
    );
    // Mirrors PoolProxyService.proxyLocalOnlyRequest's real contract: it writes the Ollama-shaped
    // response directly onto the Express Response rather than returning a value.
    proxyService.proxyLocalOnlyRequest.mockImplementation(async (path, _method, _body, res) => {
      if (path === '/api/version') {
        res.status(200).json({ version: '0.1.2' });
      } else if (path === '/api/tags') {
        res.status(200).json({ models: [{ name: 'qwen3.6:27b' }] });
      } else {
        res.status(502).json({ error: `unexpected path ${path}` });
      }
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [HubPoolOllamaCompatController],
      providers: [
        { provide: PoolProxyService, useValue: proxyService },
        { provide: ApiKeyService, useValue: apiKeys },
        { provide: LoggerService, useValue: logger },
        InferenceAccessGuard,
        // The filter the Hub actually runs (app.module.ts wires it the same way). Without it a
        // thrown guard exception falls to Nest's built-in `BaseExceptionFilter`, whose own
        // `headersSent` handling would make the refusal case below pass for the wrong reason.
        { provide: APP_FILTER, useFactory: (log: LoggerService) => new MainExceptionFilter(log), inject: [LoggerService] },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts's `app.setGlobalPrefix('/api')` exactly. This is the crux of the regression:
    // every route in the real app lives under `/api`, so testing `GET /version` here instead of
    // `GET /api/version` would pass even if the controller's path segment silently doubled the
    // prefix or otherwise stopped lining up with what a real client requests.
    app.setGlobalPrefix('/api');
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  // One app for the file, so call history is cleared per test rather than accumulated: the
  // "never looked up" assertion below must hold on its own, not because the keyed test runs later.
  beforeEach(() => {
    apiKeys.resolve.mockClear();
    proxyService.proxyLocalOnlyRequest.mockClear();
    logger.error.mockClear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers GET /api/version at the bare top-level path — what a client using the plain OLLAMA_HOST convention (or `curl $CI_HUB_URL/api/version`) actually sends, not just the /api/inference/pool-prefixed one', async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ version: '0.1.2' });
    expect(proxyService.proxyLocalOnlyRequest).toHaveBeenCalledWith('/api/version', 'GET', undefined, expect.anything());
  });

  it('answers GET /api/tags at the same top-level path, with Ollama\'s native shape ({"models": [...]}), distinct from the OpenAI /v1/models shape', async () => {
    const res = await fetch(`${baseUrl}/api/tags`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ models: [{ name: 'qwen3.6:27b' }] });
    expect(body).not.toHaveProperty('object');
    expect(body).not.toHaveProperty('data');
    expect(proxyService.proxyLocalOnlyRequest).toHaveBeenCalledWith('/api/tags', 'GET', undefined, expect.anything());
  });

  it('does not regress to Nest\'s generic "Cannot GET" 404 — the exact response shape the live repro in #1460 hit', async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    // Nest's own unmatched-route handler always returns this shape (`{statusCode, message, path}`
    // with statusCode 404). A route that quietly stops being mounted regresses to precisely this —
    // which a test that calls the controller method directly, or only asserts route metadata, can
    // never observe, because neither one dispatches through Nest's router.
    expect(res.status).not.toBe(404);
  });

  /**
   * Dispatched through Nest for real, with `MainExceptionFilter` installed, so this also proves the
   * guard's write-then-throw refusal survives the filter the Hub runs: the body the client sees is
   * the OpenAI one the guard wrote, not the `{statusCode, message}` envelope the filter writes for
   * every other thrown exception. The filter's `headersSent` early return is the load-bearing line;
   * a filter that wrote anyway would hit `ERR_HTTP_HEADERS_SENT`, which re-enters it as a 500 and
   * shows up as `logger.error` — hence the last assertion.
   */
  it('still enforces InferenceAccessGuard on the top-level route — a tunnel-forwarded request without a key is refused exactly as it is on the inference/pool-prefixed one', async () => {
    const res = await fetch(`${baseUrl}/api/version`, { headers: { 'cf-connecting-ip': '203.0.113.5' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ci-hub-inference"');
    const body = await res.json();
    expect(body).toEqual({ error: { message: expect.any(String), type: 'authentication_error', code: 'missing_api_key' } });
    expect(body).not.toHaveProperty('statusCode');
    expect(apiKeys.resolve).not.toHaveBeenCalled();
    expect(proxyService.proxyLocalOnlyRequest).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('admits a tunnel-forwarded request that carries a valid inference key', async () => {
    const res = await fetch(`${baseUrl}/api/version`, { headers: { 'cf-connecting-ip': '203.0.113.5', authorization: `Bearer ${INFERENCE_KEY}` } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ version: '0.1.2' });
    expect(apiKeys.resolve).toHaveBeenCalledTimes(1);
    expect(apiKeys.resolve).toHaveBeenCalledWith(INFERENCE_KEY, 'inference');
  });
});
