import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { hubContainerName } from '@/common/constants';

export interface TailscaleStatus {
  installed: boolean;
  connected: boolean;
  version: string | null;
  hostname: string | null;
  nodeFqdn: string | null;
  tailnet: string | null;
  ip: string | null;
  supportsServices: boolean;
  /** True when HTTPS certificates (and therefore Tailscale Serve) are enabled for the tailnet. */
  httpsAvailable: boolean;
  backendState: string | null;
  authUrl: string | null;
}

export interface TailscaleServeEntry {
  service: string;
  proto: string;
  mountPoint: string;
  dest: string;
  listenPort?: number;
  rawServiceName?: string;
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
const DEFAULT_TAILSCALE_EXTRA_ARGS = [
  DEFAULT_TAILSCALE_LOGIN_SERVER,
  '--accept-routes',
  // Upgrades keep the legacy bridge while apps move to ci-hub_network.
  '--advertise-routes=172.18.0.0/16,172.19.0.0/16',
];

function normalizeDnsName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\.+$/, '') || null;
}

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

  /**
   * Short-lived cache for {@link getStatusCached}. Every read of `getStatus`
   * shells out (`tailscale status --json`, via `docker exec` in sidecar mode),
   * which is fine for settings pages but not for the memory-connect status
   * endpoint — that is hit on every top-level navigation of every
   * memory-consumer app. Connection state changes through this service's own
   * `connectWithAuthKey`/`disconnect` (which invalidate), so 30s of staleness
   * only ever delays noticing an out-of-band change.
   */
  private statusCache: { value: TailscaleStatus; expires: number } | null = null;
  private static readonly STATUS_TTL_MS = 30_000;

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
      nodeFqdn: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      httpsAvailable: false,
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

      // CertDomains is populated only when HTTPS Certificates are enabled for the
      // tailnet. It is the same signal Tailscale Serve requires, so we use it to
      // tell whether per-app Private VPN publishing can succeed.
      const certDomains = status.CertDomains as string[] | undefined;
      const httpsAvailable = Array.isArray(certDomains) && certDomains.length > 0;

      return {
        installed,
        connected,
        version,
        hostname: (self.HostName as string) || null,
        nodeFqdn: normalizeDnsName((self.DNSName as string) || ((status.CertDomains as string[] | undefined)?.[0] ?? null)),
        tailnet:
          normalizeDnsName((status.MagicDNSSuffix as string) || ((status.CurrentTailnet as Record<string, unknown>)?.MagicDNSSuffix as string)) ??
          null,
        ip: (self.TailscaleIPs as string[])?.[0] || null,
        supportsServices,
        httpsAvailable,
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
      nodeFqdn: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      httpsAvailable: false,
      backendState: null,
      authUrl: null,
    };

    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      return notInstalled;
    }

    return this.getStatusForStrategy(strategy);
  }

  /**
   * {@link getStatus} behind a {@link TailscaleService.STATUS_TTL_MS} cache.
   * Request-path callers (memory-connect launcher resolution) MUST use this —
   * the uncached read shells out per call. Invalidated by this service's own
   * connect/disconnect so a state change it caused is visible immediately.
   */
  async getStatusCached(): Promise<TailscaleStatus> {
    const now = Date.now();
    if (this.statusCache && now < this.statusCache.expires) {
      return this.statusCache.value;
    }

    const status = await this.getStatus();
    this.statusCache = { value: status, expires: now + TailscaleService.STATUS_TTL_MS };

    return status;
  }

  private invalidateStatusCache(): void {
    this.statusCache = null;
  }

  private async getStatusForStrategy(strategy: ExecStrategy, suppressErrors = true): Promise<TailscaleStatus> {
    const notInstalled: TailscaleStatus = {
      installed: false,
      connected: false,
      version: null,
      hostname: null,
      nodeFqdn: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      httpsAvailable: false,
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
    this.invalidateStatusCache();
  }

  /**
   * Disconnect from Tailscale.
   *
   * Host mode performs a normal `tailscale down`.
   * Sidecar mode performs a stronger reset by force-stopping `tailscaled`
   * and deleting the persisted state file, which effectively logs the
   * sidecar out of Tailscale rather than only disconnecting it.
   */
  async disconnect(): Promise<void> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'host') {
      await this.execTailscale(['down']);
    } else if (strategy === 'sidecar') {
      await new Promise((resolve, reject) => {
        execFile(
          'docker',
          [
            'exec',
            this.sidecarContainer,
            'sh',
            '-c',
            'kill -9 $(pidof tailscaled 2>/dev/null) >/dev/null 2>&1 || true; rm -f /var/lib/tailscale/tailscaled.state',
          ],
          { timeout: 15000 },
          (err, stdout, stderr) => {
            if (err) {
              const execErr = err as ExecError;
              execErr.stdout = stdout;
              execErr.stderr = stderr;
              reject(execErr);
            } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
          },
        );
      });
    } else {
      throw new Error('Tailscale CLI unavailable (no host socket and no sidecar)');
    }
    this.invalidateStrategyCache();
    this.invalidateStatusCache();
  }

  private async getServeUpstreamTarget(localPort: number): Promise<string> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'sidecar') {
      const sidecarTarget = this.serveUpstreamSidecar.includes(':') ? this.serveUpstreamSidecar : `${this.serveUpstreamSidecar}:${localPort}`;
      return sidecarTarget.includes('://') ? sidecarTarget : `http://${sidecarTarget}`;
    }
    return `http://localhost:${localPort}`;
  }

  /**
   * Upstream for serving the Hub ITSELF over the tailnet.
   *
   * Sidecar mode targets the Hub gateway container directly rather than
   * `traefik:80`: Traefik routes by Host and has no router for tailnet
   * hostnames, so proxying through it 404s every request. Host mode targets
   * this process's own listen port — same `API_PORT || 3000` resolution as
   * `main.ts`, so the upstream cannot drift from where the gateway actually
   * listens.
   */
  async getHubServeUpstream(): Promise<string> {
    const strategy = await this.resolveStrategy();
    if (strategy === 'sidecar') {
      return process.env.TAILSCALE_HUB_UPSTREAM ?? `http://${hubContainerName()}:5002`;
    }
    return `http://localhost:${process.env.API_PORT || 3000}`;
  }

  /**
   * Serve an app via Tailscale Serve on a dedicated HTTPS port.
   */
  async serveApp(params: { appName: string; httpsPort: number; upstreamUrl?: string; localPort?: number }): Promise<void> {
    const { appName, httpsPort, upstreamUrl, localPort = httpsPort } = params;
    const upstream = upstreamUrl || (await this.getServeUpstreamTarget(localPort));
    await this.execTailscale(['serve', '--bg', '--yes', `--https=${httpsPort}`, upstream]);
    this.logger.log(`Tailscale Serve (port): ${appName} on :${httpsPort} → ${upstream}`);
  }

  /**
   * Remove a served app from a dedicated HTTPS port.
   */
  async unservePort(httpsPort: number): Promise<void> {
    try {
      await this.execTailscale(['serve', `--https=${httpsPort}`, 'off']);
      this.logger.log(`Tailscale Serve removed from :${httpsPort}`);
    } catch (error) {
      this.logger.warn(`Failed to remove Tailscale serve for :${httpsPort}: ${error}`);
    }
  }

  async clearService(serviceName: string): Promise<void> {
    try {
      await this.execTailscale(['serve', 'clear', serviceName]);
      this.logger.log(`Tailscale Service removed: ${serviceName}`);
    } catch (error) {
      this.logger.warn(`Failed to remove Tailscale Service ${serviceName}: ${error}`);
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
            service: name.replace(/^svc:/, ''),
            proto: 'https',
            mountPoint: '/',
            dest: config.Dest || '',
            rawServiceName: name,
          });
        }
      }

      if (data.Web) {
        for (const [listener, handlers] of Object.entries(data.Web as Record<string, Record<string, TailscaleServeWebHandler>>)) {
          const portMatch = listener.match(/:(\d+)$/);
          const listenPort = portMatch ? Number.parseInt(portMatch[1] || '', 10) : undefined;
          for (const [path, config] of Object.entries(handlers)) {
            entries.push({
              service: listenPort ? String(listenPort) : path.replace(/^\//, ''),
              proto: 'https',
              mountPoint: path,
              dest: config.Proxy || config.Path || '',
              listenPort,
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
