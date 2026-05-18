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
  /** Hub-tailscale sidecar only: `TAILSCALE_AUTHKEY` / `TS_AUTHKEY` is non-empty in the container */
  sidecarAuthKeyConfigured: boolean;
  /** `docker inspect` reports the sidecar container exists and is running (does not imply CLI exec works). */
  sidecarContainerRunning: boolean;
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
        await this.execDocker(['version'], 15_000);
        value = 'sidecar';
      } catch (firstErr) {
        this.logger.warn(`Sidecar Tailscale version check failed (first try): ${firstErr}`);
        await new Promise((r) => setTimeout(r, 2000));
        try {
          await this.execDocker(['version'], 20_000);
          value = 'sidecar';
        } catch (retryErr) {
          this.logger.warn(`Sidecar Tailscale version check failed (retry): ${retryErr}`);
          value = null;
        }
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
    return extra ? extra.split(/\s+/).filter(Boolean) : ['--accept-routes', '--advertise-routes=172.18.0.0/16'];
  }

  /**
   * Tailscale requires every non-default persisted pref to appear on each `tailscale up`
   * (e.g. sidecar/image often runs with corp DNS off → must pass `--accept-dns=false`).
   * Source of truth is `debug prefs`; on failure returns [] so callers behave as before.
   */
  private async tailscaleUpArgsFromPersistedPrefs(): Promise<string[]> {
    try {
      const { stdout } = await this.execTailscale(['debug', 'prefs', '--json'], 10_000);
      const prefs = JSON.parse(stdout) as Record<string, unknown>;
      /** ipn.Prefs field; CLI exposes it as `--accept-dns`. */
      if (typeof prefs.CorpDNS === 'boolean') {
        return prefs.CorpDNS ? ['--accept-dns=true'] : ['--accept-dns=false'];
      }
    } catch (e) {
      this.logger.debug(`Could not read tailscale prefs for up flags (${e}); continuing without prefs merge`);
    }
    return [];
  }

  /** Dedup `--accept-dns` so env/extra-args and persisted prefs agree (prefs wins). */
  private mergeTailscaleUpExtras(base: string[], fromPrefs: string[]): string[] {
    const noAcceptDns = base.filter((a) => !a.startsWith('--accept-dns'));
    return [...noAcceptDns, ...fromPrefs];
  }

  private async getTailscaleUpExtraArgsResolved(): Promise<string[]> {
    const base = this.getTailscaleUpExtraArgs();
    const fromPrefs = await this.tailscaleUpArgsFromPersistedPrefs();
    return fromPrefs.length ? this.mergeTailscaleUpExtras(base, fromPrefs) : base;
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

  /** True if `docker inspect` says the sidecar container is up (helps diagnose socket/exec issues). */
  private async isSidecarContainerRunning(): Promise<boolean> {
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile('docker', ['inspect', '-f', '{{.State.Running}}', this.sidecarContainer], { timeout: 8000 }, (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          void stderr;
          resolve({ stdout: stdout.toString() });
        });
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private parseStatusJson(stdout: string, installed: boolean, sidecarAuthKeyConfigured = false, sidecarContainerRunning = false): TailscaleStatus {
    const notInstalled: TailscaleStatus = {
      installed: false,
      connected: false,
      version: null,
      hostname: null,
      tailnet: null,
      ip: null,
      supportsServices: false,
      backendState: null,
      sidecarAuthKeyConfigured: false,
      sidecarContainerRunning: false,
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
        sidecarAuthKeyConfigured,
        sidecarContainerRunning,
      };
    } catch (error) {
      this.logger.warn(`Failed to parse tailscale status JSON: ${error}`);
      return { ...notInstalled, installed, sidecarAuthKeyConfigured, sidecarContainerRunning };
    }
  }

  /** Non-secret: whether the sidecar container has TS_AUTHKEY set */
  private async readSidecarEnvAuthKey(): Promise<string | null> {
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile('docker', ['exec', this.sidecarContainer, 'printenv', 'TS_AUTHKEY'], { timeout: 8000 }, (err, stdout, stderr) => {
          if (err) {
            reject(err);
            return;
          }
          void stderr;
          resolve({ stdout: stdout.toString() });
        });
      });
      const key = stdout.trim();
      return key.length > 0 ? key : null;
    } catch {
      return null;
    }
  }

  /**
   * Use TS_AUTHKEY from the running hub-tailscale container (from compose `.env`).
   * Does not expose the key to the client; joins via the same path as manual pre-auth.
   */
  async connectUsingSidecarEnvAuthKey(): Promise<void> {
    if ((await this.resolveStrategy()) !== 'sidecar') {
      throw new Error('Saved Docker key login only works when the Hub uses the hub-tailscale sidecar (enable the private-vpn compose profile).');
    }
    const key = await this.readSidecarEnvAuthKey();
    if (!key) {
      throw new Error(
        'No TAILSCALE_AUTHKEY is set for the Tailscale container. Add it to your Hub .env (same place as other Hub secrets), recreate the stack, or use browser sign-in and paste a pre-auth key below.',
      );
    }
    await this.connectWithAuthKey(key);
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
      sidecarAuthKeyConfigured: false,
      sidecarContainerRunning: false,
    };

    const sidecarProbe = await this.isSidecarContainerRunning();
    const strategy = await this.resolveStrategy();
    if (strategy === null) {
      return { ...notInstalled, sidecarContainerRunning: sidecarProbe };
    }

    let sidecarAuth = false;
    if (strategy === 'sidecar') {
      sidecarAuth = (await this.readSidecarEnvAuthKey()) !== null;
    }

    try {
      const execFn = strategy === 'host' ? this.execHost.bind(this) : this.execDocker.bind(this);
      const { stdout } = await execFn(['status', '--json']);
      return this.parseStatusJson(stdout, true, sidecarAuth, sidecarProbe);
    } catch (error) {
      this.logger.warn(`Failed to get Tailscale status: ${error}`);
      this.invalidateStrategyCache();
      return {
        ...notInstalled,
        installed: true,
        sidecarAuthKeyConfigured: sidecarAuth,
        sidecarContainerRunning: sidecarProbe,
      };
    }
  }

  /**
   * Initiate Tailscale auth — returns URL for browser OAuth redirect (host or sidecar).
   */
  async startAuth(operator?: string): Promise<{ authUrl: string }> {
    const args = ['up', '--json', ...(await this.getTailscaleUpExtraArgsResolved())];
    if (operator) {
      args.push(`--operator=${operator}`);
    }

    let stdout: string;
    try {
      ({ stdout } = await this.execTailscale(args, 120_000));
    } catch (e) {
      const strategy = await this.resolveStrategy();
      const hint =
        strategy === 'sidecar'
          ? ' If TAILSCALE_AUTHKEY is set in your .env, try “Connect using saved Docker key” first, or paste a pre-auth key below.'
          : '';
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not start Tailscale browser sign-in (${msg}).${hint}`);
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error(
        'Tailscale returned an unexpected response while starting sign-in. Check that Tailscale is running (hub-tailscale sidecar or host daemon).',
      );
    }

    if (result.AuthURL) {
      return { authUrl: result.AuthURL as string };
    }

    if (result.BackendState === 'Running') {
      return { authUrl: '' };
    }

    throw new Error(
      'Tailscale did not return a sign-in link. On servers without a browser, use a pre-auth key from the Tailscale admin console (or connect using a saved Docker key when configured).',
    );
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

    await this.execTailscale(['up', '--auth-key', key, ...(await this.getTailscaleUpExtraArgsResolved())], 120_000);
    this.invalidateStrategyCache();
  }

  /**
   * Disconnect from Tailscale (host or sidecar)
   */
  async disconnect(): Promise<void> {
    await this.execTailscale(['down']);
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
