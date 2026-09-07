import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceBackend } from './backend.interface';
import type { BackendHealthStatus, BackendModelInfo, PullProgress } from '@ci-hub/common/types';
import axios from 'axios';
// Shared with the Lucebox and Lemonade backends: all three mount the same AMD device nodes and
// so need the same host GIDs. See that module for the full rationale.
import { type DeviceGroupProbe, resolveAmdDeviceGroupIds } from './amd-device-groups.util';
import { QUARANTINE_STRIKES, ServingQuarantine } from './serving-quarantine';

/** Candidate Ollama URLs ordered by likelihood inside a Docker container. */
const OLLAMA_FALLBACK_URLS = [
  'http://host.docker.internal:11434',
  'http://172.17.0.1:11434', // default Docker bridge gateway (Linux)
  'http://localhost:11434',
];

/** Extra deployment hints beyond the shared `{ rocmReady, unifiedMemory }` pair. */
export interface OllamaComposeOptions {
  rocmReady?: boolean;
  unifiedMemory?: boolean;
  /**
   * Numeric host GIDs owning `/dev/kfd` and `/dev/dri/*`; derived from `/dev` when omitted.
   * Supply these when generating the config somewhere other than the GPU host, where the
   * device nodes cannot be statted.
   */
  groupIds?: number[];
  /** Test seam for {@link resolveAmdDeviceGroupIds}. */
  deviceProbe?: DeviceGroupProbe;
}

@Injectable()
export class OllamaBackend implements InferenceBackend {
  readonly type = 'ollama' as const;
  private configuredUrl: string;
  /** Resolved URL after probing — updated once on first successful contact. */
  private resolvedUrl: string;
  private urlResolved = false;
  /**
   * Models this Ollama has listed but failed to serve. `/api/tags` cannot answer that question and
   * the only thing that can — asking it to generate — is exactly what a health poll must not do,
   * so the answer is accumulated from the requests that ran anyway. See {@link ServingQuarantine}.
   */
  private readonly quarantine = new ServingQuarantine();

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

  /**
   * Reachability plus inventory — and, separately, which of that inventory this Ollama has been
   * caught unable to serve.
   *
   * `running`/`healthy` still mean only "the daemon answered", and `modelsLoaded` still means only
   * "on disk": both are what `/api/tags` can actually tell us, and the Hub's install and pull
   * decisions depend on them keeping that meaning. What changed is that they are no longer the
   * whole health contract. `/api/tags` will list a model whose every `/api/generate` returns
   * `model failed to load` — a real fleet node did exactly that — so callers choosing where to send
   * work must subtract {@link BackendHealthStatus.unservableModels} before they route.
   */
  async healthCheck(): Promise<BackendHealthStatus> {
    try {
      const url = await this.resolveUrl();
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      const models = response.data?.models ?? [];
      const unservableModels = await this.reconcileQuarantine(url);
      return {
        running: true,
        healthy: true,
        modelsLoaded: models.map((m: { name: string }) => m.name),
        // Omitted rather than empty, so a node with nothing withheld reports exactly what it did
        // before this signal existed.
        ...(unservableModels.length > 0 ? { unservableModels } : {}),
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

  /**
   * Currently withheld models, after giving any of them that Ollama reports **resident** their
   * release. `/api/ps` is the one place the engine speaks about VRAM rather than disk, so a model
   * listed there is proof of the exact thing we withheld it for lacking — and it costs nothing to
   * ask, no load, no generation.
   *
   * Skipped while the quarantine is tracking nothing at all, which is the overwhelmingly common
   * case: a node that has never failed to serve keeps its single-request health poll.
   *
   * Note the guard is `isEmpty()`, not "is anything withheld" — a model keeps its entry for the
   * whole strike window after a single failure, so one strike that never reached the withhold
   * threshold still costs one extra `/api/ps` per poll until the window closes.
   */
  private async reconcileQuarantine(url: string): Promise<string[]> {
    if (this.quarantine.isEmpty()) {
      return [];
    }
    try {
      const response = await axios.get(`${url}/api/ps`, { timeout: 5000 });
      const resident: Array<{ name: string }> = response.data?.models ?? [];
      for (const withheld of this.quarantine.list()) {
        if (resident.some((m) => this.matchesModel(m.name, withheld))) {
          this.noteServingSuccess(withheld);
        }
      }
    } catch (err) {
      // The inventory call above already succeeded, so this is a `/api/ps` problem, not a down
      // engine. Keeping the existing verdict is the safe read: it decays on its own.
      this.logger.debug(`[Ollama] Could not read /api/ps to re-check withheld models: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.quarantine.list();
  }

  /** Ollama reports fully-qualified tags (`gemma3:1b`); callers may hold either that or the bare name. */
  private matchesModel(reportedName: string, modelId: string): boolean {
    return reportedName === modelId || reportedName.startsWith(modelId);
  }

  /**
   * Record that a request for `modelId` failed in a way that says this engine cannot serve it —
   * the caller's own verdict, since the engine will not volunteer one. Callers should pass only
   * server-side rejections: a connection error means the whole daemon is unreachable, which
   * `healthCheck` already reports, and holding a model responsible for it would outlive the outage.
   */
  noteServingFailure(modelId: string, reason: string): void {
    this.recordServingFailure(modelId, reason);
  }

  /** Record that `modelId` was served. Clears its strikes and its backoff — recovery must not have to wait out a penalty. */
  noteServingSuccess(modelId: string): void {
    if (this.quarantine.recordSuccess(modelId)) {
      this.logger.info(`[Ollama] Model ${modelId} served again — no longer withheld from routing`);
    }
  }

  private recordServingFailure(modelId: string, reason: string, weight?: number): void {
    const decision = this.quarantine.recordFailure(modelId, reason, weight);
    if (decision.withheld) {
      this.logger.warn(
        `[Ollama] Model ${modelId} is listed by /api/tags but failed to serve (${reason}); withholding it from routing for ${Math.round(decision.forMs / 1000)}s`,
      );
      return;
    }
    this.logger.debug(`[Ollama] Model ${modelId} failed to serve (${reason}); strike ${decision.strikes} of ${QUARANTINE_STRIKES}`);
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

    try {
      const url = await this.resolveUrl();
      const response = await axios.post(`${url}/api/pull`, { name: modelId, stream: true }, { responseType: 'stream', timeout: 0 });

      await new Promise<void>((resolve, reject) => {
        // Ollama's /api/pull streams NDJSON with HTTP 200 even on failure: a failed pull is
        // delivered as a line like {"error":"pull model manifest: 412: ..."} rather than an HTTP
        // error, and a successful pull terminates with {"status":"success"}. We must inspect the
        // stream — resolving purely on 'end' reports a failed pull as success.
        let streamError: string | null = null;
        let sawSuccess = false;

        const handleLine = (line: string) => {
          let data: { status?: string; error?: string; digest?: string; total?: number; completed?: number };
          try {
            data = JSON.parse(line);
          } catch {
            return; // Ignore parse errors in stream
          }

          if (typeof data.error === 'string' && data.error.length > 0) {
            streamError = data.error;
            return;
          }

          if (data.status === 'success') {
            sawSuccess = true;
          }

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
        };

        // A single JSON object can be split across chunk boundaries, so buffer partial lines
        // and only parse complete (newline-terminated) ones — otherwise a split `success`/`error`
        // line would be dropped and silently flip the resolve/reject decision.
        let buffer = '';
        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const segments = buffer.split('\n');
          // The last segment may be an incomplete line — keep it buffered for the next chunk.
          buffer = segments.pop() ?? '';
          for (const segment of segments) {
            const line = segment.trim();
            if (line) handleLine(line);
          }
        });
        response.data.on('end', () => {
          const remaining = buffer.trim();
          if (remaining) handleLine(remaining);
          if (streamError) {
            reject(new Error(streamError));
            return;
          }
          if (!sawSuccess) {
            reject(new Error(`Ollama pull stream ended without a success status for ${modelId}`));
            return;
          }
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
      // The strongest proof available that this model serves here — it just did the hard part.
      this.noteServingSuccess(modelId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Ollama] Failed to load model ${modelId}: ${msg}`);
      // A load that the *engine* rejected is decisive on its own: this request asked it to do
      // nothing but load the model, so there is no other reading. A transport failure is not —
      // that is the daemon being unreachable, which healthCheck reports, and pinning it on the
      // model would outlive the outage.
      if (axios.isAxiosError(err) && err.response) {
        this.recordServingFailure(modelId, `load returned HTTP ${err.response.status}`, QUARANTINE_STRIKES);
      }
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
      return models.some((m: { name: string }) => this.matchesModel(m.name, modelId));
    } catch {
      this.invalidateResolvedUrl();
      return false;
    }
  }

  /**
   * `options.rocmReady` selects the AMD GPU-runtime variant: the `:rocm` tag when /dev/kfd
   * passthrough is confirmed working, otherwise the default tag. The default tag isn't CPU-only
   * on AMD — Ollama bundles a Vulkan (RADV/Mesa) ggml backend in it that auto-activates whenever
   * GPU devices are passed through (no separate "vulkan" tag exists), so it's the correct choice
   * for AMD hosts where ROCm isn't ready yet. See https://docs.ollama.com/docker#vulkan-support.
   */
  getDockerImage(options?: { rocmReady?: boolean }): string {
    return options?.rocmReady ? 'ollama/ollama:rocm' : 'ollama/ollama:latest';
  }

  /**
   * `options.rocmReady` mirrors HardwareProfile.gpu.hostRocmKfdAvailable — pass it through so the
   * `amd` branch below picks the matching image (see getDockerImage). `options.unifiedMemory`
   * mirrors HardwareProfile.gpu.unifiedMemory (true for the Strix Halo APU): when set alongside a
   * not-ready rocmReady, it forces llama.cpp's Vulkan backend to allocate from GTT/system RAM
   * instead of the small carved-out VRAM window unified-memory APUs expose by default — mirroring
   * the community amd-strix-halo-toolboxes / llama-vulkan-strix setups. Discrete AMD GPUs have
   * real dedicated VRAM, so this must NOT be set for them.
   *
   * `options.groupIds` / `options.deviceProbe` only affect the `amd` branch; see the comment
   * there for why group *names* cannot be used.
   */
  getComposeConfig(gpuVendor: string, options?: OllamaComposeOptions): Record<string, unknown> {
    const base: Record<string, unknown> = {
      image: this.getDockerImage(options),
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

      // `group_add: ['video', 'render']` is a silent failure: Docker resolves those *names*
      // against the **container's** /etc/group (render is typically GID 109), not the host's,
      // where the group owning /dev/kfd and /dev/dri/renderD128 is site-specific — 990 across
      // the Strix Halo fleet, with video at 44. The container joined a group granting nothing
      // and every GPU device open failed with EACCES, which on this backend reads as Ollama
      // silently running on CPU. Stat the nodes the service actually mounts instead.
      const groupIds = options?.groupIds ?? resolveAmdDeviceGroupIds(options?.deviceProbe);
      if (groupIds.length > 0) {
        base.group_add = groupIds.map(String);
      } else {
        // Degrade like Lemonade rather than throw like Lucebox. Lucebox is GPU-only, so a
        // permission-less config is worthless and refusing to emit one costs nothing. Ollama is
        // the default backend and the most widely deployed, it serves perfectly well on CPU, and
        // its container runs as root (note the /root/.ollama volume) where Docker's default
        // CAP_DAC_OVERRIDE means group membership is not the only path to the device nodes. This
        // method is itself built on degrading rather than failing — an AMD host without working
        // ROCm passthrough gets the Vulkan-bundled default tag out of getDockerImage above, not
        // an error — so throwing here would contradict its own posture, and would
        // turn "the GPU may be unavailable" into "no config at all" for any caller evaluating
        // this away from the GPU host. What it never does is emit the names: a group that
        // silently grants nothing is worse than no group at all.
        this.logger.warn(
          '[Ollama] Could not derive host GIDs for /dev/kfd and /dev/dri, so the AMD compose config omits group_add. ' +
            'If the container is run as a non-root user it will fail to open the GPU devices and fall back to CPU — ' +
            'generate this on the GPU host, or pass groupIds explicitly.',
        );
      }

      if (!options?.rocmReady && options?.unifiedMemory) {
        base.environment = { GGML_VK_PREFER_HOST_MEMORY: '1' };
      }
    }

    return base;
  }
}
