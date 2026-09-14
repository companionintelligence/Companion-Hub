import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { LoggerService } from '@/core/logger/logger.service';
import { GRANTED_ACTOR, MANAGED_KEY_ON_OTHER_APP, UNGRANTED_ACTORS, gateChecks, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
import type { AppUrn } from '@ci-hub/common/types';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

// Mock fetch globally
const mockFetch = vi.fn();

describe('ApiProxyService', () => {
  let service: ApiProxyService;
  let lifecycle: MockProxy<AppLifecycleService>;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    lifecycle = mock<AppLifecycleService>();
    // The real actor decision, so the proxy is exercised against the gate it asks in production.
    lifecycle.assertActorMay.mockImplementation(lifecycleActorGate());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiProxyService,
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: AppLifecycleService, useValue: lifecycle },
      ],
    }).compile();

    service = module.get(ApiProxyService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('S-AOA-2.1: construct HTTP request from tool parameters', () => {
    it('should interpolate path parameters', async () => {
      mockFetch.mockResolvedValue(new Response('{"id": "123"}', { status: 200 }));

      await service.proxyOpenApiCall(
        TEST_URN,
        {
          method: 'get',
          path: '/api/users/{id}',
          parameters: [{ name: 'id', in: 'path' }],
        },
        { id: '123' },
        GRANTED_ACTOR,
      );

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/users/123'), expect.anything());
    });

    it('should append query parameters', async () => {
      mockFetch.mockResolvedValue(new Response('[]', { status: 200 }));

      await service.proxyOpenApiCall(
        TEST_URN,
        {
          method: 'get',
          path: '/api/users',
          parameters: [{ name: 'limit', in: 'query' }],
        },
        { limit: '10' },
        GRANTED_ACTOR,
      );

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('limit=10'), expect.anything());
    });
  });

  describe('S-AOA-2.2: inject auth credentials', () => {
    it('should inject bearer token from env', async () => {
      process.env.TEST_TOKEN = 'secret123';
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

      await service.proxyOpenApiCall(TEST_URN, { method: 'get', path: '/api/test' }, {}, GRANTED_ACTOR, { type: 'bearer', token_env: 'TEST_TOKEN' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer secret123',
          }),
        }),
      );

      delete process.env.TEST_TOKEN;
    });
  });

  describe('S-AOA-2.3: response truncation', () => {
    it('should return full response when under 100KB', async () => {
      mockFetch.mockResolvedValue(new Response('short response', { status: 200 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test', actor: GRANTED_ACTOR });
      expect(result.content[0]?.text).toBe('short response');
      expect(result.isError).toBeUndefined();
    });

    it('should truncate responses over 100KB', async () => {
      const bigResponse = 'x'.repeat(200 * 1024);
      mockFetch.mockResolvedValue(new Response(bigResponse, { status: 200 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test', actor: GRANTED_ACTOR });
      expect(result.content[0]?.text).toContain('[Response truncated');
      expect(result.content[0]?.text.length).toBeLessThan(bigResponse.length);
    });
  });

  describe('S-AOA-2.4: non-2xx responses as error', () => {
    it('should return isError=true for 404', async () => {
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/missing', actor: GRANTED_ACTOR });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('HTTP 404');
    });

    it('should return isError=true for 500', async () => {
      mockFetch.mockResolvedValue(new Response('Server error', { status: 500 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/error', actor: GRANTED_ACTOR });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('HTTP 500');
    });
  });

  describe('S-APX-1.1: generic HTTP proxy', () => {
    it('should make HTTP request to app container', async () => {
      mockFetch.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));

      const result = await service.proxyRequest(TEST_URN, {
        method: 'POST',
        path: '/api/v1/data',
        body: { key: 'value' },
        headers: { 'X-Custom': 'header' },
        queryParams: { foo: 'bar' },
        actor: GRANTED_ACTOR,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/data'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        }),
      );
      expect(result.content[0]?.text).toContain('ok');
    });
  });

  describe('error handling', () => {
    it('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test', actor: GRANTED_ACTOR });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Network error');
    });
  });

  /*
   * The request carries the credential the app's agent config points the Hub at, so reaching an app's
   * API reads or changes its data with the Hub's access. The proxy asks the lifecycle's actor gate
   * first (CI-Hub#1397), marked as an app call, which a managed app key may make on any app.
   */
  describe('the actor gate', () => {
    it.each(UNGRANTED_ACTORS)('refuses %s before any request leaves the Hub', async (_label, actor) => {
      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', actor })).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(gateChecks(lifecycle.assertActorMay)).toEqual([[actor, TEST_URN, 'view', { appCall: true }]]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws the refusal rather than handing it back as a proxy error the caller might read as the app answering', async () => {
      const [, ungranted] = UNGRANTED_ACTORS[0] ?? [];

      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', actor: ungranted as never })).rejects.toMatchObject({
        status: 403,
      });
    });

    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])("lets a managed app's key call another app's API with %s", async (method) => {
      mockFetch.mockImplementation(async () => new Response('ok', { status: 200 }));

      await expect(service.proxyRequest(TEST_URN, { method, path: '/api/users', actor: MANAGED_KEY_ON_OTHER_APP })).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('takes view to read and configure for every other verb, so view alone never writes', async () => {
      // WhoIs grants this person `view` on the app and nothing else.
      lifecycle.assertActorMay.mockImplementation(lifecycleActorGate((_userId, _appUrn, action) => action === 'view'));
      mockFetch.mockImplementation(async () => new Response('ok', { status: 200 }));

      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', actor: GRANTED_ACTOR })).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
      });

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']) {
        await expect(service.proxyRequest(TEST_URN, { method, path: '/api/users', actor: GRANTED_ACTOR })).rejects.toThrow('APP_ACTION_GRANT_DENIED');
        expect(gateChecks(lifecycle.assertActorMay).at(-1)).toEqual([GRANTED_ACTOR, TEST_URN, 'configure', { appCall: true }]);
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gates a generated OpenAPI call the same way, as the caller it is given', async () => {
      const [, ungranted] = UNGRANTED_ACTORS[1] ?? [];

      await expect(service.proxyOpenApiCall(TEST_URN, { method: 'delete', path: '/api/users/1' }, {}, ungranted as never)).rejects.toThrow(
        'APP_ACTION_GRANT_DENIED',
      );
      expect(gateChecks(lifecycle.assertActorMay)).toEqual([[ungranted, TEST_URN, 'configure', { appCall: true }]]);
      expect(mockFetch).not.toHaveBeenCalled();

      // The same generated call, from a managed app's key on another app, reaches the app.
      mockFetch.mockImplementation(async () => new Response('ok', { status: 200 }));
      await service.proxyOpenApiCall(TEST_URN, { method: 'delete', path: '/api/users/1' }, {}, MANAGED_KEY_ON_OTHER_APP);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  /*
   * The gate asks about `appUrn`, so the request may go nowhere else: not to a host its `path` names,
   * nor to one the URN's own segments spell out.
   */
  describe('the host a request is sent to', () => {
    it.each([
      'http://ci-marketplace-immich/api/assets',
      '//ci-marketplace-immich/api/assets',
      '\\\\ci-marketplace-immich\\api',
      '/\\ci-marketplace-immich/api',
      'http://nextcloud-ci-store:8080/api',
    ])('refuses the path %s, which leaves the app the gate checked', async (path) => {
      const result = await service.proxyRequest(TEST_URN, { method: 'DELETE', path, actor: GRANTED_ACTOR });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not a URL to another host');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each([
      'nextcloud:ci-marketplace-immich#',
      'nextcloud:evil.example?',
      'nextcloud:user@evil.example#',
      'evil.com:x',
    ])('refuses the URN %s, whose segments would name another host', async (urn) => {
      const result = await service.proxyRequest(urn as AppUrn, { method: 'GET', path: '/api/x', actor: GRANTED_ACTOR });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends a path on the app to the app', async () => {
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

      await expect(
        service.proxyRequest('nextcloud:ci-marketplace' as AppUrn, { method: 'GET', path: '/api/x?y=1', actor: GRANTED_ACTOR }),
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
      });
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/x?y=1'), expect.anything());
    });
  });

  /*
   * WordPress, Slim 3, Yii2 and Restler run a GET that carries a method override as that method, so the
   * verb comes from the whole request, not its method alone.
   */
  describe('a request that asks the app to run another method', () => {
    beforeEach(() => {
      // WhoIs grants this person `view` on the app and nothing else.
      lifecycle.assertActorMay.mockImplementation(lifecycleActorGate((_userId, _appUrn, action) => action === 'view'));
      mockFetch.mockImplementation(async () => new Response('ok', { status: 200 }));
    });

    it.each([
      ['an X-HTTP-Method-Override header', { headers: { 'X-HTTP-Method-Override': 'DELETE' } }],
      ['an X-HTTP-Method header', { headers: { 'x-http-method': 'PUT' } }],
      ['an X-Method-Override header', { headers: { 'X-Method-Override': 'PATCH' } }],
      ['a _method query parameter', { queryParams: { _method: 'DELETE' } }],
      ['a _method in its path', { path: '/api/items/1?_method=DELETE' }],
    ])('takes configure for a GET carrying %s, so view alone never runs it', async (_label, request) => {
      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/items/1', actor: GRANTED_ACTOR, ...request })).rejects.toThrow(
        'APP_ACTION_GRANT_DENIED',
      );

      expect(gateChecks(lifecycle.assertActorMay)).toEqual([[GRANTED_ACTOR, TEST_URN, 'configure', { appCall: true }]]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('still takes view for an override that asks for a read, and for headers that only look alike', async () => {
      await expect(
        service.proxyRequest(TEST_URN, {
          method: 'GET',
          path: '/api/items/1',
          headers: { 'X-HTTP-Method-Override': 'HEAD', 'X-Custom-Method': 'DELETE' },
          actor: GRANTED_ACTOR,
        }),
      ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
      expect(gateChecks(lifecycle.assertActorMay)).toEqual([[GRANTED_ACTOR, TEST_URN, 'view', { appCall: true }]]);
    });
  });

  describe('an auth lookup', () => {
    it.each(UNGRANTED_ACTORS)('is never run for %s, whom the gate refuses', async (_label, actor) => {
      const auth = vi.fn(async () => ({ type: 'bearer' as const, token_env: 'TEST_TOKEN' }));

      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', auth, actor })).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(auth).not.toHaveBeenCalled();
    });

    it('is never run for a request that would leave the app', async () => {
      const auth = vi.fn(async () => ({ type: 'bearer' as const, token_env: 'TEST_TOKEN' }));

      await service.proxyRequest(TEST_URN, { method: 'GET', path: '//elsewhere/api', auth, actor: GRANTED_ACTOR });

      expect(auth).not.toHaveBeenCalled();
    });

    it('is run once the caller is admitted, and its credential sent', async () => {
      process.env.TEST_TOKEN = 'secret123';
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));
      const auth = vi.fn(async () => ({ type: 'bearer' as const, token_env: 'TEST_TOKEN' }));

      try {
        await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', auth, actor: GRANTED_ACTOR });
      } finally {
        delete process.env.TEST_TOKEN;
      }

      expect(auth).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret123' }) }),
      );
    });
  });
});
