import { Injectable, type OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { LoggerService } from '@/core/logger/logger.service';
import { ModelRegistryService } from './model-registry.service';
import type { CuratedModel } from '@ci-hub/common/types';

export type CatalogTagStatus = 'exists' | 'missing' | 'unknown';

export interface CatalogTagResult {
  catalogId: string;
  backendModelId: string;
  status: CatalogTagStatus;
  checkedAt: number;
  errorMessage?: string;
}

export interface CatalogVerificationSummary {
  startedAt: number | null;
  finishedAt: number | null;
  totalChecked: number;
  totalExists: number;
  totalMissing: number;
  totalUnknown: number;
  results: CatalogTagResult[];
}

const OLLAMA_REGISTRY_BASE = 'https://registry.ollama.ai/v2/library';
const CONCURRENCY = 8;
const PER_REQUEST_TIMEOUT_MS = 5_000;

@Injectable()
export class CatalogVerifierService implements OnModuleInit {
  private summary: CatalogVerificationSummary = {
    startedAt: null,
    finishedAt: null,
    totalChecked: 0,
    totalExists: 0,
    totalMissing: 0,
    totalUnknown: 0,
    results: [],
  };
  /** In-flight verification promise so concurrent callers share the same result. */
  private inFlight: Promise<CatalogVerificationSummary> | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly modelRegistry: ModelRegistryService,
  ) {}

  onModuleInit(): void {
    if (process.env.CI_HUB_DISABLE_CATALOG_VERIFY === '1') {
      this.logger.info('[CatalogVerifier] disabled via CI_HUB_DISABLE_CATALOG_VERIFY=1');
      return;
    }
    // Fire-and-forget: do not block module boot on a network probe.
    setImmediate(() => {
      void this.verifyAll().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[CatalogVerifier] startup verification crashed: ${msg}`);
      });
    });
  }

  getSummary(): CatalogVerificationSummary {
    return this.summary;
  }

  /**
   * Probe every Ollama-backed model in the catalog against ollama.com's
   * registry manifest endpoint. Logs missing tags but never throws.
   * Safe to call multiple times; concurrent calls de-dup via the in-flight flag.
   */
  async verifyAll(): Promise<CatalogVerificationSummary> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.runVerification().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runVerification(): Promise<CatalogVerificationSummary> {
    {
      const ollamaModels = this.modelRegistry.getCatalog().filter((m) => m.backend === 'ollama');
      this.logger.info(`[CatalogVerifier] starting probe of ${ollamaModels.length} Ollama-backed catalog entries`);

      this.summary = {
        startedAt: Date.now(),
        finishedAt: null,
        totalChecked: 0,
        totalExists: 0,
        totalMissing: 0,
        totalUnknown: 0,
        results: [],
      };

      // Dedupe by backendModelId — many CuratedModel rows can share a tag
      // (different `id`s pointing at the same Ollama manifest). One probe
      // per unique tag keeps the load on ollama.com modest.
      const byBackendId = new Map<string, CuratedModel>();
      for (const m of ollamaModels) {
        if (!byBackendId.has(m.backendModelId)) byBackendId.set(m.backendModelId, m);
      }
      const unique = Array.from(byBackendId.values());

      const results: CatalogTagResult[] = [];
      for (let i = 0; i < unique.length; i += CONCURRENCY) {
        const slice = unique.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(slice.map((m) => this.probeOne(m)));
        for (let j = 0; j < settled.length; j++) {
          const outcome = settled[j]!;
          const model = slice[j]!;
          if (outcome.status === 'fulfilled') {
            results.push(outcome.value);
          } else {
            const reason: unknown = outcome.reason;
            results.push({
              catalogId: model.id,
              backendModelId: model.backendModelId,
              status: 'unknown',
              checkedAt: Date.now(),
              errorMessage: reason instanceof Error ? reason.message : String(reason),
            });
          }
        }
      }

      const totalExists = results.filter((r) => r.status === 'exists').length;
      const totalMissing = results.filter((r) => r.status === 'missing').length;
      const totalUnknown = results.filter((r) => r.status === 'unknown').length;

      this.summary = {
        startedAt: this.summary.startedAt,
        finishedAt: Date.now(),
        totalChecked: results.length,
        totalExists,
        totalMissing,
        totalUnknown,
        results,
      };

      const missingIds = results.filter((r) => r.status === 'missing').map((r) => r.backendModelId);
      if (missingIds.length > 0) {
        this.logger.warn(`[CatalogVerifier] ${missingIds.length}/${results.length} catalog tags absent from ollama.com: ${missingIds.join(', ')}`);
      } else {
        this.logger.info(`[CatalogVerifier] all ${results.length} catalog tags resolved against ollama.com`);
      }
      if (totalUnknown > 0) {
        this.logger.info(`[CatalogVerifier] ${totalUnknown} tags returned non-2xx/4xx (network errors, registry quirks) — see results array`);
      }
      return this.summary;
    }
  }

  private async probeOne(model: CuratedModel): Promise<CatalogTagResult> {
    const url = this.buildManifestUrl(model.backendModelId);
    try {
      const response = await axios.head(url, {
        timeout: PER_REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return { catalogId: model.id, backendModelId: model.backendModelId, status: 'exists', checkedAt: Date.now() };
      }
      if (response.status === 404) {
        return { catalogId: model.id, backendModelId: model.backendModelId, status: 'missing', checkedAt: Date.now() };
      }
      return {
        catalogId: model.id,
        backendModelId: model.backendModelId,
        status: 'unknown',
        checkedAt: Date.now(),
        errorMessage: `HTTP ${response.status}`,
      };
    } catch (err) {
      return {
        catalogId: model.id,
        backendModelId: model.backendModelId,
        status: 'unknown',
        checkedAt: Date.now(),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Ollama tags are `<name>:<tag>` (e.g. `gemma3:4b`). Models without
   * an explicit tag default to `:latest`. The registry manifest lives at
   * /v2/library/<name>/manifests/<tag>.
   */
  private buildManifestUrl(backendModelId: string): string {
    const [namePart, tagPart] = backendModelId.split(':');
    const name = encodeURIComponent(namePart ?? '');
    const tag = encodeURIComponent(tagPart && tagPart.length > 0 ? tagPart : 'latest');
    return `${OLLAMA_REGISTRY_BASE}/${name}/manifests/${tag}`;
  }
}
