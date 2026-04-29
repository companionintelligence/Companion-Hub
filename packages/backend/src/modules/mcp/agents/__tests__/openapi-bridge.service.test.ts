import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { OpenApiBridgeService } from '../../agents/openapi-bridge.service';
import { ApiProxyService } from '../../agents/api-proxy.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from '../../agents/agent-config.service';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

const SAMPLE_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/api/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'number' }, description: 'Max results' }],
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
      },
    },
    '/api/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get user by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      delete: {
        summary: 'Delete a user',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
});

const makeConfig = (openapi: ResolvedAgentConfig['openapi']): ResolvedAgentConfig => ({
  skill: { enabled: false, content: null, inline: false },
  openapi,
  mcp: { enabled: false, config: null },
});

describe('OpenApiBridgeService', () => {
  let service: OpenApiBridgeService;
  let filesystem: MockProxy<FilesystemService>;
  let _apiProxy: MockProxy<ApiProxyService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenApiBridgeService,
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ApiProxyService, useValue: mock<ApiProxyService>() },
      ],
    }).compile();

    service = module.get(OpenApiBridgeService);
    filesystem = module.get(FilesystemService);
    _apiProxy = module.get(ApiProxyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('S-AOA-1.1: each operation becomes MCP tool', () => {
    it('should generate tool named <appUrn>__<operationId>', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      const names = tools.map((t) => t.name);
      expect(names).toContain('ci-store_nextcloud__listUsers');
      expect(names).toContain('ci-store_nextcloud__createUser');
      expect(names).toContain('ci-store_nextcloud__getUser');
    });

    it('should generate fallback name from method+path when no operationId', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      // The delete operation has no operationId
      const deleteTool = tools.find((t) => t.name.includes('delete'));
      expect(deleteTool).toBeDefined();
      expect(deleteTool?.name).toMatch(/ci-store_nextcloud__delete_/);
    });
  });

  describe('S-AOA-1.2: input schema derived from parameters + body', () => {
    it('should include query parameters in input schema', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      const listTool = tools.find((t) => t.name.includes('listUsers'));
      expect((listTool?.inputSchema as any).properties.limit).toBeDefined();
    });

    it('should include path parameters as required', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      const getTool = tools.find((t) => t.name.includes('getUser'));
      expect((getTool?.inputSchema as any).required).toContain('id');
    });

    it('should include request body as body parameter', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      const createTool = tools.find((t) => t.name.includes('createUser'));
      expect((createTool?.inputSchema as any).properties.body).toBeDefined();
      expect((createTool?.inputSchema as any).required).toContain('body');
    });
  });

  describe('S-AOA-1.3: description from summary/description', () => {
    it('should use operation summary as tool description', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      const listTool = tools.find((t) => t.name.includes('listUsers'));
      expect(listTool?.description).toBe('List all users');
    });
  });

  describe('S-AOA-3: operations_filter', () => {
    it('S-AOA-3.1: should filter operations by pattern', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml', operations_filter: ['GET *'] },
      });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools.every((t) => t.name.includes('get') || t.name.includes('list'))).toBe(true);
    });

    it('S-AOA-3.2: should support <METHOD> <path-glob> syntax', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml', operations_filter: ['POST /api/*'] },
      });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toContain('createUser');
    });

    it('S-AOA-3.3: should expose all operations when filter is absent', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('S-AOA-4: getRawSpec', () => {
    it('S-AOA-4.1: should return spec as JSON string', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      // Pre-populate cache
      await service.generateTools(TEST_URN, config);
      const result = await service.getRawSpec(TEST_URN, config);
      expect(result.available).toBe(true);
      expect(JSON.parse(result.spec)).toHaveProperty('openapi');
    });

    it('S-AOA-4.2: should return available=false when no spec', async () => {
      const config = makeConfig({ enabled: false, specPath: null, config: null });
      const result = await service.getRawSpec(TEST_URN, config);
      expect(result.available).toBe(false);
    });
  });

  describe('returns empty when disabled', () => {
    it('should return empty array when openapi is disabled', async () => {
      const config = makeConfig({ enabled: false, specPath: null, config: null });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools).toEqual([]);
    });

    it('should return empty when spec file cannot be read', async () => {
      filesystem.readTextFile.mockResolvedValue(null);
      const config = makeConfig({
        enabled: true,
        specPath: '/nonexistent/spec.json',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const tools = await service.generateTools(TEST_URN, config);
      expect(tools).toEqual([]);
    });
  });

  describe('S-AOA-5: listToolInfo', () => {
    it('should list all tools with source info', async () => {
      filesystem.readTextFile.mockResolvedValue(SAMPLE_SPEC);
      const config = makeConfig({
        enabled: true,
        specPath: '/data/apps/ci-store/nextcloud/agents/openapi.yaml',
        config: { enabled: true, spec_path: 'agents/openapi.yaml' },
      });
      const toolInfos = await service.listToolInfo(TEST_URN, config);
      expect(toolInfos.length).toBeGreaterThanOrEqual(4);
      expect(toolInfos.every((t) => t.source === 'openapi')).toBe(true);
    });
  });
});
