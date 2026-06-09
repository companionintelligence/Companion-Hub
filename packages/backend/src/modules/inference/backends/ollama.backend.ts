import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

/** Candidate Ollama URLs ordered by likelihood inside a Docker container. */
const OLLAMA_FALLBACK_URLS = [
  'http://host.docker.internal:11434',
  'http://172.17.0.1:11434', // default Docker bridge gateway (Linux)
  'http://localhost:11434',
];

@Injectable()
export class OllamaBackend implements InferenceBackend {
  readonly type = 'ollama' as const;
  private configuredUrl: string;
  /** Resolved URL after probing — updated once on first successful contact. */
  private resolvedUrl: string;
  private urlResolved = false;

  constructor(private readonly logger: LoggerService) {
    // OLLAMA_URL is injected by docker-compose as http://host.docker.internal:11434 (the Hub
    // container reaches the host's native Ollama over the host-gateway bridge). When the backend
    // runs directly on the host (`pnpm dev`), there is no compose env and no ci-hub-ollama
    // container, so default to the loopback address where a host Ollama listens.
    this.configuredUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    this.resolvedUrl = this.configuredUrl;
  }

  /**
   * Probe the configured URL and, on failure, try well-known fallback addresses.
   * Once a reachable URL is found it is cached for the lifetime of the process.
   */
  private async resolveUrl(): Promise<string> {
    if (this.urlResolved) return this.resolvedUrl;

    // Try configured URL first
    if (await this.probe(this.configuredUrl)) {
      this.urlResolved = true;
      return this.resolvedUrl;
    }

    // Try fallbacks (skip the configured one since we already tried it)
    for (const candidate of OLLAMA_FALLBACK_URLS) {
      if (candidate === this.configuredUrl) continue;
      if (await this.probe(candidate)) {
        this.logger.info(`[Ollama] Configured URL ${this.configuredUrl} unreachable — discovered Ollama at ${candidate}`);
        this.resolvedUrl = candidate;
        this.urlResolved = true;
        return this.resolvedUrl;
      }
    }

    // Nothing reachable — keep using configuredUrl so callers get meaningful errors
    this.logger.warn(`[Ollama] Could not reach Ollama at ${this.configuredUrl} or any fallback address`);
    return this.resolvedUrl;
  }

  private async probe(url: string): Promise<boolean> {
    try {
      await axios.get(`${url}/api/version`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Reset resolved URL so the next call re-probes. Called when a request fails with a network error. */
  private invalidateResolvedUrl(): void {
    this.urlResolved = false;
    this.resolvedUrl = this.configuredUrl;
  }

  /** URL exposed to app containers and external callers (compose / env contract). */
  getBaseUrl(): string {
    // Return the resolved URL if we've found one, otherwise the configured one.
    return this.resolvedUrl;
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const url = await this.resolveUrl();
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      const models = response.data?.models ?? [];
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m: { name: string }) => m.name),
      };
    } catch (err) {
      this.invalidateResolvedUrl();
      return {
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async listModels(): Promise<BackendModelInfo[]> {
    try {
      const url = await this.resolveUrl();
      const response = await axios.get(`${url}/api/tags`, { timeout: 10000 });
      const models = response.data?.models ?? [];
      return models.map((m: { name: string; size: number; details?: { family?: string } }) => ({
        id: m.name,
        name: m.name,
        size: m.size || 0,
        loaded: true,
      }));
    } catch {
      this.invalidateResolvedUrl();
      return [];
    }
  }

  async pullModel(modelId: string, onProgress?: (progress: PullProgress) => void): Promise<void> {
    this.logger.info(`[Ollama] Pulling model: ${modelId}`);

    const handleLine = (line: string) => {
      try {
        const data = JSON.parse(line);
        const total = data.total || 0;
        const completed = data.completed || 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        onProgress?.({
          status: data.status || 'pulling',
          digest: data.digest,
          total,
          completed,
          percent,
        });
      } catch {
        // Ignore parse errors in stream
      }
    };

    try {
      const url = await this.resolveUrl();
      const response = await axios.post(`${url}/api/pull`, { name: modelId, stream: true }, { responseType: 'stream', timeout: 0 });

      await new Promise<void>((resolve, reject) => {
        response.data.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            handleLine(line);
          }
        });
        response.data.on('end', () => {
          this.logger.info(`[Ollama] Model pulled: ${modelId}`);
          resolve();
        });
        response.data.on('error', (streamErr: Error) => {
          this.logger.error(`[Ollama] Pull stream failed for ${modelId}: ${streamErr.message}`);
          reject(streamErr);
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Pull failed for ${modelId}: ${msg}`);
      this.invalidateResolvedUrl();
      throw err;
    }
  }

  async loadModel(modelId: string, options?: { embedding?: boolean }): Promise<void> {
    this.logger.info(`[Ollama] Loading model: ${modelId}`);
    try {
      const url = await this.resolveUrl();
      if (options?.embedding) {
        await axios.post(`${url}/api/embed`, { model: modelId, input: '', keep_alive: -1 }, { timeout: 120000 });
      } else {
        await axios.post(`${url}/api/generate`, { model: modelId, prompt: '', keep_alive: -1 }, { timeout: 120000 });
      }
      this.logger.info(`[Ollama] Model loaded and pinned: ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to load model ${modelId}: ${msg}`);
      this.invalidateResolvedUrl();
      throw err;
    }
  }

  async unloadModel(modelId: string, options?: { embedding?: boolean }): Promise<void> {
    this.logger.info(`[Ollama] Unloading model: ${modelId}`);
    try {
      const url = await this.resolveUrl();
      if (options?.embedding) {
        await axios.post(`${url}/api/embed`, { model: modelId, input: '', keep_alive: 0 }, { timeout: 30000 });
      } else {
        await axios.post(`${url}/api/generate`, { model: modelId, prompt: '', keep_alive: 0 }, { timeout: 30000 });
      }
      this.logger.info(`[Ollama] Model unloaded: ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to unload model ${modelId}: ${msg}`);
      this.invalidateResolvedUrl();
      throw err;
    }
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    try {
      const url = await this.resolveUrl();
      const response = await axios.get(`${url}/api/ps`, { timeout: 5000 });
      const models = response.data?.models ?? [];
      return models.some((m: { name: string }) => m.name === modelId || m.name.startsWith(modelId));
    } catch {
      this.invalidateResolvedUrl();
      return false;
    }
  }

  getDockerImage(): string {
    return 'ollama/ollama:latest';
  }

  getComposeConfig(gpuVendor: string): Record<string, unknown> {
    const base: Record<string, unknown> = {
      image: this.getDockerImage(),
      container_name: 'ci-hub-ollama',
      restart: 'unless-stopped',
      ports: ['11434:11434'],
      volumes: ['ollama-data:/root/.ollama'],
    };

    if (gpuVendor === 'nvidia') {
      base.deploy = {
        resources: {
          reservations: { devices: [{ capabilities: ['gpu'], count: 'all' }] },
        },
      };
      base.runtime = 'nvidia';
    } else if (gpuVendor === 'amd') {
      base.devices = ['/dev/kfd', '/dev/dri'];
      base.group_add = ['video', 'render'];
    }

    return base;
  }
}
