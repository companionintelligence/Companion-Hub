import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { isBridgeConnectionRefused } from './backends/ollama-host-bridge';
import { OllamaBackend } from './backends/ollama.backend';

export interface OllamaInstallStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  /** Where the Hub reached Ollama, when ready. */
  reachableVia?: 'direct' | 'host-network';
  /** User-facing endpoint label. */
  displayEndpoint?: string;
  /** Actionable guidance when not ready or when apps may need extra host config. */
  hint?: string;
  error?: string;
}

@Injectable()
export class OllamaInstallerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly ollamaBackend: OllamaBackend,
  ) {}

  /**
   * Check whether host Ollama is reachable (directly or via the Hub's host-network bridge).
   */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    const endpointUrl = this.ollamaBackend.getBaseUrl();
    this.ollamaBackend.resetTransportCache();

    try {
      const endpointHealth = await this.ollamaBackend.healthCheck();
      const ready = endpointHealth.running && endpointHealth.healthy;
      const reachableVia = ready ? this.ollamaBackend.getTransport() : undefined;
      const displayEndpoint = ready ? this.ollamaBackend.getDisplayEndpoint() : endpointUrl;
      const hint = this.buildHint(ready, reachableVia, endpointHealth.error);

      this.logger.info(
        `[OllamaInstaller] Health check — ready=${ready} running=${endpointHealth.running} url=${endpointUrl} via=${reachableVia ?? 'none'}`,
      );

      return {
        ready,
        running: endpointHealth.running,
        endpointUrl,
        reachableVia,
        displayEndpoint,
        hint,
        error: ready ? undefined : endpointHealth.error,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Health check threw unexpectedly: ${msg}`);
      return {
        ready: false,
        running: false,
        endpointUrl,
        hint: this.buildHint(false, undefined, msg),
        error: msg,
      };
    }
  }

  private buildHint(ready: boolean, reachableVia?: 'direct' | 'host-network', error?: string): string | undefined {
    if (ready && reachableVia === 'host-network') {
      return 'Ollama is running on the host. App containers may also need OLLAMA_HOST=0.0.0.0 in the host Ollama service to reach it directly.';
    }

    if (ready) return undefined;

    if (isBridgeConnectionRefused(error)) {
      return 'Ollama may already be installed on this machine, but the Hub container could not connect over the Docker bridge. Ensure Ollama is running (systemctl status ollama). On Linux, set OLLAMA_HOST=0.0.0.0:11434 in the Ollama service so containers can reach it, then re-check.';
    }

    if (error?.includes('docker curl exited') || error?.includes('Cannot connect to the Docker daemon')) {
      return 'The Hub could not probe host Ollama. Ensure Docker is running and Ollama is started on the host, then re-check.';
    }

    return undefined;
  }

  /**
   * Validate Ollama availability and provide host-first guidance.
   */
  async install(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.checkInstallation();
      if (status.ready) {
        const where = status.displayEndpoint ?? status.endpointUrl;
        return {
          success: true,
          message: `Ollama is running and reachable at ${where}.`,
        };
      }

      const hint = status.hint ?? 'Install it from ollama.com and start it on the host, then re-check.';
      return {
        success: false,
        message: `Ollama isn't reachable at ${status.endpointUrl}. ${hint}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Installation failed: ${message}`);
      return {
        success: false,
        message: `Installation failed: ${message}`,
      };
    }
  }
}
