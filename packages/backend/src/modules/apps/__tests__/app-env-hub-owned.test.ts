import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { InferenceEnvResolver } from '@/modules/inference/inference-env-resolver';
import { MemoryConnectionService } from '@/modules/memory-connect/memory-connection.service';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { Test } from '@nestjs/testing';
import { type AppInfo, type FormField, HUB_OWNED_APP_ENV_VARS } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';

/*
 * The Hub writes the app's id, name, store, URN, hosts and data directory into its env. Its Traefik
 * label check and its sandbox take them as the app's own. The manifest schema refuses a manifest
 * that names one. These tests hand the env builder such a manifest directly (as one that reached it
 * some other way) and check the Hub's value is what the app gets.
 */
describe('AppHelpers.generateEnvFile keeps the values the Hub sets for the app', () => {
  const appUrn: AppUrn = createAppUrn('app', 'home');
  const OTHER = 'other-app-ci-marketplace';

  let appHelpers: AppHelpers;
  let appFilesManager = mock<AppFilesManager>();
  let config = mock<ConfigurationService>();
  let inferenceEnv = mock<InferenceEnvResolver>();
  let memoryConnection = mock<MemoryConnectionService>();
  let deviceRegistrationRepository = mock<DeviceRegistrationRepository>();
  let filesystem = mock<FilesystemService>();
  let written = '';

  const appInfo = (overrides: Partial<AppInfo> = {}): AppInfo =>
    fromPartial({
      id: 'app',
      urn: appUrn,
      name: 'App',
      port: 8080,
      exposable: true,
      dynamic_config: true,
      available: true,
      version: '1.0.0',
      categories: ['utilities'],
      form_fields: [],
      ...overrides,
    });

  const generate = async (info: AppInfo, form: Record<string, unknown> = { exposedLocal: true }) => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue(info);
    await appHelpers.generateEnvFile(appUrn, form);
    return new EnvUtils().envStringToMap(written);
  };

  const field = (overrides: Partial<FormField>): FormField => fromPartial({ type: 'text', label: 'Field', required: false, ...overrides });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [AppHelpers] })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    config = moduleRef.get(ConfigurationService);
    inferenceEnv = moduleRef.get(InferenceEnvResolver);
    memoryConnection = moduleRef.get(MemoryConnectionService);

    const realEnvUtils = new EnvUtils();
    const envUtils = moduleRef.get(EnvUtils);
    envUtils.envStringToMap.mockImplementation(realEnvUtils.envStringToMap);
    envUtils.envMapToString.mockImplementation(realEnvUtils.envMapToString);
    envUtils.createRandomString.mockImplementation(realEnvUtils.createRandomString);

    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '192.168.1.20',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        localDomain: 'hub.lan',
        ciCloudUrl: 'https://portal.example.com',
        userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com', localDomain: 'hub.lan' },
      }),
    );
    config.getInferencePreferences.mockReturnValue(fromPartial({ preferredBackend: 'ollama' }));
    inferenceEnv.resolve.mockResolvedValue(fromPartial({ CI_CHAT_MODEL: OTHER }));
    memoryConnection.getInjectableCreds.mockResolvedValue(fromPartial({ url: OTHER, token: OTHER }));
    filesystem = moduleRef.get(FilesystemService);
    filesystem.readTextFile.mockResolvedValue('');
    deviceRegistrationRepository = moduleRef.get(DeviceRegistrationRepository);
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(fromPartial({ slug: 'acme' }));
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app-data/home/app/app.env', content: '' });
    written = '';
    appFilesManager.writeAppEnv.mockImplementation(async (_urn, content) => {
      written = content;
    });
  });

  it('sets every one of them for an exposed app', async () => {
    const env = await generate(appInfo());

    expect(Object.fromEntries([...HUB_OWNED_APP_ENV_VARS].map((name) => [name, env.get(name)]))).toEqual({
      APP_ID: 'app-home',
      APP_NAME: 'app',
      APP_STORE_ID: 'home',
      APP_URN: 'app:home',
      APP_DOMAIN: 'app-home-acme.example.com',
      APP_LOCAL_DOMAIN: 'app-home-acme.hub.lan',
      APP_BASE_HOST: 'app-home-acme.example.com',
      APP_DATA_DIR: expect.stringMatching(/\/home\/app$/),
    });
  });

  describe.each([...HUB_OWNED_APP_ENV_VARS])('%s', (name) => {
    const hubValue = async (form?: Record<string, unknown>) => (await generate(appInfo(), form)).get(name);

    it('over a form field’s value', async () => {
      const expected = await hubValue();
      const env = await generate(appInfo({ form_fields: [field({ env_variable: name })] }), { exposedLocal: true, [name]: OTHER });
      expect(env.get(name)).toBe(expected);
    });

    it('over a form field’s default', async () => {
      const expected = await hubValue();
      const env = await generate(appInfo({ form_fields: [field({ env_variable: name, default: OTHER })] }));
      expect(env.get(name)).toBe(expected);
    });

    it('over a random field', async () => {
      const expected = await hubValue();
      const env = await generate(appInfo({ form_fields: [field({ type: 'random', env_variable: name })] }));
      expect(env.get(name)).toBe(expected);
    });

    it('over a base URL field and its alias', async () => {
      const expected = await hubValue();
      const env = await generate(
        appInfo({
          form_fields: [
            field({ type: 'app_base_url', env_variable: name }),
            field({ type: 'app_base_url', env_variable: 'SITE_URL', alias_env_variables: [name] }),
          ],
        }),
        { exposedLocal: true, [name]: `https://${OTHER}`, SITE_URL: `https://${OTHER}` },
      );
      expect(env.get(name)).toBe(expected);
      expect(env.get('SITE_URL')).toBe(`https://${OTHER}`);
    });

    it('over the Hub integrations a manifest names variables for', async () => {
      const expected = await hubValue();
      const env = await generate(
        appInfo({
          categories: ['ai'],
          hub_integration: fromPartial({
            inference: { chat_model: name },
            inference_provider: { env: name, ollama: OTHER, openai_compatible: OTHER },
            oidc: { issuer_env: name },
            memory: { url_env: name, token_env: 'MEMORY_TOKEN' },
          }),
        }),
      );
      expect(env.get(name)).toBe(expected);
    });

    it('and sets none where the Hub sets none', async () => {
      // A local app with no port: no host for it and no LAN name.
      const local = appInfo({ port: undefined, exposable: false, form_fields: [field({ env_variable: name, default: OTHER })] });
      const expected = (await generate(appInfo({ port: undefined, exposable: false }), {})).get(name);
      expect((await generate(local, { [name]: OTHER })).get(name)).toBe(expected);
    });
  });

  // The staleness check compares the keys the inference block owns with app.env. One it can never
  // write would read as stale on every check.
  it('leaves the values it keeps out of the keys the inference block owns', async () => {
    const inference = await appHelpers.buildInferenceEnv('app', {
      categories: ['ai'],
      hub_integration: fromPartial({
        inference: { chat_model: 'APP_ID', embedding_model: 'EMBED_MODEL' },
        inference_provider: { env: 'APP_DOMAIN', ollama: OTHER, openai_compatible: OTHER },
      }),
    });
    expect(inference.ownedKeys).toContain('EMBED_MODEL');
    expect(inference.ownedKeys).not.toContain('APP_ID');
    expect(inference.ownedKeys).not.toContain('APP_DOMAIN');
    expect(inference.entries.has('APP_ID')).toBe(false);
    expect(inference.entries.has('APP_DOMAIN')).toBe(false);
  });

  it('inherits none of them from the Hub’s .env under a Memory variable name', async () => {
    filesystem.readTextFile.mockResolvedValue(`APP_LOCAL_DOMAIN=${OTHER}.hub.lan\nMEMORY_TOKEN=pinned\n`);
    const env = await generate(
      appInfo({ exposable: false, hub_integration: fromPartial({ memory: { url_env: 'APP_LOCAL_DOMAIN', token_env: 'MEMORY_TOKEN' } }) }),
      {},
    );
    expect(env.get('APP_LOCAL_DOMAIN')).toBeUndefined();
    expect(env.get('MEMORY_TOKEN')).toBe('pinned');
  });

  it('writes the variables the manifest names that the Hub doesn’t own', async () => {
    const env = await generate(
      appInfo({ form_fields: [field({ env_variable: 'SITE_NAME', default: 'My app' }), field({ env_variable: 'DOMAIN' })] }),
      { exposedLocal: true, DOMAIN: 'mail.example.org' },
    );
    expect(env.get('SITE_NAME')).toBe('My app');
    expect(env.get('DOMAIN')).toBe('mail.example.org');
  });

  it('derives the app’s host from its own address, not a form field’s', async () => {
    // An unpaired Hub has no platform address for the app, so its base URL falls back to the app's
    // own address, which an app with no port doesn't have.
    deviceRegistrationRepository.getFirstDeviceRegistration.mockResolvedValue(undefined);
    const env = await generate(
      appInfo({ port: undefined, form_fields: [field({ env_variable: 'APP_INTERNAL_AUTHORITY' }), field({ env_variable: 'APP_URL' })] }),
      {
        APP_INTERNAL_AUTHORITY: `${OTHER}.example.com:443`,
        APP_URL: `https://${OTHER}.example.com`,
      },
    );
    expect(env.get('APP_DOMAIN')).toBeUndefined();
    expect(env.get('APP_BASE_HOST')).toBeUndefined();
  });

  it('takes the base URL from the operator or the Hub, never a manifest default', async () => {
    const hub = (await generate(appInfo())).get('APP_BASE_HOST');

    const withDefault = await generate(
      appInfo({ form_fields: [field({ type: 'app_base_url', env_variable: 'APP_BASE_URL', default: `https://${OTHER}.example.com` })] }),
    );
    expect(withDefault.get('APP_BASE_HOST')).toBe(hub);

    const asAlias = await generate(
      appInfo({
        form_fields: [
          field({ type: 'app_base_url', env_variable: 'SITE_URL', alias_env_variables: ['APP_BASE_URL'], default: `https://${OTHER}.example.com` }),
        ],
      }),
    );
    expect(asAlias.get('APP_BASE_HOST')).toBe(hub);

    const plain = await generate(appInfo({ form_fields: [field({ env_variable: 'APP_BASE_URL', default: `https://${OTHER}.example.com` })] }));
    expect(plain.get('APP_BASE_HOST')).toBe(hub);

    // The operator's own address still counts.
    const typed = await generate(appInfo({ form_fields: [field({ type: 'app_base_url', env_variable: 'APP_BASE_URL' })] }), {
      exposedLocal: true,
      APP_BASE_URL: 'https://app.example.org',
    });
    expect(typed.get('APP_BASE_HOST')).toBe('app.example.org');
  });
});
