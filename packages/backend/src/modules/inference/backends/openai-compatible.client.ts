import axios from 'axios';
import type { BackendHealthStatus, BackendModelInfo } from '@ci-hub/common/types';

export interface OpenAiCompatibleRequestOptions {
  apiKey?: string;
  timeout?: number;
}

export interface OpenAiCompatibleHealthOptions extends OpenAiCompatibleRequestOptions {
  /** Optional provider health path. Model discovery always uses `/v1/models`. */
  healthPath?: string;
}

interface OpenAiCompatibleModel {
  id?: unknown;
}

/**
 * The shared HTTP contract for host-managed OpenAI-compatible inference servers.
 *
 * Client harnesses and provider-specific launchers are deliberately outside the Hub runtime.
 * Backends use this adapter for health and model discovery so a new server only supplies its
 * endpoint, optional health path, and lifecycle/deployment policy.
 */
export class OpenAiCompatibleClient {
  private authHeaders(apiKey?: string): Record<string, string> | undefined {
    const trimmed = apiKey?.trim();
    return trimmed ? { Authorization: `Bearer ${trimmed}` } : undefined;
  }

  async listModelIds(baseUrl: string, options: OpenAiCompatibleRequestOptions = {}): Promise<string[]> {
    const response = await axios.get(`${baseUrl}/v1/models`, {
      timeout: options.timeout ?? 10000,
      headers: this.authHeaders(options.apiKey),
    });
    const models = response.data?.data ?? [];
    return models.map((model: OpenAiCompatibleModel) => model.id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
  }

  async listModels(baseUrl: string, options: OpenAiCompatibleRequestOptions = {}): Promise<BackendModelInfo[]> {
    const ids = await this.listModelIds(baseUrl, options);
    return ids.map((id) => ({ id, name: id, size: 0, loaded: true }));
  }

  async healthCheck(baseUrl: string, options: OpenAiCompatibleHealthOptions = {}): Promise<BackendHealthStatus> {
    try {
      if (options.healthPath) {
        await axios.get(`${baseUrl}${options.healthPath}`, {
          timeout: options.timeout ?? 5000,
          headers: this.authHeaders(options.apiKey),
        });
      }

      const modelsLoaded = await this.listModelIds(baseUrl, {
        apiKey: options.apiKey,
        timeout: options.timeout ?? 5000,
      });
      return { running: true, healthy: true, modelsLoaded };
    } catch (err) {
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
