import { Injectable } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { APP_DATA_DIR } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { AppCredentialsService } from './app-credentials.service';

interface OpenClawModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsTools: boolean };
}

interface OpenClawConfig {
  models?: {
    mode?: string;
    providers?: Record<
      string,
      {
        baseUrl?: string;
        apiKey?: string;
        api?: string;
        models?: OpenClawModelEntry[];
      }
    >;
  };
  agents?: {
    defaults?: {
      model?: { primary?: string | null };
      models?: Record<string, unknown>;
    };
  };
  tools?: { profile?: string };
}

/**
 * Patches the live OpenClaw `openclaw.json` on disk before Hub restarts the
 * container so the provider swap is visible immediately (not only after entrypoint).
 */
@Injectable()
export class OpenClawConfigReconcileService {
  constructor(
    private readonly logger: LoggerService,
    private readonly appCredentials: AppCredentialsService,
  ) {}

  async reconcileBeforeRestart(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    if (appName !== 'openclaw') {
      return;
    }

    this.appCredentials.invalidateCache();
    const credentials = await this.appCredentials.getCredentials('openclaw');
    if (credentials.provider === 'cloud') {
      return;
    }

    const stateDir = path.join(APP_DATA_DIR, appStoreId, appName, 'data', '.openclaw');
    const configPath = path.join(stateDir, 'openclaw.json');
    try {
      await fs.access(configPath);
    } catch {
      this.logger.info(`[OpenClawReconcile] no openclaw.json at ${configPath}; skipping pre-restart patch`);
      return;
    }

    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as OpenClawConfig;

    if (credentials.provider === 'vllm') {
      await this.patchVllmProvider(
        config,
        credentials.endpointUrl,
        credentials.env.OPENAI_API_KEY ?? '',
        credentials.chatModelId,
        credentials.env.CI_LLM_NUM_CTX,
      );
    } else if (credentials.provider === 'ollama') {
      this.patchOllamaProvider(config, credentials.env.OLLAMA_HOST ?? '', credentials.env.OPENAI_API_KEY ?? 'ollama');
    } else {
      return;
    }

    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    this.logger.info(`[OpenClawReconcile] patched ${configPath} for provider=${credentials.provider}`);
  }

  private patchOllamaProvider(config: OpenClawConfig, ollamaHost: string, apiKey: string): void {
    config.models = config.models ?? { mode: 'merge', providers: {} };
    config.models.mode = 'merge';
    config.models.providers = config.models.providers ?? {};
    const existing = config.models.providers['ci-hub'] ?? {};
    config.models.providers['ci-hub'] = {
      ...existing,
      baseUrl: ollamaHost.replace(/\/$/, ''),
      apiKey,
      api: 'ollama',
    };
  }

  private async patchVllmProvider(
    config: OpenClawConfig,
    openAiBaseUrl: string,
    apiKey: string,
    defaultModel: string | null,
    numCtxRaw?: string,
  ): Promise<void> {
    const baseUrl = openAiBaseUrl.replace(/\/$/, '');
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    let servedIds: string[] = [];
    try {
      const response = await axios.get(`${baseUrl}/models`, { timeout: 5000, headers });
      servedIds = (response.data?.data ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[OpenClawReconcile] vLLM /models fetch failed: ${message}; patching provider URL only`);
    }

    const parsedNumCtx = Number.parseInt(numCtxRaw ?? '', 10);
    const contextWindow = Number.isFinite(parsedNumCtx) && parsedNumCtx > 0 ? parsedNumCtx : 32000;

    const models: OpenClawModelEntry[] = servedIds.filter((id) => !/embed/i.test(id)).map((id) => this.vllmModelEntry(id, contextWindow));

    const defaultModelAvailable = defaultModel && servedIds.includes(defaultModel) ? defaultModel : (models.find((m) => m.id !== 'auto')?.id ?? null);
    const autoTarget = defaultModelAvailable ?? models[0]?.id ?? null;
    if (autoTarget) {
      models.unshift(this.vllmModelEntry('auto', contextWindow, `Hub Auto (${autoTarget})`));
    }

    config.models = config.models ?? { mode: 'merge', providers: {} };
    config.models.mode = 'merge';
    config.models.providers = config.models.providers ?? {};
    config.models.providers['ci-hub'] = {
      baseUrl,
      apiKey,
      api: 'openai-completions',
      models,
    };

    config.agents = config.agents ?? { defaults: {} };
    config.agents.defaults = config.agents.defaults ?? {};
    const existingModels = config.agents.defaults.models ?? {};
    const map = Object.fromEntries(Object.entries(existingModels).filter(([key]) => !key.startsWith('ci-hub/')));
    for (const model of models) {
      map[`ci-hub/${model.id}`] = existingModels[`ci-hub/${model.id}`] ?? {};
    }
    config.agents.defaults.models = map;

    const availableIds = new Set(models.map((m) => m.id));
    let primaryId: string | null = null;
    const existingPrimary = config.agents.defaults.model?.primary;
    if (typeof existingPrimary === 'string' && existingPrimary.startsWith('ci-hub/')) {
      const existingId = existingPrimary.slice('ci-hub/'.length);
      if (availableIds.has(existingId)) {
        primaryId = existingId;
      }
    }
    if (!primaryId) {
      primaryId = defaultModelAvailable ?? models.find((m) => m.id !== 'auto')?.id ?? null;
    }
    config.agents.defaults.model = { primary: primaryId ? `ci-hub/${primaryId}` : null };

    config.tools = config.tools ?? {};
    config.tools.profile = models.some((m) => m.compat.supportsTools) ? 'coding' : 'minimal';
  }

  private vllmModelEntry(id: string, contextWindow: number, name?: string): OpenClawModelEntry {
    return {
      id,
      name: name ?? id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: Math.min(4096, contextWindow),
      compat: { supportsTools: true },
    };
  }
}
