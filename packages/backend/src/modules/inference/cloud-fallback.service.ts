import axios from 'axios';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import type { CloudProviderConfig, CloudProviderType } from '@ci-hub/common/types';
import { buildCloudProviderEnv } from './cloud-provider-env';

const CLOUD_BASE_URLS: Record<CloudProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'github-copilot': 'https://api.githubcopilot.com',
};

const CLOUD_DEFAULTS: Record<CloudProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4',
  google: 'gemini-2.5-pro',
  'github-copilot': 'claude-opus-4',
};

/**
 * Whether a provider serves OpenAI's legacy text-completions route, `POST {baseUrl}/completions`.
 *
 * Only OpenAI itself. Anthropic speaks its own Messages API (see `proxyAnthropicChat`), and the
 * OpenAI-compatible surfaces of Google and GitHub Copilot are chat-only. The router's
 * `/v1/completions` cloud fallback asks this before posting, rather than sending a request to a route
 * that does not exist and relaying the provider's 404 as though the model were missing.
 */
export function speaksOpenAiCompletions(provider: CloudProviderType): boolean {
  return provider === 'openai';
}

/**
 * Cloud provider key store.
 *
 * The Hub no longer proxies inference requests, so this service no longer makes
 * any HTTP calls. It persists the operator's cloud-provider configuration
 * (base URL / API key / default model) to settings.json and hands those
 * credentials to AI apps, which then call the cloud API directly.
 */
@Injectable()
export class CloudFallbackService implements OnModuleInit {
  private providers = new Map<CloudProviderType, CloudProviderConfig>();

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
  ) {}

  onModuleInit(): void {
    for (const stored of this.configuration.getInferenceCloudProviders()) {
      this.providers.set(stored.provider, this.resolveConfig(stored));
    }
    const enabled = this.getEnabledProviders().length;
    if (this.providers.size > 0) {
      this.logger.info(`[CloudFallback] Loaded ${this.providers.size} cloud provider(s) from settings (${enabled} enabled)`);
    }
  }

  /** Get the default model for a cloud provider */
  getDefaultModel(provider: CloudProviderType): string {
    return CLOUD_DEFAULTS[provider] ?? 'gpt-4o';
  }

  /** The canonical base URL for a provider when the operator hasn't overridden it. */
  getDefaultBaseUrl(provider: CloudProviderType): string {
    return CLOUD_BASE_URLS[provider] ?? CLOUD_BASE_URLS.openai;
  }

  /**
   * Configure a cloud provider. Callers may omit `baseUrl` (e.g. onboarding only sends
   * provider/key/enabled); we backfill the provider's canonical base URL so app credentials never
   * point a cloud key/model at the wrong endpoint (the Ollama fallback URL).
   *
   * An omitted / blank `apiKey` keeps the previously stored key so a Settings save of a masked
   * field (`••••`) can toggle `enabled` without wiping the secret.
   */
  setProvider(config: CloudProviderConfig): void {
    const existing = this.providers.get(config.provider);
    const resolved = this.resolveConfig({
      ...existing,
      ...config,
      apiKey: config.apiKey?.trim() || existing?.apiKey,
      baseUrl: config.baseUrl || existing?.baseUrl,
      defaultModel: config.defaultModel || existing?.defaultModel || this.getDefaultModel(config.provider),
    });
    this.providers.set(resolved.provider, resolved);
    this.logger.info(`[CloudFallback] Configured provider: ${resolved.provider} (enabled: ${resolved.enabled}, baseUrl: ${resolved.baseUrl})`);
    void this.persist().catch((error) => {
      this.logger.error(`[CloudFallback] Failed to persist ${resolved.provider}`, error);
    });
  }

  /** Get a provider config */
  getProvider(provider: CloudProviderType): CloudProviderConfig | undefined {
    return this.providers.get(provider);
  }

  /** List all configured providers */
  listProviders(): CloudProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /** Get enabled providers */
  getEnabledProviders(): CloudProviderConfig[] {
    return this.listProviders().filter((p) => p.enabled && p.apiKey);
  }

  /** Check if any cloud provider is available */
  hasCloudFallback(): boolean {
    return this.getEnabledProviders().length > 0;
  }

  /** Env vars for every enabled provider — additive, does not replace local inference. */
  toAppEnv(): Record<string, string> {
    return buildCloudProviderEnv(this.getEnabledProviders());
  }

  /** Find which provider can serve a model */
  resolveProvider(model: string): CloudProviderConfig | undefined {
    // Check model prefix patterns
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
      return this.getEnabledProvider('openai');
    }
    if (model.startsWith('claude-')) {
      return this.getEnabledProvider('anthropic');
    }
    if (model.startsWith('gemini-')) {
      return this.getEnabledProvider('google');
    }

    // Fall back to first enabled provider
    return this.getEnabledProviders()[0];
  }

  /** Proxy a chat completion request to a cloud provider */
  async proxyChatCompletion(
    provider: CloudProviderConfig,
    body: Record<string, unknown>,
  ): Promise<{ data: unknown; stream?: NodeJS.ReadableStream; headers: Record<string, string> }> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS[provider.provider];

    if (provider.provider === 'anthropic') {
      // Anthropic uses a different API format — convert both request and response
      return this.proxyAnthropicChat(provider, body);
    }

    const isStream = !!body.stream;
    const response = await axios.post(`${baseUrl}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: isStream ? 'stream' : 'json',
      timeout: 120000,
    });

    if (isStream) {
      return { data: null, stream: response.data, headers: response.headers as Record<string, string> };
    }

    return { data: response.data, headers: response.headers as Record<string, string> };
  }

  /** Proxy an image generation request to a cloud provider */
  async proxyImageGeneration(
    provider: CloudProviderConfig,
    body: Record<string, unknown>,
  ): Promise<{ data: unknown; headers: Record<string, string> }> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS[provider.provider];
    const response = await axios.post(`${baseUrl}/images/generations`, body, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    });
    return { data: response.data, headers: response.headers as Record<string, string> };
  }

  /** Proxy TTS to a cloud provider */
  async proxyTts(provider: CloudProviderConfig, body: Record<string, unknown>): Promise<Buffer> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS[provider.provider];
    const response = await axios.post(`${baseUrl}/audio/speech`, body, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /** Proxy STT to a cloud provider */
  async proxyStt(provider: CloudProviderConfig, formData: FormData): Promise<unknown> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS[provider.provider];
    const response = await axios.post(`${baseUrl}/audio/transcriptions`, formData, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
      },
      timeout: 120000,
    });
    return response.data;
  }

  private async proxyAnthropicChat(
    provider: CloudProviderConfig,
    body: Record<string, unknown>,
  ): Promise<{ data: unknown; stream?: NodeJS.ReadableStream; headers: Record<string, string> }> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS.anthropic;

    // Convert OpenAI format to Anthropic Messages API
    const messages = (body.messages as Array<{ role: string; content: string }>) || [];
    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const anthropicBody: Record<string, unknown> = {
      model: body.model || provider.defaultModel,
      max_tokens: body.max_tokens || 4096,
      messages: nonSystemMessages,
    };
    if (systemMessage) {
      anthropicBody.system = systemMessage.content;
    }

    if (body.stream) {
      anthropicBody.stream = true;
    }

    const response = await axios.post(`${baseUrl}/messages`, anthropicBody, {
      headers: {
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      responseType: body.stream ? 'stream' : 'json',
      timeout: 120000,
    });

    if (body.stream) {
      // Convert Anthropic SSE stream to OpenAI SSE format
      const { Transform } = await import('node:stream');
      const transformStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const text = chunk.toString();
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') {
              if (jsonStr === '[DONE]') {
                this.push('data: [DONE]\n\n');
              }
              continue;
            }
            try {
              const event = JSON.parse(jsonStr);
              if (event.type === 'content_block_delta' && event.delta?.text) {
                const openaiChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: anthropicBody.model,
                  choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
                };
                this.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              } else if (event.type === 'message_stop') {
                const finalChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: anthropicBody.model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                this.push(`data: ${JSON.stringify(finalChunk)}\n\n`);
                this.push('data: [DONE]\n\n');
              }
            } catch {
              // Skip unparseable lines
            }
          }
          callback();
        },
      });
      (response.data as NodeJS.ReadableStream).pipe(transformStream);
      return { data: null, stream: transformStream, headers: response.headers as Record<string, string> };
    }

    // Convert Anthropic response to OpenAI format
    const anthropicData = response.data as {
      id: string;
      content: Array<{ type: string; text?: string }>;
      model: string;
      stop_reason: string;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const textContent =
      anthropicData.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('') || '';

    const openaiResponse = {
      id: `chatcmpl-${anthropicData.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: anthropicData.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: textContent },
          finish_reason: anthropicData.stop_reason === 'end_turn' ? 'stop' : anthropicData.stop_reason || 'stop',
        },
      ],
      usage: anthropicData.usage
        ? {
            prompt_tokens: anthropicData.usage.input_tokens,
            completion_tokens: anthropicData.usage.output_tokens,
            total_tokens: anthropicData.usage.input_tokens + anthropicData.usage.output_tokens,
          }
        : undefined,
    };

    return { data: openaiResponse, headers: response.headers as Record<string, string> };
  }

  private getEnabledProvider(type: CloudProviderType): CloudProviderConfig | undefined {
    const provider = this.providers.get(type);
    return provider?.enabled && provider?.apiKey ? provider : undefined;
  }

  private resolveConfig(config: CloudProviderConfig): CloudProviderConfig {
    return {
      ...config,
      baseUrl: config.baseUrl || this.getDefaultBaseUrl(config.provider),
      defaultModel: config.defaultModel || this.getDefaultModel(config.provider),
    };
  }

  private async persist(): Promise<void> {
    await this.configuration.setInferenceCloudProviders(this.listProviders());
  }
}
