import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { execFile } from 'node:child_process';
import * as yaml from 'yaml';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';

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

@Injectable()
export class HeadscaleService implements OnModuleInit {
  private readonly logger = new Logger(HeadscaleService.name);
  private readonly stateDir = join(DATA_DIR, 'state', 'headscale');
  private readonly configPath = join(DATA_DIR, 'state', 'headscale', 'config.yaml');
  private readonly apiKeyPath = join(DATA_DIR, 'state', 'headscale', 'api.key');
  private readonly defaultUser = 'hub';
  private apiKey: string | null = null;

  // Headscale API runs on port 8080 inside the container, accessible via Docker network
  private readonly headscaleApiUrl = 'http://headscale:8080';

  constructor(
    private readonly configService: ConfigurationService,
    private readonly dockerService: DockerService,
  ) {}

  async onModuleInit() {
    try {
      await this.ensureConfigExists();
      await this.loadOrCreateApiKey();
      await this.ensureUser();
    } catch (error) {
      this.logger.warn(`Headscale init: ${error}`);
    }
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

    const config = {
      server_url: 'http://headscale:8080',
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
   * Write a pre-auth key to .env as HEADSCALE_PREAUTH_KEY and recreate hub-tailscale
   * so it picks up the new key without a full stack restart.
   */
  async applyPreAuthKey(key: string): Promise<void> {
    await this.configService.setEnvVariable('HEADSCALE_PREAUTH_KEY', key);

    // Must use compose up (not restart) so the container is recreated with updated env
    const composeFile = join(DATA_DIR, 'docker-compose.yml');
    await this.dockerService.recreateService('hub-tailscale', { composeFile });
    this.logger.info('Applied pre-auth key and recreated hub-tailscale container');
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
}
