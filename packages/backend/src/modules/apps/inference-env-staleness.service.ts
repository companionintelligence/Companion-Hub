import { Injectable } from '@nestjs/common';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { EnvUtils } from '../env/env.utils';
import { AppCredentialsService, type AppCredentialsConfig } from '../inference/app-credentials.service';
import { INFERENCE_ERROR_ENV_KEY } from '../inference/app-model-handout';
import { isPoolProxyUrl } from '../inference/inference-endpoint.service';
import { AppFilesManager } from './app-files-manager';
import { AppHelpers, hasInferenceMapping, isAiAppInfo } from './app.helpers';

/** The inference facts an operator actually asks about, on one side of the comparison. */
export interface InferenceEnvView {
  /** The app's OpenAI-compatible base URL points at this Hub's pool proxy. */
  routedThroughPool: boolean;
  chatModel: string | null;
  /** The explicit `CI_INFERENCE_ERROR` the app was (or would be) handed instead of a model. */
  error: string | null;
}

export type InferenceEnvBasis = 'app-env' | 'bootstrap-handout';

export interface InferenceEnvStaleness {
  appUrn: AppUrn;
  /** False for an app the Hub hands no inference config to; nothing else in the answer applies. */
  aiApp: boolean;
  /** True when a regeneration would hand the app something different from what it holds. */
  stale: boolean;
  /** What was compared: the generated `app.env`, the last `bootstrap.env` the app fetched, or both. */
  basis: InferenceEnvBasis[];
  /** Env keys whose values differ. Names only: several of these keys carry credentials. */
  differences: string[];
  /** The differences in operator terms, such as "chat model: gemma3:1b -> qwen3-coder:30b". */
  reasons: string[];
  /** What the app holds, or null when the Hub has no record of it. */
  generated: InferenceEnvView | null;
  /** What the app would be handed now. */
  current: InferenceEnvView | null;
  /**
   * True when regenerating now would take away an inference endpoint the app has — the local
   * backend is down and nothing else can serve. An automatic refresh must not act on that: a
   * restart would strip a working-when-it-recovers config down to nothing.
   */
  wouldRemoveEndpoint: boolean;
  checkedAt: string;
}

/**
 * Answers "is this app's inference config out of date", which nothing could answer before.
 *
 * An app's inference env is baked when it starts: `app.env` at generate time, `bootstrap.env` when
 * the container's entrypoint fetches it. Pairing a peer, unpairing one, or changing the preferred
 * model changes what the Hub *would* hand out, but not what the app holds until something restarts
 * it — and on core-4 nothing did, so its apps kept the direct Ollama URL after core-6 paired. This
 * compares the two without side effects: it resolves with `AppHelpers.buildInferenceEnv` (the code
 * that writes `app.env`) and `AppCredentialsService.previewCredentials` (no cache, no pre-pull).
 */
@Injectable()
export class InferenceEnvStalenessService {
  constructor(
    private readonly appFilesManager: AppFilesManager,
    private readonly appHelpers: AppHelpers,
    private readonly envUtils: EnvUtils,
    private readonly appCredentials: AppCredentialsService,
    private readonly config: ConfigurationService,
    private readonly filesystem: FilesystemService,
    private readonly logger: LoggerService,
  ) {}

  async check(appUrn: AppUrn): Promise<InferenceEnvStaleness> {
    const checkedAt = new Date().toISOString();
    const info = await this.appFilesManager.getInstalledAppInfo(appUrn);
    if (!info || !isAiAppInfo(info)) {
      return {
        appUrn,
        aiApp: false,
        stale: false,
        basis: [],
        differences: [],
        reasons: [],
        generated: null,
        current: null,
        wouldRemoveEndpoint: false,
        checkedAt,
      };
    }

    const { appName } = extractAppUrn(appUrn);
    const basis: InferenceEnvBasis[] = ['app-env'];
    const differences = new Set<string>();
    const reasons: string[] = [];

    // ── app.env: what generateEnvFile wrote, against what it would write now ──
    const [{ content }, inference, baseEnv] = await Promise.all([
      this.appFilesManager.getAppEnv(appUrn),
      this.appHelpers.buildInferenceEnv(appName, info),
      this.readBaseEnv(),
    ]);
    const onDisk = this.envUtils.envStringToMap(content);
    for (const key of inference.ownedKeys) {
      // A key the resolution leaves unset is written from the Hub's own `.env`, when that has it.
      const expected = inference.entries.get(key) ?? baseEnv.get(key) ?? null;
      if ((onDisk.get(key) ?? null) !== expected) {
        differences.add(key);
      }
    }

    const mapping = info.hub_integration?.inference ?? {};
    let generated: InferenceEnvView | null = null;
    let current: InferenceEnvView | null = null;
    if (hasInferenceMapping(info)) {
      generated = {
        routedThroughPool: isPoolProxyUrl(mapping.llm_base_url ? onDisk.get(mapping.llm_base_url) : undefined),
        chatModel: (mapping.chat_model ? onDisk.get(mapping.chat_model) : undefined) ?? null,
        error: onDisk.get(INFERENCE_ERROR_ENV_KEY) ?? null,
      };
      current = {
        routedThroughPool: isPoolProxyUrl(inference.aiEnv.CI_LLM_BASE_URL),
        chatModel: (mapping.chat_model ? inference.entries.get(mapping.chat_model) : undefined) ?? null,
        error: inference.entries.get(INFERENCE_ERROR_ENV_KEY) ?? null,
      };
    }
    let wouldRemoveEndpoint = Boolean(mapping.llm_base_url && onDisk.get(mapping.llm_base_url) && !inference.aiEnv.CI_LLM_BASE_URL);

    // ── bootstrap.env: apps whose inference config arrives only over HTTP ──
    // hermes-agent also bootstraps, but its manifest maps the same values into app.env, which is
    // the authoritative copy; only an app with no mapping (openclaw) is judged on its handout.
    if (this.appCredentials.isSupported(appName) && !hasInferenceMapping(info)) {
      basis.push('bootstrap-handout');
      const preview = await this.appCredentials.previewCredentials(appName);
      const handout = this.appCredentials.lastHandout(appName);
      current = viewOfHandout(preview);
      if (handout) {
        generated = viewOfHandout(handout.config);
        for (const key of new Set([...preview.managedKeys, ...handout.config.managedKeys])) {
          if ((handout.config.env[key] ?? null) !== (preview.env[key] ?? null)) {
            differences.add(key);
          }
        }
        wouldRemoveEndpoint = wouldRemoveEndpoint || Boolean(handout.config.endpointUrl && !preview.endpointUrl);
      } else {
        reasons.push(`${appName} has fetched no bootstrap.env since this Hub started, so the Hub cannot vouch for what it holds`);
      }
    }

    if (generated && current) {
      if (generated.routedThroughPool !== current.routedThroughPool) {
        reasons.push(`routing: ${generated.routedThroughPool ? 'pool' : 'direct'} -> ${current.routedThroughPool ? 'pool' : 'direct'}`);
      }
      if (generated.chatModel !== current.chatModel) {
        reasons.push(`chat model: ${generated.chatModel ?? 'none'} -> ${current.chatModel ?? 'none'}`);
      }
    }
    if (differences.size > 0 && reasons.length === 0) {
      reasons.push(`${differences.size} inference setting(s) changed`);
    }

    const stale = differences.size > 0 || reasons.length > 0;
    return {
      appUrn,
      aiApp: true,
      stale,
      basis,
      differences: [...differences].sort(),
      reasons,
      generated,
      current,
      wouldRemoveEndpoint,
      checkedAt,
    };
  }

  private async readBaseEnv(): Promise<Map<string, string>> {
    try {
      const { envFilePath } = this.config.getConfig();
      const text = await this.filesystem.readTextFile(envFilePath);
      return this.envUtils.envStringToMap(text?.toString() ?? '');
    } catch (err) {
      this.logger.debug(`[InferenceEnvStaleness] could not read the Hub .env: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }
}

function viewOfHandout(config: AppCredentialsConfig): InferenceEnvView {
  return { routedThroughPool: config.routedThroughPool, chatModel: config.chatModelId, error: config.chatModelError };
}
