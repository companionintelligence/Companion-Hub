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
    const endpointHealth = await this.ollamaBackend.healthCheck();
    const endpointUrl = this.ollamaBackend.getBaseUrl();
    const ready = endpointHealth.running && endpointHealth.healthy;

    return {
      ready,
      running: endpointHealth.running,
      endpointUrl,
      error: ready ? undefined : endpointHealth.error,
    };
  }

  /**
   * Validate Ollama container availability and provide container-first guidance.
   */
  async install(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.checkInstallation();
      if (status.ready) {
        return {
          success: true,
          message: 'Ollama container is already running and reachable.',
        };
      }

      return {
        success: false,
        message: `Ollama is managed by the ci-hub-ollama container. Start or restart that container and re-check ${status.endpointUrl}.`,
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
