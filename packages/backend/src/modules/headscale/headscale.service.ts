import { buildHeadscaleTunnelFqdn, isPrivateVpnEnabled } from '@/common/helpers/private-vpn';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit, Optional } from '@nestjs/common';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, DEFAULT_HUB_TAILSCALE_CONTAINER_NAME } from '@/common/constants';
import { execFile } from 'node:child_process';
import * as yaml from 'yaml';
import { RegistrationService } from '../registration/registration.service';

export interface HeadscaleDevice {
  id: string;
  name: string;
  givenName: string;
  ipAddresses: string[];
  online: boolean;
  lastSeen: string;
  createdAt: string;
  user: string;
}

export interface HeadscalePreAuthKey {
  id: string;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration: string;
  createdAt: string;
  user: string;
}

export interface VpnStatus {
  enabled: boolean;
  headscaleHealthy: boolean;
  tailscaleConnected: boolean;
  tailscaleIp: string | null;
  deviceCount: number;
}

/** Shown in Settings so users can run tailscale up / custom coordination server */
export interface HeadscaleClientInfo {
  /** URL Tailscale clients should use as --login-server (must match Headscale server_url) */
  loginServerUrl: string;
  /** True when server URL is not the internal Docker-only address (public HTTPS join path) */
  publicConfigured: boolean;
}

@Injectable()
export class HeadscaleService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(HeadscaleService.name);
  private readonly stateDir = join(DATA_DIR, 'state', 'headscale');
  private readonly configPath = join(DATA_DIR, 'state', 'headscale', 'config.yaml');
  private readonly apiKeyPath = join(DATA_DIR, 'state', 'headscale', 'api.key');
  /** Persisted reusable pre-auth key used to enroll hub-tailscale (no manual .env) */
  private readonly hubTailscalePreauthPath = join(DATA_DIR, 'state', 'headscale', 'hub-tailscale.preauth.key');
  /** Traefik file provider watches this dir (same host path as Traefik's /etc/traefik/dynamic) */
  private readonly traefikDynamicDir = join(DATA_DIR, 'state', 'traefik', 'dynamic');
  private readonly traefikHeadscaleRoutePath = join(DATA_DIR, 'state', 'traefik', 'dynamic', 'headscale.yml');
  private readonly defaultUser = 'hub';
  private apiKey: string | null = null;
  private hubBootstrapAttempts = 0;

  // Headscale API runs on port 8080 inside the container, accessible via Docker network
  private readonly headscaleApiUrl = 'http://headscale:8080';

  constructor(
    @Optional() private readonly registrationService?: RegistrationService,
    @Optional() private readonly configService?: ConfigurationService,
  ) {}

  /** Base hostname from DOMAIN (no scheme/path), for headscale.<DOMAIN> convention */
  private static resolveDomainBase(): string | null {
    const d = process.env.DOMAIN?.trim();
    if (!d) return null;
    return d.replace(/^https?:\/\//, '').split('/')[0] || null;
  }

   /**
   * Public URL from env only (HEADSCALE_PUBLIC_*, headscale.<DOMAIN>). Tests and callers that
   * do not have registration context use this. Full runtime URL may add tunnel FQDN via resolveEffectiveServerUrl.
   */
  static resolveHeadscaleServerUrlFromEnv(): string {
    const full = process.env.HEADSCALE_PUBLIC_URL?.trim();
    if (full) {
      try {
        const u = new URL(full);
        return u.origin;
      } catch {
        return 'http://headscale:8080';
      }
    }
    const host = process.env.HEADSCALE_PUBLIC_HOST?.trim();
    if (host) {
      const h = host.replace(/^https?:\/\//, '').split('/')[0];
      return `https://${h}`;
    }
    const domainBase = HeadscaleService.resolveDomainBase();
    if (domainBase) {
      return `https://headscale.${domainBase}`;
    }
    return 'http://headscale:8080';
  }

  private async resolveEffectiveServerUrl(): Promise<string> {
    const full = process.env.HEADSCALE_PUBLIC_URL?.trim();
    if (full) {
      try {
        return new URL(full).origin;
      } catch {
        return 'http://headscale:8080';
      }
    }
    const hostEnv = process.env.HEADSCALE_PUBLIC_HOST?.trim();
    if (hostEnv) {
      const h = hostEnv.replace(/^https?:\/\//, '').split('/')[0];
      return `https://${h}`;
    }
    if (isPrivateVpnEnabled() && this.registrationService && this.configService) {
      const org = await this.registrationService.getDeviceRegistrationInfo();
      const cfg = this.configService.getConfig();
      const publicDomain = cfg.userSettings?.domain || cfg.domain;
      const fqdn = buildHeadscaleTunnelFqdn(org, publicDomain);
      if (fqdn) return `https://${fqdn}`;
    }
    return HeadscaleService.resolveHeadscaleServerUrlFromEnv();
  }

  private async resolveEffectiveTraefikHost(): Promise<string | null> {
    const full = process.env.HEADSCALE_PUBLIC_URL?.trim();
    if (full) {
      try {
        const u = new URL(full);
        if (u.hostname) return u.hostname;
      } catch {
        /* fall through */
      }
    }
    const hostEnv = process.env.HEADSCALE_PUBLIC_HOST?.trim();
    if (hostEnv) {
      return hostEnv.replace(/^https?:\/\//, '').split('/')[0] || null;
    }
    if (isPrivateVpnEnabled() && this.registrationService && this.configService) {
      const org = await this.registrationService.getDeviceRegistrationInfo();
      const cfg = this.configService.getConfig();
      const publicDomain = cfg.userSettings?.domain || cfg.domain;
      const fqdn = buildHeadscaleTunnelFqdn(org, publicDomain);
      if (fqdn) return fqdn;
    }
    const domainBase = HeadscaleService.resolveDomainBase();
    if (domainBase) {
      return `headscale.${domainBase}`;
    }
    return null;
  }

  /**
   * Writes Traefik dynamic config so HTTPS clients reach headscale:8080 with correct Host() and TLS.
   * Compose labels cannot reliably interpolate Host(`…`) with env; file provider avoids that.
   */
  private async ensureTraefikHeadscaleRoute(): Promise<void> {
    const host = await this.resolveEffectiveTraefikHost();
    await mkdir(this.traefikDynamicDir, { recursive: true });
    if (!host) {
      await unlink(this.traefikHeadscaleRoutePath).catch(() => {});
      return;
    }

    const doc = {
      http: {
        routers: {
          'headscale-public': {
            rule: `Host(\`${host}\`)`,
            entryPoints: ['websecure'],
            service: 'headscale-public-svc',
            tls: { certResolver: 'myresolver' },
          },
        },
        services: {
          'headscale-public-svc': {
            loadBalancer: {
              servers: [{ url: 'http://headscale:8080' }],
            },
          },
        },
      },
    };

    await writeFile(this.traefikHeadscaleRoutePath, yaml.stringify(doc), 'utf-8');
    this.logger.log(`Traefik headscale route written for Host(\`${host}\`)`);
  }

  async getClientInfo(): Promise<HeadscaleClientInfo> {
    if (!isPrivateVpnEnabled()) {
      return { loginServerUrl: 'http://headscale:8080', publicConfigured: false };
    }
    const loginServerUrl = await this.resolveEffectiveServerUrl();
    const publicConfigured = loginServerUrl !== 'http://headscale:8080';
    return { loginServerUrl, publicConfigured };
  }

  async onModuleInit() {
    if (!isPrivateVpnEnabled()) {
      await mkdir(this.traefikDynamicDir, { recursive: true });
      await unlink(this.traefikHeadscaleRoutePath).catch(() => {});
      this.logger.debug('Private VPN disabled (PRIVATE_VPN_ENABLED=false); skipping Headscale init');
      return;
    }
    try {
      await this.ensureConfigExists();
      await this.ensureTraefikHeadscaleRoute();
      await this.loadOrCreateApiKey();
      await this.ensureUser();
    } catch (error) {
      this.logger.warn(`Headscale init: ${error}`);
    }
  }

  async onApplicationBootstrap() {
    if (!isPrivateVpnEnabled()) return;
    // headscale / hub-tailscale often start after ci-os-hub; enroll after a short delay and retry
    setTimeout(() => void this.runHubTailscaleBootstrapLoop(), 8000);
  }

  private readonly hubBootstrapMaxAttempts = 18;
  private readonly hubBootstrapIntervalMs = 10_000;

  private async runHubTailscaleBootstrapLoop(): Promise<void> {
    while (this.hubBootstrapAttempts < this.hubBootstrapMaxAttempts) {
      this.hubBootstrapAttempts++;
      try {
        const result = await this.ensureHubTailscaleJoined();
        if (result === 'done' || result === 'skipped') return;
      } catch (error) {
        this.logger.warn(`Hub tailscale bootstrap attempt ${this.hubBootstrapAttempts}: ${error}`);
      }
      await new Promise((r) => setTimeout(r, this.hubBootstrapIntervalMs));
    }
    this.logger.warn('Hub tailscale bootstrap: stopped after max attempts (container may be missing in this environment)');
  }

  /**
   * Enroll hub-tailscale using a Headscale pre-auth key created via API and stored on disk.
   * Avoids requiring HEADSCALE_PREAUTH_KEY in .env.
   */
  async ensureHubTailscaleJoined(): Promise<'done' | 'retry' | 'skipped'> {
    if (!isPrivateVpnEnabled()) {
      return 'skipped';
    }
    if (process.env.HEADSCALE_AUTO_BOOTSTRAP === 'false') {
      return 'skipped';
    }
    if (!this.apiKey) {
      return 'skipped';
    }
    if (!(await this.isHealthy())) {
      return 'retry';
    }
    const ts = await this.getTailscaleStatus();
    if (ts.connected) {
      return 'done';
    }

    const container = process.env.TAILSCALE_SIDECAR_CONTAINER ?? DEFAULT_HUB_TAILSCALE_CONTAINER_NAME;
    if (!(await this.isDockerContainerRunning(container))) {
      return 'retry';
    }

    try {
      const key = await this.loadOrCreateHubTailscalePreauthKey();
      await this.execTailscaleUpInHubSidecar(key);
      const after = await this.getTailscaleStatus();
      if (after.connected) {
        this.logger.log('hub-tailscale enrolled with Headscale');
        return 'done';
      }
      this.logger.warn('hub-tailscale tailscale up ran but node is not online yet');
      return 'retry';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('invalid') && msg.toLowerCase().includes('auth')) {
        await unlink(this.hubTailscalePreauthPath).catch(() => {});
        this.logger.warn('Cleared stored hub-tailscale pre-auth key after auth failure; a new key will be created on next attempt');
      }
      throw error;
    }
  }

  private async loadOrCreateHubTailscalePreauthKey(): Promise<string> {
    try {
      const existing = (await readFile(this.hubTailscalePreauthPath, 'utf-8')).trim();
      if (existing) return existing;
    } catch {
      /* no file */
    }

    const pre = await this.createPreAuthKey({
      reusable: true,
      ephemeral: false,
      expirationHours: 24 * 365 * 10,
    });
    await writeFile(this.hubTailscalePreauthPath, pre.key, 'utf-8');
    await chmod(this.hubTailscalePreauthPath, 0o600).catch(() => {});
    this.logger.log('Created and stored hub-tailscale Headscale pre-auth key');
    return pre.key;
  }

  private async isDockerContainerRunning(containerName: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('docker', ['inspect', '-f', '{{.State.Running}}', containerName], { timeout: 8000 }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(stdout.trim() === 'true');
      });
    });
  }

  private async execTailscaleUpInHubSidecar(authKey: string): Promise<void> {
    const container = process.env.TAILSCALE_SIDECAR_CONTAINER ?? DEFAULT_HUB_TAILSCALE_CONTAINER_NAME;
    const loginServer = process.env.HUB_TAILSCALE_LOGIN_SERVER ?? 'http://headscale:8080';
    const advertise = process.env.HUB_TAILSCALE_ADVERTISE_ROUTES ?? '172.18.0.0/16';

    // Tailscale 1.82+ requires every non-default flag on repeat `up`, or --reset.
    // Match headless/container defaults: no MagicDNS inside the sidecar.
    const tailscaleArgs = [
      'up',
      '--reset',
      `--login-server=${loginServer}`,
      '--authkey',
      authKey,
      '--accept-routes',
      `--advertise-routes=${advertise}`,
      '--accept-dns=false',
    ];

    const args = ['exec', container, 'tailscale', ...tailscaleArgs];

    await new Promise<void>((resolve, reject) => {
      execFile('docker', args, { timeout: 120_000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        if (stdout) this.logger.debug(`tailscale up: ${stdout.trim()}`);
        resolve();
      });
    });
  }

  /**
   * Load API key from file, or create one via Headscale CLI (docker exec)
   */
  private async loadOrCreateApiKey(): Promise<void> {
    // Try loading from file first
    try {
      const key = (await readFile(this.apiKeyPath, 'utf-8')).trim();
      if (key) {
        this.apiKey = key;
        this.logger.log('Loaded Headscale API key from file');
        return;
      }
    } catch {
      // File doesn't exist yet
    }

    // Create via docker exec into headscale container
    try {
      const key = await this.execHeadscaleCli('apikeys', 'create', '--expiration', '365d');
      if (key) {
        this.apiKey = key.trim();
        await writeFile(this.apiKeyPath, this.apiKey, 'utf-8');
        this.logger.log('Created and stored Headscale API key');
      }
    } catch (error) {
      this.logger.warn(`Could not create API key: ${error}`);
    }
  }

  /**
   * Execute a headscale CLI command via docker exec
   */
  private execHeadscaleCli(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('docker', ['exec', 'headscale', 'headscale', ...args], { timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * Generate the Headscale configuration file
   */
  async ensureConfigExists(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(join(this.stateDir, 'data'), { recursive: true });

    const serverUrl = await this.resolveEffectiveServerUrl();
    if (serverUrl.startsWith('https://')) {
      this.logger.log(`Headscale server_url (public): ${serverUrl}`);
    }

    const config = {
      server_url: serverUrl,
      listen_addr: '0.0.0.0:8080',
      metrics_listen_addr: '0.0.0.0:9090',
      private_key_path: '/etc/headscale/private.key',
      noise: {
        private_key_path: '/etc/headscale/noise_private.key',
      },
      prefixes: {
        v4: '100.64.0.0/10',
        v6: 'fd7a:115c:a1e0::/48',
      },
      database: {
        type: 'sqlite',
        sqlite: {
          path: '/etc/headscale/data/db.sqlite',
        },
      },
      disable_check_updates: true,
      ephemeral_node_inactivity_timeout: '5m',
      log: {
        level: 'warn',
      },
      dns: {
        magic_dns: true,
        base_domain: 'hub.internal',
        nameservers: {
          global: ['1.1.1.1', '8.8.8.8'],
        },
      },
      derp: {
        server: {
          enabled: true,
          region_id: 999,
          region_code: 'hub',
          region_name: 'Hub Embedded DERP',
          stun_listen_addr: '0.0.0.0:3478',
          private_key_path: '/etc/headscale/derp_server_private.key',
        },
        urls: [],
        auto_update_enabled: false,
      },
      policy: {
        mode: 'file',
        path: '',
      },
    };

    await writeFile(this.configPath, yaml.stringify(config), 'utf-8');
    this.logger.log('Headscale config written');
  }

  /**
   * Get the Headscale config file path (for docker volume mount)
   */
  getConfigPath(): string {
    return this.configPath;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  /**
   * Make authenticated API request to Headscale
   */
  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const res = await fetch(`${this.headscaleApiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Headscale API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Create an API key for internal use
   */
  async createApiKey(): Promise<string> {
    try {
      const result = await this.apiRequest<{ apiKey: string }>('POST', '/api/v1/apikey', {
        expiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      });
      this.apiKey = result.apiKey;
      return result.apiKey;
    } catch (error) {
      this.logger.error(`Failed to create API key: ${error}`);
      throw error;
    }
  }

  /**
   * Set the API key (loaded from stored state or newly created)
   */
  setApiKey(key: string) {
    this.apiKey = key;
  }

  /**
   * Ensure the default Hub user exists
   */
  async ensureUser(): Promise<void> {
    try {
      await this.apiRequest('POST', '/api/v1/user', { name: this.defaultUser });
      this.logger.log('Created Headscale user: hub');
    } catch (error) {
      // User already exists — that's fine
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('UNIQUE constraint') || msg.includes('already exists')) {
        this.logger.debug('Headscale user already exists');
        return;
      }
      throw error;
    }
  }

  /**
   * Create a pre-auth key for device enrollment
   */
  async createPreAuthKey(params?: { reusable?: boolean; ephemeral?: boolean; expirationHours?: number }): Promise<HeadscalePreAuthKey> {
    const { reusable = false, ephemeral = false, expirationHours = 24 } = params || {};

    const result = await this.apiRequest<{ preAuthKey: HeadscalePreAuthKey }>('POST', '/api/v1/preauthkey', {
      user: this.defaultUser,
      reusable,
      ephemeral,
      expiration: new Date(Date.now() + expirationHours * 60 * 60 * 1000).toISOString(),
    });

    return result.preAuthKey;
  }

  /**
   * List all pre-auth keys
   */
  async listPreAuthKeys(): Promise<HeadscalePreAuthKey[]> {
    const result = await this.apiRequest<{ preAuthKeys: HeadscalePreAuthKey[] }>('GET', `/api/v1/preauthkey?user=${this.defaultUser}`);
    return result.preAuthKeys || [];
  }

  /**
   * List connected devices/nodes
   */
  async listDevices(): Promise<HeadscaleDevice[]> {
    const result = await this.apiRequest<{ nodes: HeadscaleDevice[] }>('GET', '/api/v1/node');
    return (result.nodes || []).map((node) => ({
      id: node.id,
      name: node.name,
      givenName: node.givenName || node.name,
      ipAddresses: node.ipAddresses || [],
      online: node.online ?? false,
      lastSeen: node.lastSeen || '',
      createdAt: node.createdAt || '',
      user: node.user || this.defaultUser,
    }));
  }

  /**
   * Remove a device by ID
   */
  async removeDevice(deviceId: string): Promise<void> {
    await this.apiRequest('DELETE', `/api/v1/node/${deviceId}`);
  }

  /**
   * Enable all advertised routes for a node
   */
  async enableRoutes(nodeId: string): Promise<void> {
    const result = await this.apiRequest<{ routes: { id: string; enabled: boolean }[] }>('GET', `/api/v1/node/${nodeId}/routes`);
    for (const route of result.routes || []) {
      if (!route.enabled) {
        await this.apiRequest('POST', `/api/v1/routes/${route.id}/enable`);
      }
    }
  }

  /**
   * Check if Headscale API is reachable
   */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.headscaleApiUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check containerised Tailscale status via Headscale's node list
   */
  async getTailscaleStatus(): Promise<{ connected: boolean; ip: string | null }> {
    try {
      const devices = await this.listDevices();
      const hubNode = devices.find((d) => d.name === 'hub-tailscale');
      if (hubNode) {
        return {
          connected: hubNode.online,
          ip: hubNode.ipAddresses[0] || null,
        };
      }
      return { connected: false, ip: null };
    } catch {
      return { connected: false, ip: null };
    }
  }

  /**
   * Get overall VPN status
   */
  async getVpnStatus(): Promise<VpnStatus> {
    if (!isPrivateVpnEnabled()) {
      return {
        enabled: false,
        headscaleHealthy: false,
        tailscaleConnected: false,
        tailscaleIp: null,
        deviceCount: 0,
      };
    }
    const [headscaleHealthy, tailscaleStatus, devices] = await Promise.all([
      this.isHealthy(),
      this.getTailscaleStatus(),
      this.listDevices().catch(() => []),
    ]);

    return {
      enabled: true,
      headscaleHealthy,
      tailscaleConnected: tailscaleStatus.connected,
      tailscaleIp: tailscaleStatus.ip,
      deviceCount: devices.length,
    };
  }

  /**
   * True when Headscale is reachable and the hub-tailscale node is online.
   * Used with host Tailscale to decide if Private VPN app exposure is available.
   */
  async isPrivateVpnReady(): Promise<boolean> {
    if (!isPrivateVpnEnabled()) return false;
    try {
      const healthy = await this.isHealthy();
      if (!healthy) return false;
      const ts = await this.getTailscaleStatus();
      return ts.connected;
    } catch {
      return false;
    }
  }
}
