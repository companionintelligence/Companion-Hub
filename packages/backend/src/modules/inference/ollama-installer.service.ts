import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaBackend } from './backends/ollama.backend';

export interface OllamaInstallStatus {
  ready: boolean;
  running: boolean;
  endpointUrl: string;
  error?: string;
}

@Injectable()
export class OllamaInstallerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly ollamaBackend: OllamaBackend,
  ) {}

  /**
   * Check whether the containerised Ollama endpoint is reachable and healthy.
   */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    const endpointUrl = this.ollamaBackend.getBaseUrl();
    try {
      const endpointHealth = await this.ollamaBackend.healthCheck();
      const ready = endpointHealth.running && endpointHealth.healthy;

      this.logger.info(`[OllamaInstaller] Health check — ready=${ready} running=${endpointHealth.running} url=${endpointUrl}`);

      return {
        ready,
        running: endpointHealth.running,
        endpointUrl,
        error: ready ? undefined : endpointHealth.error,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Health check threw unexpectedly: ${msg}`);
      return {
        ready: false,
        running: false,
        endpointUrl,
        error: msg,
      };
    }
  }

  /**
   * Validate Ollama availability and provide host-first guidance.
   */
  async install(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.checkInstallation();
      if (status.ready) {
        return {
          success: true,
          message: `Ollama is running and reachable at ${status.endpointUrl}.`,
        };
      }

      return {
        success: false,
        message: `Ollama isn't reachable at ${status.endpointUrl}. Install it from ollama.com and start it on the host (the Hub reaches it over host.docker.internal), then re-check.`,
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
