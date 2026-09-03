import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentConfigService } from '../../agents/agent-config.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

const makeAppInfo = (agents?: unknown): AppInfo =>
  ({
    id: 'nextcloud',
    urn: TEST_URN,
    name: 'Nextcloud',
    available: true,
    agents,
  }) as unknown as AppInfo;

describe('AgentConfigService', () => {
  let service: AgentConfigService;
  let appFilesManager: MockProxy<AppFilesManager>;
  let filesystem: MockProxy<FilesystemService>;
  let envUtils: MockProxy<EnvUtils>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentConfigService,
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: EnvUtils, useValue: mock<EnvUtils>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = module.get(AgentConfigService);
    appFilesManager = module.get(AppFilesManager);
    filesystem = module.get(FilesystemService);
    envUtils = module.get(EnvUtils);

    appFilesManager.getAppPaths.mockReturnValue({
      appInstalledDir: '/data/apps/ci-store/nextcloud',
      appDataDir: '/data/app-data/ci-store/nextcloud',
    });
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/.env', content: '' });
    envUtils.envStringToMap.mockReturnValue(new Map());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('S-ACL-1.1: loads agents field from config.json', () => {
    it('should load skill config when agents.skill is true', async () => {
      filesystem.pathExists.mockImplementation(async (p: string) => p.includes('SKILL.md'));
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ skill: true }));
      expect(result?.skill.enabled).toBe(true);
    });

    it('should load openapi config when agents.openapi is set', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ openapi: { enabled: true, spec_path: 'agents/openapi.yaml' } }));
      expect(result?.openapi.enabled).toBe(true);
      expect(result?.openapi.specPath).toContain('openapi.yaml');
    });

    it('should load mcp config when agents.mcp is set', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ mcp: { enabled: true, transport: 'sse', url: 'http://localhost/mcp' } }));
      expect(result?.mcp.enabled).toBe(true);
    });
  });

  describe('S-ACL-1.2: auto-enable skill when SKILL.md exists', () => {
    it('should auto-enable skill when agents/SKILL.md exists but no agents field', async () => {
      filesystem.pathExists.mockImplementation(async (p: string) => p.includes('SKILL.md'));
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo(undefined));
      expect(result?.skill.enabled).toBe(true);
      expect(result?.openapi.enabled).toBe(false);
      expect(result?.mcp.enabled).toBe(false);
    });
  });

  describe('S-ACL-1.3: inline SKILL.md content', () => {
    it('should treat string agents.skill as inline content', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ skill: 'Inline skill content' }));
      expect(result?.skill.enabled).toBe(true);
      expect(result?.skill.content).toBe('Inline skill content');
      expect(result?.skill.inline).toBe(true);
    });
  });

  describe('S-ACL-1.4: null when no agents and no agents/ dir', () => {
    it('should return null when no agents field and no agents directory', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo(undefined));
      expect(result).toBeNull();
    });
  });

  describe('disabled configs', () => {
    it('should disable skill when agents.skill is false', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ skill: false }));
      expect(result?.skill.enabled).toBe(false);
    });

    it('should disable openapi when enabled is false', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ openapi: { enabled: false } }));
      expect(result?.openapi.enabled).toBe(false);
    });

    it('should disable mcp when enabled is false', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(TEST_URN, makeAppInfo({ mcp: { enabled: false } }));
      expect(result?.mcp.enabled).toBe(false);
    });
  });

  describe('hasAgentIntegration', () => {
    it('should return true when app has any agent layer', async () => {
      filesystem.pathExists.mockImplementation(async (p: string) => p.includes('SKILL.md'));
      const result = await service.hasAgentIntegration(TEST_URN, makeAppInfo({ skill: true }));
      expect(result).toBe(true);
    });

    it('should return false when no agent config', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.hasAgentIntegration(TEST_URN, makeAppInfo(undefined));
      expect(result).toBe(false);
    });
  });

  describe('marketplace top-level mcp block (#936)', () => {
    const MCP_URN = 'fetch-mcp:ci-marketplace' as AppUrn;

    const makeMcpAppInfo = (mcp: unknown, agents?: unknown): AppInfo =>
      ({ id: 'fetch-mcp', urn: MCP_URN, name: 'Fetch MCP', available: true, agents, mcp }) as unknown as AppInfo;

    it('normalizes a stdio listing: command string + args → command array, resolved container', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/data/apps/ci-marketplace/fetch-mcp/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'fetch-mcp', isMain: true, image: 'x' }] },
      });

      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch==2026.6.4'] }),
      );

      expect(result?.mcp.enabled).toBe(true);
      expect(result?.mcp.config?.transport).toBe('stdio');
      expect(result?.mcp.config?.command).toEqual(['uvx', 'mcp-server-fetch==2026.6.4']);
      expect(result?.mcp.config?.container).toBe('fetch-mcp_ci-marketplace-fetch-mcp-1');
    });

    it('expands ${VAR} placeholders in stdio args from app.env', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/x/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'filesystem-mcp', isMain: true, image: 'x' }] },
      });
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/.env', content: 'ALLOWED_PATH=/data\n' });
      envUtils.envStringToMap.mockReturnValue(new Map([['ALLOWED_PATH', '/data']]));

      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '${ALLOWED_PATH}'],
        }),
      );

      expect(result?.mcp.config?.command).toEqual(['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data']);
    });

    it('prefers explicit mcp.auth over inferred secret env', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({
          transport: 'http',
          command: '',
          args: [],
          url: 'http://ad4m:3001/mcp',
          auth: { type: 'bearer', token_env: 'ADMIN_CREDENTIAL' },
          env: [{ key: 'ADMIN_CREDENTIAL', required: true, secret: true }],
        }),
      );

      expect(result?.mcp.config?.auth).toEqual({ type: 'bearer', token_env: 'ADMIN_CREDENTIAL' });
    });

    it('infers bearer auth from required secret mcp.env when mcp.auth is absent', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({
          transport: 'http',
          command: '',
          args: [],
          url: 'http://ad4m:3001/mcp',
          env: [{ key: 'ADMIN_CREDENTIAL', required: true, secret: true }],
        }),
      );

      expect(result?.mcp.config?.auth).toEqual({ type: 'bearer', token_env: 'ADMIN_CREDENTIAL' });
    });

    it('infers host_docker launch for docker run stdio listings', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      envUtils.envStringToMap.mockReturnValue(new Map([['GITHUB_PERSONAL_ACCESS_TOKEN', 'ghp_test']]));

      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({
          transport: 'stdio',
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server:v0.6.0'],
        }),
      );

      expect(result?.mcp.config?.launch).toBe('host_docker');
      expect(result?.mcp.config?.container).toBeUndefined();
      expect(result?.mcp.config?.command?.[0]).toBe('docker');
    });

    it('honours explicit mcp.launch over inference', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/x/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'fetch-mcp', isMain: true, image: 'x' }] },
      });

      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({
          transport: 'stdio',
          launch: 'container_exec',
          command: 'docker',
          args: ['run', '-i', 'image:tag'],
        }),
      );

      expect(result?.mcp.config?.launch).toBe('container_exec');
      expect(result?.mcp.config?.container).toBe('fetch-mcp_ci-marketplace-fetch-mcp-1');
    });

    it('falls back to the app name when the compose file is unreadable', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      appFilesManager.getDockerComposeJson.mockRejectedValue(new Error('missing'));

      const result = await service.getAgentConfig(MCP_URN, makeMcpAppInfo({ transport: 'stdio', command: 'uvx', args: [] }));
      expect(result?.mcp.config?.container).toBe('fetch-mcp_ci-marketplace-fetch-mcp-1');
    });

    it('bridges an http listing with a pinned url over the http client', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({ transport: 'http', command: '', args: [], url: 'http://miro.example/mcp' }),
      );

      expect(result?.mcp.enabled).toBe(true);
      expect(result?.mcp.config?.transport).toBe('streamable-http');
      expect(result?.mcp.config?.url).toBe('http://miro.example/mcp');
    });

    it('does not bridge an http listing without a url (hosted/remote server)', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(MCP_URN, makeMcpAppInfo({ transport: 'http', command: '', args: [] }));
      expect(result).toBeNull();
    });

    it('prefers an explicit agents.mcp over the marketplace block', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentConfig(
        MCP_URN,
        makeMcpAppInfo({ transport: 'stdio', command: 'uvx', args: [] }, { mcp: { enabled: true, transport: 'sse', url: 'http://explicit/mcp' } }),
      );
      expect(result?.mcp.config?.transport).toBe('sse');
      expect(result?.mcp.config?.url).toBe('http://explicit/mcp');
    });

    it('counts a marketplace mcp block as agent integration', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      appFilesManager.getDockerComposeJson.mockResolvedValue({
        path: '/x/docker-compose.json',
        content: { schemaVersion: 2, services: [{ name: 'fetch-mcp', isMain: true, image: 'x' }] },
      });
      const result = await service.hasAgentIntegration(MCP_URN, makeMcpAppInfo({ transport: 'stdio', command: 'uvx', args: [] }));
      expect(result).toBe(true);
    });
  });

  describe('getAgentSummary', () => {
    it('should return summary with layer flags', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentSummary(
        TEST_URN,
        makeAppInfo({ skill: true, openapi: { enabled: true }, mcp: { enabled: true, transport: 'sse' } }),
      );
      expect(result).toEqual({ hasSkill: true, hasOpenApi: true, hasMcp: true });
    });

    it('should return null when no agent config', async () => {
      filesystem.pathExists.mockResolvedValue(false);
      const result = await service.getAgentSummary(TEST_URN, makeAppInfo(undefined));
      expect(result).toBeNull();
    });
  });
});
