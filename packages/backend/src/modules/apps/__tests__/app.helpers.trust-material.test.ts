import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { ApiKeyService } from '@/modules/api-keys/api-key.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers, hubTrustMaterialScopes } from '../app.helpers';
import { AppsRepository } from '../apps.repository';

/**
 * Trust-material provisioning matrix (CI-Engineering#74): which apps receive the managed
 * callback key (HUB_APP_KEY), with which scopes, and which receive a per-app forward-auth
 * secret — and, just as load-bearing, which receive NOTHING (third-party stores).
 */
describe('AppHelpers trust material (#74)', () => {
  let appHelpers: AppHelpers;
  let appFilesManager: MockProxy<AppFilesManager>;
  let config: MockProxy<ConfigurationService>;
  let envUtils: MockProxy<EnvUtils>;
  let apiKeys: MockProxy<ApiKeyService>;
  let appsRepository: MockProxy<AppsRepository>;
  let envMap: Map<string, string>;

  const officialConsumerUrn: AppUrn = createAppUrn('importer', 'ci-marketplace');
  const thirdPartyUrn: AppUrn = createAppUrn('importer', 'sketchy-store');
  const providerUrn: AppUrn = createAppUrn('ci-memory', 'ci-marketplace');

  const baseInfo = (urn: AppUrn, hubIntegration: AppInfo['hub_integration']): AppInfo =>
    fromPartial<AppInfo>({
      id: urn.split(':')[0],
      urn,
      name: 'Fixture App',
      port: 9091,
      exposable: true,
      form_fields: [],
      hub_integration: hubIntegration,
    });

  const memoryConsumer = { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } };

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({ providers: [AppHelpers] })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    config = moduleRef.get(ConfigurationService);
    envUtils = moduleRef.get(EnvUtils);
    apiKeys = moduleRef.get(ApiKeyService);
    appsRepository = moduleRef.get(AppsRepository);
    appsRepository.getAppMcpAccess.mockResolvedValue(null);
    const filesystem = moduleRef.get<MockProxy<FilesystemService>>(FilesystemService);
    const registrationService = moduleRef.get<MockProxy<RegistrationService>>(RegistrationService);

    config.getConfig.mockReturnValue(
      fromPartial({
        internalIp: '192.168.1.10',
        envFilePath: '/data/.env',
        rootFolderHost: '/opt/ci-hub',
        domain: 'example.com',
        ciHubApiKey: 'hub-api-key',
        userSettings: { appDataPath: '/opt/ci-hub', domain: 'example.com' },
      }),
    );
    envMap = new Map<string, string>();
    envUtils.envStringToMap.mockImplementation(() => envMap);
    envUtils.envMapToString.mockReturnValue('');
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: '' });
    filesystem.readTextFile.mockResolvedValue('');
    registrationService.getDeviceId.mockResolvedValue('hub-device-id');
    apiKeys.provisionManagedKey.mockResolvedValue('minted-managed-key');
  });

  const run = async (urn: AppUrn, hubIntegration: AppInfo['hub_integration']) => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue(baseInfo(urn, hubIntegration));
    await appHelpers.generateEnvFile(urn, {});
  };

  it("official-store memory consumer: HUB_APP_KEY ('app' scope) + HUB_URL + CI_APP_URN + per-app forward-auth secret", async () => {
    await run(officialConsumerUrn, memoryConsumer);

    expect(apiKeys.provisionManagedKey).toHaveBeenCalledTimes(1);
    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ appUrn: officialConsumerUrn, scopes: ['app'] }));
    expect(envMap.get('HUB_APP_KEY')).toBe('minted-managed-key');
    expect(envMap.get('HUB_URL')).toBe('http://ci-hub:3000');
    expect(envMap.get('CI_APP_URN')).toBe(officialConsumerUrn);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_ENABLED')).toBe('true');
    // Freshly minted per-app secret: 64 hex chars, never the Hub-global value.
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toMatch(/^[a-f0-9]{64}$/);
    // No MCP surface was granted.
    expect(envMap.has('HUB_MCP_API_KEY')).toBe(false);
    expect(envMap.has('HUB_MCP_URL')).toBe(false);
  });

  it('official-store oidc-only consumer receives the same callback material', async () => {
    await run(officialConsumerUrn, { oidc: { issuer_env: 'PORTAL_OIDC_ISSUER' } } as never);

    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['app'] }));
    expect(envMap.get('HUB_APP_KEY')).toBe('minted-managed-key');
    expect(envMap.get('CI_APP_URN')).toBe(officialConsumerUrn);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_ENABLED')).toBe('true');
  });

  it('third-party-store app with an IDENTICAL manifest receives neither credential', async () => {
    await run(thirdPartyUrn, memoryConsumer);

    expect(apiKeys.provisionManagedKey).not.toHaveBeenCalled();
    expect(envMap.has('HUB_APP_KEY')).toBe(false);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_SECRET')).toBe(false);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_ENABLED')).toBe(false);
  });

  it('mcp_client + memory (Hermes-style): ONE key with both scopes, same raw value under both env names', async () => {
    appsRepository.getAppMcpAccess.mockResolvedValue('write');
    await run(officialConsumerUrn, { mcp_client: true, wake_endpoint: '/hooks/wake', sse_events: false, ...memoryConsumer } as never);

    expect(apiKeys.provisionManagedKey).toHaveBeenCalledTimes(1);
    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['mcp', 'app'] }));
    expect(envMap.get('HUB_MCP_API_KEY')).toBe('minted-managed-key');
    expect(envMap.get('HUB_APP_KEY')).toBe('minted-managed-key');
    expect(envMap.get('HUB_MCP_URL')).toBe('http://ci-hub:3000/api/mcp');
  });

  it("a granted mcp_client-only app (any store): ['mcp'] scope, no HUB_APP_KEY, no forward-auth secret", async () => {
    appsRepository.getAppMcpAccess.mockResolvedValue('write');
    await run(thirdPartyUrn, { mcp_client: true, wake_endpoint: '/hooks/wake', sse_events: false } as never);

    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['mcp'] }));
    expect(envMap.get('HUB_MCP_API_KEY')).toBe('minted-managed-key');
    expect(envMap.has('HUB_APP_KEY')).toBe(false);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_SECRET')).toBe(false);
  });

  it("SECURITY: Hermes-style app nobody granted MCP access keeps only its 'app' scope", async () => {
    await run(officialConsumerUrn, { mcp_client: true, ...memoryConsumer } as never);

    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['app'] }));
    expect(envMap.get('HUB_APP_KEY')).toBe('minted-managed-key');
    expect(envMap.has('HUB_MCP_API_KEY')).toBe(false);
    expect(envMap.has('HUB_MCP_URL')).toBe(false);
  });

  it('preserves an existing per-app forward-auth secret across env regeneration (no churn)', async () => {
    // The base Hub .env and the app's own app.env must be distinct maps here: the strip
    // loop deletes the var from the base map, while preservation reads the app's map.
    const existingAppEnv = new Map<string, string>([['CI_HUB_FORWARD_AUTH_SECRET', 'a'.repeat(64)]]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
    envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? existingAppEnv : envMap));

    await run(officialConsumerUrn, memoryConsumer);

    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toBe('a'.repeat(64));
  });

  it('replaces an existing forward-auth secret that is the Hub-wide one with a key of its own', async () => {
    // An older Hub copied its .env into app envs, so a consumer can still hold the Hub-wide value.
    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'hub-global-secret' : undefined) as never);
    const existingAppEnv = new Map<string, string>([['CI_HUB_FORWARD_AUTH_SECRET', 'hub-global-secret']]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
    envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? existingAppEnv : envMap));

    await run(officialConsumerUrn, memoryConsumer);

    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('passes the existing HUB_APP_KEY (falling back to legacy HUB_MCP_API_KEY) as the preserve candidate', async () => {
    // The legacy key is in the app's own app.env (distinct from the Hub .env
    // seed, which is allowlisted and never carries a managed key).
    const existingAppEnv = new Map<string, string>([['HUB_MCP_API_KEY', 'legacy-raw-key']]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
    envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? existingAppEnv : envMap));
    await run(officialConsumerUrn, { mcp_client: true, wake_endpoint: '/hooks/wake', sse_events: false, ...memoryConsumer } as never);
    expect(apiKeys.provisionManagedKey).toHaveBeenCalledWith(expect.objectContaining({ existingRawKey: 'legacy-raw-key' }));
  });

  // Its connect calls (both ways) are signed with this key. It used to be the Hub-wide secret, so
  // anything inside a Memory container held a key the Hub's own endpoints took.
  it('the memory PROVIDER gets a connect key of its own, never the Hub-wide secret', async () => {
    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'hub-global-secret' : undefined) as never);
    await run(providerUrn, { memory: { provider: { service: 'gateway', port: 8642 } } } as never);

    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toMatch(/^[a-f0-9]{64}$/);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).not.toBe('hub-global-secret');
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).not.toBe(envMap.get('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET'));
    expect(envMap.get('CI_HUB_FORWARD_AUTH_ENABLED')).toBe('true');
    // The provider declares no consumer/oidc integration → no callback key.
    expect(apiKeys.provisionManagedKey).not.toHaveBeenCalled();
    expect(envMap.has('HUB_APP_KEY')).toBe(false);
  });

  it('the memory PROVIDER also gets a forward-auth key of its own and its URN, the audience of its bound assertion', async () => {
    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'hub-global-secret' : undefined) as never);
    await run(providerUrn, { memory: { provider: { service: 'gateway', port: 8642 } } } as never);

    expect(envMap.get('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET')).toMatch(/^[a-f0-9]{64}$/);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET')).not.toBe('hub-global-secret');
    expect(envMap.get('CI_APP_URN')).toBe(providerUrn);
  });

  it("keeps the memory PROVIDER's connect key across env regeneration, and replaces an older Hub's Hub-wide copy", async () => {
    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'hub-global-secret' : undefined) as never);
    const kept = new Map<string, string>([['CI_HUB_FORWARD_AUTH_SECRET', 'c'.repeat(64)]]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
    envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? kept : envMap));

    await run(providerUrn, { memory: { provider: { service: 'gateway', port: 8642 } } } as never);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toBe('c'.repeat(64));

    envMap.clear();
    kept.set('CI_HUB_FORWARD_AUTH_SECRET', 'hub-global-secret');
    await run(providerUrn, { memory: { provider: { service: 'gateway', port: 8642 } } } as never);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).toMatch(/^[a-f0-9]{64}$/);
    expect(envMap.get('CI_HUB_FORWARD_AUTH_SECRET')).not.toBe('hub-global-secret');
  });

  it("preserves the memory PROVIDER's own key across env regeneration, so the running Memory and the Hub keep agreeing", async () => {
    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'hub-global-secret' : undefined) as never);
    const existingAppEnv = new Map<string, string>([['CI_HUB_FORWARD_AUTH_IDENTITY_SECRET', 'b'.repeat(64)]]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/data/app.env', content: 'EXISTING' });
    envUtils.envStringToMap.mockImplementation((content?: string) => (content === 'EXISTING' ? existingAppEnv : envMap));

    await run(providerUrn, { memory: { provider: { service: 'gateway', port: 8642 } } } as never);

    expect(envMap.get('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET')).toBe('b'.repeat(64));
  });

  it('gives no other app the identity key, first-party consumers and third-party apps alike', async () => {
    await run(officialConsumerUrn, memoryConsumer);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET')).toBe(false);

    envMap.clear();
    await run(createAppUrn('ci-memory', 'sketchy-store'), { memory: { provider: { service: 'gateway', port: 8642 } } } as never);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_IDENTITY_SECRET')).toBe(false);
    expect(envMap.has('CI_HUB_FORWARD_AUTH_SECRET')).toBe(false);
  });
});

/**
 * The single trust-material gate, unit-tested directly. generateEnvFile and HubAccessService both
 * read what to grant / what to report from this one function, so its truth table is asserted here
 * rather than only inferred through the injection matrix above.
 */
describe('hubTrustMaterialScopes', () => {
  const info = (urn: string, hubIntegration: AppInfo['hub_integration']): Pick<AppInfo, 'urn' | 'hub_integration'> => ({
    urn: urn as AppUrn,
    hub_integration: hubIntegration,
  });
  const memory = { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } };

  it("grants 'app' only to an official-store consumer, and nothing to the same manifest from a third-party store", () => {
    expect(hubTrustMaterialScopes(info(createAppUrn('importer', 'ci-marketplace'), memory), null)).toEqual(['app']);
    expect(hubTrustMaterialScopes(info(createAppUrn('importer', 'sketchy-store'), memory), null)).toEqual([]);
  });

  it("grants 'mcp' from any store once a person granted it, and both when both apply", () => {
    expect(hubTrustMaterialScopes(info(createAppUrn('agent', 'sketchy-store'), { mcp_client: true }), 'read')).toEqual(['mcp']);
    expect(hubTrustMaterialScopes(info(createAppUrn('hermes', 'ci-marketplace'), { mcp_client: true, ...memory }), 'write')).toEqual(['mcp', 'app']);
  });

  it.each([null, undefined, 'none', 'nonsense'])("SECURITY: grants no 'mcp' for the answer %s, official store or not", (access) => {
    expect(hubTrustMaterialScopes(info(createAppUrn('agent', 'sketchy-store'), { mcp_client: true }), access)).toEqual([]);
    expect(hubTrustMaterialScopes(info(createAppUrn('hermes', 'ci-marketplace'), { mcp_client: true, ...memory }), access)).toEqual(['app']);
  });

  it('grants nothing to a plain app and never throws on a malformed URN', () => {
    expect(hubTrustMaterialScopes(info(createAppUrn('plain', 'ci-marketplace'), undefined), 'write')).toEqual([]);
    expect(hubTrustMaterialScopes(info('not-a-urn', memory), null)).toEqual([]);
  });
});
