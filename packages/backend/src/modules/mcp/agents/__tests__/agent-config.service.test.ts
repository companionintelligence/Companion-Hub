import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AgentConfigService } from '../../agents/agent-config.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentConfigService,
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = module.get(AgentConfigService);
    appFilesManager = module.get(AppFilesManager);
    filesystem = module.get(FilesystemService);

    appFilesManager.getAppPaths.mockReturnValue({
      appInstalledDir: '/data/apps/ci-store/nextcloud',
      appDataDir: '/data/app-data/ci-store/nextcloud',
    });
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
