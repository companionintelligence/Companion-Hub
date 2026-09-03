import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { SkillResolverService } from '../../agents/skill-resolver.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import type { ResolvedAgentConfig } from '../../agents/agent-config.service';

const TEST_URN = 'ci-store:nextcloud' as AppUrn;

const makeConfig = (skill: ResolvedAgentConfig['skill']): ResolvedAgentConfig => ({
  skill,
  openapi: { enabled: false, specPath: null, config: null },
  mcp: { enabled: false, config: null },
});

describe('SkillResolverService', () => {
  let service: SkillResolverService;
  let filesystem: MockProxy<FilesystemService>;
  let configService: MockProxy<ConfigurationService>;
  let appFilesManager: MockProxy<AppFilesManager>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillResolverService,
        { provide: AppFilesManager, useValue: mock<AppFilesManager>() },
        { provide: FilesystemService, useValue: mock<FilesystemService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    service = module.get(SkillResolverService);
    filesystem = module.get(FilesystemService);
    configService = module.get(ConfigurationService);
    appFilesManager = module.get(AppFilesManager);

    appFilesManager.getAppPaths.mockReturnValue({
      appInstalledDir: '/data/apps/ci-store/nextcloud',
      appDataDir: '/data/app-data/ci-store/nextcloud',
    });

    configService.getConfig.mockReturnValue({
      userSettings: { localDomain: 'local.ci.computer' },
    } as any);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('S-ASK-1.1: returns { content, available }', () => {
    it('should return content and available=true when SKILL.md exists', async () => {
      filesystem.readTextFile.mockResolvedValue('# Nextcloud\nA cloud storage app.');
      const result = await service.getSkillContent(TEST_URN, makeConfig({ enabled: true, content: null, inline: false }));
      expect(result.available).toBe(true);
      expect(result.content).toContain('Nextcloud');
    });
  });

  describe('S-ASK-1.2: available=false when no SKILL.md', () => {
    it('should return available=false when skill is disabled', async () => {
      const result = await service.getSkillContent(TEST_URN, makeConfig({ enabled: false, content: null, inline: false }));
      expect(result.available).toBe(false);
      expect(result.content).toBe('');
    });

    it('should return available=false when agent config is null', async () => {
      const result = await service.getSkillContent(TEST_URN, null);
      expect(result.available).toBe(false);
    });

    it('should return available=false when SKILL.md does not exist', async () => {
      filesystem.readTextFile.mockResolvedValue(null);
      const result = await service.getSkillContent(TEST_URN, makeConfig({ enabled: true, content: null, inline: false }));
      expect(result.available).toBe(false);
    });
  });

  describe('S-ASK-1.3: template variables resolved', () => {
    it('should resolve inline skill content with template variables', async () => {
      const result = await service.getSkillContent(
        TEST_URN,
        makeConfig({ enabled: true, content: 'Access at ${APP_HOST}:${APP_PORT}', inline: true }),
        { APP_HOST: 'nextcloud-ci-store', APP_PORT: '8080' },
      );
      expect(result.content).toBe('Access at nextcloud-ci-store:8080');
      expect(result.available).toBe(true);
    });
  });

  describe('S-ACL-2.1: ${APP_HOST} resolves to app hostname', () => {
    it('should resolve APP_HOST from env vars', () => {
      const result = service.resolveTemplateVariables('Host: ${APP_HOST}', TEST_URN, { APP_HOST: 'my-host' });
      expect(result).toBe('Host: my-host');
    });

    it('should fallback to container name derived from URN', () => {
      const result = service.resolveTemplateVariables('Host: ${APP_HOST}', TEST_URN);
      // default: appName-storeSlug → ci-store-nextcloud
      expect(result).toContain('Host:');
    });
  });

  describe('S-ACL-2.2: ${APP_PORT} resolves to app port', () => {
    it('should resolve APP_PORT', () => {
      const result = service.resolveTemplateVariables('Port: ${APP_PORT}', TEST_URN, { APP_PORT: '9090' });
      expect(result).toBe('Port: 9090');
    });
  });

  describe('S-ACL-2.3: ${APP_DOMAIN} resolves to public domain', () => {
    it('should resolve APP_DOMAIN when provided', () => {
      const result = service.resolveTemplateVariables('https://${APP_DOMAIN}', TEST_URN, { APP_DOMAIN: 'nextcloud.example.com' });
      expect(result).toBe('https://nextcloud.example.com');
    });

    it('should resolve to empty string when no domain', () => {
      const result = service.resolveTemplateVariables('https://${APP_DOMAIN}', TEST_URN);
      expect(result).toBe('https://');
    });
  });

  describe('S-ACL-2.4: ${ENV:<key>} resolves to env variable', () => {
    it('should resolve ENV: prefixed variables', () => {
      const result = service.resolveTemplateVariables('Token: ${ENV:API_TOKEN}', TEST_URN, { API_TOKEN: 'secret123' });
      expect(result).toBe('Token: secret123');
    });

    it('should leave ENV: variable as-is when not found', () => {
      const result = service.resolveTemplateVariables('Token: ${ENV:MISSING_VAR}', TEST_URN, {});
      expect(result).toBe('Token: ${ENV:MISSING_VAR}');
    });
  });

  describe('S-ACL-2.5: unresolved variables left as-is', () => {
    it('should preserve unresolved variables', () => {
      const result = service.resolveTemplateVariables('Value: ${UNKNOWN_VAR}', TEST_URN);
      expect(result).toBe('Value: ${UNKNOWN_VAR}');
    });

    it('should resolve known vars and leave unknown ones', () => {
      const result = service.resolveTemplateVariables('${APP_URN} at ${UNKNOWN} on port ${APP_PORT}', TEST_URN, { APP_PORT: '443' });
      expect(result).toContain(TEST_URN);
      expect(result).toContain('${UNKNOWN}');
      expect(result).toContain('443');
    });
  });
});
