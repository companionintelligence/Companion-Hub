import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { LoggerService } from '@/core/logger/logger.service';
import { GRANTED_ACTOR, REFUSED_ACTORS, lifecycleActorGate } from '@/tests/utils/lifecycle-actor-gate';
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
   * first (CI-Hub#1397).
   */
  describe('the actor gate', () => {
    it.each(REFUSED_ACTORS)('refuses %s before any request leaves the Hub', async (_label, actor) => {
      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', actor })).rejects.toThrow('APP_ACTION_GRANT_DENIED');

      expect(lifecycle.assertActorMay).toHaveBeenCalledWith(actor, TEST_URN, 'view');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws the refusal rather than handing it back as a proxy error the caller might read as the app answering', async () => {
      const [, neighbour] = REFUSED_ACTORS[1] ?? [];

      await expect(service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/users', actor: neighbour as never })).rejects.toMatchObject({
        status: 403,
      });
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
        expect(lifecycle.assertActorMay).toHaveBeenLastCalledWith(GRANTED_ACTOR, TEST_URN, 'configure');
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gates a generated OpenAPI call the same way, as the caller it is given', async () => {
      const [, neighbour] = REFUSED_ACTORS[1] ?? [];

      await expect(service.proxyOpenApiCall(TEST_URN, { method: 'delete', path: '/api/users/1' }, {}, neighbour as never)).rejects.toThrow(
        'APP_ACTION_GRANT_DENIED',
      );

      expect(lifecycle.assertActorMay).toHaveBeenCalledWith(neighbour, TEST_URN, 'configure');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
