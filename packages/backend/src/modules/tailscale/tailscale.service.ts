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

type ExecStrategy = 'host' | 'sidecar';

@Injectable()
export class TailscaleService {
  private readonly logger = new Logger(TailscaleService.name);
  private readonly binaryPath = '/usr/bin/tailscale';
  /** Docker sidecar for Tailscale (`hub-tailscale`, `private-vpn` profile) when the host has no Tailscale socket */
  private readonly sidecarContainer = process.env.TAILSCALE_SIDECAR_CONTAINER ?? 'hub-tailscale';
  /** Upstream for `tailscale serve` when using sidecar (Traefik service name:port) */
  private readonly serveUpstreamSidecar = process.env.TAILSCALE_SERVE_UPSTREAM ?? 'traefik:80';

  private strategyCache: { value: ExecStrategy | null; expires: number } | null = null;
  private static readonly STRATEGY_TTL_MS = 30_000;

  private execHost(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(this.binaryPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  private execDocker(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile('docker', ['exec', this.sidecarContainer, 'tailscale', ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  /**
   * Host Tailscale (binary + socket in this process namespace) or a Tailscale container via `docker exec`.
   */
  private async resolveStrategy(): Promise<ExecStrategy | null> {
    const now = Date.now();
    if (this.strategyCache && now < this.strategyCache.expires) {
      return this.strategyCache.value;
    }

    let value: ExecStrategy | null = null;

    const hostBinary = await this.isInstalled();
    const hostSocket = await this.isSocketAvailable();
    if (hostBinary && hostSocket) {
      try {
        await this.execHost(['version'], 5000);
        value = 'host';
      } catch {
        this.logger.debug('Host tailscale binary present but version check failed; trying sidecar');
      }
    }

    if (value === null) {
      try {
        await this.execDocker(['version'], 5000);
        value = 'sidecar';
      } catch {
        value = null;
      }
    }

    this.strategyCache = { value, expires: now + TailscaleService.STRATEGY_TTL_MS };
    return value;
  }

  private invalidateStrategyCache(): void {
    this.strategyCache = null;
  }

  private async execTailscale(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'host') {
      return this.execHost(args, timeoutMs);
    }
    if (strategy === 'sidecar') {
      return this.execDocker(args, timeoutMs);
    }
    throw new Error('Tailscale CLI unavailable (no host socket and no sidecar)');
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

  private parseStatusJson(stdout: string, installed: boolean): TailscaleStatus {
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

    try {
      const status = JSON.parse(stdout) as Record<string, unknown>;

      const version = (status.Version as string) || null;
      const connected = status.BackendState === 'Running';

      let supportsServices = false;
      if (version) {
        const match = version.match(/^(\d+)\.(\d+)/);
        if (match) {
          const major = Number(match[1]);
          const minor = Number(match[2]);
          supportsServices = major > 1 || (major === 1 && minor >= 86);
        }
      }

      const self = (status.Self as Record<string, unknown>) || {};

      return {
        installed,
        connected,
        version,
        hostname: (self.HostName as string) || null,
        tailnet: ((status.CurrentTailnet as Record<string, unknown>)?.Name as string) || null,
        ip: (self.TailscaleIPs as string[])?.[0] || null,
        supportsServices,
        backendState: (status.BackendState as string) || null,
      };
    } catch (error) {
      this.logger.warn(`Failed to parse tailscale status JSON: ${error}`);
      return { ...notInstalled, installed };
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

    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      return notInstalled;
    }

    try {
      const execFn = strategy === 'host' ? this.execHost.bind(this) : this.execDocker.bind(this);
      const { stdout } = await execFn(['status', '--json']);
      return this.parseStatusJson(stdout, true);
    } catch (error) {
      this.logger.warn(`Failed to get Tailscale status: ${error}`);
      this.invalidateStrategyCache();
      return { ...notInstalled, installed: true };
    }
  }

  /**
   * Initiate Tailscale auth — returns URL for browser OAuth redirect (host Tailscale only).
   */
  async startAuth(operator?: string): Promise<{ authUrl: string }> {
    const args = ['up', '--json'];
    if (operator) {
      args.push(`--operator=${operator}`);
    }

    const { stdout } = await this.execHost(args, 30000);
    const result = JSON.parse(stdout) as Record<string, unknown>;

    if (result.AuthURL) {
      return { authUrl: result.AuthURL as string };
    }

    if (result.BackendState === 'Running') {
      return { authUrl: '' };
    }

    throw new Error('Failed to get Tailscale auth URL');
  }

  /**
   * Disconnect from Tailscale (host only)
   */
  async disconnect(): Promise<void> {
    await this.execHost(['down']);
  }

  private async getServeUpstreamTarget(localPort: number): Promise<string> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'sidecar') {
      return this.serveUpstreamSidecar.includes(':') ? this.serveUpstreamSidecar : `${this.serveUpstreamSidecar}:${localPort}`;
    }
    return `localhost:${localPort}`;
  }

  /**
   * Serve an app via Tailscale Serve (path-based)
   */
  async serveApp(params: { subdomain: string; localPort: number }): Promise<void> {
    const { subdomain, localPort } = params;
    const upstream = await this.getServeUpstreamTarget(localPort);

    const status = await this.getStatus();

    if (status.supportsServices) {
      try {
        await this.execTailscale(['serve', '--bg', '--yes', `--service=${subdomain}`, '--https=443', upstream]);
        this.logger.log(`Tailscale Serve (service): ${subdomain} → ${upstream}`);
        return;
      } catch (error) {
        this.logger.warn(`Tailscale Services failed, falling back to path-based: ${error}`);
      }
    }

    await this.execTailscale(['serve', '--bg', '--yes', `--set-path=/${subdomain}`, upstream]);
    this.logger.log(`Tailscale Serve (path): /${subdomain} → ${upstream}`);
  }

  /**
   * Remove a served app
   */
  async unserveApp(subdomain: string): Promise<void> {
    const status = await this.getStatus();

    try {
      if (status.supportsServices) {
        await this.execTailscale(['serve', `--service=${subdomain}`, 'off']);
      } else {
        await this.execTailscale(['serve', `--set-path=/${subdomain}`, 'off']);
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
      const { stdout } = await this.execTailscale(['serve', 'status', '--json']);
      const data = JSON.parse(stdout) as Record<string, unknown>;

      const entries: TailscaleServeEntry[] = [];

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
