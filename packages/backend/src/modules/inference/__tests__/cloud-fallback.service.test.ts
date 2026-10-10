import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { PassThrough } from 'node:stream';
import { InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import type { CloudProviderConfig } from '@ci-hub/common/types';
import { CloudFallbackService } from '../cloud-fallback.service';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { COMPLETION_TIMEOUT_MS, CONNECT_TIMEOUT_MS, firstByteBudgetMs } from '@/modules/hub-pool/hub-pool-budget';

// Only `post` is faked; `isAxiosError` stays real.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, post: vi.fn() } };
});

describe('CloudFallbackService.setProvider', () => {
  let service: CloudFallbackService;
  let configuration: ReturnType<typeof mock<ConfigurationService>>;

  beforeEach(() => {
    configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([]);
    configuration.setInferenceCloudProviders.mockResolvedValue([]);
    service = new CloudFallbackService(mock<LoggerService>(), configuration);
    service.onModuleInit();
  });

  it('backfills the canonical base URL when none is provided (onboarding path)', () => {
    // Onboarding POSTs only provider/apiKey/enabled (+ a defaulted model) — no baseUrl.
    service.setProvider({ provider: 'openai', apiKey: 'sk-test', enabled: true, defaultModel: 'gpt-4o' });

    const provider = service.getProvider('openai');
    expect(provider?.baseUrl).toBe('https://api.openai.com/v1');
    expect(provider?.defaultModel).toBe('gpt-4o');
  });

  it('respects an explicitly provided base URL', () => {
    service.setProvider({
      provider: 'anthropic',
      apiKey: 'sk-ant',
      enabled: true,
      defaultModel: 'claude-opus-4',
      baseUrl: 'https://proxy.internal/v1',
    });

    expect(service.getProvider('anthropic')?.baseUrl).toBe('https://proxy.internal/v1');
  });

  it('backfills a default model when one is missing', () => {
    service.setProvider({ provider: 'google', apiKey: 'key', enabled: true, defaultModel: '' });

    const provider = service.getProvider('google');
    expect(provider?.defaultModel).toBe('gemini-2.5-pro');
    expect(provider?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('keeps the stored API key when a later save omits it (masked Settings field)', () => {
    service.setProvider({ provider: 'openai', apiKey: 'sk-live', enabled: true, defaultModel: 'gpt-4o' });
    service.setProvider({ provider: 'openai', enabled: false, defaultModel: 'gpt-4o' });

    expect(service.getProvider('openai')?.apiKey).toBe('sk-live');
    expect(service.getProvider('openai')?.enabled).toBe(false);
  });

  it('answers only once the provider is in settings.json', async () => {
    // Settings > AI sends the preferences as soon as this answers, and both rewrite settings.json.
    let finishWrite = () => {};
    configuration.setInferenceCloudProviders.mockReturnValue(
      new Promise<CloudProviderConfig[]>((resolve) => {
        finishWrite = () => resolve([]);
      }),
    );
    let answered = false;

    const saving = (async () => {
      await service.setProvider({ provider: 'openai', enabled: true, defaultModel: 'gpt-4o' });
      answered = true;
    })();
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);

    finishWrite();
    await saving;
    expect(answered).toBe(true);
  });

  it('fails when the provider could not be saved, instead of answering as if it had been', async () => {
    configuration.setInferenceCloudProviders.mockRejectedValue(new InternalServerErrorException('Failed to set user settings'));

    await expect(service.setProvider({ provider: 'openai', apiKey: 'sk-live', enabled: true, defaultModel: 'gpt-4o' })).rejects.toThrow(
      'Failed to set user settings',
    );
  });

  it('reloads persisted providers on boot', () => {
    configuration.getInferenceCloudProviders.mockReturnValue([
      { provider: 'anthropic', apiKey: 'sk-ant', enabled: true, defaultModel: 'claude-opus-4', baseUrl: 'https://api.anthropic.com/v1' },
    ]);
    const booted = new CloudFallbackService(mock<LoggerService>(), configuration);
    booted.onModuleInit();

    expect(booted.getEnabledProviders()).toHaveLength(1);
    expect(booted.getProvider('anthropic')?.apiKey).toBe('sk-ant');
  });

  it('emits additive env for every enabled provider', () => {
    service.setProvider({ provider: 'openai', apiKey: 'sk-oai', enabled: true, defaultModel: 'gpt-4o' });
    service.setProvider({ provider: 'anthropic', apiKey: 'sk-ant', enabled: true, defaultModel: 'claude-opus-4' });
    service.setProvider({ provider: 'google', apiKey: 'g-key', enabled: false, defaultModel: 'gemini-2.5-pro' });

    expect(service.toAppEnv()).toEqual({
      CI_CLOUD_OPENAI_API_KEY: 'sk-oai',
      CI_CLOUD_OPENAI_BASE_URL: 'https://api.openai.com/v1',
      CI_CLOUD_OPENAI_MODEL: 'gpt-4o',
      CI_CLOUD_ANTHROPIC_API_KEY: 'sk-ant',
      CI_CLOUD_ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
      CI_CLOUD_ANTHROPIC_MODEL: 'claude-opus-4',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
  });
});

// ─── How long a cloud request may wait ───────────────
// Streamed cloud requests had axios's `timeout: 120000`. With axios's default follow-redirects
// transport that is also a socket idle timeout never cleared after the headers, so a reasoning
// model that went quiet for two minutes between frames lost a stream that had already answered
// 200. They now get the local path's treatment: `timeout: 0` and a header deadline, the pool's
// first-byte budget, cleared the moment the provider answers.
describe('CloudFallbackService — request budgets', () => {
  let service: CloudFallbackService;
  const post = vi.mocked(axios.post);
  const openai: CloudProviderConfig = {
    provider: 'openai',
    apiKey: 'sk-test',
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'o3',
  };
  const anthropic: CloudProviderConfig = {
    provider: 'anthropic',
    apiKey: 'sk-ant',
    enabled: true,
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-4',
  };
  const streamedTurn = { model: 'o3', stream: true, messages: [{ role: 'user', content: 'think hard' }] };

  beforeEach(() => {
    post.mockReset();
    const configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([]);
    service = new CloudFallbackService(mock<LoggerService>(), configuration);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A provider that never answers: the request settles only when its signal aborts it. */
  function providerThatNeverAnswers(): { signal: () => AbortSignal | undefined } {
    let signal: AbortSignal | undefined;
    post.mockImplementationOnce((_url, _body, config) => {
      signal = config?.signal as AbortSignal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('canceled'))));
    });
    return { signal: () => signal };
  }

  /** A provider that answers after `headersAfterMs` with `upstream` as the body; returns the config it was sent. */
  function providerAnsweringAfter(headersAfterMs: number, upstream: PassThrough): () => { signal?: AbortSignal; timeout?: number } | undefined {
    let config: { signal?: AbortSignal; timeout?: number } | undefined;
    post.mockImplementationOnce(async (_url, _body, cfg) => {
      config = cfg as typeof config;
      await new Promise((resolve) => setTimeout(resolve, headersAfterMs));
      return { data: upstream, headers: {} };
    });
    return () => config;
  }

  it.each([
    ['an OpenAI-compatible provider', openai],
    ['Anthropic', anthropic],
  ])('never cuts a stream from %s that pauses longer than the old 120 s mid-generation', async (_label, provider) => {
    const upstream = new PassThrough();
    const sent = providerAnsweringAfter(30_000, upstream);

    const pending = service.proxyChatCompletion(provider, streamedTurn);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.stream).toBeDefined();

    // Forty minutes of generation with a ten-minute silence between frames: a reasoning model thinking.
    for (let minute = 0; minute < 40; minute += 10) {
      upstream.write('data: {"type":"content_block_delta","delta":{"text":"."}}\n\n');
      await vi.advanceTimersByTimeAsync(600_000);
    }
    expect(sent()?.timeout).toBe(0);
    expect(sent()?.signal?.aborted).toBe(false);
    expect(upstream.destroyed).toBe(false);
    // Nothing left armed that could fire later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a streamed cloud request the pool first-byte budget, and aborts it when no headers arrive within it', async () => {
    const budget = firstByteBudgetMs(Buffer.byteLength(JSON.stringify(streamedTurn)));
    const provider = providerThatNeverAnswers();

    const outcome = service.proxyChatCompletion(openai, streamedTurn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      streamedTurn,
      expect.objectContaining({ responseType: 'stream', timeout: 0, signal: expect.any(AbortSignal) }),
    );

    // Past the old 120 s, still waiting.
    await vi.advanceTimersByTimeAsync(121_000);
    expect(provider.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(budget - 121_000);
    expect(provider.signal()?.aborted).toBe(true);

    const err = await outcome;
    expect((err as Error).message).toBe(
      `cloud provider openai sent no response headers within ${budget}ms (HUB_POOL_FIRST_BYTE_TIMEOUT_MS / HUB_POOL_MIN_PREFILL_TOKENS_PER_SEC size this budget)`,
    );
  });

  it('puts a streamed Anthropic request under the same header deadline', async () => {
    const provider = providerThatNeverAnswers();

    const outcome = service.proxyChatCompletion(anthropic, streamedTurn).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ stream: true }),
      expect.objectContaining({ responseType: 'stream', timeout: 0, signal: expect.any(AbortSignal) }),
    );
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    expect(provider.signal()?.aborted).toBe(true);
    expect((await outcome) as Error).toBeInstanceOf(Error);
  });

  // The only thing that used to close a stream whose client had left was the 120 s idle timeout this
  // took out. The client-closed signal replaces it, so it has to outlive the header deadline.
  // `upstream-stream.test.ts` shows the same over real sockets.
  it.each([
    ['an OpenAI-compatible provider', openai],
    ['Anthropic', anthropic],
  ])('abandons a request to %s when its client leaves: armed past the headers on a stream, as is on a whole answer', async (_label, provider) => {
    const clientClosed = new AbortController();
    const sent = providerAnsweringAfter(1_000, new PassThrough());
    const pending = service.proxyChatCompletion(provider, streamedTurn, clientClosed.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    post.mockResolvedValueOnce({ data: { content: [], id: 'x', model: 'm', stop_reason: 'end_turn' }, headers: {} });
    await service.proxyChatCompletion(provider, { ...streamedTurn, stream: false }, clientClosed.signal);
    expect(post.mock.calls[1]?.[2]).toMatchObject({ signal: clientClosed.signal });

    expect(sent()?.signal?.aborted).toBe(false);
    clientClosed.abort();
    expect(sent()?.signal?.aborted).toBe(true);
  });

  it('relays a provider refusal as the axios error it is, not as our own deadline', async () => {
    const refusal = Object.assign(new Error('Request failed with status code 429'), { isAxiosError: true, response: { status: 429 } });
    post.mockRejectedValueOnce(refusal);

    await expect(service.proxyChatCompletion(openai, streamedTurn)).rejects.toBe(refusal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['an OpenAI-compatible provider', openai, 'https://api.openai.com/v1/chat/completions'],
    ['Anthropic', anthropic, 'https://api.anthropic.com/v1/messages'],
  ])('gives a non-streamed request to %s the pool completion budget for the whole answer', async (_label, provider, url) => {
    post.mockResolvedValueOnce({ data: { content: [], id: 'x', model: 'm', stop_reason: 'end_turn' }, headers: {} });

    await service.proxyChatCompletion(provider, { ...streamedTurn, stream: false });

    expect(post).toHaveBeenCalledWith(url, expect.anything(), expect.objectContaining({ timeout: COMPLETION_TIMEOUT_MS }));
    expect(COMPLETION_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(post.mock.calls[0]?.[2]).not.toHaveProperty('responseType', 'stream');
  });
});
