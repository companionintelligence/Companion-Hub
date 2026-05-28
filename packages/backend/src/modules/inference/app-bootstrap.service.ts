import { Injectable, NotFoundException } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { HardwareInspectorService } from './hardware-inspector.service';
import { ModelRegistryService } from './model-registry.service';
import { OllamaBackend } from './backends/ollama.backend';
import type { CuratedModel } from '@ci-hub/common/types';

export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw'] as const;
export type AppSlug = (typeof SUPPORTED_APP_SLUGS)[number];

export interface AppBootstrapConfig {
  app: AppSlug;
  endpointUrl: string;
  llmModelId: string | null;
  llmBackendModelId: string | null;
  embeddingsModelId: string | null;
  embeddingsBackendModelId: string | null;
  env: Record<string, string>;
}

const APP_ENV_KEYS: Record<AppSlug, { baseUrl: string; model: string; embeddings: string; apiKey: string }> = {
  'hermes-agent': {
    baseUrl: 'HERMES_OPENAI_BASE_URL',
    model: 'HERMES_DEFAULT_MODEL',
    embeddings: 'HERMES_EMBEDDINGS_MODEL',
    apiKey: 'HERMES_OPENAI_API_KEY',
  },
  openclaw: {
    baseUrl: 'OPENAI_API_BASE',
    model: 'DEFAULT_MODEL',
    embeddings: 'EMBEDDINGS_MODEL',
    apiKey: 'OPENAI_API_KEY',
  },
};

@Injectable()
export class AppBootstrapService {
  constructor(
    private readonly logger: LoggerService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly modelRegistry: ModelRegistryService,
    private readonly ollamaBackend: OllamaBackend,
  ) {}

  isSupported(slug: string): slug is AppSlug {
    return (SUPPORTED_APP_SLUGS as readonly string[]).includes(slug);
  }

  async getBootstrap(slug: string): Promise<AppBootstrapConfig> {
    if (!this.isSupported(slug)) {
      throw new NotFoundException(`Unknown app slug: ${slug}. Supported: ${SUPPORTED_APP_SLUGS.join(', ')}`);
    }

    const profile = await this.hardwareInspector.getProfile();
    const endpointUrl = `${this.ollamaBackend.getBaseUrl()}/v1`;

    const llm = this.pickTopRunnableModel(this.modelRegistry.getRecommendedModelsForHardware(profile.tier, profile));
    const embeddings = this.pickTopRunnableModel(
      this.modelRegistry
        .getModelsByModality('embedding')
        .filter((m) => m.backend === 'ollama')
        .filter((m) => m.requirements.minRamMb <= profile.ram.totalMb),
    );

    const keys = APP_ENV_KEYS[slug];
    const env: Record<string, string> = {
      [keys.baseUrl]: endpointUrl,
      [keys.apiKey]: 'ollama',
    };
    if (llm) {
      env[keys.model] = llm.id;
      env[`${keys.model}_BACKEND_ID`] = llm.backendModelId;
    }
    if (embeddings) {
      env[keys.embeddings] = embeddings.id;
      env[`${keys.embeddings}_BACKEND_ID`] = embeddings.backendModelId;
    }

    this.logger.info(`[AppBootstrap] ${slug}: endpoint=${endpointUrl} llm=${llm?.id ?? 'none'} embeddings=${embeddings?.id ?? 'none'}`);

    return {
      app: slug,
      endpointUrl,
      llmModelId: llm?.id ?? null,
      llmBackendModelId: llm?.backendModelId ?? null,
      embeddingsModelId: embeddings?.id ?? null,
      embeddingsBackendModelId: embeddings?.backendModelId ?? null,
      env,
    };
  }

  serializeAsDotenv(config: AppBootstrapConfig): string {
    return (
      Object.entries(config.env)
        .map(([k, v]) => `${k}=${this.escapeDotenvValue(v)}`)
        .join('\n') + '\n'
    );
  }

  private pickTopRunnableModel(candidates: CuratedModel[]): CuratedModel | null {
    return candidates[0] ?? null;
  }

  private escapeDotenvValue(value: string): string {
    if (/[\s"'#=]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
}
