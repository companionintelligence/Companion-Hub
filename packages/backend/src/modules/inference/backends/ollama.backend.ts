import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
import {
  dockerHostCurl,
  HOST_LOOPBACK_OLLAMA_URL,
  isConnectionRefused,
  isRunningInDocker,
  probeHostNetworkOllama,
  shouldTryHostNetworkBridge,
  type OllamaTransport,
} from './ollama-host-bridge';

@Injectable()
export class OllamaBackend implements InferenceBackend {
  readonly type = 'ollama' as const;
  private configuredUrl: string;
  private transport: OllamaTransport = 'direct';
  private transportResolved = false;
  private transportPromise: Promise<OllamaTransport> | null = null;

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

  getTransport(): OllamaTransport {
    return this.transport;
  }

  /** Clear cached reachability — call before an explicit re-check. */
  resetTransportCache(): void {
    this.transport = 'direct';
    this.transportResolved = false;
    this.transportPromise = null;
  }

  getDisplayEndpoint(): string {
    if (this.transport === 'host-network') {
      return `${HOST_LOOPBACK_OLLAMA_URL} (host)`;
    }
    return this.configuredUrl;
  }

  private async resolveTransport(force = false): Promise<OllamaTransport> {
    if (this.transportResolved && !force) return this.transport;
    if (this.transportPromise && !force) return this.transportPromise;

    this.transportPromise = this.probeTransport();
    const resolved = await this.transportPromise;
    this.transport = resolved.transport;
    this.transportResolved = resolved.reachable;
    this.transportPromise = null;
    return this.transport;
  }

  private async probeTransport(): Promise<{ transport: OllamaTransport; reachable: boolean }> {
    if (await this.directHealthProbe()) {
      this.logger.info(`[Ollama] Reachable at ${this.configuredUrl} (direct)`);
      return { transport: 'direct', reachable: true };
    }

    if (isRunningInDocker() && (await probeHostNetworkOllama())) {
      this.logger.info(
        `[Ollama] Direct URL ${this.configuredUrl} unreachable; using host-network bridge to reach Ollama on the host (127.0.0.1:11434). ` +
          'For app containers to reach Ollama too, set OLLAMA_HOST=0.0.0.0 in the host Ollama service.',
      );
      return { transport: 'host-network', reachable: true };
    }

    this.logger.warn(`[Ollama] Not reachable at ${this.configuredUrl}${isRunningInDocker() ? ' or via host-network bridge' : ''}`);
    return { transport: 'direct', reachable: false };
  }

  private async directHealthProbe(): Promise<boolean> {
    try {
      await axios.get(`${this.configuredUrl}/api/tags`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private async maybeSwitchToHostNetwork(err: unknown): Promise<boolean> {
    if (this.transport === 'host-network') return false;
    if (!shouldTryHostNetworkBridge(this.configuredUrl, err)) return false;
    if (!(await probeHostNetworkOllama())) return false;

    this.transport = 'host-network';
    this.transportResolved = true;
    this.logger.info('[Ollama] Switched to host-network bridge after connection refused on bridge URL');
    return true;
  }

  private async getJson<T>(path: string, timeoutMs: number): Promise<T> {
    await this.resolveTransport();
    if (this.transport === 'host-network') {
      const raw = await dockerHostCurl('GET', path, undefined, { timeoutMs });
      return JSON.parse(raw) as T;
    }

    try {
      const response = await axios.get(`${this.configuredUrl}${path}`, { timeout: timeoutMs });
      return response.data as T;
    } catch (err) {
      if (await this.maybeSwitchToHostNetwork(err)) {
        const raw = await dockerHostCurl('GET', path, undefined, { timeoutMs });
        return JSON.parse(raw) as T;
      }
      throw err;
    }
  }

  private async postJson(path: string, body: unknown, timeoutMs: number): Promise<void> {
    await this.resolveTransport();
    if (this.transport === 'host-network') {
      await dockerHostCurl('POST', path, body, { timeoutMs });
      return;
    }

    try {
      await axios.post(`${this.configuredUrl}${path}`, body, { timeout: timeoutMs });
    } catch (err) {
      if (await this.maybeSwitchToHostNetwork(err)) {
        await dockerHostCurl('POST', path, body, { timeoutMs });
        return;
      }
      throw err;
    }
  }

  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const data = await this.getJson<{ models?: Array<{ name: string }> }>('/api/tags', 5000);
      const models = data?.models ?? [];
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m) => m.name),
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
      const data = await this.getJson<{ models?: Array<{ name: string; size: number; details?: { family?: string } }> }>('/api/tags', 10000);
      const models = data?.models ?? [];
      return models.map((m) => ({
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
    await this.resolveTransport();

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

    const pullViaHostNetwork = async () => {
      let lastPercent = -1;
      await dockerHostCurl(
        'POST',
        '/api/pull',
        { name: modelId, stream: true },
        {
          onLine: (line) => {
            handleLine(line);
            try {
              const data = JSON.parse(line);
              const total = data.total || 0;
              const completed = data.completed || 0;
              const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
              if (percent !== lastPercent) lastPercent = percent;
            } catch {
              // ignore
            }
          },
        },
      );
      this.logger.info(`[Ollama] Model pulled via host-network bridge: ${modelId}`);
    };

    if (this.transport === 'host-network') {
      await pullViaHostNetwork();
      return;
    }

    try {
      const response = await axios.post(`${this.configuredUrl}/api/pull`, { name: modelId, stream: true }, { responseType: 'stream', timeout: 0 });

      await new Promise<void>((resolve, reject) => {
        let lastPercent = 0;
        response.data.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            handleLine(line);
            try {
              const data = JSON.parse(line);
              const total = data.total || 0;
              const completed = data.completed || 0;
              const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
              if (percent !== lastPercent) lastPercent = percent;
            } catch {
              // ignore
            }
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
      if (isConnectionRefused(err) && (await this.maybeSwitchToHostNetwork(err))) {
        await pullViaHostNetwork();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Pull failed for ${modelId}: ${msg}`);
      throw err;
    }
  }

  async loadModel(modelId: string): Promise<void> {
    this.logger.info(`[Ollama] Loading model: ${modelId}`);
    try {
      await this.postJson('/api/generate', { model: modelId, prompt: '', keep_alive: -1 }, 120000);
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
      await this.postJson('/api/generate', { model: modelId, prompt: '', keep_alive: 0 }, 30000);
      this.logger.info(`[Ollama] Model unloaded: ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to unload model ${modelId}: ${msg}`);
      throw err;
    }
  }

  async isModelLoaded(modelId: string): Promise<boolean> {
    try {
      const data = await this.getJson<{ models?: Array<{ name: string }> }>('/api/ps', 5000);
      const models = data?.models ?? [];
      return models.some((m) => m.name === modelId || m.name.startsWith(modelId));
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
