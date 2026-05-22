import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const execAsync = promisify(exec);

export interface OllamaInstallStatus {
  installed: boolean;
  version?: string;
  installPath?: string;
  needsInstall: boolean;
}

@Injectable()
export class OllamaInstallerService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * Check if Ollama is installed and get version info
   */
  async checkInstallation(): Promise<OllamaInstallStatus> {
    try {
      // Try to get Ollama version
      const { stdout } = await execAsync('ollama --version', { timeout: 5000 });
      const version = stdout.trim();

      // Get installation path
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
    } catch (_err) {
      this.logger.info('[OllamaInstaller] Ollama not found in PATH');
      return {
        installed: false,
        needsInstall: true,
      };
    }
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
          return await this.installMacOS();
        case 'linux':
          return await this.installLinux();
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
   * Install Ollama on macOS using official installer
   */
  private async installMacOS(): Promise<{ success: boolean; message: string }> {
    const tempDir = os.tmpdir();
    const installerPath = path.join(tempDir, 'Ollama.dmg');

    try {
      // Download Ollama DMG
      this.logger.info('[OllamaInstaller] Downloading Ollama for macOS...');
      await execAsync(`curl -L -o "${installerPath}" https://ollama.com/download/Ollama-darwin.zip`, {
        timeout: 300000, // 5 minute timeout for download
      });

      // Mount DMG and install
      this.logger.info('[OllamaInstaller] Installing Ollama...');
      await execAsync(`open "${installerPath}"`);

      // Wait a bit for installation to complete
      await new Promise((resolve) => setTimeout(resolve, 5000));

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
        message: 'Installation completed but Ollama is not available in PATH. You may need to restart your terminal or system.',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] macOS installation failed: ${message}`);

      // Clean up on failure
      await fs.unlink(installerPath).catch(() => {
        /* Ignore cleanup errors */
      });

      return {
        success: false,
        message: `macOS installation failed: ${message}`,
      };
    }
  }

  /**
   * Install Ollama on Linux using official install script
   */
  private async installLinux(): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.info('[OllamaInstaller] Installing Ollama on Linux...');

      // Use official install script
      await execAsync('curl -fsSL https://ollama.com/install.sh | sh', {
        timeout: 300000, // 5 minute timeout
      });

      // Verify installation
      const status = await this.checkInstallation();
      if (status.installed) {
        return {
          success: true,
          message: `Ollama installed successfully${status.version ? ` (${status.version})` : ''}`,
        };
      }

      return {
        success: false,
        message: 'Installation script completed but Ollama is not available in PATH',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[OllamaInstaller] Linux installation failed: ${message}`);
      return {
        success: false,
        message: `Linux installation failed: ${message}`,
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
      await new Promise((resolve) => setTimeout(resolve, 10000));

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
