import { Test } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { LocalAiBackend } from '../backends/localai.backend';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, get: vi.fn(), isAxiosError: actual.default.isAxiosError } };
});

const get = vi.mocked(axios.get);

describe('LocalAiBackend', () => {
  let backend: LocalAiBackend;
  const savedUrl = process.env.LOCALAI_URL;
  const savedKey = process.env.LOCALAI_API_KEY;

  beforeEach(async () => {
    delete process.env.LOCALAI_URL;
    delete process.env.LOCALAI_API_KEY;
    get.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [LocalAiBackend, { provide: LoggerService, useValue: mock<LoggerService>() }],
    }).compile();

    backend = moduleRef.get(LocalAiBackend);
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.LOCALAI_URL;
    else process.env.LOCALAI_URL = savedUrl;
    if (savedKey === undefined) delete process.env.LOCALAI_API_KEY;
    else process.env.LOCALAI_API_KEY = savedKey;
  });

  it('has type localai', () => {
    expect(backend.type).toBe('localai');
  });

  it('resolves base URL from environment when present', () => {
    process.env.LOCALAI_URL = 'http://192.168.1.100:8080';
    expect(backend.getBaseUrl()).toBe('http://192.168.1.100:8080');
  });

  it('reads API key from environment or parameter override', () => {
    expect(backend.getApiKey()).toBeUndefined();
    process.env.LOCALAI_API_KEY = 'secret-token';
    expect(backend.getApiKey()).toBe('secret-token');
    expect(backend.getApiKey('override-key')).toBe('override-key');
  });

  it('reports healthy with loaded models on successful /v1/models response', async () => {
    get.mockResolvedValueOnce({
      data: {
        object: 'list',
        data: [
          { id: 'qwen3-7b', object: 'model' },
          { id: 'whisper-base', object: 'model' },
        ],
      },
    });

    const status = await backend.healthCheck();
    expect(status.running).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.modelsLoaded).toEqual(['qwen3-7b', 'whisper-base']);
  });

  it('reports running false and healthy false when connection fails', async () => {
    get.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8080'));

    const status = await backend.healthCheck();
    expect(status.running).toBe(false);
    expect(status.healthy).toBe(false);
    expect(status.modelsLoaded).toEqual([]);
    expect(status.error).toContain('ECONNREFUSED');
  });

  it('lists models formatted as BackendModelInfo', async () => {
    get.mockResolvedValueOnce({
      data: {
        object: 'list',
        data: [{ id: 'qwen3-7b', object: 'model' }],
      },
    });

    const models = await backend.listModels();
    expect(models).toEqual([{ id: 'qwen3-7b', name: 'qwen3-7b', size: 0, loaded: true }]);
  });

  it('checks if a model is loaded via healthCheck', async () => {
    get.mockResolvedValue({
      data: {
        object: 'list',
        data: [{ id: 'qwen3-7b', object: 'model' }],
      },
    });

    expect(await backend.isModelLoaded('qwen3-7b')).toBe(true);
    expect(await backend.isModelLoaded('nonexistent')).toBe(false);
  });

  it('generates docker compose config with GPU reservations for nvidia', () => {
    const config = backend.getComposeConfig('nvidia');
    expect(config.image).toBe('localai/localai:latest');
    expect(config.deploy).toBeDefined();
  });

  it('generates docker compose config without GPU reservations for cpu', () => {
    const config = backend.getComposeConfig('none');
    expect(config.image).toBe('localai/localai:latest');
    expect(config.deploy).toBeUndefined();
  });
});
