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
  authUrl: string | null;
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

interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

type ExecStrategy = 'host' | 'sidecar';

const DEFAULT_TAILSCALE_LOGIN_SERVER = '--login-server=https://controlplane.tailscale.com';
const DEFAULT_TAILSCALE_EXTRA_ARGS = [DEFAULT_TAILSCALE_LOGIN_SERVER, '--accept-routes', '--advertise-routes=172.18.0.0/16'];

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
        if (err) {
          const execErr = err as ExecError;
          execErr.stdout = stdout;
          execErr.stderr = stderr;
          reject(execErr);
        } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  private execDocker(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile('docker', ['exec', this.sidecarContainer, 'tailscale', ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          const execErr = err as ExecError;
          execErr.stdout = stdout;
          execErr.stderr = stderr;
          reject(execErr);
        } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
    });
  }

  private getConfiguredLoginServerHost(extraArgs: string[]): string | null {
    const inline = extraArgs.find((arg) => arg.startsWith('--login-server='));
    const explicitIndex = extraArgs.indexOf('--login-server');
    const rawValue = inline ? inline.slice('--login-server='.length) : explicitIndex >= 0 ? (extraArgs[explicitIndex + 1] ?? '') : '';

    if (!rawValue) {
      return null;
    }

    try {
      return new URL(rawValue).host;
    } catch {
      return null;
    }
  }

  private extractAuthUrl(output: string, expectedHost?: string | null): string | null {
    const candidates = (output.match(/https?:\/\/[^\s"']+/gi) ?? []).map((url) => url.replace(/[),.;]+$/, ''));
    if (!candidates.length) {
      return null;
    }

    if (expectedHost) {
      const hostMatch = candidates.find((url) => {
        try {
          return new URL(url).host === expectedHost;
        } catch {
          return false;
        }
      });
      if (hostMatch) {
        return hostMatch;
      }
    }

    const tailscaleLoginMatch = candidates.find((url) => {
      try {
        return new URL(url).host === 'login.tailscale.com';
      } catch {
        return false;
      }
    });
    return tailscaleLoginMatch ?? candidates[0] ?? null;
  }

  private getExecErrorOutput(error: unknown): string {
    if (!(error instanceof Error)) {
      return '';
    }
    const execErr = error as ExecError;
    const stdout = execErr.stdout?.toString() ?? '';
    const stderr = execErr.stderr?.toString() ?? '';
    return [stdout, stderr, error.message].filter(Boolean).join('\n');
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

  /** Same flags as `connectWithAuthKey`: env override or default Docker bridge advertisement. */
  private getTailscaleUpExtraArgs(): string[] {
    const extra = (process.env.HUB_TAILSCALE_EXTRA_ARGS || '').trim();
    if (!extra) {
      return [...DEFAULT_TAILSCALE_EXTRA_ARGS];
    }

    const parsed = extra.split(/\s+/).filter(Boolean);
    if (parsed.some((arg) => arg === '--login-server' || arg.startsWith('--login-server='))) {
      return parsed;
    }

    return [DEFAULT_TAILSCALE_LOGIN_SERVER, ...parsed];
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

  /** True when Tailscale can be invoked (host CLI + socket, or `docker exec` into the sidecar). */
  async isCliAvailable(): Promise<boolean> {
    return (await this.resolveStrategy()) !== null;
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
      authUrl: null,
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
        authUrl: (status.AuthURL as string) || null,
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
      authUrl: null,
    };

    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      return notInstalled;
    }

    return this.getStatusForStrategy(strategy);
  }

  private async getStatusForStrategy(strategy: ExecStrategy, suppressErrors = true): Promise<TailscaleStatus> {
    const notInstalled: TailscaleStatus = {
      installed: false,
      connected: false,
      version: null,
      hostname: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      backendState: null,
      authUrl: null,
    };

    try {
      const execFn = strategy === 'host' ? this.execHost.bind(this) : this.execDocker.bind(this);
      const { stdout } = await execFn(['status', '--json']);
      return this.parseStatusJson(stdout, true);
    } catch (error) {
      this.logger.warn(`Failed to get Tailscale status: ${error}`);
      this.invalidateStrategyCache();
      if (!suppressErrors) {
        throw error;
      }
      return { ...notInstalled, installed: true };
    }
  }

  /**
   * Poll the tailscaled daemon inside the sidecar container until it is ready
   * to accept commands. The daemon initializes its Unix socket asynchronously
   * after container start, so `tailscale up` can return EOF if called too soon.
   *
   * We treat any response that is NOT a "socket not ready" error (EOF, no such
   * file, connection refused) as "daemon is up" — including NeedsLogin / NoState
   * exit-1 responses, which are valid daemon states for our purposes.
   */
  private async waitForSidecarDaemon(maxAttempts = 10, delayMs = 2000): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.execDocker(['status', '--json'], 5000);
        return; // daemon responded — ready
      } catch (err: unknown) {
        const msg = String(err);
        const isDaemonNotReady = msg.includes('EOF') || msg.includes('no such file') || msg.includes('connection refused');

        if (!isDaemonNotReady) {
          // Daemon responded with a non-zero exit (e.g. NeedsLogin) — ready enough for `tailscale up`
          return;
        }

        if (attempt === maxAttempts) {
          throw new Error(`Tailscale sidecar daemon not ready after ${(attempt * delayMs) / 1000}s`);
        }

        this.logger.debug(`tailscaled not ready yet (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Initiate Tailscale auth — returns URL for browser OAuth redirect (host or sidecar).
   */
  async startAuth(operator?: string): Promise<{ authUrl: string }> {
    const publicErrorMessage = 'Failed to start Tailscale auth. Check server logs for details.';
    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      throw new Error('Tailscale CLI unavailable (no host socket and no sidecar)');
    }

    // The sidecar's tailscaled daemon initializes its Unix socket asynchronously
    // after container start. Wait for it to be ready before running `tailscale up`
    // to avoid an immediate EOF from a not-yet-ready daemon.
    if (strategy === 'sidecar') {
      await this.waitForSidecarDaemon();
    }

    // If the daemon is already in interactive auth mode, reuse the current URL
    // instead of running another `tailscale up` that can churn login state.
    const preAuthStatus = await this.getStatusForStrategy(strategy);
    if (preAuthStatus.connected || preAuthStatus.backendState === 'Running') {
      return { authUrl: '' };
    }
    if (preAuthStatus.backendState === 'NeedsLogin' && preAuthStatus.authUrl) {
      return { authUrl: preAuthStatus.authUrl };
    }

    // --reset resets persisted non-default preferences to defaults before applying
    // the provided flags. Only safe for the sidecar (isolated daemon); on the host
    // it would mutate the user's existing Tailscale configuration.
    const extraArgs = this.getTailscaleUpExtraArgs();
    const loginServerHost = this.getConfiguredLoginServerHost(extraArgs);
    const args = ['up', ...(strategy === 'sidecar' ? ['--reset'] : []), ...extraArgs];
    if (operator) {
      args.push(`--operator=${operator}`);
    }

    const execFn = strategy === 'host' ? this.execHost.bind(this) : this.execDocker.bind(this);
    let upOutput = '';
    try {
      const { stdout, stderr } = await execFn(args, 30000);
      upOutput = `${stdout}\n${stderr}`;
      const authUrl = this.extractAuthUrl(upOutput, loginServerHost);
      if (authUrl) {
        return { authUrl };
      }

      let status: TailscaleStatus;
      try {
        status = await this.getStatusForStrategy(strategy, false);
      } catch (statusError) {
        const statusOutput = this.getExecErrorOutput(statusError);
        const combinedOutput = [upOutput, statusOutput].filter(Boolean).join('\n');
        const authUrlFromCombinedOutput = this.extractAuthUrl(combinedOutput, loginServerHost);
        if (authUrlFromCombinedOutput) {
          return { authUrl: authUrlFromCombinedOutput };
        }
        this.logger.error(`[TailscaleService] startAuth status check failed after tailscale up\n${combinedOutput || '(no diagnostic output)'}`);
        throw new Error(publicErrorMessage);
      }

      if (status.connected || status.backendState === 'Running') {
        return { authUrl: '' };
      }

      if (status.backendState === 'NeedsLogin' && status.authUrl) {
        return { authUrl: status.authUrl };
      }

      throw new Error('Failed to get Tailscale auth URL from tailscale up output');
    } catch (error) {
      const output = [upOutput, this.getExecErrorOutput(error)].filter(Boolean).join('\n');
      const authUrl = this.extractAuthUrl(output, loginServerHost);
      if (authUrl) {
        return { authUrl };
      }
      this.logger.error(`[TailscaleService] startAuth failed\n${output || '(no diagnostic output)'}`);
      throw new Error(publicErrorMessage);
    }
  }

  /**
   * Join the tailnet using a [pre-auth key](https://login.tailscale.com/admin/settings/keys) (typical for the hub-tailscale sidecar).
   */
  async connectWithAuthKey(authKey: string): Promise<void> {
    const key = authKey.trim();
    if (!key) {
      throw new Error('Auth key is required');
    }
    if (!key.startsWith('tskey-auth-')) {
      throw new Error('Expected a Tailscale pre-authentication key (tskey-auth-…)');
    }

    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      throw new Error('Tailscale CLI unavailable (no host socket and no sidecar)');
    }

    // Same race as startAuth: the sidecar daemon initialises its Unix socket
    // asynchronously — wait until it's ready before running tailscale up.
    if (strategy === 'sidecar') {
      await this.waitForSidecarDaemon();
    }

    // --reset is scoped to the sidecar only — same rationale as startAuth.
    const upArgs = ['up', ...(strategy === 'sidecar' ? ['--reset'] : []), '--auth-key', key, ...this.getTailscaleUpExtraArgs()];
    const execFn = strategy === 'host' ? this.execHost.bind(this) : this.execDocker.bind(this);
    await execFn(upArgs, 120_000);
    this.invalidateStrategyCache();
  }

  /**
   * Disconnect from Tailscale (host or sidecar)
   */
  async disconnect(): Promise<void> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'host') {
      await this.execTailscale(['down']);
    }
    else if (strategy === 'sidecar') {
      await new Promise((resolve, reject) => {
        execFile('docker', ['exec', this.sidecarContainer, 'sh', '-c', 'kill -9 $(pidof tailscaled) && rm -f /var/lib/tailscale/tailscaled.state'], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) {
            const execErr = err as ExecError;
            execErr.stdout = stdout;
            execErr.stderr = stderr;
            reject(execErr);
          } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        });
      });
    }
    this.invalidateStrategyCache();
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
