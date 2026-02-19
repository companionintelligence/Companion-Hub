import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

export interface TailscaleStatus {
  installed: boolean;
  connected: boolean;
  version: string | null;
  hostname: string | null;
  tailnet: string | null;
  ip: string | null;
  supportsServices: boolean;
  backendState: string | null;
}

export interface TailscaleServeEntry {
  service: string;
  proto: string;
  mountPoint: string;
  dest: string;
}

interface TailscaleServeServiceConfig {
  Dest?: string;
}

interface TailscaleServeWebHandler {
  Proxy?: string;
  Path?: string;
}

@Injectable()
export class TailscaleService {
  private readonly logger = new Logger(TailscaleService.name);
  private readonly binaryPath = '/usr/bin/tailscale';

  /**
   * Execute a tailscale CLI command
   */
  private exec(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  async isInstalled(): Promise<boolean> {
    try {
      await access(this.binaryPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async isSocketAvailable(): Promise<boolean> {
    try {
      await access('/var/run/tailscale/tailscaled.sock', constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<TailscaleStatus> {
    const notInstalled: TailscaleStatus = {
      installed: false,
      connected: false,
      version: null,
      hostname: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      backendState: null,
    };

    const installed = await this.isInstalled();
    if (!installed) return notInstalled;

    try {
      const { stdout } = await this.exec(['status', '--json']);
      const status = JSON.parse(stdout);

      const version = status.Version || null;
      const connected = status.BackendState === 'Running';

      // Tailscale Services requires v1.86+
      let supportsServices = false;
      if (version) {
        const match = version.match(/^(\d+)\.(\d+)/);
        if (match) {
          const [, major, minor] = match.map(Number);
          supportsServices = major > 1 || (major === 1 && minor >= 86);
        }
      }

      const self = status.Self || {};

      return {
        installed: true,
        connected,
        version,
        hostname: self.HostName || null,
        tailnet: status.CurrentTailnet?.Name || null,
        ip: self.TailscaleIPs?.[0] || null,
        supportsServices,
        backendState: status.BackendState || null,
      };
    } catch (error) {
      this.logger.warn(`Failed to get Tailscale status: ${error}`);
      return { ...notInstalled, installed: true };
    }
  }

  /**
   * Initiate Tailscale auth — returns URL for browser OAuth redirect
   */
  async startAuth(operator?: string): Promise<{ authUrl: string }> {
    const args = ['up', '--json'];
    if (operator) {
      args.push(`--operator=${operator}`);
    }

    const { stdout } = await this.exec(args, 30000);
    const result = JSON.parse(stdout);

    if (result.AuthURL) {
      return { authUrl: result.AuthURL };
    }

    // Already authenticated
    if (result.BackendState === 'Running') {
      return { authUrl: '' };
    }

    throw new Error('Failed to get Tailscale auth URL');
  }

  /**
   * Disconnect from Tailscale
   */
  async disconnect(): Promise<void> {
    await this.exec(['down']);
  }

  /**
   * Serve an app via Tailscale Serve (path-based)
   */
  async serveApp(params: { subdomain: string; localPort: number }): Promise<void> {
    const { subdomain, localPort } = params;

    // Try Tailscale Services first (v1.86+), fall back to path-based
    const status = await this.getStatus();

    if (status.supportsServices) {
      try {
        await this.exec(['serve', '--bg', '--yes', `--service=${subdomain}`, '--https=443', `localhost:${localPort}`]);
        this.logger.log(`Tailscale Serve (service): ${subdomain} → localhost:${localPort}`);
        return;
      } catch (error) {
        this.logger.warn(`Tailscale Services failed, falling back to path-based: ${error}`);
      }
    }

    // Fallback: path-based
    await this.exec(['serve', '--bg', '--yes', `--set-path=/${subdomain}`, `localhost:${localPort}`]);
    this.logger.log(`Tailscale Serve (path): /${subdomain} → localhost:${localPort}`);
  }

  /**
   * Remove a served app
   */
  async unserveApp(subdomain: string): Promise<void> {
    const status = await this.getStatus();

    try {
      if (status.supportsServices) {
        await this.exec(['serve', `--service=${subdomain}`, 'off']);
      } else {
        await this.exec(['serve', `--set-path=/${subdomain}`, 'off']);
      }
      this.logger.log(`Tailscale Serve removed: ${subdomain}`);
    } catch (error) {
      this.logger.warn(`Failed to remove Tailscale serve for ${subdomain}: ${error}`);
    }
  }

  /**
   * Get current Tailscale Serve status
   */
  async getServeStatus(): Promise<{ entries: TailscaleServeEntry[] }> {
    try {
      const { stdout } = await this.exec(['serve', 'status', '--json']);
      const data = JSON.parse(stdout);

      const entries: TailscaleServeEntry[] = [];

      // Parse the serve config structure
      if (data.Services) {
        for (const [name, config] of Object.entries(data.Services as Record<string, TailscaleServeServiceConfig>)) {
          entries.push({
            service: name,
            proto: 'https',
            mountPoint: '/',
            dest: config.Dest || '',
          });
        }
      }

      if (data.Web) {
        for (const [, handlers] of Object.entries(data.Web as Record<string, Record<string, TailscaleServeWebHandler>>)) {
          for (const [path, config] of Object.entries(handlers)) {
            entries.push({
              service: path.replace(/^\//, ''),
              proto: 'https',
              mountPoint: path,
              dest: config.Proxy || config.Path || '',
            });
          }
        }
      }

      return { entries };
    } catch {
      return { entries: [] };
    }
  }
}
