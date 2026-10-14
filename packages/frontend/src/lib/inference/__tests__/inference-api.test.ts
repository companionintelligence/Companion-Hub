import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updatePreferences, getCloudProviders, clientDelete, getVllmStatus, getOnboardingProfile } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  getCloudProviders: vi.fn(),
  clientDelete: vi.fn(),
  getVllmStatus: vi.fn(),
  getOnboardingProfile: vi.fn(),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  updatePreferences,
  getCloudProviders,
  getVllmStatus,
  getOnboardingProfile,
}));

vi.mock('@/api-client/client.gen', () => ({
  client: { delete: clientDelete },
}));

import {
  fetchConfiguredCloudProviders,
  fetchInferenceOnboardingProfile,
  fetchVllmInstallStatus,
  removeCloudProviderConfig,
  saveInferencePreferences,
} from '@/lib/inference/inference-api';
import { MASKED_KEY } from '@/lib/inference/masked-key';

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
