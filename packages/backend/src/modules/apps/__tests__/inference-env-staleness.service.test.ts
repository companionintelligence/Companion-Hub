import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { AppInfo } from '@ci-hub/common/schemas';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { AppCredentialsService, type AppCredentialsConfig } from '@/modules/inference/app-credentials.service';
import { InferenceEnvResolver } from '@/modules/inference/inference-env-resolver';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';
import { InferenceEnvStalenessService } from '../inference-env-staleness.service';

const POOL_URL = 'http://ci-hub:3000/api/inference/pool';
const DIRECT_URL = 'http://ci-hub-ollama:11434';

// The marketplace's own hermes-agent mapping, so the comparison runs against the keys that ship.
const hermesInfo = {
  id: 'hermes-agent',
  categories: ['agents', 'ai'],
  hub_integration: {
    inference: {
      llm_base_url: 'HERMES_OPENAI_BASE_URL',
      llm_api_key: 'HERMES_OPENAI_API_KEY',
      chat_model: 'HERMES_DEFAULT_MODEL',
      embedding_model: 'HERMES_EMBEDDINGS_MODEL',
      ollama_host: 'OLLAMA_HOST',
      num_ctx: 'HERMES_NUM_CTX',
    },
  },
} as unknown as AppInfo;

const openclawInfo = { id: 'openclaw', categories: ['agents', 'ai'] } as unknown as AppInfo;

const envFile = (entries: Record<string, string>) =>
  Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

const handout = (overrides: Partial<AppCredentialsConfig>): AppCredentialsConfig => ({
  app: 'openclaw',
  apiVersion: 1,
  endpointUrl: `${DIRECT_URL}/v1`,
  endpointReady: true,
  chatModelId: 'gemma3:1b',
  embeddingsModelId: null,
  chatModelReady: true,
  provider: 'ollama',
  routedThroughPool: false,
  chatModelServedBy: [],
  chatModelError: null,
  prePull: [],
  env: { OPENAI_API_BASE: `${DIRECT_URL}/v1`, OPENAI_API_KEY: 'ollama', DEFAULT_MODEL: 'gemma3:1b' },
  managedKeys: ['OPENAI_API_BASE', 'OPENAI_API_KEY', 'DEFAULT_MODEL', 'CI_INFERENCE_ERROR'],
  ...overrides,
});

describe('InferenceEnvStalenessService', () => {
  let service: InferenceEnvStalenessService;
  let appFilesManager: MockProxy<AppFilesManager>;
  let inferenceEnv: MockProxy<InferenceEnvResolver>;
  let appCredentials: MockProxy<AppCredentialsService>;
  let config: MockProxy<ConfigurationService>;
  let filesystem: MockProxy<FilesystemService>;

  const hermesUrn = createAppUrn('hermes-agent', 'ci-marketplace');
  const openclawUrn = createAppUrn('openclaw', 'ci-marketplace');

  beforeEach(async () => {
    vi.clearAllMocks();
    // The real AppHelpers: `buildInferenceEnv` is the code that writes app.env, and the whole point
    // of the check is to compare against exactly that, not a restatement of its mapping rules.
    const moduleRef = await Test.createTestingModule({ providers: [AppHelpers] })
      .useMocker(mock)
      .compile();
    const appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    inferenceEnv = moduleRef.get(InferenceEnvResolver);
    config = moduleRef.get(ConfigurationService);
    filesystem = moduleRef.get(FilesystemService);
    appCredentials = mock<AppCredentialsService>();
    appCredentials.isSupported.mockImplementation(((slug: string) => slug === 'openclaw' || slug === 'hermes-agent') as never);

    config.getInferencePreferences.mockReturnValue({
      preferredBackend: 'ollama',
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
    });
    config.getConfig.mockReturnValue({ envFilePath: '/data/.env' } as never);
    filesystem.readTextFile.mockResolvedValue('');

    service = new InferenceEnvStalenessService(
      appFilesManager,
      appHelpers,
      new EnvUtils(),
      appCredentials,
      config,
      filesystem,
      mock<LoggerService>(),
    );
  });

  describe('apps whose inference env is baked into app.env', () => {
    beforeEach(() => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue(hermesInfo);
      // What core-4's hermes-agent held: generated before core-6 paired.
      appFilesManager.getAppEnv.mockResolvedValue({
        path: '/app-data/hermes-agent/app.env',
        content: envFile({
          HERMES_OPENAI_BASE_URL: `${DIRECT_URL}/v1`,
          HERMES_OPENAI_API_KEY: 'ollama',
          HERMES_DEFAULT_MODEL: 'gemma3:1b',
          OLLAMA_HOST: DIRECT_URL,
          HERMES_NUM_CTX: '32000',
        }),
      });
    });

    it('reports the app stale once the Hub would route it through the pool to a different model', async () => {
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: `${POOL_URL}/v1`,
        CI_LLM_API_KEY: 'ollama',
        CI_CHAT_MODEL: 'qwen3-coder:30b',
        OLLAMA_HOST: POOL_URL,
        CI_LLM_NUM_CTX: '64000',
      });

      const result = await service.check(hermesUrn);

      expect(result).toMatchObject({
        aiApp: true,
        stale: true,
        basis: ['app-env'],
        generated: { routedThroughPool: false, chatModel: 'gemma3:1b', error: null },
        current: { routedThroughPool: true, chatModel: 'qwen3-coder:30b', error: null },
        wouldRemoveEndpoint: false,
      });
      expect(result.reasons).toEqual(['routing: direct -> pool', 'chat model: gemma3:1b -> qwen3-coder:30b']);
      expect(result.differences).toEqual(['HERMES_DEFAULT_MODEL', 'HERMES_NUM_CTX', 'HERMES_OPENAI_BASE_URL', 'OLLAMA_HOST']);
      // Resolved for this app, so its requirements applied to the "current" side as they would on regeneration.
      expect(inferenceEnv.resolve).toHaveBeenCalledWith({ appSlug: 'hermes-agent', minContextLength: 64_000 });
    });

    it('reports the app current when a regeneration would write the same values', async () => {
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: `${DIRECT_URL}/v1`,
        CI_LLM_API_KEY: 'ollama',
        CI_CHAT_MODEL: 'gemma3:1b',
        OLLAMA_HOST: DIRECT_URL,
        CI_LLM_NUM_CTX: '32000',
      });

      const result = await service.check(hermesUrn);

      expect(result).toMatchObject({ stale: false, differences: [], reasons: [] });
    });

    it('does not call a key stale that the resolver leaves unset and the Hub .env supplies', async () => {
      filesystem.readTextFile.mockResolvedValue(`OLLAMA_HOST=${DIRECT_URL}\n`);
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: `${DIRECT_URL}/v1`,
        CI_LLM_API_KEY: 'ollama',
        CI_CHAT_MODEL: 'gemma3:1b',
        CI_LLM_NUM_CTX: '32000',
      });

      const result = await service.check(hermesUrn);

      expect(result.stale).toBe(false);
    });

    it('flags a regeneration that would strip the inference endpoint, so no automatic restart does it', async () => {
      inferenceEnv.resolve.mockResolvedValue({});

      const result = await service.check(hermesUrn);

      expect(result).toMatchObject({ stale: true, wouldRemoveEndpoint: true });
    });

    it('surfaces the explicit error the app would be handed in place of a model', async () => {
      inferenceEnv.resolve.mockResolvedValue({
        CI_LLM_BASE_URL: `${POOL_URL}/v1`,
        CI_LLM_API_KEY: 'ollama',
        OLLAMA_HOST: POOL_URL,
        CI_INFERENCE_ERROR: "No chat model served by this Hub's pool meets hermes-agent's requirements.",
      });

      const result = await service.check(hermesUrn);

      expect(result.current).toEqual({
        routedThroughPool: true,
        chatModel: null,
        error: "No chat model served by this Hub's pool meets hermes-agent's requirements.",
      });
      expect(result.differences).toContain('CI_INFERENCE_ERROR');
    });
  });

  describe('apps that bootstrap their inference config over HTTP', () => {
    beforeEach(() => {
      appFilesManager.getInstalledAppInfo.mockResolvedValue(openclawInfo);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/app-data/openclaw/app.env', content: '' });
      inferenceEnv.resolve.mockResolvedValue({ CI_LLM_BASE_URL: `${POOL_URL}/v1` });
    });

    it('compares the handout openclaw last fetched with the one it would get now, by key name only', async () => {
      appCredentials.lastHandout.mockReturnValue({ config: handout({}), servedAt: '2026-09-17T09:00:00.000Z' });
      appCredentials.previewCredentials.mockResolvedValue(
        handout({
          endpointUrl: `${POOL_URL}/v1`,
          routedThroughPool: true,
          chatModelId: 'qwen3-coder:30b',
          env: { OPENAI_API_BASE: `${POOL_URL}/v1`, OPENAI_API_KEY: 'ollama', DEFAULT_MODEL: 'qwen3-coder:30b' },
        }),
      );

      const result = await service.check(openclawUrn);

      expect(result).toMatchObject({
        stale: true,
        basis: ['app-env', 'bootstrap-handout'],
        differences: ['DEFAULT_MODEL', 'OPENAI_API_BASE'],
        reasons: ['routing: direct -> pool', 'chat model: gemma3:1b -> qwen3-coder:30b'],
      });
      expect(JSON.stringify(result)).not.toContain('sk-');
      // A check never starts a download or records a handout: preview, not getCredentials.
      expect(appCredentials.getCredentials).not.toHaveBeenCalled();
    });

    it('treats an app with no recorded handout as stale, because the Hub cannot vouch for it', async () => {
      appCredentials.lastHandout.mockReturnValue(null);
      appCredentials.previewCredentials.mockResolvedValue(handout({}));

      const result = await service.check(openclawUrn);

      expect(result.stale).toBe(true);
      expect(result.generated).toBeNull();
      expect(result.reasons[0]).toContain('has fetched no bootstrap.env since this Hub started');
    });

    it('reports current when the recorded handout matches', async () => {
      appCredentials.lastHandout.mockReturnValue({ config: handout({}), servedAt: '2026-09-17T09:00:00.000Z' });
      appCredentials.previewCredentials.mockResolvedValue(handout({}));

      expect((await service.check(openclawUrn)).stale).toBe(false);
    });
  });

  it('answers aiApp=false, and resolves nothing, for an app the Hub hands no inference config', async () => {
    appFilesManager.getInstalledAppInfo.mockResolvedValue({ id: 'mealie', categories: ['utilities'] } as unknown as AppInfo);

    const result = await service.check(createAppUrn('mealie', 'ci-marketplace'));

    expect(result).toMatchObject({ aiApp: false, stale: false });
    expect(inferenceEnv.resolve).not.toHaveBeenCalled();
  });
});
