import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { CloudProviderConfig, CloudProviderType } from '@ci-hub/common/types';

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
 * Cloud provider key store.
 *
 * The Hub no longer proxies inference requests, so this service no longer makes
 * any HTTP calls. It only persists the operator's cloud-provider configuration
 * (base URL / API key / default model). The credentials endpoint reads from here
 * to hand a cloud connection to apps, which then call the cloud API directly.
 */
@Injectable()
export class CloudFallbackService {
  private providers = new Map<CloudProviderType, CloudProviderConfig>();

  constructor(private readonly logger: LoggerService) {}

  /** Get the default model for a cloud provider */
  getDefaultModel(provider: CloudProviderType): string {
    return CLOUD_DEFAULTS[provider] ?? 'gpt-4o';
  }

  /** The canonical base URL for a provider when the operator hasn't overridden it. */
  getDefaultBaseUrl(provider: CloudProviderType): string {
    return CLOUD_BASE_URLS[provider] ?? CLOUD_BASE_URLS.openai;
  }

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

  private getEnabledProvider(type: CloudProviderType): CloudProviderConfig | undefined {
    const provider = this.providers.get(type);
    return provider?.enabled && provider?.apiKey ? provider : undefined;
  }
}
