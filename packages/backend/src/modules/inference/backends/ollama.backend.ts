import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';

@Injectable()
export class OllamaBackend implements InferenceBackend {
  readonly type = 'ollama' as const;
  private configuredUrl: string;

  constructor(private readonly logger: LoggerService) {
    // OLLAMA_URL is injected by docker-compose as http://host.docker.internal:11434 (the Hub
    // container reaches the host's native Ollama over the host-gateway bridge). When the backend
    // runs directly on the host (`pnpm dev`), there is no compose env and no ci-hub-ollama
    // container, so default to the loopback address where a host Ollama listens.
    this.configuredUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  }

  /** URL exposed to app containers and external callers (compose / env contract). */
  getBaseUrl(): string {
    return this.configuredUrl;
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const response = await axios.get(`${this.configuredUrl}/api/tags`, { timeout: 5000 });
      const models = response.data?.models ?? [];
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m: { name: string }) => m.name),
      };
    } catch (err) {
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
      const response = await axios.get(`${this.configuredUrl}/api/tags`, { timeout: 10000 });
      const models = response.data?.models ?? [];
      return models.map((m: { name: string; size: number; details?: { family?: string } }) => ({
        id: m.name,
        name: m.name,
        size: m.size || 0,
        loaded: true,
      }));
    } catch {
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
      const response = await axios.post(`${this.configuredUrl}/api/pull`, { name: modelId, stream: true }, { responseType: 'stream', timeout: 0 });

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
      throw err;
    }
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[Ollama] Loading model: ${modelId}`);
    try {
      await axios.post(`${this.configuredUrl}/api/generate`, { model: modelId, prompt: '', keep_alive: -1 }, { timeout: 120000 });
      this.logger.info(`[Ollama] Model loaded and pinned: ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to load model ${modelId}: ${msg}`);
      throw err;
    }
  }

  async unloadModel(modelId: string): Promise<void> {
    this.logger.info(`[Ollama] Unloading model: ${modelId}`);
    try {
      await axios.post(`${this.configuredUrl}/api/generate`, { model: modelId, prompt: '', keep_alive: 0 }, { timeout: 30000 });
      this.logger.info(`[Ollama] Model unloaded: ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to unload model ${modelId}: ${msg}`);
      throw err;
    }
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    try {
      const response = await axios.get(`${this.configuredUrl}/api/ps`, { timeout: 5000 });
      const models = response.data?.models ?? [];
      return models.some((m: { name: string }) => m.name === modelId || m.name.startsWith(modelId));
    } catch {
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
