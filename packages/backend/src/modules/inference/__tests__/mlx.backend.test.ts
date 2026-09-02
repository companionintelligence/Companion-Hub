import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildMlxRemediation, MlxBackend, normalizeMlxBaseUrl, resolveMlxProbeUrl } from '../backends/mlx.backend';

vi.mock('axios');

describe('MlxBackend', () => {
  let backend: MlxBackend;
  let logger: MockProxy<LoggerService>;
  let configuration: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    logger = mock<LoggerService>();
    configuration = mock<ConfigurationService>();
    configuration.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredMlxUrl: null,
    });
    delete process.env.MLX_URL;

    const module: TestingModule = await Test.createTestingModule({
      providers: [MlxBackend, { provide: LoggerService, useValue: logger }, { provide: ConfigurationService, useValue: configuration }],
    }).compile();

    backend = module.get<MlxBackend>(MlxBackend);
  });

  afterEach(() => {
    delete process.env.MLX_URL;
  });

  it('normalizes a pasted OpenAI /v1 URL to the server origin', () => {
    expect(normalizeMlxBaseUrl('  http://host:8080/v1/  ')).toBe('http://host:8080');
  });

  it('rewrites loopback to the Docker host only for container probes', () => {
    expect(resolveMlxProbeUrl('http://127.0.0.1:8080/v1', true)).toBe('http://host.docker.internal:8080');
    expect(resolveMlxProbeUrl('http://127.0.0.1:8080/v1', false)).toBe('http://127.0.0.1:8080');
  });

  it('prefers the saved Settings URL over MLX_URL and the loopback default', () => {
    expect(backend.getBaseUrl()).toBe('http://127.0.0.1:8080');

    process.env.MLX_URL = 'http://10.0.0.5:8080';
    expect(backend.getBaseUrl()).toBe('http://10.0.0.5:8080');

    configuration.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredMlxUrl: 'http://192.168.1.50:8080/v1',
    });
    expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8080');
  });

  it('requires both MLX-LM health and the shared OpenAI model listing', async () => {
    const get = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/health')) return Promise.resolve({ data: { status: 'ok' } });
      return Promise.resolve({ data: { data: [{ id: 'mlx-community/Qwen3-8B-4bit' }, { id: 42 }] } });
    });
    (axios.get as never) = get;

    await expect(backend.healthCheck('http://192.168.1.50:8080/v1')).resolves.toEqual({
      running: true,
      healthy: true,
      modelsLoaded: ['mlx-community/Qwen3-8B-4bit'],
    });
    expect(get).toHaveBeenNthCalledWith(1, 'http://192.168.1.50:8080/health', { timeout: 5000 });
    expect(get).toHaveBeenNthCalledWith(2, 'http://192.168.1.50:8080/v1/models', { timeout: 5000 });
  });

  it('reports unavailable when either endpoint rejects', async () => {
    (axios.get as never) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(backend.healthCheck()).resolves.toEqual({
      running: false,
      healthy: false,
      modelsLoaded: [],
      error: 'ECONNREFUSED',
    });
  });

  it('maps the shared OpenAI model resources into Hub model info', async () => {
    (axios.get as never) = vi.fn().mockResolvedValue({ data: { data: [{ id: 'Qwen3-8B' }] } });

    await expect(backend.listModels()).resolves.toEqual([{ id: 'Qwen3-8B', name: 'Qwen3-8B', size: 0, loaded: true }]);
  });

  it('does not fake a pull API for MLX-LM and explains the startup lifecycle', async () => {
    const progress = vi.fn();

    await backend.pullModel('mlx-community/Qwen3-8B-4bit', progress);

    expect(progress).toHaveBeenCalledWith({ status: 'MLX models are downloaded when mlx_lm.server starts', percent: 100 });
    expect(logger.info).toHaveBeenCalledWith('[MLX] Model mlx-community/Qwen3-8B-4bit must be selected with mlx_lm.server --model and restarted');
  });

  it('provides native Apple Silicon remediation and declines Docker compose', () => {
    expect(buildMlxRemediation().command).toContain('mlx_lm.server --model');
    expect(() => backend.getDockerImage()).toThrow(/no Docker path/i);
    expect(() => backend.getComposeConfig()).toThrow(/Apple-Silicon-native/i);
  });
});
