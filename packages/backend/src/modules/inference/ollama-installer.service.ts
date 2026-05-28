import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { OllamaBackend } from './backends/ollama.backend';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const execAsync = promisify(exec);
const OLLAMA_INSTALL_SCRIPT = 'curl -fsSL https://ollama.com/install.sh | sh';

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

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

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
   * Install Ollama for the current platform
   */
  async install(): Promise<{ success: boolean; message: string }> {
    const platform = os.platform();

    try {
      this.logger.info(`[OllamaInstaller] Starting Ollama installation for platform: ${platform}`);

      switch (platform) {
        case 'darwin':
        case 'linux':
          return {
            success: false,
            message: `Install Ollama on the host machine with: ${OLLAMA_INSTALL_SCRIPT}`,
          };
        case 'win32':
          return await this.installWindows();
        default:
          return {
            success: false,
            message: `Unsupported platform: ${platform}`,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Installation failed: ${message}`);
      return {
        success: false,
        message: `Installation failed: ${message}`,
      };
    }
  }

  /**
   * Install Ollama on Windows using official installer
   */
  private async installWindows(): Promise<{ success: boolean; message: string }> {
    const tempDir = os.tmpdir();
    const installerPath = path.join(tempDir, 'OllamaSetup.exe');

    try {
      this.logger.info('[OllamaInstaller] Downloading Ollama for Windows...');

      // Download Windows installer
      await execAsync(`curl -L -o "${installerPath}" https://ollama.com/download/OllamaSetup.exe`, {
        timeout: 300000, // 5 minute timeout
      });

      // Run installer silently
      this.logger.info('[OllamaInstaller] Running Ollama installer...');
      await execAsync(`"${installerPath}" /S`, {
        timeout: 300000, // 5 minute timeout for installation
      });

      // Wait for installation to complete
      await this.delay(10000);

      // Verify installation
      const status = await this.checkInstallation();
      if (status.ready) {
        // Clean up installer
        await fs.unlink(installerPath).catch(() => {
          /* Ignore cleanup errors */
        });
        return {
          success: true,
          message: `Ollama installed successfully${status.version ? ` (${status.version})` : ''}`,
        };
      }

      return {
        success: false,
        message: `Installation completed but the configured Ollama endpoint is not reachable (${status.endpointUrl}). Start Ollama on the host machine and re-check the connection.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Windows installation failed: ${message}`);

      // Clean up on failure
      await fs.unlink(installerPath).catch(() => {
        /* Ignore cleanup errors */
      });

      return {
        success: false,
        message: `Windows installation failed: ${message}`,
      };
    }
  }
}
