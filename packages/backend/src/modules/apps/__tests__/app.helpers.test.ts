import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@ci-hub/common/schemas';
import { type AppUrn, buildOriginServerName } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers, isPlatformIdentityUrlFor } from '../app.helpers';
import { AppsRepository } from '../apps.repository';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { InferenceEnvResolver } from '../../inference/inference-env-resolver';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { MemoryConnectionService } from '@/modules/memory-connect/memory-connection.service';
import { ForwardAuthSecretResolver } from '@/modules/auth/forward-auth-secret.resolver';
import { ProxyTrustService } from '@/modules/network/proxy-trust.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';

// APP_DATA_DIR is a host path built with Node's platform-aware path.join, so it uses
// `\` on Windows. Normalize to POSIX separators before asserting so these path tests
// stay stable cross-platform (they encode a Linux/container bind-mount contract).
const toPosix = (p: string) => p.replace(/\\/g, '/');

describe('AppHelpers', () => {
  let appHelpers: AppHelpers;
  let moduleRefForHelpers: ModuleRef;
  let appFilesManager = mock<AppFilesManager>();
  let config = mock<ConfigurationService>();
  let filesystem = mock<FilesystemService>();
  let envUtils = mock<EnvUtils>();
  let deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
  let registrationService = mock<RegistrationService>();
  let inferenceEnv = mock<InferenceEnvResolver>();
  let apiKeys: MockProxy<ApiKeyService>;
  let memoryConnection: MockProxy<MemoryConnectionService>;
  let portalClient: MockProxy<PortalClientService>;
  let appsRepository: MockProxy<AppsRepository>;
  const testAppUrn: AppUrn = createAppUrn('test-app', 'test-store');
  // First-party Memory is known by where it was installed from, never by its manifest's `id`/`source`.
  const OFFICIAL_MEMORY_URN: AppUrn = createAppUrn('ci-memory', 'ci-marketplace');
  const SOURCE_BUILD_URN: AppUrn = createAppUrn('ci-server', '_user');

  beforeEach(async () => {
    // Clear call history between tests: useMocker reuses mock instances, so a
    // prior test's calls (e.g. markManual) would otherwise leak into assertions.
    vi.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [AppHelpers],
    })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    // The real ModuleRef Nest injected into the helper — the lazy lookups
    // (`resolveTrustedProxyCidrs`) go through it, so tests spy on this one.
    moduleRefForHelpers = (appHelpers as unknown as { moduleRef: ModuleRef }).moduleRef;
    appFilesManager = moduleRef.get(AppFilesManager);
    config = moduleRef.get(ConfigurationService);
    filesystem = moduleRef.get(FilesystemService);
    envUtils = moduleRef.get(EnvUtils);
    deviceRegistrationRepository = moduleRef.get(DeviceRegistrationRepository);
    registrationService = moduleRef.get(RegistrationService);
    inferenceEnv = moduleRef.get(InferenceEnvResolver);
    apiKeys = moduleRef.get(ApiKeyService);
    config.getInferencePreferences.mockReturnValue({
      preferredBackend: 'ollama',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
    });
    memoryConnection = moduleRef.get(MemoryConnectionService);
    portalClient = moduleRef.get(PortalClientService);
    portalClient.fetchMapsConfig.mockResolvedValue(null);
    appsRepository = moduleRef.get(AppsRepository);
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
      // useMocker reuses mock instances across tests and clearAllMocks does not
      // drop implementations, so a bound custom domain from one test would
      // otherwise rewrite the public hostname of every test after it.
      appsRepository.getAppCustomDomain.mockResolvedValue(null);
      deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(undefined);
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

    it("never passes the Hub's own master secrets through to an app container", async () => {
      // The app env is seeded from the Hub's .env and handed to the container via
      // env_file. An operator who pins CI_HUB_FORWARD_AUTH_SECRET there (as
      // .env.example invites) would otherwise hand every installed app — third-party
      // store apps included — the secret that signs the connect exchange/rotate/revoke
      // calls, letting a hostile app mint or steal another app's memory key.
      envUtils.envStringToMap.mockReturnValue(
        new Map([
          ['CI_HUB_FORWARD_AUTH_SECRET', 'hub-forward-auth-secret'],
          ['JWT_SECRET', 'hub-jwt-secret'],
          ['MCP_API_KEY', 'hub-mcp-api-key'],
          ['DOMAIN', 'example.com'],
        ]),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;

      expect(written.has('CI_HUB_FORWARD_AUTH_SECRET')).toBe(false);
      expect(written.has('JWT_SECRET')).toBe(false);
      expect(written.has('MCP_API_KEY')).toBe(false);
      // Non-secret base config still reaches the app.
      expect(written.get('DOMAIN')).toBe('example.com');
    });

    it('SECURITY: inherits ONLY the allowlisted Hub .env keys — the broker password and anything else in that file stay put', async () => {
      // The Hub's .env is the seed for every app.env, and it holds every Hub
      // secret. A denylist covered four of them; the RabbitMQ password was not
      // on it, so every installed app could publish lifecycle commands to the
      // Hub's own queue. Nor is the leak limited to what we can name today:
      // whatever an installer or operator adds to that file must not flow.
      envUtils.envStringToMap.mockReturnValue(
        new Map([
          ['RABBITMQ_HOST', 'ci-hub-queue'],
          ['RABBITMQ_USERNAME', 'companion'],
          ['RABBITMQ_PASSWORD', 'broker-password'],
          ['POSTGRES_PASSWORD', 'db-password'],
          ['POSTGRES_HOST', 'ci-hub-db'],
          ['HUB_API_KEY', 'portal-device-key'],
          ['NODE_AUTH_TOKEN', 'registry-token'],
          ['SOME_FUTURE_HUB_SECRET', 'whatever-lands-here-next'],
          // …and the documented, non-secret identity an app may rely on.
          ['DOMAIN', 'example.com'],
          ['LOCAL_DOMAIN', 'hub.local'],
          ['ROOT_FOLDER_HOST', '/opt/hub'],
          ['TZ', 'Europe/Berlin'],
          ['CI_HUB_VERSION', '0.2.99'],
        ]),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;

      for (const withheld of [
        'RABBITMQ_HOST',
        'RABBITMQ_USERNAME',
        'RABBITMQ_PASSWORD',
        'POSTGRES_PASSWORD',
        'POSTGRES_HOST',
        'HUB_API_KEY',
        'NODE_AUTH_TOKEN',
        'SOME_FUTURE_HUB_SECRET',
      ]) {
        expect(written.has(withheld), `${withheld} must not reach app.env`).toBe(false);
      }
      expect(written.get('DOMAIN')).toBe('example.com');
      expect(written.get('LOCAL_DOMAIN')).toBe('hub.local');
      expect(written.get('TZ')).toBe('Europe/Berlin');
      expect(written.get('CI_HUB_VERSION')).toBe('0.2.99');
    });

    it('still honours the documented operator pins from the Hub .env', async () => {
      // These are the values `setUnlessOperatorSet` and the maps-key gate read
      // back from the seed on purpose; the allowlist must not silently turn
      // that operator override off.
      envUtils.envStringToMap.mockReturnValue(
        new Map([
          ['CI_CLOUD_URL', 'https://portal.example'],
          ['GOOGLE_MAPS_KEY', 'operator-maps-key'],
          ['PORTAL_OIDC_ISSUER', 'https://portal.example'],
        ]),
      );

      await appHelpers.generateEnvFile(testAppUrn, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;

      expect(written.get('CI_CLOUD_URL')).toBe('https://portal.example');
      expect(written.get('PORTAL_OIDC_ISSUER')).toBe('https://portal.example');
      // The operator's Google Maps key is not every app's: only first-party Memory's.
      expect(written.has('GOOGLE_MAPS_KEY')).toBe(false);
    });

    it("keeps the operator's maps key for first-party Memory, over Portal's", async () => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });
      envUtils.envStringToMap.mockReturnValue(new Map([['GOOGLE_MAPS_KEY', 'operator-maps-key']]));

      // The URN env generation is called with decides provenance, as `getInstalledAppInfo` stamps it.
      await appHelpers.generateEnvFile(OFFICIAL_MEMORY_URN, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
      expect(written.get('GOOGLE_MAPS_KEY')).toBe('operator-maps-key');
    });

    it('SECURITY: a manifest cannot name a Hub-only secret as its Memory env and inherit it', async () => {
      envUtils.envStringToMap.mockReturnValue(
        new Map([
          ['CI_HUB_FORWARD_AUTH_SECRET', 'hub-wide-secret'],
          ['JWT_SECRET', 'hub-jwt-secret'],
        ]),
      );
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: { memory: { url_env: 'CI_HUB_FORWARD_AUTH_SECRET', token_env: 'JWT_SECRET' } },
      } as AppInfo);

      await appHelpers.generateEnvFile(testAppUrn, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
      expect(written.has('CI_HUB_FORWARD_AUTH_SECRET')).toBe(false);
      expect(written.has('JWT_SECRET')).toBe(false);
    });

    /*
     * The Hub's .env holds secrets no denylist names (`.env.example` documents TAILSCALE_AUTHKEY and
     * NODE_AUTH_TOKEN), so only an official-store app may pin its Memory env from it.
     */
    it('SECURITY: a third-party app cannot name another Hub .env key as its Memory env and inherit it', async () => {
      envUtils.envStringToMap.mockReturnValue(
        new Map([
          ['TAILSCALE_AUTHKEY', 'tskey-auth-secret'],
          ['NODE_AUTH_TOKEN', 'registry-token'],
        ]),
      );
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: { memory: { url_env: 'NODE_AUTH_TOKEN', token_env: 'TAILSCALE_AUTHKEY' } },
      } as AppInfo);

      await appHelpers.generateEnvFile(testAppUrn, {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
      expect(written.has('TAILSCALE_AUTHKEY')).toBe(false);
      expect(written.has('NODE_AUTH_TOKEN')).toBe(false);
    });

    it('keeps an operator-pinned Memory env for an official-store app', async () => {
      envUtils.envStringToMap.mockReturnValue(new Map([['CI_SERVER_TOKEN', 'operator-pinned-token']]));
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } },
      } as AppInfo);

      await appHelpers.generateEnvFile(createAppUrn('test-app', 'ci-marketplace'), {});

      const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
      expect(written.get('CI_SERVER_TOKEN')).toBe('operator-pinned-token');
    });

    describe('the Cloudflare tunnel token', () => {
      beforeEach(() => {
        envUtils.envStringToMap.mockReturnValue(new Map());
        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(
          fromPartial({ tunnelToken: 'tunnel-token', tunnelId: 'tunnel-id' }),
        );
      });

      it('goes to the official store cloudflared', async () => {
        await appHelpers.generateEnvFile(createAppUrn('cloudflared', 'ci-marketplace'), {});

        const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
        expect(written.get('TUNNEL_TOKEN')).toBe('tunnel-token');
        expect(written.get('TUNNEL_ID')).toBe('tunnel-id');
      });

      it('SECURITY: does not go to an app named cloudflared from another store', async () => {
        await appHelpers.generateEnvFile(createAppUrn('cloudflared', 'test-store'), {});

        const written = envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;
        expect(written.has('TUNNEL_TOKEN')).toBe(false);
        expect(written.has('TUNNEL_ID')).toBe(false);
      });
    });

    describe('Companion Memory credential injection', () => {
      // A consumer app declaring the env vars it reads its memory URL + key from.
      const memoryConsumerApp: AppInfo = {
        ...mockAppInfo,
        hub_integration: { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } },
      };

      it('hands an app the URL shape its manifest declares (url_style: api_base)', async () => {
        // CI-Import-Tools treats CI_SERVER_URL as the API BASE and appends
        // server-local paths (`<base>/graphql`, `<base>/v1/...`). The provider's
        // gateway proxies the API only under `/api/`, so a bare origin would send
        // every push to the SPA — silently, with a 200 and HTML.
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          hub_integration: {
            memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN', url_style: 'api_base' },
          },
        } as AppInfo);
        memoryConnection.getInjectableCreds.mockResolvedValue({ url: 'http://gateway:8642', token: 'brokered-key' });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_SERVER_URL')).toBe('http://gateway:8642/api');
        expect(envMap.get('CI_SERVER_TOKEN')).toBe('brokered-key');
      });

      it('injects brokered creds for a connected app and does not mark it manual', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(memoryConsumerApp);
        memoryConnection.getInjectableCreds.mockResolvedValue({ url: 'http://gateway:8642', token: 'brokered-key' });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_APP_URN')).toBe(testAppUrn);
        expect(envMap.get('CI_SERVER_URL')).toBe('http://gateway:8642');
        expect(envMap.get('CI_SERVER_TOKEN')).toBe('brokered-key');
        expect(memoryConnection.markManual).not.toHaveBeenCalled();
      });

      it('prefers the brokered connection even when the token env already carries a (default) value', async () => {
        // Regression: a manifest default for token_env must NOT pin a genuinely
        // connected app to `manual` (which would stop re-injecting the real creds).
        const envMap = new Map<string, string>([['CI_SERVER_TOKEN', 'manifest-default']]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(memoryConsumerApp);
        memoryConnection.getInjectableCreds.mockResolvedValue({ url: 'http://gateway:8642', token: 'brokered-key' });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_SERVER_TOKEN')).toBe('brokered-key');
        expect(memoryConnection.markManual).not.toHaveBeenCalled();
      });

      it('marks manual when the operator set a token and there is no brokered connection', async () => {
        // An operator pin in the Hub's .env reaches only an official-store app.
        const officialUrn = createAppUrn('test-app', 'ci-marketplace');
        const envMap = new Map<string, string>([['CI_SERVER_TOKEN', 'operator-set']]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(memoryConsumerApp);
        memoryConnection.getInjectableCreds.mockResolvedValue(null);

        await appHelpers.generateEnvFile(officialUrn, {});

        // markManual is idempotent at the service layer; env-gen just delegates.
        expect(memoryConnection.markManual).toHaveBeenCalledWith(officialUrn);
        // The operator's own value is left untouched.
        expect(envMap.get('CI_SERVER_TOKEN')).toBe('operator-set');
      });

      it('neither injects nor marks manual when there is no token and no brokered connection', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(memoryConsumerApp);
        memoryConnection.getInjectableCreds.mockResolvedValue(null);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('CI_SERVER_TOKEN')).toBe(false);
        expect(memoryConnection.markManual).not.toHaveBeenCalled();
      });
    });

    describe('custom domain binding', () => {
      /** What `buildPublicWebIdentity` composes for this app, and Companion Portal's join key. */
      const PLATFORM_HOSTNAME = 'test-app-test-store-core2-acme.example.com';
      const PLATFORM_URL = `https://${PLATFORM_HOSTNAME}`;
      const CUSTOM_URL = 'https://comfy.acme.com';

      const exposedForm = { exposedLocal: true, openPort: false } as const;

      beforeEach(() => {
        // The real parser, so the app's PREVIOUS env is read as an env file
        // rather than as the same empty map the Hub seed produces — the
        // carry-forward rules for base URLs only exist against a real one.
        const realEnvUtils = new EnvUtils();
        envUtils.envStringToMap.mockImplementation(realEnvUtils.envStringToMap);
        envUtils.envMapToString.mockImplementation(realEnvUtils.envMapToString);

        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(
          fromPartial({ id: 'org-1', slug: 'acme', hubSubdomain: 'core2-acme' }),
        );
      });

      const bind = (customDomain: string | null) => {
        appsRepository.getAppCustomDomain.mockResolvedValue(customDomain);
      };

      /** The env map actually written out for the app. */
      const written = () => envUtils.envMapToString.mock.calls.at(-1)?.[0] as Map<string, string>;

      it('emits the platform hostname when nothing is bound', async () => {
        bind(null);

        await appHelpers.generateEnvFile(testAppUrn, exposedForm);

        expect(written().get('APP_PUBLIC_HOSTNAME')).toBe(PLATFORM_HOSTNAME);
        expect(written().get('APP_PUBLIC_URL')).toBe(PLATFORM_URL);
      });

      it('emits the custom hostname on every public identity var once bound', async () => {
        // The cloned tunnel rule keeps the platform Host header, so the app cannot
        // learn the customer's hostname from the request — these vars are the only
        // way it ever finds out, and `redirect_uri` is built from them.
        bind('comfy.acme.com');

        await appHelpers.generateEnvFile(testAppUrn, exposedForm);

        const env = written();
        expect(env.get('APP_PUBLIC_HOSTNAME')).toBe('comfy.acme.com');
        expect(env.get('APP_PUBLIC_URL')).toBe(CUSTOM_URL);
        expect(env.get('APP_HOST')).toBe('comfy.acme.com');
        expect(env.get('APP_DOMAIN')).toBe('comfy.acme.com');
        expect(env.get('APP_EXPOSED_DOMAIN')).toBe('comfy.acme.com');
        expect(env.get('APP_URL')).toBe(CUSTOM_URL);
        expect(env.get('APP_BASE_URL')).toBe(CUSTOM_URL);
        expect(env.get('APP_SCHEME')).toBe('https');
      });

      it('reverts to the platform hostname when the binding is dropped', async () => {
        bind(null);
        // The env still carries the previous binding — regeneration is what
        // reverts it, so an unbind has to be as reliable as a bind.
        appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: `APP_PUBLIC_URL=${CUSTOM_URL}\nAPP_BASE_URL=${CUSTOM_URL}\n` });

        await appHelpers.generateEnvFile(testAppUrn, exposedForm);

        expect(written().get('APP_PUBLIC_URL')).toBe(PLATFORM_URL);
        expect(written().get('APP_BASE_URL')).toBe(PLATFORM_URL);
      });

      it('leaves a local-only app alone — there is no public identity to alias', async () => {
        bind('comfy.acme.com');

        await appHelpers.generateEnvFile(testAppUrn, { exposedLocal: false });

        expect(written().get('APP_EXPOSED')).toBe('false');
        expect(written().has('APP_PUBLIC_URL')).toBe(false);
      });

      describe('app_base_url form fields', () => {
        const withBaseUrlField = (content: string) => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({
            ...mockAppInfo,
            form_fields: [
              {
                type: 'app_base_url',
                label: 'Base URL',
                env_variable: 'PUBLIC_BASE_URL',
                required: false,
                alias_env_variables: ['NEXTAUTH_URL'],
              },
            ],
          } as AppInfo);
          appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content });
        };

        it('moves a stale auto-derived base URL onto the newly bound domain', async () => {
          // Most apps build their OAuth redirect_uri from this value, so leaving it
          // on the platform hostname is INVALID_REDIRECT_URI even though
          // APP_PUBLIC_URL is right.
          bind('comfy.acme.com');
          withBaseUrlField(`PUBLIC_BASE_URL=${PLATFORM_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, exposedForm);

          expect(written().get('PUBLIC_BASE_URL')).toBe(CUSTOM_URL);
          expect(written().get('NEXTAUTH_URL')).toBe(CUSTOM_URL);
        });

        it('moves it back when the domain is unbound', async () => {
          bind(null);
          // Carrying the app's previous public URL — that is what identifies the
          // base URL as auto-derived rather than operator-chosen.
          withBaseUrlField(`APP_PUBLIC_URL=${CUSTOM_URL}\nPUBLIC_BASE_URL=${CUSTOM_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, exposedForm);

          expect(written().get('PUBLIC_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('also follows a plain public-domain change, not just a custom-domain one', async () => {
          // Widens existing behaviour on purpose: a base URL that is merely the
          // app's previous public URL used to be carried forward verbatim, so an
          // app whose public domain moved kept signing redirects for the hostname
          // it had left. The rule is "the Hub does not argue with a value a human
          // chose", not "the Hub never corrects its own".
          bind(null);
          const stale = 'https://test-app-test-store-core2-acme.old.example';
          withBaseUrlField(`APP_PUBLIC_URL=${stale}\nPUBLIC_BASE_URL=${stale}\n`);

          await appHelpers.generateEnvFile(testAppUrn, exposedForm);

          expect(written().get('PUBLIC_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('never argues with a base URL the operator chose', async () => {
          bind('comfy.acme.com');
          withBaseUrlField('PUBLIC_BASE_URL=https://pinned.example.org\n');

          await appHelpers.generateEnvFile(testAppUrn, exposedForm);

          // Only the two hostnames the Hub derives itself are superseded.
          expect(written().get('PUBLIC_BASE_URL')).toBe('https://pinned.example.org');
        });

        it('moves an auto-derived value that arrives on the FORM, not just one already in the env', async () => {
          /*
           * This is the path essentially every UI install actually takes. The
           * install dialog pre-fills each `app_base_url` field with the suggested
           * public URL, that value is persisted into `app.config`, and every later
           * start/restart replays `config` as the form — so `hasValidFormValue` is
           * true and the env branch never runs. A correction that lived only in the
           * env branch left `APP_PUBLIC_URL` on the custom domain while the value
           * the OAuth `redirect_uri` is built from stayed on the platform hostname.
           */
          bind('comfy.acme.com');
          withBaseUrlField('');

          await appHelpers.generateEnvFile(testAppUrn, { ...exposedForm, PUBLIC_BASE_URL: PLATFORM_URL });

          expect(written().get('PUBLIC_BASE_URL')).toBe(CUSTOM_URL);
          expect(written().get('NEXTAUTH_URL')).toBe(CUSTOM_URL);
        });

        it('still leaves an operator-chosen form value alone', async () => {
          bind('comfy.acme.com');
          withBaseUrlField('');

          await appHelpers.generateEnvFile(testAppUrn, { ...exposedForm, PUBLIC_BASE_URL: 'https://pinned.example.org' });

          expect(written().get('PUBLIC_BASE_URL')).toBe('https://pinned.example.org');
        });
      });

      describe('after the Hub changes organization or domain', () => {
        /*
         * core-2, 2026-09-23: re-registered from `bill-co` on companionintelligence.com
         * to `demopool1` on ci.computer. Hermes was never exposed (`openPort: true`),
         * so it had no `APP_PUBLIC_URL`, and its Public URL field is replayed from the
         * stored install form on every restart. Neither of the two values the Hub used
         * to recognise an automatic base URL was the old org's address, so it stayed.
         */
        const openPortForm = { exposedLocal: true, openPort: true } as const;

        const withAppBaseUrlField = (content: string) => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({
            ...mockAppInfo,
            form_fields: [{ type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', required: false }],
          } as AppInfo);
          appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content });
        };

        beforeEach(() => {
          bind(null);
        });

        it('moves a base URL from the previous organization onto the current one', async () => {
          const previousOrg = 'https://test-app-test-store-core2-bill-co.example.com';
          withAppBaseUrlField(`APP_BASE_URL=${previousOrg}\n`);

          await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, APP_BASE_URL: previousOrg });

          const env = written();
          expect(env.get('APP_BASE_URL')).toBe(PLATFORM_URL);
          // What OpenClaw-style apps derive their allowed origin from.
          expect(env.get('APP_BASE_HOST')).toBe(PLATFORM_HOSTNAME);
          expect(env.get('APP_BASE_WSS_ORIGIN')).toBe(`wss://${PLATFORM_HOSTNAME}`);
        });

        it('moves a base URL from the previous public domain onto the current one', async () => {
          const previousDomain = 'https://test-app-test-store-core2-acme.companionintelligence.com';
          withAppBaseUrlField(`APP_BASE_URL=${previousDomain}\n`);

          await appHelpers.generateEnvFile(testAppUrn, openPortForm);

          expect(written().get('APP_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('recognises the previous identity under the default subdomain after a custom one was chosen', async () => {
          // The shape is checked against the subdomain the app routes on now and the
          // `<app>-<store>` default, so choosing a subdomain does not strand the old one.
          withAppBaseUrlField('APP_BASE_URL=https://test-app-test-store-core2-bill-co.example.com\n');

          await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, localSubdomain: 'comfy' });

          expect(written().get('APP_BASE_URL')).toBe('https://comfy-core2-acme.example.com');
        });

        it('keeps a custom URL the operator pinned', async () => {
          withAppBaseUrlField('');

          await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, APP_BASE_URL: 'https://agents.acme.org' });

          expect(written().get('APP_BASE_URL')).toBe('https://agents.acme.org');
        });

        it('keeps an operator URL that merely starts with the chosen subdomain', async () => {
          // The install dialog sets `localSubdomain` to the bare app name, so an operator's own
          // `<app>-<team>.<corp>` host looks like `<subdomain>-<org>.<zone>`. Nothing ties it to this Hub.
          for (const pinned of ['https://comfy-team.acme.io', 'https://comfy-staging.apps.acme.io']) {
            withAppBaseUrlField(`APP_BASE_URL=${pinned}\n`);

            await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, localSubdomain: 'comfy', APP_BASE_URL: pinned });

            expect(written().get('APP_BASE_URL')).toBe(pinned);
            expect(written().get('APP_BASE_HOST')).toBe(new URL(pinned).host);
          }
        });

        it('moves an earlier address under the chosen subdomain when it carries this Hub', async () => {
          // `<subdomain>-<device>-<org>`: the device slug survives the move to another org.
          const previousOrg = 'https://comfy-core2-bill-co.companionintelligence.com';
          withAppBaseUrlField(`APP_BASE_URL=${previousOrg}\n`);

          await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, localSubdomain: 'comfy', APP_BASE_URL: previousOrg });

          expect(written().get('APP_BASE_URL')).toBe('https://comfy-core2-acme.example.com');
        });

        it('keeps a LAN HTTPS name under a local domain of two labels', async () => {
          config.getConfig.mockReturnValue(
            fromPartial({
              internalIp: '127.0.0.1',
              envFilePath: '/data/.env',
              rootFolderHost: '/opt/ci-hub',
              domain: 'example.com',
              userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com', localDomain: 'home.arpa' },
            }),
          );
          const lanName = 'https://test-app-test-store-core2-acme.home.arpa';
          withAppBaseUrlField(`APP_BASE_URL=${lanName}\n`);

          await appHelpers.generateEnvFile(testAppUrn, openPortForm);

          expect(written().get('APP_BASE_URL')).toBe(lanName);
        });

        it('keeps an operator value that only resembles the platform address', async () => {
          // A path, a port or plain HTTP is something a person typed; the Hub never derives one.
          for (const pinned of [
            'https://test-app-test-store-core2-bill-co.example.com/app',
            'https://test-app-test-store-core2-bill-co.example.com:8443',
            'http://test-app-test-store-core2-bill-co.example.com',
          ]) {
            withAppBaseUrlField('');

            await appHelpers.generateEnvFile(testAppUrn, { ...openPortForm, APP_BASE_URL: pinned });

            expect(written().get('APP_BASE_URL')).toBe(pinned);
          }
        });

        it('keeps a LAN APP_URL written while the Hub was unregistered on another address', async () => {
          withAppBaseUrlField('APP_BASE_URL=http://192.168.1.20:9091\n');

          await appHelpers.generateEnvFile(testAppUrn, openPortForm);

          expect(written().get('APP_BASE_URL')).toBe('http://192.168.1.20:9091');
        });

        it('does not move a previous platform address while the Hub has no organization', async () => {
          // The only thing to move it to would be the LAN APP_URL. A brief unregistered
          // window should not move a public address there.
          deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(undefined);
          const previousOrg = 'https://test-app-test-store-core2-bill-co.example.com';
          withAppBaseUrlField(`APP_BASE_URL=${previousOrg}\n`);

          await appHelpers.generateEnvFile(testAppUrn, openPortForm);

          expect(written().get('APP_BASE_URL')).toBe(previousOrg);
        });
      });

      describe('on This machine only', () => {
        /*
         * #2545: an app moved to This machine only kept `APP_BASE_URL` on its platform hostname,
         * which Portal stops publishing, so CI Memory sent every sign-in to a name with no DNS record.
         */
        const thisMachineOnlyForm = { exposureMode: 'local', exposedLocal: false, openPort: true } as const;
        const LOCAL_URL = 'http://127.0.0.1:9091';

        const withAppBaseUrlField = (content: string) => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({
            ...mockAppInfo,
            form_fields: [{ type: 'app_base_url', label: 'Public URL', env_variable: 'APP_BASE_URL', required: false }],
          } as AppInfo);
          appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content });
        };

        beforeEach(() => {
          bind(null);
        });

        it('gives the app its local address as its base URL, not a public name nothing serves', async () => {
          await appHelpers.generateEnvFile(testAppUrn, thisMachineOnlyForm);

          const env = written();
          expect(env.get('APP_URL')).toBe(LOCAL_URL);
          expect(env.get('APP_BASE_URL')).toBe(LOCAL_URL);
          expect(env.get('APP_BASE_HOST')).toBe('127.0.0.1:9091');
          expect(env.get('APP_BASE_WSS_ORIGIN')).toBe('ws://127.0.0.1:9091');
        });

        it('moves a base URL field off the public address the app had on Public web', async () => {
          // The install dialog filled the field with the public URL. The stored form replays it.
          withAppBaseUrlField(`APP_PUBLIC_URL=${PLATFORM_URL}\nAPP_BASE_URL=${PLATFORM_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, { ...thisMachineOnlyForm, APP_BASE_URL: PLATFORM_URL });

          expect(written().get('APP_BASE_URL')).toBe(LOCAL_URL);

          // The next start no longer has APP_PUBLIC_URL to recognise the value by.
          withAppBaseUrlField(`APP_BASE_URL=${LOCAL_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, { ...thisMachineOnlyForm, APP_BASE_URL: PLATFORM_URL });

          expect(written().get('APP_BASE_URL')).toBe(LOCAL_URL);
        });

        it('gives the app its public address again when it goes back to Public web', async () => {
          withAppBaseUrlField(`APP_BASE_URL=${LOCAL_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, exposedForm);

          expect(written().get('APP_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('moves the localhost address the install dialog filled in when the app goes to Public web', async () => {
          // The dialog suggests `http://localhost:<port>` on This machine only. The stored form replays it.
          withAppBaseUrlField('APP_BASE_URL=http://localhost:9091\n');

          await appHelpers.generateEnvFile(testAppUrn, { ...exposedForm, APP_BASE_URL: 'http://localhost:9091' });

          expect(written().get('APP_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('follows the app to its new port', async () => {
          // The last env build gave the app port 9091. Its form now asks for 9095.
          withAppBaseUrlField(`APP_PORT=9091\nAPP_BASE_URL=${LOCAL_URL}\n`);

          await appHelpers.generateEnvFile(testAppUrn, { ...thisMachineOnlyForm, port: 9095 });

          expect(written().get('APP_BASE_URL')).toBe('http://127.0.0.1:9095');
        });

        it('moves a localhost address on a port the app has left when the app goes to Public web', async () => {
          // The settings dialog keeps a filled-in base URL field when the port changes.
          withAppBaseUrlField('APP_PORT=9095\nAPP_BASE_URL=http://localhost:9091\n');

          await appHelpers.generateEnvFile(testAppUrn, { ...exposedForm, port: 9095, APP_BASE_URL: 'http://localhost:9091' });

          expect(written().get('APP_BASE_URL')).toBe(PLATFORM_URL);
        });

        it('keeps a localhost address the operator entered while the app stays on This machine only', async () => {
          withAppBaseUrlField('');

          await appHelpers.generateEnvFile(testAppUrn, { ...thisMachineOnlyForm, APP_BASE_URL: 'http://localhost:3000' });

          expect(written().get('APP_BASE_URL')).toBe('http://localhost:3000');
        });

        it('keeps a base URL the operator entered', async () => {
          withAppBaseUrlField('');

          await appHelpers.generateEnvFile(testAppUrn, { ...thisMachineOnlyForm, APP_BASE_URL: 'http://hubbox.lan:9091' });

          expect(written().get('APP_BASE_URL')).toBe('http://hubbox.lan:9091');
        });

        it('gives CI Memory no base URL, so it signs a browser in on the address the browser used', async () => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });
          appFilesManager.getAppEnv.mockResolvedValue({
            path: '/data/app.env',
            content:
              'APP_BASE_URL=https://ci-memory-ci-marketplace-core2-acme.example.com\nAPP_BASE_HOST=ci-memory-ci-marketplace-core2-acme.example.com\n',
          });

          await appHelpers.generateEnvFile(OFFICIAL_MEMORY_URN, thisMachineOnlyForm);

          const env = written();
          expect(env.get('APP_URL')).toBe(LOCAL_URL);
          expect(env.has('APP_BASE_URL')).toBe(false);
          expect(env.has('APP_BASE_HOST')).toBe(false);
          expect(env.has('APP_BASE_WSS_ORIGIN')).toBe(false);
        });

        it('gives a CI Memory source build no base URL either', async () => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({
            ...mockAppInfo,
            source: 'https://github.com/companionintelligence/CI-Server',
            urn: SOURCE_BUILD_URN,
          });

          await appHelpers.generateEnvFile(SOURCE_BUILD_URN, thisMachineOnlyForm);

          const env = written();
          expect(env.get('APP_URL')).toBe(LOCAL_URL);
          expect(env.has('APP_BASE_URL')).toBe(false);
        });

        it('gives no other app the CI Memory exemption', async () => {
          // The store slug decides, not the manifest: a lookalike from another store is an ordinary app.
          appFilesManager.getInstalledAppInfo.mockResolvedValue({
            ...mockAppInfo,
            id: 'ci-memory',
            source: 'https://github.com/companionintelligence/CI-Server',
            urn: createAppUrn('ci-memory', 'someones-store'),
          });

          await appHelpers.generateEnvFile(createAppUrn('ci-memory', 'someones-store'), thisMachineOnlyForm);

          expect(written().get('APP_BASE_URL')).toBe(LOCAL_URL);
        });

        it('still gives CI Memory its public address on Public web', async () => {
          appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

          await appHelpers.generateEnvFile(OFFICIAL_MEMORY_URN, exposedForm);

          expect(written().get('APP_BASE_URL')).toBe('https://ci-memory-ci-marketplace-core2-acme.example.com');
        });
      });
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
      expect(toPosix(envMap.get('APP_DATA_DIR') ?? '')).toBe('/opt/ci-hub/app-data/test-store/test-app');
      expect(envMap.get('HUB_DEVICE_ID')).toBe('hub-device-id');
      // Third-party / unmarked apps never get `ciHubApiKey`. It authenticates as the
      // operator on AuthGuard routes; only first-party Memory gets it back later.
      expect(envMap.has('HUB_API_KEY')).toBe(false);
    });

    it("passes the hops the app may trust as HUB_TRUSTED_PROXY_CIDRS, with Traefik's address on the app's own network, and removes a stale value when there are none", async () => {
      const proxyTrust = { appTrustedProxyCidrs: vi.fn() };
      const subnets = { allocateSubnet: vi.fn().mockResolvedValue('10.128.12.0/24') };
      const moduleRefGet = vi
        .spyOn(moduleRefForHelpers, 'get')
        .mockImplementation((token: unknown) => (token === ProxyTrustService ? proxyTrust : token === SubnetManagerService ? subnets : undefined));
      try {
        proxyTrust.appTrustedProxyCidrs.mockReturnValue(['10.128.0.3/32', '10.128.12.254/32']);
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        await appHelpers.generateEnvFile(testAppUrn, {});
        expect(envMap.get('HUB_TRUSTED_PROXY_CIDRS')).toBe('10.128.0.3/32,10.128.12.254/32');
        // The app's subnet decides Traefik's address there; it is allocated now if the app has none yet.
        expect(subnets.allocateSubnet).toHaveBeenCalledWith(testAppUrn);
        expect(proxyTrust.appTrustedProxyCidrs).toHaveBeenCalledWith('10.128.12.0/24');

        // Nothing to vouch for: the app must not keep trusting an address Docker may hand to another
        // container next.
        proxyTrust.appTrustedProxyCidrs.mockReturnValue([]);
        const stale = new Map<string, string>([['HUB_TRUSTED_PROXY_CIDRS', '172.19.0.7/32']]);
        envUtils.envStringToMap.mockReturnValue(stale);
        await appHelpers.generateEnvFile(testAppUrn, {});
        expect(stale.has('HUB_TRUSTED_PROXY_CIDRS')).toBe(false);
      } finally {
        moduleRefGet.mockRestore();
      }
    });

    it('passes the Host names the gateway may answer to as HUB_GATEWAY_ALLOWED_HOSTS, with the LAN suffixes when the port is open on the network', async () => {
      registrationService.getDeviceRegistrationInfo.mockResolvedValue({ hubSubdomain: 'hub-kyle', slug: 'kyle' } as never);
      const publicWeb = new Map<string, string>([['LOCAL_DOMAIN', 'ci.computer']]);
      envUtils.envStringToMap.mockReturnValue(publicWeb);
      await appHelpers.generateEnvFile(testAppUrn, { exposureMode: 'cloudflare', localSubdomain: 'memory' });
      // The name compose writes the tunnel router for, from the same registration and local domain.
      const origin = buildOriginServerName({ appSubdomain: 'memory', hubSubdomain: 'hub-kyle', orgSlug: 'kyle', localDomain: 'ci.computer' });
      expect(publicWeb.get('HUB_GATEWAY_ALLOWED_HOSTS')).toBe(`${origin},host.docker.internal,.ts.net`);

      const privateVpn = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(privateVpn);
      await appHelpers.generateEnvFile(testAppUrn, { exposureMode: 'tailscale' });
      expect(privateVpn.get('HUB_GATEWAY_ALLOWED_HOSTS')).toBe('test-app.test-store,host.docker.internal,.ts.net');

      // Opened on the network: the LAN suffixes, for the names a router or mDNS gives this computer, and
      // the operator's own names, which replace a stale value.
      const onNetwork = new Map<string, string>([['HUB_GATEWAY_ALLOWED_HOSTS', 'stale.example']]);
      envUtils.envStringToMap.mockReturnValue(onNetwork);
      await appHelpers.generateEnvFile(testAppUrn, {
        exposureMode: 'local',
        openPort: true,
        portOnNetwork: true,
        gatewayHostNames: ['kyle-pc.fritz.box'],
      });
      expect(onNetwork.get('HUB_GATEWAY_ALLOWED_HOSTS')).toBe(
        'host.docker.internal,.ts.net,.local,.lan,.home,.home.arpa,.internal,kyle-pc.fritz.box',
      );
    });

    it('omits HUB_TRUSTED_PROXY_CIDRS when the trust service is unavailable, without failing generation', async () => {
      const moduleRefGet = vi.spyOn(moduleRefForHelpers, 'get').mockImplementation(() => {
        throw new Error('no such provider');
      });
      try {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        await appHelpers.generateEnvFile(testAppUrn, {});
        expect(envMap.has('HUB_TRUSTED_PROXY_CIDRS')).toBe(false);
      } finally {
        moduleRefGet.mockRestore();
      }
    });

    it("drops forward auth's cached keys for the app once its new app.env is written, and only after", async () => {
      const order: string[] = [];
      const resolver = { invalidateApp: vi.fn(() => order.push('invalidate')) };
      appFilesManager.writeAppEnv.mockImplementation(async () => {
        order.push('write');
      });
      const moduleRefGet = vi
        .spyOn(moduleRefForHelpers, 'get')
        .mockImplementation((token: unknown) => (token === ForwardAuthSecretResolver ? resolver : undefined));
      try {
        envUtils.envStringToMap.mockReturnValue(new Map<string, string>());
        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(resolver.invalidateApp).toHaveBeenCalledWith(testAppUrn);
        expect(order).toEqual(['write', 'invalidate']);
      } finally {
        moduleRefGet.mockRestore();
      }
    });

    it('still writes app.env when the forward-auth resolver is unavailable', async () => {
      const moduleRefGet = vi.spyOn(moduleRefForHelpers, 'get').mockImplementation(() => {
        throw new Error('no such provider');
      });
      try {
        envUtils.envStringToMap.mockReturnValue(new Map<string, string>());
        await expect(appHelpers.generateEnvFile(testAppUrn, {})).resolves.toBeUndefined();
        expect(appFilesManager.writeAppEnv).toHaveBeenCalled();
      } finally {
        moduleRefGet.mockRestore();
      }
    });

    it('never issues HUB_API_KEY to a third-party app, even when the Hub has a device key configured', async () => {
      // The regression this guards: `ciHubApiKey` is accepted by AuthMiddleware as an operator
      // bearer, so a third-party app holding it could pair pool peers, read settings and install
      // or uninstall apps. First-party Memory is the only exception (cloud OAuth / geocode).
      const envMap = new Map<string, string>([['HUB_API_KEY', 'inherited-from-hub-dotenv']]);
      envUtils.envStringToMap.mockReturnValue(envMap);

      await appHelpers.generateEnvFile(testAppUrn, {});

      expect(envMap.has('HUB_API_KEY')).toBe(false);
    });

    it.each(['C:/foo/bar', 'C:\\foo\\bar', '\\\\server\\share\\folder'])('accepts Windows absolute ROOT_FOLDER_HOST (%s)', async (rootFolderHost) => {
      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '127.0.0.1',
          envFilePath: '/data/.env',
          rootFolderHost,
          domain: 'example.com',
          userSettings: {
            appDataPath: rootFolderHost,
            domain: 'example.com',
          },
        }),
      );
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      await appHelpers.generateEnvFile(testAppUrn, {});

      const appDataDir = envMap.get('APP_DATA_DIR');
      expect(appDataDir).toBeDefined();
      expect(toPosix(appDataDir ?? '')).toContain('app-data/test-store/test-app');
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
      expect(toPosix(envMap.get('APP_DATA_DIR') ?? '')).toBe(`${desktopRoot}/app-data/test-store/test-app`);
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

      const appDataDirRaw = envMap.get('APP_DATA_DIR');
      expect(appDataDirRaw).toBeDefined();

      if (!appDataDirRaw) {
        throw new Error('APP_DATA_DIR was not generated');
      }

      // Normalize to POSIX separators — the production path is built with path.join, so
      // it uses `\` on Windows even though it encodes a Linux bind-mount contract.
      const appDataDir = toPosix(appDataDirRaw);

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

    it('does not write APP_PUBLIC_DOMAIN (consolidated to APP_PUBLIC_HOSTNAME)', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);

      await appHelpers.generateEnvFile(testAppUrn, {
        exposed: true,
        domain: 'myapp-device1-myorg.example.com',
      });

      expect(envMap.has('APP_PUBLIC_DOMAIN')).toBe(false);
      expect(envMap.get('APP_PUBLIC_HOSTNAME')).toBe('myapp-device1-myorg.example.com');
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

    it('maps listen-all INTERNAL_IP to loopback for URL vars while keeping APP_HOSTNAME raw', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const port = 9091;

      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '0.0.0.0',
          envFilePath: '/data/.env',
          rootFolderHost: '/opt/ci-hub',
          domain: 'example.com',
          userSettings: {
            appDataPath: '/opt/ci-hub',
            domain: 'example.com',
          },
        }),
      );

      await appHelpers.generateEnvFile(testAppUrn, { port });

      expect(envMap.get('APP_HOSTNAME')).toBe('0.0.0.0');
      expect(envMap.get('APP_INTERNAL_AUTHORITY')).toBe('127.0.0.1:9091');
      expect(envMap.get('APP_DOMAIN')).toBe('127.0.0.1:9091');
      expect(envMap.get('APP_HOST')).toBe('127.0.0.1');
      expect(envMap.get('APP_URL')).toBe('http://127.0.0.1:9091');
      expect(envMap.get('APP_DOMAIN')).not.toContain('0.0.0.0');
      expect(envMap.get('APP_URL')).not.toContain('0.0.0.0');
    });

    it('preserves real LAN IP in URL vars when INTERNAL_IP is not a listen-all sentinel', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const lanIp = '192.168.1.100';
      const port = 8080;

      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: lanIp,
          envFilePath: '/data/.env',
          rootFolderHost: '/opt/ci-hub',
          domain: 'example.com',
          userSettings: {
            appDataPath: '/opt/ci-hub',
            domain: 'example.com',
          },
        }),
      );

      await appHelpers.generateEnvFile(testAppUrn, { port });

      expect(envMap.get('APP_HOSTNAME')).toBe(lanIp);
      expect(envMap.get('APP_INTERNAL_AUTHORITY')).toBe(`${lanIp}:${port}`);
      expect(envMap.get('APP_DOMAIN')).toBe(`${lanIp}:${port}`);
      expect(envMap.get('APP_HOST')).toBe(lanIp);
      expect(envMap.get('APP_URL')).toBe(`http://${lanIp}:${port}`);
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

    it("leaves a required field with no value out, with a warning, when the caller allows it (an update's first boot)", async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      const logger = (appHelpers as unknown as { logger: MockProxy<LoggerService> }).logger;
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        form_fields: [
          { env_variable: 'LICENSE_KEY', label: 'License key', required: true, type: 'text' as const },
          { env_variable: 'SMTP_PORT', label: 'SMTP port', required: true, type: 'number' as const, default: 587 },
          { env_variable: 'ADMIN_EMAIL', label: 'Admin email', required: true, type: 'email' as const },
        ],
      });

      await appHelpers.generateEnvFile(testAppUrn, { ADMIN_EMAIL: 'admin@example.com' }, { allowMissingRequired: true });

      expect(envMap.has('LICENSE_KEY')).toBe(false);
      expect(envMap.get('SMTP_PORT')).toBe('587');
      expect(envMap.get('ADMIN_EMAIL')).toBe('admin@example.com');
      expect(appFilesManager.writeAppEnv).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('License key (LICENSE_KEY)'));
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
      expect(envUtils.createRandomString).toHaveBeenCalledWith(testAppUrn, 'RANDOM_VAR', 16, undefined);
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

    it('passes the app-specific context floor (hermes-agent → 64K) to the inference resolver', async () => {
      // Arrange — a hermes-agent install that opts into standardized inference env.
      const hermesUrn = createAppUrn('hermes-agent', 'test-store');
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        id: 'hermes-agent',
        urn: hermesUrn,
        hub_integration: { inference: { num_ctx: 'HERMES_NUM_CTX' } },
      } as unknown as AppInfo);
      inferenceEnv.resolve.mockResolvedValue({ CI_LLM_NUM_CTX: '64000' });

      // Act
      await appHelpers.generateEnvFile(hermesUrn, {});

      // Assert — the resolver is asked to floor at Hermes' 64K minimum, and told which app it is
      // resolving for so a model Hermes would refuse is never baked into its app.env.
      expect(inferenceEnv.resolve).toHaveBeenCalledWith({ appSlug: 'hermes-agent', minContextLength: 64_000 });
    });

    it('applies the same 64K floor to ci-hermes, the first-party listing the fleet actually installs', async () => {
      // core-4 runs `ci-hermes`, not `hermes-agent`. A floor keyed only by the bootstrap slug left
      // its app.env with HERMES_NUM_CTX=32000, which Hermes refuses at startup.
      const ciHermesUrn = createAppUrn('ci-hermes', 'ci-marketplace');
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        id: 'ci-hermes',
        urn: ciHermesUrn,
        hub_integration: { inference: { num_ctx: 'HERMES_NUM_CTX' } },
      } as unknown as AppInfo);
      inferenceEnv.resolve.mockResolvedValue({ CI_LLM_NUM_CTX: '64000' });

      await appHelpers.generateEnvFile(ciHermesUrn, {});

      expect(inferenceEnv.resolve).toHaveBeenCalledWith({ appSlug: 'ci-hermes', minContextLength: 64_000 });
    });

    it('writes CI_INFERENCE_ERROR into app.env when the resolver has no model the app can use', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: { inference: { chat_model: 'APP_CHAT_MODEL' } },
      } as unknown as AppInfo);
      inferenceEnv.resolve.mockResolvedValue({ CI_INFERENCE_ERROR: 'No chat model served by this Hub pool meets the app.' });

      await appHelpers.generateEnvFile(testAppUrn, {});

      expect(envMap.get('CI_INFERENCE_ERROR')).toBe('No chat model served by this Hub pool meets the app.');
      expect(envMap.has('APP_CHAT_MODEL')).toBe(false);
    });

    it('passes no context floor for apps without a declared minimum', async () => {
      // Arrange — an app with an inference mapping but no minimum.
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: { inference: { num_ctx: 'APP_NUM_CTX' } },
      } as unknown as AppInfo);
      inferenceEnv.resolve.mockResolvedValue({ CI_LLM_NUM_CTX: '32768' });

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(inferenceEnv.resolve).toHaveBeenCalledWith({ appSlug: 'test-app', minContextLength: undefined });
    });

    it('injects llm_base_url and sets dual-provider env to ollama when Hub backend is Ollama', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'ollama',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
      });
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: 'http://host.docker.internal:11434/v1',
        CI_LLM_API_KEY: 'ollama',
        OLLAMA_HOST: 'http://host.docker.internal:11434',
      });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: {
          inference: {
            llm_base_url: 'APP_OPENAI_COMPATIBLE_URL',
            llm_api_key: 'APP_OPENAI_API_KEY',
            ollama_host: 'APP_OLLAMA_BASE_PATH',
          },
          inference_provider: {
            env: 'APP_LLM_PROVIDER',
            ollama: 'ollama',
            openai_compatible: 'generic-openai',
          },
          llm_base_url_strip_v1: true,
        },
      } as unknown as AppInfo);

      await appHelpers.generateEnvFile(testAppUrn, {});

      expect(envMap.get('APP_OPENAI_COMPATIBLE_URL')).toBe('http://host.docker.internal:11434');
      expect(envMap.get('APP_OPENAI_API_KEY')).toBe('ollama');
      expect(envMap.get('APP_OLLAMA_BASE_PATH')).toBe('http://host.docker.internal:11434');
      expect(envMap.get('APP_LLM_PROVIDER')).toBe('ollama');
    });

    it('sets dual-provider env to generic-openai when Hub backend is vLLM', async () => {
      const envMap = new Map<string, string>();
      envUtils.envStringToMap.mockReturnValue(envMap);
      config.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
      });
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: 'http://host.docker.internal:8000/v1',
        CI_LLM_API_KEY: 'vllm',
      });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        hub_integration: {
          inference: { llm_base_url: 'APP_OPENAI_COMPATIBLE_URL', llm_api_key: 'APP_OPENAI_API_KEY' },
          inference_provider: {
            env: 'APP_LLM_PROVIDER',
            ollama: 'ollama',
            openai_compatible: 'generic-openai',
          },
          llm_base_url_strip_v1: true,
        },
      } as unknown as AppInfo);

      await appHelpers.generateEnvFile(testAppUrn, {});

      expect(envMap.get('APP_OPENAI_COMPATIBLE_URL')).toBe('http://host.docker.internal:8000');
      expect(envMap.get('APP_LLM_PROVIDER')).toBe('generic-openai');
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

    describe('app_base_url form fields', () => {
      it('defaults APP_BASE_URL to suggested public URL when org is registered', async () => {
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
          localSubdomain: 'n8n',
        });

        expect(envMap.get('APP_BASE_URL')).toBe('https://n8n-test1-myorg.example.com');
        expect(envMap.get('APP_BASE_HOST')).toBe('n8n-test1-myorg.example.com');
        expect(envMap.get('APP_BASE_WSS_ORIGIN')).toBe('wss://n8n-test1-myorg.example.com');
      });

      it('uses form override and alias env vars with trailing slash', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          form_fields: [
            {
              env_variable: 'APP_BASE_URL',
              label: 'Public URL',
              type: 'app_base_url' as const,
              alias_env_variables: ['N8N_EDITOR_BASE_URL', 'WEBHOOK_URL'],
              trailing_slash: true,
              required: false,
            },
          ],
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          APP_BASE_URL: 'https://n8n.example.com/',
        });

        expect(envMap.get('APP_BASE_URL')).toBe('https://n8n.example.com');
        expect(envMap.get('N8N_EDITOR_BASE_URL')).toBe('https://n8n.example.com/');
        expect(envMap.get('WEBHOOK_URL')).toBe('https://n8n.example.com/');
      });

      it('falls back to APP_URL when org is not registered', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(null);

        await appHelpers.generateEnvFile(testAppUrn, { port: 9091 });

        expect(envMap.get('APP_URL')).toBe('http://127.0.0.1:9091');
        expect(envMap.get('APP_BASE_URL')).toBe('http://127.0.0.1:9091');
        expect(envMap.get('APP_BASE_WSS_ORIGIN')).toBe('ws://127.0.0.1:9091');
      });

      it('derives ws origin for http APP_BASE_URL and wss for https', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          form_fields: [
            {
              env_variable: 'APP_BASE_URL',
              label: 'Public URL',
              type: 'app_base_url' as const,
              required: false,
            },
          ],
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          APP_BASE_URL: 'http://localhost:5678',
        });

        expect(envMap.get('APP_BASE_WSS_ORIGIN')).toBe('ws://localhost:5678');

        envMap.clear();
        await appHelpers.generateEnvFile(testAppUrn, {
          APP_BASE_URL: 'https://n8n.example.com',
        });

        expect(envMap.get('APP_BASE_WSS_ORIGIN')).toBe('wss://n8n.example.com');
      });

      it('defaults scheme-less APP_BASE_URL to http when deriving host vars', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);

        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          form_fields: [
            {
              env_variable: 'APP_BASE_URL',
              label: 'Public URL',
              type: 'app_base_url' as const,
              required: false,
            },
          ],
        });

        await appHelpers.generateEnvFile(testAppUrn, {
          APP_BASE_URL: '127.0.0.1:8080',
        });

        expect(envMap.get('APP_BASE_HOST')).toBe('127.0.0.1:8080');
        expect(envMap.get('APP_BASE_WSS_ORIGIN')).toBe('ws://127.0.0.1:8080');
      });
    });

    describe('R-ENV: MCP env injection for agent harness apps', () => {
      // A person let these apps use the Hub's tools (`app.mcp_access`); see the MCP access block below.
      beforeEach(() => {
        appsRepository.getAppMcpAccess.mockResolvedValue('write');
      });

      // BUG-MCP-1: single Streamable HTTP endpoint (/api/mcp); the old /sse + /messages pair is gone.
      it('R-ENV-1/2: should inject HUB_URL and the single HUB_MCP_URL when hub_integration.mcp_client is true', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_URL')).toBe('http://ci-hub:3000');
        expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-hub:3000/api/mcp');
        expect(envMap.has('HUB_MCP_MESSAGES_URL')).toBe(false);
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
          expect(envMap.get('HUB_MCP_URL')).toBe('http://my-custom-hub:3000/api/mcp');
        } finally {
          delete process.env.HUB_CONTAINER_NAME;
        }
      });

      it('R-ENV-1: should retain the legacy Hub URL under a pre-rename compose file', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);

        const previousHubContainerName = process.env.HUB_CONTAINER_NAME;
        const previousRabbitmqHost = process.env.RABBITMQ_HOST;
        delete process.env.HUB_CONTAINER_NAME;
        process.env.RABBITMQ_HOST = 'ci-os-hub-queue';
        try {
          await appHelpers.generateEnvFile(testAppUrn, {});
          expect(envMap.get('HUB_URL')).toBe('http://ci-os-hub:3000');
          expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-os-hub:3000/api/mcp');
        } finally {
          if (previousHubContainerName === undefined) delete process.env.HUB_CONTAINER_NAME;
          else process.env.HUB_CONTAINER_NAME = previousHubContainerName;
          if (previousRabbitmqHost === undefined) delete process.env.RABBITMQ_HOST;
          else process.env.RABBITMQ_HOST = previousRabbitmqHost;
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
          expect(envMap.get('HUB_URL')).toBe('http://ci-hub:5002');
          expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-hub:5002/api/mcp');
          expect(envMap.has('HUB_MCP_MESSAGES_URL')).toBe(false);
        } finally {
          delete process.env.API_PORT;
        }
      });

      it('mints the key at the level the person granted', async () => {
        envUtils.envStringToMap.mockReturnValue(new Map());
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, hub_integration: { mcp_client: true } } as AppInfo);
        appsRepository.getAppMcpAccess.mockResolvedValue('read');

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['mcp'], mcpCapability: 'read' }));
      });

      describe.each([
        ['nobody has answered', null],
        ['the answer was no', 'none'],
      ])('SECURITY: when %s', (_label, access) => {
        it('gives the app no MCP key and takes away one it holds', async () => {
          const envMap = new Map<string, string>();
          envUtils.envStringToMap.mockReturnValue(envMap);
          appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'HUB_MCP_API_KEY=old-key' });
          appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, hub_integration: { mcp_client: true } } as AppInfo);
          appsRepository.getAppMcpAccess.mockResolvedValue(access);

          await appHelpers.generateEnvFile(testAppUrn, {});

          expect(apiKeys.provisionManagedKey).not.toHaveBeenCalled();
          expect(apiKeys.revokeManagedByApp).toHaveBeenCalledWith(testAppUrn);
          expect(envMap.has('HUB_MCP_API_KEY')).toBe(false);
          expect(envMap.has('HUB_MCP_URL')).toBe(false);
        });
      });

      describe('an app installed before the Hub asked', () => {
        const officialUrn = createAppUrn('ci-openclaw', 'ci-marketplace');

        beforeEach(() => {
          envUtils.envStringToMap.mockImplementation((content: string) => new Map(content ? [['HUB_MCP_API_KEY', 'held-key']] : []));
          appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'HUB_MCP_API_KEY=held-key' });
          appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, hub_integration: { mcp_client: true } } as AppInfo);
          appsRepository.getAppMcpAccess.mockResolvedValue(null);
          apiKeys.provisionManagedKey.mockResolvedValue('held-key');
        });

        it("keeps an official-store app's MCP key at its level, and records that as the answer", async () => {
          apiKeys.findManagedByApp.mockResolvedValue(fromPartial({ scopes: ['mcp'], capability: 'read' }));

          await appHelpers.generateEnvFile(officialUrn, {});

          expect(appsRepository.setAppMcpAccess).toHaveBeenCalledWith(officialUrn, 'read');
          expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['mcp'], mcpCapability: 'read' }));
        });

        it('SECURITY: does not keep one for an app from another store', async () => {
          apiKeys.findManagedByApp.mockResolvedValue(fromPartial({ scopes: ['mcp'], capability: 'write' }));

          await appHelpers.generateEnvFile(createAppUrn('ci-openclaw', 'test-store'), {});

          expect(appsRepository.setAppMcpAccess).not.toHaveBeenCalled();
          expect(apiKeys.provisionManagedKey).not.toHaveBeenCalled();
          expect(apiKeys.revokeManagedByApp).toHaveBeenCalled();
        });

        it('gives an official-store app that holds no MCP key none', async () => {
          apiKeys.findManagedByApp.mockResolvedValue(null);

          await appHelpers.generateEnvFile(officialUrn, {});

          expect(appsRepository.setAppMcpAccess).not.toHaveBeenCalled();
          expect(apiKeys.provisionManagedKey).not.toHaveBeenCalled();
        });
      });

      it('R-ENV/SEC-MCP-8: provisions a dedicated managed key and injects it as HUB_MCP_API_KEY', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);
        apiKeys.provisionManagedKey.mockResolvedValue('managed-key-xyz');

        // Independent of process.env.MCP_API_KEY now — the app gets its OWN managed key.
        delete process.env.MCP_API_KEY;
        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_MCP_API_KEY')).toBe('managed-key-xyz');
        expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ appUrn: testAppUrn, appName: agentApp.name }));
      });

      it("R-ENV/SEC-MCP-8: passes the app's existing HUB_MCP_API_KEY to provisionManagedKey (preserve path)", async () => {
        // The prior key lives in the app's OWN app.env, not the Hub's .env — keep
        // the two maps distinct, as generateEnvFile does: the Hub .env seed is
        // allowlisted (a managed key is not inheritable), the app env is where
        // preservation reads from.
        const envMap = new Map<string, string>();
        const existingAppEnv = new Map<string, string>([['HUB_MCP_API_KEY', 'old-key']]);
        appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
        envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? existingAppEnv : envMap));
        const agentApp = { ...mockAppInfo, hub_integration: { mcp_client: true, wake_endpoint: '/hooks/hub-wake', sse_events: false } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(agentApp);
        apiKeys.provisionManagedKey.mockResolvedValue('old-key');

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ existingRawKey: 'old-key' }));
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

    // CI-Hub#870: exposed apps that "Sign in with CI-Portal" must authenticate against the
    // paired Portal (CI_CLOUD_URL). The Hub injects that issuer into the app-declared env var.
    describe('Portal OIDC issuer injection', () => {
      const CI_CLOUD_URL = 'https://hub.ci.computer';

      beforeEach(() => {
        // Re-mock with a paired Portal URL present (the base beforeEach omits ciCloudUrl).
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: CI_CLOUD_URL,
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
      });

      it('injects <origin>/api/auth into the app-declared env var when a path suffix is set', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const oidcApp = { ...mockAppInfo, hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth' } } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(oidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_OIDC_ISSUER')).toBe('https://hub.ci.computer/api/auth');
        // The legacy OIDC_ISSUER_URL is not written for a manifest-declared app.
        expect(envMap.has('OIDC_ISSUER_URL')).toBe(false);
      });

      it('injects the bare Portal origin when no path suffix is declared', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const oidcApp = { ...mockAppInfo, hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER' } } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(oidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_OIDC_ISSUER')).toBe('https://hub.ci.computer');
      });

      it('normalizes trailing slashes on the origin and leading/trailing slashes on the path', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: 'https://hub.ci.computer///',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        const oidcApp = { ...mockAppInfo, hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth/' } } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(oidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_OIDC_ISSUER')).toBe('https://hub.ci.computer/api/auth');
      });

      it('joins an issuer_path that has no leading slash', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const oidcApp = { ...mockAppInfo, hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: 'api/auth' } } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(oidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_OIDC_ISSUER')).toBe('https://hub.ci.computer/api/auth');
      });

      it('does not inject any issuer for a third-party app that does not opt in', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        // mockAppInfo is a third-party app (source http://example.com) with no hub_integration.
        appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('CI_OIDC_ISSUER')).toBe(false);
        expect(envMap.has('OIDC_ISSUER_URL')).toBe(false);
      });

      it('injects bare OIDC_ISSUER_URL for the legacy first-party app id (ci-memory)', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const firstPartyApp = { ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(firstPartyApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('OIDC_ISSUER_URL')).toBe('https://hub.ci.computer');
      });

      it('injects bare OIDC_ISSUER_URL for a legacy first-party app by CI-Server source', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        const firstPartyApp = { ...mockAppInfo, source: 'https://github.com/companionintelligence/CI-Server', urn: SOURCE_BUILD_URN };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(firstPartyApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('OIDC_ISSUER_URL')).toBe('https://hub.ci.computer');
      });

      it('lets a manifest oidc declaration take precedence over the legacy first-party branch', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        // A first-party app that also opts in via the manifest: only the declared var is written.
        const firstPartyOidcApp = {
          ...mockAppInfo,
          id: 'ci-memory',
          urn: OFFICIAL_MEMORY_URN,
          hub_integration: { oidc: { issuer_env: 'CUSTOM_ISSUER', issuer_path: '/api/auth' } },
        };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(firstPartyOidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CUSTOM_ISSUER')).toBe('https://hub.ci.computer/api/auth');
        expect(envMap.has('OIDC_ISSUER_URL')).toBe(false);
      });

      it('skips injection (no env written) when the manifest opts in but CI_CLOUD_URL is empty', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: '',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        const oidcApp = { ...mockAppInfo, hub_integration: { oidc: { issuer_env: 'CI_OIDC_ISSUER', issuer_path: '/api/auth' } } };
        appFilesManager.getInstalledAppInfo.mockResolvedValue(oidcApp);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('CI_OIDC_ISSUER')).toBe(false);
      });
    });

    // CI-Server's Bearer path (`auth.portal.*`) is a separate config block from the
    // interactive-login issuer above, ships disabled, and defaults to the prod portal.
    // Unset, every token-authenticated call from a portal client 401s.
    describe('Portal Bearer-auth config injection (first-party CI-Server apps)', () => {
      const CI_CLOUD_URL = 'https://hub.companionintelligence.com';

      beforeEach(() => {
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: CI_CLOUD_URL,
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
      });

      it('injects the enabled flag, bare-origin issuer and JWKS URI for ci-memory', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('PORTAL_OIDC_ENABLED')).toBe('true');
        // Bare origin: the `iss` claim is the origin, NOT the /api/auth discovery base.
        expect(envMap.get('PORTAL_OIDC_ISSUER')).toBe('https://hub.companionintelligence.com');
        // The JWKS, unlike the issuer, does live under the /api/auth mount.
        expect(envMap.get('PORTAL_OIDC_JWKS_URI')).toBe('https://hub.companionintelligence.com/api/auth/jwks');
      });

      it('injects for a first-party app identified by CI-Server source', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          source: 'https://github.com/companionintelligence/CI-Server',
          urn: SOURCE_BUILD_URN,
        });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('PORTAL_OIDC_ENABLED')).toBe('true');
        expect(envMap.get('PORTAL_OIDC_ISSUER')).toBe('https://hub.companionintelligence.com');
      });

      it('normalizes a trailing slash on the paired Portal origin', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: 'https://hub.companionintelligence.com///',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('PORTAL_OIDC_ISSUER')).toBe('https://hub.companionintelligence.com');
        expect(envMap.get('PORTAL_OIDC_JWKS_URI')).toBe('https://hub.companionintelligence.com/api/auth/jwks');
      });

      it('still injects when the app also declares hub_integration.oidc (independent config blocks)', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          id: 'ci-memory',
          urn: OFFICIAL_MEMORY_URN,
          hub_integration: { oidc: { issuer_env: 'CUSTOM_ISSUER', issuer_path: '/api/auth' } },
        });

        await appHelpers.generateEnvFile(testAppUrn, {});

        // Opting into the interactive-login mapping must not cost the app its Bearer config.
        expect(envMap.get('CUSTOM_ISSUER')).toBe('https://hub.companionintelligence.com/api/auth');
        expect(envMap.get('PORTAL_OIDC_ENABLED')).toBe('true');
      });

      it('does not inject for a third-party app', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('PORTAL_OIDC_ENABLED')).toBe(false);
        expect(envMap.has('PORTAL_OIDC_ISSUER')).toBe(false);
        expect(envMap.has('PORTAL_OIDC_JWKS_URI')).toBe(false);
      });

      it('never overwrites values the operator pinned in the Hub .env', async () => {
        const envMap = new Map<string, string>([
          ['PORTAL_OIDC_ENABLED', 'false'],
          ['PORTAL_OIDC_ISSUER', 'https://portal.internal'],
        ]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        // An operator who deliberately disabled the path, or pinned another portal, keeps it.
        expect(envMap.get('PORTAL_OIDC_ENABLED')).toBe('false');
        expect(envMap.get('PORTAL_OIDC_ISSUER')).toBe('https://portal.internal');
        // The unset key is still filled in.
        expect(envMap.get('PORTAL_OIDC_JWKS_URI')).toBe('https://hub.companionintelligence.com/api/auth/jwks');
      });

      it('writes nothing when CI_CLOUD_URL is empty', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'hub-api-key',
            ciCloudUrl: '',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('PORTAL_OIDC_ENABLED')).toBe(false);
        expect(envMap.has('PORTAL_OIDC_JWKS_URI')).toBe(false);
      });
    });

    describe('Portal Google Maps key injection (ci-memory)', () => {
      it('injects GOOGLE_MAPS_KEY and GEOCODING_API_KEY from Portal for ci-memory', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });
        portalClient.fetchMapsConfig.mockResolvedValue({ configured: true, apiKey: 'AIzaSyPortalMapsKey' });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('GOOGLE_MAPS_KEY')).toBe('AIzaSyPortalMapsKey');
        expect(envMap.get('GEOCODING_API_KEY')).toBe('AIzaSyPortalMapsKey');
      });

      it('does not overwrite an operator-set GOOGLE_MAPS_KEY', async () => {
        const envMap = new Map<string, string>([['GOOGLE_MAPS_KEY', 'operator-key']]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });
        portalClient.fetchMapsConfig.mockResolvedValue({ configured: true, apiKey: 'AIzaSyPortalMapsKey' });

        await appHelpers.generateEnvFile(OFFICIAL_MEMORY_URN, {});

        expect(envMap.get('GOOGLE_MAPS_KEY')).toBe('operator-key');
        expect(portalClient.fetchMapsConfig).not.toHaveBeenCalled();
      });

      it('skips third-party apps', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);
        portalClient.fetchMapsConfig.mockResolvedValue({ configured: true, apiKey: 'AIzaSyPortalMapsKey' });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('GOOGLE_MAPS_KEY')).toBe(false);
        expect(portalClient.fetchMapsConfig).not.toHaveBeenCalled();
      });
    });

    describe('Portal device key injection (ci-memory cloud OAuth)', () => {
      it('injects HUB_API_KEY and CI_CLOUD_URL for first-party Memory', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'portal-device-key',
            ciCloudUrl: 'https://hub.ci.computer',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_API_KEY')).toBe('portal-device-key');
        expect(envMap.get('HUB_DEVICE_ID')).toBe('hub-device-id');
        expect(envMap.get('CI_CLOUD_URL')).toBe('https://hub.ci.computer');
      });

      // `id` and `source` are manifest fields any store can publish. A copycat that claimed both was
      // handed this Hub's Portal device key (2026-11-18).
      it.each([
        ['claims the id ci-memory', { id: 'ci-memory', urn: createAppUrn('ci-memory', 'someones-store') }],
        [
          'names the CI-Server repository as its source',
          { source: 'https://github.com/companionintelligence/CI-Server', urn: createAppUrn('ci-server', 'someones-store') },
        ],
        [
          'claims both from another store',
          { id: 'ci-memory', source: 'https://github.com/companionintelligence/CI-Server', urn: createAppUrn('lookalike', 'someones-store') },
        ],
      ])('gives no Portal device key, maps key or Portal sign-in config to a store app that %s', async (_case, claims) => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'portal-device-key',
            ciCloudUrl: 'https://hub.ci.computer',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, ...claims });

        await appHelpers.generateEnvFile(testAppUrn, {});

        // HUB_DEVICE_ID is every app's (an identifier, not a credential); the key that goes with it is not.
        for (const key of ['HUB_API_KEY', 'GOOGLE_MAPS_KEY', 'PORTAL_OIDC_ENABLED', 'OIDC_ISSUER_URL']) {
          expect(envMap.has(key), key).toBe(false);
        }
      });

      it('never gives Memory the move key, which is what keeps a device key leaked from it from moving the Hub', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'portal-device-key',
            ciHubMoveKey: 'portal-move-key',
            ciCloudUrl: 'https://hub.ci.computer',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_API_KEY')).toBe('portal-device-key');
        expect([...envMap.values()]).not.toContain('portal-move-key');
      });

      it('injects HUB_API_KEY for a first-party app identified by CI-Server source', async () => {
        const envMap = new Map<string, string>();
        envUtils.envStringToMap.mockReturnValue(envMap);
        appFilesManager.getInstalledAppInfo.mockResolvedValue({
          ...mockAppInfo,
          source: 'https://github.com/companionintelligence/CI-Server',
          urn: SOURCE_BUILD_URN,
        });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('HUB_API_KEY')).toBe('hub-api-key');
      });

      it('does not overwrite an operator-set CI_CLOUD_URL', async () => {
        const envMap = new Map<string, string>([['CI_CLOUD_URL', 'https://portal.internal']]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: 'portal-device-key',
            ciCloudUrl: 'https://hub.ci.computer',
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.get('CI_CLOUD_URL')).toBe('https://portal.internal');
        expect(envMap.get('HUB_API_KEY')).toBe('portal-device-key');
      });

      it('omits HUB_API_KEY when the Hub has no Portal device key', async () => {
        const envMap = new Map<string, string>([['HUB_API_KEY', 'stale-inherited']]);
        envUtils.envStringToMap.mockReturnValue(envMap);
        config.getConfig.mockReturnValue(
          fromPartial({
            internalIp: '127.0.0.1',
            envFilePath: '/data/.env',
            rootFolderHost: '/opt/ci-hub',
            domain: 'example.com',
            ciHubApiKey: null,
            userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
          }),
        );
        appFilesManager.getInstalledAppInfo.mockResolvedValue({ ...mockAppInfo, id: 'ci-memory', urn: OFFICIAL_MEMORY_URN });

        await appHelpers.generateEnvFile(testAppUrn, {});

        expect(envMap.has('HUB_API_KEY')).toBe(false);
      });
    });
  });
});

describe('isPlatformIdentityUrlFor', () => {
  const hermes = { defaultSubdomain: 'ci-hermes-ci-marketplace', deviceSlug: 'core-2', localDomainRoot: 'ci.lan' };

  it('matches the store-qualified default under any org, device and zone', () => {
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-core-2-bill-co.companionintelligence.com', hermes)).toBe(true);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-demopool1.ci.computer', hermes)).toBe(true);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-core-2-acme.my.lifescope.io/', hermes)).toBe(true);
    // A Hub whose device slug changed, or that had none, still wrote the default.
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-old-box-acme.ci.computer', { ...hermes, deviceSlug: null })).toBe(true);
  });

  it('matches a chosen subdomain only when this Hub device slug follows it', () => {
    const n8n = { defaultSubdomain: 'n8n-ci-marketplace', routingSubdomain: 'n8n', deviceSlug: 'core-2', localDomainRoot: 'ci.lan' };

    expect(isPlatformIdentityUrlFor('https://n8n-core-2-bill-co.companionintelligence.com', n8n)).toBe(true);
    expect(isPlatformIdentityUrlFor('https://n8n-team.acme.io', n8n)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://n8n-core-2.acme.io', n8n)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://n8n-core-2-bill-co.companionintelligence.com', { ...n8n, deviceSlug: null })).toBe(false);
  });

  it('never matches a name under the local domain', () => {
    const lan = { ...hermes, routingSubdomain: 'hermes', localDomainRoot: 'home.arpa' };

    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-core-2-acme.home.arpa', lan)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://hermes-core-2-acme.home.arpa', lan)).toBe(false);
  });

  it('does not match another app, the bare subdomain, or a single-label zone', () => {
    expect(isPlatformIdentityUrlFor('https://ci-openclaw-ci-marketplace-core-2-acme.ci.computer', hermes)).toBe(false);
    // `<subdomain>.<zone>` is the unregistered shape, which `APP_PUBLIC_URL` already tracks.
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace.ci.computer', hermes)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-core-2.localhost', hermes)).toBe(false);
  });

  it('does not match anything the Hub would never have written', () => {
    expect(isPlatformIdentityUrlFor('not a url', hermes)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-acme.ci.computer?x=1', hermes)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-acme.ci.computer#top', hermes)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://user@ci-hermes-ci-marketplace-acme.ci.computer', hermes)).toBe(false);
    expect(isPlatformIdentityUrlFor('https://ci-hermes-ci-marketplace-acme.ci.computer', { defaultSubdomain: '' })).toBe(false);
  });
});
