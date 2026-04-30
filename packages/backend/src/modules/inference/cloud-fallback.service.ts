import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { CloudProviderConfig, CloudProviderType } from '@ci-hub/common/types';
import axios from 'axios';

const CLOUD_BASE_URLS: Record<CloudProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'github-copilot': 'https://api.githubcopilot.com',
};

const _CLOUD_DEFAULTS: Record<CloudProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4',
  google: 'gemini-2.5-pro',
  'github-copilot': 'claude-opus-4',
};

@Injectable()
export class CloudFallbackService {
  private providers = new Map<CloudProviderType, CloudProviderConfig>();

  constructor(private readonly logger: LoggerService) {}

  /** Configure a cloud provider */
  setProvider(config: CloudProviderConfig): void {
    this.providers.set(config.provider, config);
    this.logger.info(`[CloudFallback] Configured provider: ${config.provider} (enabled: ${config.enabled})`);
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
  ): Promise<{ data: unknown; headers: Record<string, string> }> {
    const baseUrl = provider.baseUrl || CLOUD_BASE_URLS[provider.provider];

    if (provider.provider === 'anthropic') {
      // Anthropic uses a different API format
      return this.proxyAnthropicChat(provider, body);
    }

    const response = await axios.post(`${baseUrl}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      responseType: body.stream ? 'stream' : 'json',
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

  private getEnabledProvider(type: CloudProviderType): CloudProviderConfig | undefined {
    const provider = this.providers.get(type);
    return provider?.enabled && provider?.apiKey ? provider : undefined;
  }

  private async proxyAnthropicChat(
    provider: CloudProviderConfig,
    body: Record<string, unknown>,
  ): Promise<{ data: unknown; headers: Record<string, string> }> {
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

    const response = await axios.post(`${baseUrl}/messages`, anthropicBody, {
      headers: {
        'x-api-key': provider.apiKey || '',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      responseType: body.stream ? 'stream' : 'json',
      timeout: 120000,
    });

    return { data: response.data, headers: response.headers as Record<string, string> };
  }
}
