import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
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
}

@Injectable()
export class OllamaInstallerService {
  constructor(private readonly logger: LoggerService) {}

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if Ollama is installed and get version info
   * Checks both container PATH and host system
   */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    // First try: Check if Ollama is accessible in container PATH
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
        needsInstall: false,
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
          needsInstall: false,
        };
      } catch {
        // This path doesn't have Ollama, try next
      }
    }

    // Not found anywhere
    this.logger.info('[OllamaInstaller] Ollama not found in PATH or common installation locations');
    return {
      installed: false,
      needsInstall: true,
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
          return await this.installUnixLike('macOS');
        case 'linux':
          return await this.installUnixLike('Linux');
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
   * Install Ollama on Unix-like systems using Ollama's official install script.
   */
  private async installUnixLike(platformLabel: 'macOS' | 'Linux'): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.info(`[OllamaInstaller] Installing Ollama on ${platformLabel} using the official install script...`);
      await execAsync(OLLAMA_INSTALL_SCRIPT, {
        timeout: 300000,
      });

      await this.delay(2000);

      const status = await this.checkInstallation();
      if (status.installed) {
        return {
          success: true,
          message: `Ollama installed successfully${status.version ? ` (${status.version})` : ''}`,
        };
      }

      return {
        success: false,
        message: `${platformLabel} installation completed but Ollama is not available. You may need to restart the Hub or ensure the Ollama CLI install path is on PATH.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] ${platformLabel} installation failed: ${message}`);

      if (message.includes('Permission denied') || message.includes('EACCES')) {
        return {
          success: false,
          message: `Installation requires administrator permissions. Please install Ollama manually: ${OLLAMA_INSTALL_SCRIPT}`,
        };
      }

      return {
        success: false,
        message: `${platformLabel} installation failed: ${message}`,
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
      if (status.installed) {
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
        message: 'Installation completed but Ollama is not available in PATH. You may need to restart your system.',
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
