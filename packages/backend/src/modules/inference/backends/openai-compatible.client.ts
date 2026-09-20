import axios from 'axios';
import type { BackendHealthStatus, BackendModelInfo } from '@ci-hub/common/types';
import { foreignEngineHealth, openAiModelIds, type SharedPortEngine } from './engine-identity';

export interface OpenAiCompatibleRequestOptions {
  apiKey?: string;
  timeout?: number;
  /**
   * The engine the caller IS. When the server's `/v1/models` names a different one (see
   * `engine-identity.ts`), health reports it unhealthy and the model list is empty — the server
   * belongs to another backend that will offer it.
   */
  claimedBy?: SharedPortEngine;
}

export interface OpenAiCompatibleHealthOptions extends OpenAiCompatibleRequestOptions {
  /** Optional provider health path. Model discovery always uses `/v1/models`. */
  healthPath?: string;
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

  /** The raw `/v1/models` body, for callers that need more than the ids (the `owned_by` claim). */
  async fetchModels(baseUrl: string, options: OpenAiCompatibleRequestOptions = {}): Promise<unknown> {
    const response = await axios.get(`${baseUrl}/v1/models`, {
      timeout: options.timeout ?? 10000,
      headers: this.authHeaders(options.apiKey),
    });
    return response.data;
  }

  async listModelIds(baseUrl: string, options: OpenAiCompatibleRequestOptions = {}): Promise<string[]> {
    const body = await this.fetchModels(baseUrl, options);
    if (options.claimedBy && foreignEngineHealth(options.claimedBy, body, baseUrl)) return [];
    return openAiModelIds(body);
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

      const body = await this.fetchModels(baseUrl, {
        apiKey: options.apiKey,
        timeout: options.timeout ?? 5000,
      });
      const foreign = options.claimedBy ? foreignEngineHealth(options.claimedBy, body, baseUrl) : null;
      if (foreign) return foreign;
      return { running: true, healthy: true, modelsLoaded: openAiModelIds(body) };
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
