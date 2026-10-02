import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updatePreferences } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  updatePreferences,
}));

import { saveInferencePreferences } from '@/lib/inference/inference-api';

describe('saveInferencePreferences', () => {
  beforeEach(() => {
    updatePreferences.mockReset().mockResolvedValue({ data: {} });
  });

  it('sends null for a cleared model and vLLM key, and leaves an omitted field off the wire', async () => {
    await saveInferencePreferences({
      backend: 'vllm',
      model: null,
      embeddingModel: null,
      visionModel: 'llava',
      vllmApiKey: null,
    });

    const body = updatePreferences.mock.calls[0]?.[0]?.body;
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      backend: 'vllm',
      model: null,
      embeddingModel: null,
      visionModel: 'llava',
      vllmApiKey: null,
    });
  });

  it('sends a saved vLLM key when the caller provides one', async () => {
    await saveInferencePreferences({
      backend: 'ollama',
      model: 'llama3.2',
      embeddingModel: 'nomic-embed',
      visionModel: null,
      vllmApiKey: 'secret',
      vllmUrl: 'http://127.0.0.1:8000',
    });

    const body = updatePreferences.mock.calls[0]?.[0]?.body;
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({
      model: 'llama3.2',
      visionModel: null,
      vllmApiKey: 'secret',
      vllmUrl: 'http://127.0.0.1:8000',
    });
  });
});
