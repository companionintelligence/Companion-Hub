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
      defaultModel: config.defaultModel || existing?.defaultModel,
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
