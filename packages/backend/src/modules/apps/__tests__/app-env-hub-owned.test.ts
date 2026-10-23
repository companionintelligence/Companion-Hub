import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
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
import { AppHelpers, appInheritableHubEnvKeys } from '../app.helpers';

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
  let logger = mock<LoggerService>();
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
    logger = moduleRef.get(LoggerService);

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

  /*
   * An app installed before a field that writes APP_BASE_URL lost its default has that default in
   * app.env, and in the form the install dialog saved. The installed manifest is read without it
   * (parseInstalledAppInfo), and a value that is still that default goes too.
   */
  describe('a base URL that is still the default the installed manifest gave it', () => {
    const DEFAULT = 'http://ci-hub.local';
    const baseUrlField = field({ type: 'app_base_url', env_variable: 'APP_BASE_URL', alias_env_variables: ['NEXTAUTH_URL'] });
    const logged = (level: 'warn' | 'info') => logger[level].mock.calls.map(([line]) => String(line));

    beforeEach(() => {
      appFilesManager.getInstalledBaseUrlDefaults.mockResolvedValue(new Map([['APP_BASE_URL', DEFAULT]]));
    });

    const hubAddress = async () => {
      const env = await generate(appInfo({ form_fields: [baseUrlField] }));
      logger.warn.mockClear();
      logger.info.mockClear();
      return { url: env.get('APP_BASE_URL'), host: env.get('APP_BASE_HOST') };
    };

    it('gives the app the Hub’s address in place of the one app.env still holds', async () => {
      const hub = await hubAddress();
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: `APP_BASE_URL=${DEFAULT}/\nAPP_BASE_HOST=ci-hub.local\n` });

      const env = await generate(appInfo({ form_fields: [baseUrlField] }));

      expect(hub.host).toBe('app-home-acme.example.com');
      expect([env.get('APP_BASE_URL'), env.get('APP_BASE_HOST'), env.get('NEXTAUTH_URL')]).toEqual([hub.url, hub.host, hub.url]);
      expect(logged('warn')).toContainEqual(expect.stringContaining('APP_BASE_URL held the default its installed manifest gave it'));
    });

    it('gives the app the Hub’s address in place of the one its saved form holds', async () => {
      const hub = await hubAddress();
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: `APP_BASE_URL=${DEFAULT}\n` });

      const base = await generate(appInfo({ form_fields: [baseUrlField] }), { exposedLocal: true, APP_BASE_URL: DEFAULT });
      const plain = await generate(appInfo({ form_fields: [field({ env_variable: 'APP_BASE_URL' })] }), {
        exposedLocal: true,
        APP_BASE_URL: DEFAULT,
      });

      expect([base.get('APP_BASE_URL'), base.get('APP_BASE_HOST')]).toEqual([hub.url, hub.host]);
      expect([plain.get('APP_BASE_URL'), plain.get('APP_BASE_HOST')]).toEqual([hub.url, hub.host]);
    });

    it('says nothing more once app.env holds the Hub’s address', async () => {
      await generate(appInfo({ form_fields: [baseUrlField] }), { exposedLocal: true, APP_BASE_URL: DEFAULT });
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: written });
      logger.warn.mockClear();
      logger.info.mockClear();

      await generate(appInfo({ form_fields: [baseUrlField] }), { exposedLocal: true, APP_BASE_URL: DEFAULT });

      expect([...logged('warn'), ...logged('info')].filter((line) => line.includes('APP_BASE_URL'))).toEqual([]);
    });

    it('keeps a value the person entered, in the form or in app.env', async () => {
      const typed = await generate(appInfo({ form_fields: [baseUrlField] }), { exposedLocal: true, APP_BASE_URL: 'https://app.example.org' });
      expect([typed.get('APP_BASE_URL'), typed.get('APP_BASE_HOST')]).toEqual(['https://app.example.org', 'app.example.org']);
      expect(logged('info')).toContainEqual(expect.stringContaining('APP_BASE_URL keeps the value the person entered'));
      expect(logged('warn').filter((line) => line.includes('APP_BASE_URL held'))).toEqual([]);

      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: 'APP_BASE_URL=https://app.example.org\n' });
      const carried = await generate(appInfo({ form_fields: [baseUrlField] }));
      expect(carried.get('APP_BASE_HOST')).toBe('app.example.org');

      const plain = await generate(appInfo({ form_fields: [field({ env_variable: 'APP_BASE_URL' })] }), {
        exposedLocal: true,
        APP_BASE_URL: 'https://app.example.org',
      });
      expect(plain.get('APP_BASE_HOST')).toBe('app.example.org');
    });

    it('goes by the installed manifest’s own default only', async () => {
      appFilesManager.getInstalledBaseUrlDefaults.mockResolvedValue(new Map());
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: `APP_BASE_URL=${DEFAULT}\n` });

      expect((await generate(appInfo({ form_fields: [baseUrlField] }))).get('APP_BASE_HOST')).toBe('ci-hub.local');

      // Another field's default doesn't count for this one.
      appFilesManager.getInstalledBaseUrlDefaults.mockResolvedValue(new Map([['DOCS_URL', DEFAULT]]));
      expect((await generate(appInfo({ form_fields: [baseUrlField] }))).get('APP_BASE_HOST')).toBe('ci-hub.local');
    });
  });

  /*
   * A Hub integration writes after the Hub has taken APP_BASE_HOST from APP_BASE_URL, and a base URL
   * field keeps what app.env holds, so the next env build would take the integration's host. The
   * manifest schema refuses APP_BASE_URL there; the env builder doesn't write it either.
   */
  describe('a Hub integration that names APP_BASE_URL', () => {
    const baseUrlField = field({ type: 'app_base_url', env_variable: 'APP_BASE_URL' });

    it.each([
      ['inference', { inference: { llm_base_url: 'APP_BASE_URL' } }],
      ['inference_provider', { inference_provider: { env: 'APP_BASE_URL', ollama: `http://${OTHER}`, openai_compatible: `http://${OTHER}` } }],
      ['oidc', { oidc: { issuer_env: 'APP_BASE_URL' } }],
      ['memory', { memory: { url_env: 'APP_BASE_URL', token_env: 'MEMORY_TOKEN' } }],
    ])('leaves the app its own address: %s', async (_name, integration) => {
      inferenceEnv.resolve.mockResolvedValue(fromPartial({ CI_LLM_BASE_URL: `http://${OTHER}:11434/v1`, CI_CHAT_MODEL: OTHER }));
      memoryConnection.getInjectableCreds.mockResolvedValue(fromPartial({ url: `https://${OTHER}.example.com`, token: OTHER }));
      const info = appInfo({ categories: ['ai'], form_fields: [baseUrlField], hub_integration: fromPartial(integration) });

      const first = await generate(info);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x/app.env', content: written });
      const second = await generate(info);

      expect(first.get('APP_BASE_URL')).toBe('https://app-home-acme.example.com');
      expect([second.get('APP_BASE_URL'), second.get('APP_BASE_HOST')]).toEqual(['https://app-home-acme.example.com', 'app-home-acme.example.com']);
    });

    it('leaves it out of the keys the inference block owns and of what an app inherits', async () => {
      const inference = await appHelpers.buildInferenceEnv('app', {
        categories: ['ai'],
        hub_integration: fromPartial({ inference: { llm_base_url: 'APP_BASE_URL', chat_model: 'LLM_MODEL' } }),
      });
      expect(inference.ownedKeys).toContain('LLM_MODEL');
      expect(inference.ownedKeys).not.toContain('APP_BASE_URL');

      const inherited = appInheritableHubEnvKeys({
        hub_integration: fromPartial({ memory: { url_env: 'APP_BASE_URL', token_env: 'MEMORY_TOKEN' } }),
      });
      expect(inherited.has('APP_BASE_URL')).toBe(false);
      expect(inherited.has('MEMORY_TOKEN')).toBe(true);
    });
  });
});
