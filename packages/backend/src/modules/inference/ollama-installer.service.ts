import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaBackend } from './backends/ollama.backend';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execAsync = promisify(exec);

export interface OllamaInstallStatus {
  installed: boolean;
  version?: string;
  installPath?: string;
  needsInstall: boolean;
  running: boolean;
  ready: boolean;
  endpointUrl: string;
  error?: string;
}

@Injectable()
export class OllamaInstallerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly ollamaBackend: OllamaBackend,
  ) {}

  private async detectCliInstallation() {
    try {
      const { stdout } = await execAsync('ollama --version', { timeout: 5000 });
      const version = stdout.trim();

      let installPath: string | undefined;
      try {
        const { stdout: whichOutput } = await execAsync(os.platform() === 'win32' ? 'where ollama' : 'which ollama');
        installPath = whichOutput.trim().split('\n')[0];
      } catch {
        // Path detection failed, but version works so it's installed somewhere
      }
      return {
        installed: true,
        version,
        installPath,
      };
    } catch {
      // Container PATH check failed
    }

    // Second try: Check common host installation paths
    const commonPaths = [
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      '/opt/homebrew/bin/ollama', // macOS Homebrew (Apple Silicon)
      '/home/linuxbrew/.linuxbrew/bin/ollama', // Linux Homebrew
      '/usr/local/opt/ollama/bin/ollama', // macOS Homebrew (Intel)
      '/Applications/Ollama.app/Contents/Resources/ollama', // macOS app bundle
      '/Applications/Ollama.app/Contents/MacOS/Ollama', // macOS app executable
    ];

    for (const ollamaPath of commonPaths) {
      try {
        const { stdout } = await execAsync(`${ollamaPath} --version`, { timeout: 5000 });
        const version = stdout.trim();

        this.logger.info(`[OllamaInstaller] Found Ollama at ${ollamaPath}`);
        return {
          installed: true,
          version,
          installPath: ollamaPath,
        };
      } catch {
        // This path doesn't have Ollama, try next
      }
    }

    // Not found anywhere
    this.logger.info('[OllamaInstaller] Ollama not found in PATH or common installation locations');
    return {
      installed: false,
    };
  }

  /**
   * Check if Ollama is installed and whether the configured runtime endpoint is reachable.
   */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    const [cliStatus, endpointHealth] = await Promise.all([this.detectCliInstallation(), this.ollamaBackend.healthCheck()]);
    const endpointUrl = this.ollamaBackend.getBaseUrl();
    const ready = endpointHealth.running && endpointHealth.healthy;
    const installed = cliStatus.installed || ready;

    return {
      installed,
      version: cliStatus.version,
      installPath: cliStatus.installPath,
      needsInstall: !installed,
      running: ready,
      ready,
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
