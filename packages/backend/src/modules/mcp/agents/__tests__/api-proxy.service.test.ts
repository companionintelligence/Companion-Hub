import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

// Mock fetch globally
const mockFetch = vi.fn();

describe('ApiProxyService', () => {
  let service: ApiProxyService;

  beforeEach(async () => {
    vi.stubGlobal('fetch', mockFetch);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiProxyService,
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
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
      );

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('limit=10'), expect.anything());
    });
  });

  describe('S-AOA-2.2: inject auth credentials', () => {
    it('should inject bearer token from env', async () => {
      process.env.TEST_TOKEN = 'secret123';
      mockFetch.mockResolvedValue(new Response('ok', { status: 200 }));

      await service.proxyOpenApiCall(TEST_URN, { method: 'get', path: '/api/test' }, {}, { type: 'bearer', token_env: 'TEST_TOKEN' });

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

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test' });
      expect(result.content[0]?.text).toBe('short response');
      expect(result.isError).toBeUndefined();
    });

    it('should truncate responses over 100KB', async () => {
      const bigResponse = 'x'.repeat(200 * 1024);
      mockFetch.mockResolvedValue(new Response(bigResponse, { status: 200 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test' });
      expect(result.content[0]?.text).toContain('[Response truncated');
      expect(result.content[0]?.text.length).toBeLessThan(bigResponse.length);
    });
  });

  describe('S-AOA-2.4: non-2xx responses as error', () => {
    it('should return isError=true for 404', async () => {
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/missing' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('HTTP 404');
    });

    it('should return isError=true for 500', async () => {
      mockFetch.mockResolvedValue(new Response('Server error', { status: 500 }));

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/error' });
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

      const result = await service.proxyRequest(TEST_URN, { method: 'GET', path: '/api/test' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Network error');
    });
  });
});
