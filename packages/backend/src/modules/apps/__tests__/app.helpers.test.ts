import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';

describe('AppHelpers', () => {
  let appHelpers: AppHelpers;
  let appFilesManager = mock<AppFilesManager>();
  let config = mock<ConfigurationService>();
  let filesystem = mock<FilesystemService>();
  let envUtils = mock<EnvUtils>();
  let deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
  let registrationService = mock<RegistrationService>();
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
    registrationService = moduleRef.get(RegistrationService);
  });

  describe('generateEnvFile', () => {
    const mockAppInfo: AppInfo = {
      id: 'test-app',
      urn: testAppUrn,
      name: 'Test App',
      author: 'Test Author',
      port: 9091,
      https: false,
      no_gui: false,
      available: true,
      exposable: true,
      dynamic_config: true,
      source: 'http://example.com',
      version: '1.0.0',
      categories: ['utilities'],
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

    beforeEach(() => {
      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '127.0.0.1',
          envFilePath: '/data/.env',
          rootFolderHost: '/opt/ci-hub',
          domain: 'example.com',
          ciHubApiKey: 'hub-api-key',
          userSettings: {
            appDataPath: '/opt/ci-hub',
            domain: 'example.com',
          },
        }),
      );

      envUtils.envStringToMap.mockReturnValue(new Map());
      envUtils.envMapToString.mockReturnValue('');
      appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/.env', content: '' });
      filesystem.readTextFile.mockResolvedValue('');
      registrationService.getDeviceId.mockResolvedValue('hub-device-id');
    });

    it('should throw an error if app is not found', async () => {
      // Arrange
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null as any);

      // Act & Assert
      await expect(appHelpers.generateEnvFile(testAppUrn, {})).rejects.toThrow(`App ${testAppUrn} not found`);
    });

    it('should set default env variables correctly', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(envMap.get('APP_PORT')).toBe('9091');
      expect(envMap.get('APP_ID')).toBe('test-app-test-store');
      expect(envMap.get('ROOT_FOLDER_HOST')).toBe('/opt/ci-hub');
      expect(envMap.get('APP_DATA_DIR')).toBe('/opt/ci-hub/app-data/test-store/test-app');
      expect(envMap.get('HUB_DEVICE_ID')).toBe('hub-device-id');
      expect(envMap.get('HUB_API_KEY')).toBe('hub-api-key');
    });

    it('should omit unavailable hub variables without failing env generation', async () => {
      const envMap = new Map<string, string>([
        ['HUB_DEVICE_ID', 'stale-device-id'],
        ['HUB_API_KEY', 'stale-api-key'],
      ]);
      envUtils.envStringToMap.mockReturnValue(envMap);
      registrationService.getDeviceId.mockRejectedValue(new Error('lookup failed'));
      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '127.0.0.1',
          envFilePath: '/data/.env',
          rootFolderHost: '/opt/ci-hub',
          domain: 'example.com',
          userSettings: {
            appDataPath: '/opt/ci-hub',
            domain: 'example.com',
          },
        }),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      expect(envMap.has('HUB_DEVICE_ID')).toBe(false);
      expect(envMap.has('HUB_API_KEY')).toBe(false);
    });

    it('should generate APP_DATA_DIR under ROOT_FOLDER_HOST/app-data (desktop storage contract)', async () => {
      // Simulates a desktop environment where ROOT_FOLDER_HOST is the app data dir
      const desktopRoot = '/Users/testuser/Library/Application Support/companion-hub';
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '0.0.0.0',
          envFilePath: '/data/.env',
          rootFolderHost: desktopRoot,
          domain: 'companionintelligence.com',
          userSettings: {
            appDataPath: desktopRoot,
            domain: 'companionintelligence.com',
          },
        }),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      // APP_DATA_DIR must be under ROOT_FOLDER_HOST/app-data so that the bind mount
      // ${ROOT_FOLDER_HOST}/app-data:/app-data aligns with container path /app-data
      expect(envMap.get('APP_DATA_DIR')).toBe(`${desktopRoot}/app-data/test-store/test-app`);
    });

    it('should align APP_DATA_DIR host path with container seeded data path', async () => {
      // Verifies the core storage invariant: the host path in APP_DATA_DIR
      // (used by launched app compose) shares the same suffix as the container
      // path used by AppStoreFilesManager to seed data.
      const rootHost = '/opt/ci-hub';
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '127.0.0.1',
          envFilePath: '/data/.env',
          rootFolderHost: rootHost,
          domain: 'example.com',
          userSettings: {
            appDataPath: rootHost,
            domain: 'example.com',
          },
        }),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      const appDataDir = envMap.get('APP_DATA_DIR');
      expect(appDataDir).toBeDefined();

      if (!appDataDir) {
        throw new Error('APP_DATA_DIR was not generated');
      }

      // The host path must be: ${ROOT_FOLDER_HOST}/app-data/{storeId}/{appName}
      // The container path is: /app-data/{storeId}/{appName}
      // When compose mounts ${ROOT_FOLDER_HOST}/app-data:/app-data, these align.
      expect(appDataDir).toBe(`${rootHost}/app-data/test-store/test-app`);
      expect(appDataDir.startsWith(rootHost)).toBe(true);
      // Verify the suffix after ROOT_FOLDER_HOST matches the container layout
      const suffix = appDataDir.slice(rootHost.length);
      expect(suffix).toBe('/app-data/test-store/test-app');
    });

    it('should handle form port override', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const customPort = 9090;

      // Act
      await appHelpers.generateEnvFile(testAppUrn, { port: customPort });

      // Assert
      expect(envMap.get('APP_PORT')).toBe(String(customPort));
    });

    it('should generate VAPID keys if configured', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const appInfoWithVapid = { ...mockAppInfo, generate_vapid_keys: true };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithVapid);

      const mockVapidKeys = {
        publicKey: 'test-public-key',
        privateKey: 'test-private-key',
      };
      envUtils.generateVapidKeys.mockReturnValue(mockVapidKeys);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(envMap.get('VAPID_PUBLIC_KEY')).toBe(mockVapidKeys.publicKey);
      expect(envMap.get('VAPID_PRIVATE_KEY')).toBe(mockVapidKeys.privateKey);
    });

    it('should reuse existing VAPID keys if available', async () => {
      // Arrange
      const existingEnvMap = new Map<string, string>([
        ['VAPID_PUBLIC_KEY', 'existing-public-key'],
        ['VAPID_PRIVATE_KEY', 'existing-private-key'],
      ]);
      const newEnvMap = new Map<string, string>();
      envUtils.envStringToMap
        .mockReturnValueOnce(newEnvMap) // For base env file
        .mockReturnValueOnce(existingEnvMap); // For app env file

      const appInfoWithVapid = { ...mockAppInfo, generate_vapid_keys: true };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithVapid);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(newEnvMap.get('VAPID_PUBLIC_KEY')).toBe('existing-public-key');
      expect(newEnvMap.get('VAPID_PRIVATE_KEY')).toBe('existing-private-key');
    });

    it('should set correct domain settings when app is exposed', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const domain = 'test.example.com';

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {
        exposed: true,
        domain,
      });

      // Assert
      expect(envMap.get('APP_EXPOSED')).toBe('true');
      // Legacy
      expect(envMap.get('APP_DOMAIN')).toBe(domain);
      expect(envMap.get('APP_HOST')).toBe(domain);
      expect(envMap.get('APP_PROTOCOL')).toBe('https');
      // Atomic
      expect(envMap.get('APP_SCHEME')).toBe('https');
      expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe(domain);
      expect(envMap.get('APP_PUBLIC_URL')).toBe(`https://${domain}`);
    });

    it('should write APP_PUBLIC_DOMAIN derived from APP_PUBLIC_HOSTNAME', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      await appHelpers.generateEnvFile(testAppUrn, {
        exposed: true,
        domain: 'myapp-device1-myorg.example.com',
      });

      // APP_PUBLIC_DOMAIN is everything after the first dot in the hostname
      expect(envMap.get('APP_PUBLIC_DOMAIN')).toBe('example.com');
    });

    it('should write APP_PUBLIC_DOMAIN correctly for multi-label domains', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      await appHelpers.generateEnvFile(testAppUrn, {
        exposed: true,
        domain: 'myapp-device1-myorg.my.lifescope.io',
      });

      // Must preserve all labels after the first dot — slice(-2) heuristic would give 'lifescope.io'
      expect(envMap.get('APP_PUBLIC_DOMAIN')).toBe('my.lifescope.io');
    });

    it('should set correct domain settings for local exposure', async () => {
      // Arrange
      const envMap = new Map<string, string>([['LOCAL_DOMAIN', 'local.test']]);
      envUtils.envStringToMap.mockReturnValue(envMap);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {
        exposedLocal: true,
        openPort: false,
      });

      // Assert
      const expectedDomain = 'test-app-test-store.example.com';
      // Legacy
      expect(envMap.get('APP_DOMAIN')).toBe(expectedDomain);
      expect(envMap.get('APP_HOST')).toBe(expectedDomain);
      expect(envMap.get('APP_PROTOCOL')).toBe('https');
      // Atomic
      expect(envMap.get('APP_SCHEME')).toBe('https');
      expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe(expectedDomain);
      expect(envMap.get('APP_PUBLIC_URL')).toBe(`https://${expectedDomain}`);
    });

    it('should set correct domain settings for internal access', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const port = 9091;

      // Act
      await appHelpers.generateEnvFile(testAppUrn, { port });

      // Assert
      // Legacy
      expect(envMap.get('APP_DOMAIN')).toBe('127.0.0.1:9091');
      expect(envMap.get('APP_HOST')).toBe('127.0.0.1');
      expect(envMap.get('APP_PROTOCOL')).toBe('http');
      // Atomic
      expect(envMap.get('APP_HOSTNAME')).toBe('127.0.0.1');
      expect(envMap.get('APP_INTERNAL_AUTHORITY')).toBe('127.0.0.1:9091');
      expect(envMap.get('APP_SCHEME')).toBe('http');
    });

    it('should throw error for required form fields', async () => {
      // Arrange
      const appInfoWithRequired = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'REQUIRED_VAR',
            label: 'Required Variable',
            required: true,
            type: 'text' as const,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithRequired);

      // Act & Assert
      await expect(appHelpers.generateEnvFile(testAppUrn, {})).rejects.toThrow('Variable Required Variable is required');
    });

    it('should handle random type form fields', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithRandom = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'RANDOM_VAR',
            type: 'random' as const,
            min: 16,
            label: 'Random Variable',
            required: false,
            options: undefined,
            tooltip: undefined,
            force_write: undefined,
            value: undefined,
            placeholder: undefined,
            encoding: undefined,
            max: undefined,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithRandom);

      const randomString = 'random-string';
      envUtils.createRandomString.mockReturnValue(randomString);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(envMap.get('RANDOM_VAR')).toBe(randomString);
      expect(envUtils.createRandomString).toHaveBeenCalledWith('RANDOM_VAR', 16, undefined);
    });

    it('should write the transformed env map to file', async () => {
      // Arrange
      const envMap = new Map<string, string>([['TEST_VAR', 'test-value']]);
      envUtils.envStringToMap.mockReturnValue(envMap);
      const transformedEnv = 'TEST_VAR=test-value';
      envUtils.envMapToString.mockReturnValue(transformedEnv);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(appFilesManager.writeAppEnv).toHaveBeenCalledWith(testAppUrn, transformedEnv);
    });

    it('should use default value when form field is not provided', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-text-value',
            required: false,
          },
          {
            env_variable: 'NUMBER_WITH_DEFAULT',
            label: 'Number Field',
            type: 'number' as const,
            default: 42,
            required: false,
          },
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(envMap.get('TEXT_WITH_DEFAULT')).toBe('default-text-value');
      expect(envMap.get('NUMBER_WITH_DEFAULT')).toBe('42');
      expect(envMap.get('BOOLEAN_WITH_DEFAULT')).toBe('true');
    });

    it('should use default value when form field is empty string', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-value',
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing empty string from form
      await appHelpers.generateEnvFile(testAppUrn, { TEXT_WITH_DEFAULT: '' });

      // Assert - should use default value, not empty string
      expect(envMap.get('TEXT_WITH_DEFAULT')).toBe('default-value');
    });

    it('should override default value when form provides a value', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-value',
            required: false,
          },
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing custom values from form
      await appHelpers.generateEnvFile(testAppUrn, {
        TEXT_WITH_DEFAULT: 'custom-value',
        BOOLEAN_WITH_DEFAULT: false,
      });

      // Assert - should use form values, not defaults
      expect(envMap.get('TEXT_WITH_DEFAULT')).toBe('custom-value');
      expect(envMap.get('BOOLEAN_WITH_DEFAULT')).toBe('false');
    });

    it('should handle number zero as valid form value and not use default', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'NUMBER_WITH_DEFAULT',
            label: 'Number Field',
            type: 'number' as const,
            default: 100,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing 0 as the value (which is falsy)
      await appHelpers.generateEnvFile(testAppUrn, { NUMBER_WITH_DEFAULT: 0 });

      // Assert - should use 0, not the default
      expect(envMap.get('NUMBER_WITH_DEFAULT')).toBe('0');
    });

    it('should handle false as valid form value and not use default', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing false as the value
      await appHelpers.generateEnvFile(testAppUrn, { BOOLEAN_WITH_DEFAULT: false });

      // Assert - should use false, not the default
      expect(envMap.get('BOOLEAN_WITH_DEFAULT')).toBe('false');
    });

    it('should correctly format APP_DOMAIN for subdomains', async () => {
      // Arrange
      const envMap = new Map<string, string>();
      envMap.set('DOMAIN', 'mydevice-myorg.example.com');
      envUtils.envStringToMap.mockReturnValue(envMap);

      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
        id: '123',
        slug: 'myorg',
        name: 'My Org',
        tunnelId: 'tunnel-id',
        tunnelToken: 'tunnel-token',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const form = {
        exposedLocal: true,
        localSubdomain: 'myapp',
      };

      // Act
      await appHelpers.generateEnvFile(testAppUrn, form);

      // Assert
      expect(envMap.get('APP_DOMAIN')).toBe('myapp-myorg.example.com');
      expect(envMap.get('APP_EXPOSED_DOMAIN')).toBe('myapp-myorg.example.com');
    });

    describe('device slug subdomain construction', () => {
      it('should include device slug when hubSubdomain has a different device slug', async () => {
        // hubSubdomain = hub-test1-myorg → deviceSlug = test1
        // expected subdomain: element-test1-myorg.example.com
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
          id: '123',
          slug: 'myorg',
          name: 'My Org',
          hubSubdomain: 'hub-test1-myorg',
          tunnelId: 'tunnel-id',
          tunnelToken: 'tunnel-token',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          exposedLocal: true,
          localSubdomain: 'element',
        });

        expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe('element-test1-myorg.example.com');
        expect(envMap.get('APP_PUBLIC_URL')).toBe('https://element-test1-myorg.example.com');
      });

      it('should omit device slug when hubSubdomain is null', async () => {
        // No hubSubdomain → fallback: element-myorg.example.com
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
          id: '123',
          slug: 'myorg',
          name: 'My Org',
          hubSubdomain: null,
          tunnelId: 'tunnel-id',
          tunnelToken: 'tunnel-token',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          exposedLocal: true,
          localSubdomain: 'element',
        });

        expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe('element-myorg.example.com');
      });

      it('should omit device slug when it equals org slug', async () => {
        // hubSubdomain = hub-myorg-myorg → deviceSlug = myorg (same as org slug)
        // expected: element-myorg.example.com (no duplication)
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue({
          id: '123',
          slug: 'myorg',
          name: 'My Org',
          hubSubdomain: 'hub-myorg-myorg',
          tunnelId: 'tunnel-id',
          tunnelToken: 'tunnel-token',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          exposedLocal: true,
          localSubdomain: 'element',
        });

        expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe('element-myorg.example.com');
      });
    });

    describe('R-ENV: MCP env injection for agent harness apps', () => {
      it('R-ENV-1/2/3: should inject HUB_URL, HUB_MCP_URL, and HUB_MCP_MESSAGES_URL when hub_integration.mcp_client is true', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_URL')).toBe('http://ci-os-hub:3000');
        expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-os-hub:3000/api/mcp/sse');
        expect(envMap.get('HUB_MCP_MESSAGES_URL')).toBe('http://ci-os-hub:3000/api/mcp/messages');
      });

      it('R-ENV-1: should use HUB_CONTAINER_NAME env var when set', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        process.env.HUB_CONTAINER_NAME = 'my-custom-hub';
        try {
          await appHelpers.generateEnvFile(testAppUrn, {});
          expect(envMap.get('HUB_URL')).toBe('http://my-custom-hub:3000');
          expect(envMap.get('HUB_MCP_URL')).toBe('http://my-custom-hub:3000/api/mcp/sse');
        } finally {
          delete process.env.HUB_CONTAINER_NAME;
        }
      });

      it('R-ENV-1: should use API_PORT env var for Hub URL', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        process.env.API_PORT = '5002';
        try {
          await appHelpers.generateEnvFile(testAppUrn, {});
          expect(envMap.get('HUB_URL')).toBe('http://ci-os-hub:5002');
          expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-os-hub:5002/api/mcp/sse');
          expect(envMap.get('HUB_MCP_MESSAGES_URL')).toBe('http://ci-os-hub:5002/api/mcp/messages');
        } finally {
          delete process.env.API_PORT;
        }
      });

      it('R-ENV: should inject HUB_MCP_API_KEY when MCP_API_KEY is set', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        process.env.MCP_API_KEY = 'test-mcp-key-12345';
        try {
          await appHelpers.generateEnvFile(testAppUrn, {});
          expect(envMap.get('HUB_MCP_API_KEY')).toBe('test-mcp-key-12345');
        } finally {
          delete process.env.MCP_API_KEY;
        }
      });

      it('R-ENV: should NOT inject HUB_MCP_API_KEY when MCP_API_KEY is not set', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        delete process.env.MCP_API_KEY;
        await appHelpers.generateEnvFile(testAppUrn, {});
        expect(envMap.has('HUB_MCP_API_KEY')).toBe(false);
      });

      it('R-ENV-4: should generate a HUB_WAKE_SECRET', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        const secret = envMap.get('HUB_WAKE_SECRET');
        expect(secret).toBeDefined();
        expect(secret).toHaveLength(64); // 32 bytes hex = 64 chars
      });

      it('R-ENV-4: should preserve existing HUB_WAKE_SECRET on restart/update', async () => {
        const envMap = new Map<string, string>();
        const existingEnv = new Map<string, string>([['HUB_WAKE_SECRET', 'existing-secret-value']]);
        envUtils.envStringToMap.mockReturnValueOnce(envMap).mockReturnValueOnce(existingEnv);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_WAKE_SECRET')).toBe('existing-secret-value');
      });

      it('R-ENV-5: should NOT inject MCP vars when hub_integration is not set', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('HUB_MCP_URL')).toBe(false);
        expect(envMap.has('HUB_MCP_MESSAGES_URL')).toBe(false);
        expect(envMap.has('HUB_WAKE_SECRET')).toBe(false);
      });

      it('R-ENV-5: should NOT inject MCP vars when mcp_client is false', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const nonAgentApp = { ...mockAppInfo, hub_integration: { mcp_client: false, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(nonAgentApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('HUB_MCP_URL')).toBe(false);
        expect(envMap.has('HUB_WAKE_SECRET')).toBe(false);
      });
    });
  });
});
