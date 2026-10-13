import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updatePreferences, getCloudProviders, clientDelete } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  getCloudProviders: vi.fn(),
  clientDelete: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  updatePreferences,
  getCloudProviders,
}));

vi.mock('@/api-client/client.gen', () => ({
  client: { delete: clientDelete },
}));

import { fetchConfiguredCloudProviders, removeCloudProviderConfig, saveInferencePreferences } from '@/lib/inference/inference-api';

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

describe('cloud provider keys', () => {
  it('marks a provider that holds a key as saved, so Settings can offer to remove it', async () => {
    getCloudProviders.mockResolvedValue({
      data: [
        { provider: 'openai', configured: true, enabled: false },
        { provider: 'google', configured: false, enabled: false },
      ],
    });

    await expect(fetchConfiguredCloudProviders()).resolves.toEqual([{ provider: 'openai', apiKey: '••••••••', enabled: false, stored: true }]);
  });

  it('deletes a saved key at the route the Hub serves for it', async () => {
    clientDelete.mockResolvedValue({ data: { success: true, removed: true } });

    await removeCloudProviderConfig('github-copilot');

    expect(clientDelete).toHaveBeenCalledWith({ url: '/api/inference/cloud-providers/github-copilot' });
  });

  it('reports a failed delete instead of letting the save say it worked', async () => {
    clientDelete.mockResolvedValue({ error: { message: 'Failed to set user settings' } });

    await expect(removeCloudProviderConfig('openai')).rejects.toThrow('Failed to set user settings');
  });
});
