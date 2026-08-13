import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import axios from 'axios';
import { OpenClawConfigReconcileService } from '../openclaw-config-reconcile.service';
import { AppCredentialsService } from '../app-credentials.service';
import { LoggerService } from '@/core/logger/logger.service';

vi.mock('axios');
vi.mock('node:fs/promises');

describe('OpenClawConfigReconcileService', () => {
  let service: OpenClawConfigReconcileService;
  let appCredentials: MockProxy<AppCredentialsService>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        models: { providers: { 'ci-hub': { api: 'ollama', baseUrl: 'http://old:11434', models: [] } } },
        agents: { defaults: { model: { primary: 'ci-hub/qwen3.5:9b' }, models: { 'ci-hub/qwen3.5:9b': {} } } },
      }),
    );
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(axios.get).mockResolvedValue({
      data: { data: [{ id: 'Qwen/Qwen2.5-7B-Instruct' }] },
    });

    appCredentials = mock<AppCredentialsService>();
    appCredentials.getCredentials.mockResolvedValue({
      app: 'openclaw',
      apiVersion: 1,
      endpointUrl: 'http://host.docker.internal:8000/v1',
      endpointReady: true,
      chatModelId: 'Qwen/Qwen2.5-7B-Instruct',
      embeddingsModelId: null,
      chatModelReady: true,
      provider: 'vllm',
      env: {
        OPENAI_API_BASE: 'http://host.docker.internal:8000/v1',
        OPENAI_API_KEY: 'vllm-local',
        CI_LLM_NUM_CTX: '65536',
        CI_INFERENCE_BACKEND: 'vllm',
      },
      managedKeys: [],
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenClawConfigReconcileService,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: AppCredentialsService, useValue: appCredentials },
      ],
    }).compile();

    service = module.get(OpenClawConfigReconcileService);
  });

  it('patches live openclaw.json to openai-completions before restart', async () => {
    await service.reconcileBeforeRestart('openclaw:ci-marketplace' as never);

    expect(appCredentials.invalidateCache).toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledWith('http://host.docker.internal:8000/v1/models', {
      timeout: 5000,
      headers: { Authorization: 'Bearer vllm-local' },
    });

    const written = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.models.providers['ci-hub']).toMatchObject({
      baseUrl: 'http://host.docker.internal:8000/v1',
      apiKey: 'vllm-local',
      api: 'openai-completions',
    });
    expect(parsed.agents.defaults.model.primary).toBe('ci-hub/Qwen/Qwen2.5-7B-Instruct');
  });

  it('skips non-openclaw apps', async () => {
    await service.reconcileBeforeRestart('hermes-agent:ci-marketplace' as never);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
