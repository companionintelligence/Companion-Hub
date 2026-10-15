import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updatePreferences, getCloudProviders, clientDelete, getVllmStatus, getOnboardingProfile, loadModel, unloadModel, pinModel, unpinModel } =
  vi.hoisted(() => ({
    updatePreferences: vi.fn(),
    getCloudProviders: vi.fn(),
    clientDelete: vi.fn(),
    getVllmStatus: vi.fn(),
    getOnboardingProfile: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
    pinModel: vi.fn(),
    unpinModel: vi.fn(),
  }));

vi.mock('@/api-client/sdk.gen', () => ({
  updatePreferences,
  getCloudProviders,
  getVllmStatus,
  getOnboardingProfile,
  loadModel,
  unloadModel,
  pinModel,
  unpinModel,
}));

vi.mock('@/api-client/client.gen', () => ({
  client: { delete: clientDelete },
}));

import {
  fetchConfiguredCloudProviders,
  fetchInferenceOnboardingProfile,
  fetchVllmInstallStatus,
  loadInferenceModel,
  pinInferenceModel,
  removeCloudProviderConfig,
  saveInferencePreferences,
  unloadInferenceModel,
  unpinInferenceModel,
} from '@/lib/inference/inference-api';
import { MASKED_KEY } from '@/lib/inference/masked-key';

// The generated SDK types `loadModel`'s body from the backend's request DTO. These wrappers once
// cast the call past that type, which also hid a body the route did not document; they call the SDK
// directly now, and what they put on the wire is checked here.
describe('model load, unload and pin', () => {
  beforeEach(() => {
    for (const call of [loadModel, unloadModel, pinModel, unpinModel]) {
      call.mockReset().mockResolvedValue({ data: { success: true } });
    }
  });

  it('loads a model on the engine the caller names, sending both in the body', async () => {
    await loadInferenceModel('qwen3:8b', 'ollama');

    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledWith({ body: { modelId: 'qwen3:8b', backend: 'ollama' } });
  });

  it('reports a load the Hub refused with 201 and success: false, as the pin does', async () => {
    loadModel.mockResolvedValue({ data: { success: false, message: 'qwen3:8b does not fit on this card' } });

    await expect(loadInferenceModel('qwen3:8b', 'ollama')).rejects.toThrow('qwen3:8b does not fit on this card');
  });

  it('names the model in a refused load that gave no reason', async () => {
    loadModel.mockResolvedValue({ data: { success: false } });

    await expect(loadInferenceModel('qwen3:8b', 'vllm')).rejects.toThrow('Could not load qwen3:8b');
  });

  it('reports a load the Hub answered with an error', async () => {
    loadModel.mockResolvedValue({ error: { message: ['modelId must be a string'] } });

    await expect(loadInferenceModel('qwen3:8b', 'omlx')).rejects.toThrow('modelId must be a string');
  });

  it('unloads with the engine when the caller names one, and leaves it off the wire when not', async () => {
    await unloadInferenceModel('user.Qwen3-8B', 'lemonade');
    await unloadInferenceModel('qwen3:8b');

    expect(unloadModel.mock.calls.map(([options]) => options.body)).toEqual([
      { modelId: 'user.Qwen3-8B', backend: 'lemonade' },
      { modelId: 'qwen3:8b' },
    ]);
  });

  it('pins and unpins by model id alone', async () => {
    await pinInferenceModel('qwen3:8b');
    await unpinInferenceModel('qwen3:8b');

    expect(pinModel).toHaveBeenCalledWith({ body: { modelId: 'qwen3:8b' } });
    expect(unpinModel).toHaveBeenCalledWith({ body: { modelId: 'qwen3:8b' } });
  });

  it('reports a pin the Hub refused with 201 and success: false', async () => {
    pinModel.mockResolvedValue({ data: { success: false, message: 'over the pin budget' } });

    await expect(pinInferenceModel('qwen3:8b')).rejects.toThrow('over the pin budget');
  });
});

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

  // A provider moved to another server without a key read as never set up. A key entered for it went
  // to that server.
  it('lists a provider set to another server with or without a key, with its URL', async () => {
    getCloudProviders.mockResolvedValue({
      data: [
        { provider: 'openai', configured: true, enabled: true, defaultModel: 'gpt-4o', baseUrl: 'https://llm-proxy.example.test/v1' },
        {
          provider: 'anthropic',
          configured: false,
          enabled: true,
          defaultModel: 'claude-opus-4',
          baseUrl: 'https://llm-proxy.example.test/anthropic',
        },
        { provider: 'google', configured: false, enabled: false, defaultModel: 'gemini-2.5-pro' },
      ],
    });

    const providers = await fetchConfiguredCloudProviders();

    expect(providers).toEqual([
      { provider: 'openai', apiKey: '••••••••', enabled: true, stored: true, baseUrl: 'https://llm-proxy.example.test/v1' },
      { provider: 'anthropic', apiKey: '', enabled: true, baseUrl: 'https://llm-proxy.example.test/anthropic' },
    ]);
    // Marked as stored, an empty field would be deleted by the next save.
    expect(providers[1]).not.toHaveProperty('stored');
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

// Settings > AI shows a stored vLLM key as the mask. A Re-check then probes with the key the Hub
// stored, so the mask itself is never sent as a key.
describe('vLLM probes', () => {
  beforeEach(() => {
    getVllmStatus.mockReset().mockResolvedValue({ data: {} });
    getOnboardingProfile.mockReset().mockResolvedValue({ data: {} });
  });

  it('send a key that was typed in', async () => {
    await fetchVllmInstallStatus('http://127.0.0.1:8000', 'typed-key');
    await fetchInferenceOnboardingProfile('vllm', 'http://127.0.0.1:8000', 'typed-key');

    expect(getVllmStatus.mock.calls[0]?.[0]?.headers).toEqual({ 'x-ci-vllm-api-key': 'typed-key' });
    expect(getOnboardingProfile.mock.calls[0]?.[0]?.headers).toEqual({ 'x-ci-vllm-api-key': 'typed-key' });
  });

  it('send no key when the field still shows the mask', async () => {
    await fetchVllmInstallStatus('http://127.0.0.1:8000', MASKED_KEY);
    await fetchInferenceOnboardingProfile('vllm', 'http://127.0.0.1:8000', MASKED_KEY);

    expect(getVllmStatus.mock.calls[0]?.[0]?.headers).toBeUndefined();
    expect(getOnboardingProfile.mock.calls[0]?.[0]?.headers).toBeUndefined();
  });

  // The header value is trimmed, so the check is too: sent, the mask's dots make fetch throw.
  it('send no key for a mask with a stray space around it', async () => {
    await fetchVllmInstallStatus('http://127.0.0.1:8000', ` ${MASKED_KEY}`);

    expect(getVllmStatus.mock.calls[0]?.[0]?.headers).toBeUndefined();
  });
});
