import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';

describe('AppHelpers Reproduction', () => {
  let appHelpers: AppHelpers;
  let appFilesManager = mock<AppFilesManager>();
  let config = mock<ConfigurationService>();
  let filesystem = mock<FilesystemService>();
  let envUtils = mock<EnvUtils>();
  let deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
  const testAppUrn: AppUrn = createAppUrn('test-app', 'test-store');

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [AppHelpers],
    })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    config = moduleRef.get(ConfigurationService);
    filesystem = moduleRef.get(FilesystemService);
    envUtils = moduleRef.get(EnvUtils);
    deviceRegistrationRepository = moduleRef.get(DeviceRegistrationRepository);

    // Default mock setup that mirrors app.helpers.test.ts
    // Use the real EnvUtils for map operations to ensure we test the logic correctly
    const realEnvUtils = new EnvUtils();
    envUtils.envStringToMap.mockImplementation(realEnvUtils.envStringToMap);
    envUtils.envMapToString.mockImplementation(realEnvUtils.envMapToString);
    envUtils.createRandomString.mockImplementation(realEnvUtils.createRandomString);
  });

  it('should set APP_URL and correctly format subdomain with org slug', async () => {
    // Arrange
    const mockAppInfo: AppInfo = {
      id: 'test-app',
      urn: testAppUrn,
      name: 'Test App',
      author: 'Test Author',
      port: 8000,
      https: false,
      no_gui: false,
      available: true,
      exposable: true,
      dynamic_config: true,
      source: 'http://example.com',
      version: '1.0.0',
      categories: ['test-store'],
      description: 'Test description',
      short_desc: 'Test short description',
      website: 'http://example.com',
      supported_architectures: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      deprecated: false,
      cihub_app_version: 1,
      force_expose: false,
      force_pull: false,
      generate_vapid_keys: false,
      form_fields: [],
    };

    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        userSettings: {
          appDataPath: '/opt/ci-hub',
          domain: 'example.com',
          localDomain: 'test.local',
        },
      }),
    );

    appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/.env', content: '' });
    filesystem.readTextFile.mockResolvedValue('');

    // Mock Device Registration to return an org with a slug
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(
      fromPartial({
        id: 'org-id',
        slug: 'test-org-slug',
      }),
    );

    // Mock appFilesManager.writeAppEnv to capture the output
    let generatedEnvContent = '';
    appFilesManager.writeAppEnv.mockImplementation(async (_urn, content) => {
      generatedEnvContent = content;
    });

    // Act
    await appHelpers.generateEnvFile(testAppUrn, {
      exposedLocal: true, // This triggers the external exposure logic
      exposed: false,
    });

    // Assert
    expect(generatedEnvContent).toContain('APP_URL=https://test-app-test-store-test-org-slug.example.com');
    // Also check APP_DOMAIN
    expect(generatedEnvContent).toContain('APP_DOMAIN=test-app-test-store-test-org-slug.example.com');

    // Verify correct subdomain construction
    expect(generatedEnvContent).toContain('APP_EXPOSED_DOMAIN=test-app-test-store-test-org-slug.example.com');

    // Verify new atomic variables
    expect(generatedEnvContent).toContain('APP_PUBLIC_HOSTNAME=test-app-test-store-test-org-slug.example.com');
    expect(generatedEnvContent).toContain('APP_PUBLIC_URL=https://test-app-test-store-test-org-slug.example.com');
    expect(generatedEnvContent).toContain('APP_SCHEME=https');
  });

  it('serializes an injected OIDC issuer as exactly one clean env line (real EnvUtils)', async () => {
    // Arrange: an opted-in app (hub_integration.oidc) on a paired Hub.
    const mockAppInfo: AppInfo = {
      id: 'ci-planning',
      urn: testAppUrn,
      name: 'Companion Planning',
      author: 'CI',
      port: 8000,
      https: false,
      no_gui: false,
      available: true,
      exposable: true,
      dynamic_config: true,
      source: 'https://github.com/companionintelligence/Companion-Planning',
      version: '1.0.0',
      categories: ['utilities'],
      description: 'Test description',
      short_desc: 'Test short description',
      website: 'http://example.com',
      supported_architectures: [],
      created_at: 0,
      updated_at: 0,
      deprecated: false,
      cihub_app_version: 2,
      force_expose: false,
      force_pull: false,
      generate_vapid_keys: false,
      form_fields: [],
      hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth' } },
    };

    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '127.0.0.1',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        ciCloudUrl: 'https://hub.ci.computer',
        userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com', localDomain: 'test.local' },
      }),
    );

    appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/.env', content: '' });
    filesystem.readTextFile.mockResolvedValue('');
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(fromPartial({ id: 'org-id', slug: 'test-org-slug' }));

    let generatedEnvContent = '';
    appFilesManager.writeAppEnv.mockImplementation(async (_urn, content) => {
      generatedEnvContent = content;
    });

    // Act
    await appHelpers.generateEnvFile(testAppUrn, {});

    // Assert: the issuer is present exactly once, as a single well-formed line
    // (guards against the value corrupting the serialized env file).
    const issuerLines = generatedEnvContent.split('\n').filter((line) => line.startsWith('CI_OIDC_ISSUER='));
    expect(issuerLines).toEqual(['CI_OIDC_ISSUER=https://hub.ci.computer/api/auth']);
  });
});
