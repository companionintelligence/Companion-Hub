/**
 * Octelium Tunnel Service
 *
 * Implementation of ITunnelService for Octelium tunnel provider.
 * Octelium is a self-hosted zero trust secure access platform that provides
 * programmable secure tunnels as an alternative to Cloudflare Tunnel.
 */

import { Injectable } from '@nestjs/common';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type ITunnelService, type TunnelCredentials, type TunnelResult, type TunnelStatus, type AppInfo, type TunnelProvider } from './tunnel.interface';

@Injectable()
export class OcteliumTunnelService implements ITunnelService {
  private clusterId: string | null = null;
  private clientToken: string | null = null;
  private configPath = path.join(APP_DIR, 'octelium');

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  getProvider(): TunnelProvider {
    return 'octelium';
  }

  async initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult> {
    this.logger.info(`Initializing Octelium tunnel: ${credentials.tunnelId}`);

    try {
      this.clusterId = credentials.tunnelId;
      this.clientToken = credentials.token;

      // Ensure octelium directory exists
      if (!fs.existsSync(this.configPath)) {
        fs.mkdirSync(this.configPath, { recursive: true, mode: 0o700 });
      }

      // Write Octelium client configuration
      await this.writeOcteliumConfig(credentials);

      // Write token file
      const tokenPath = path.join(this.configPath, 'token');
      fs.writeFileSync(tokenPath, credentials.token, { mode: 0o600 });

      // Start Octelium client container
      await this.startOcteliumContainer();

      this.logger.info(`Octelium tunnel initialized successfully: ${credentials.tunnelId}`);

      return {
        success: true,
        tunnelId: credentials.tunnelId,
        publicUrl: credentials.domain ? `https://${credentials.domain}` : undefined,
        message: 'Octelium tunnel initialized successfully',
      };
    } catch (error) {
      this.logger.error('Failed to initialize Octelium tunnel:', error);
      return {
        success: false,
        tunnelId: credentials.tunnelId,
        message: `Failed to initialize Octelium tunnel: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    this.logger.info(`Syncing ${apps.length} apps to Octelium cluster`);

    try {
      // Generate Octelium routing configuration
      const routes = apps.map(app => this.createRouteConfig(app));

      // Write routes configuration
      const routesPath = path.join(this.configPath, 'routes.json');
      fs.writeFileSync(routesPath, JSON.stringify({ routes }, null, 2), { mode: 0o600 });

      // Reload Octelium client to apply new routes
      await this.reloadOcteliumConfig();

      this.logger.info(`Successfully synced ${apps.length} apps to Octelium`);
      return true;
    } catch (error) {
      this.logger.error('Failed to sync apps to Octelium:', error);
      return false;
    }
  }

  async ensureTunnelRunning(): Promise<boolean> {
    try {
      const isRunning = await this.isOcteliumContainerRunning();

      if (isRunning) {
        this.logger.debug('Octelium tunnel is already running');
        return true;
      }

      this.logger.info('Starting Octelium tunnel...');
      await this.startOcteliumContainer();
      return true;
    } catch (error) {
      this.logger.error('Failed to ensure Octelium tunnel is running:', error);
      return false;
    }
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    try {
      const connected = await this.isOcteliumContainerRunning();

      // TODO: Query Octelium API for detailed metrics
      const publicUrls: string[] = [];

      return {
        connected,
        lastCheck: new Date(),
        publicUrls,
        provider: 'octelium',
      };
    } catch (error) {
      this.logger.error('Failed to get Octelium tunnel status:', error);
      return {
        connected: false,
        lastCheck: new Date(),
        publicUrls: [],
        provider: 'octelium',
      };
    }
  }

  async disconnectTunnel(): Promise<boolean> {
    try {
      this.logger.info('Disconnecting Octelium tunnel...');
      await this.stopOcteliumContainer();
      return true;
    } catch (error) {
      this.logger.error('Failed to disconnect Octelium tunnel:', error);
      return false;
    }
  }

  async loadTunnelTokenFromDisk(tunnelId?: string): Promise<void> {
    try {
      const tokenPath = path.join(this.configPath, 'token');
      if (fs.existsSync(tokenPath)) {
        this.clientToken = fs.readFileSync(tokenPath, 'utf-8').trim();
        this.logger.info('Loaded Octelium token from disk');

        // Try to load cluster ID from config
        const configPath = path.join(this.configPath, 'config.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          this.clusterId = config.cluster?.id || tunnelId || null;
        } else {
          this.clusterId = tunnelId || null;
        }
      }
    } catch (error) {
      this.logger.warn('Failed to load Octelium token from disk:', error);
    }
  }

  getTunnelToken(): string | null {
    return this.clientToken;
  }

  // Private helper methods

  private async writeOcteliumConfig(credentials: TunnelCredentials): Promise<void> {
    const config = {
      cluster: {
        id: credentials.tunnelId,
        url: credentials.metadata?.clusterUrl || this.config.getConfig().octeliumClusterUrl || 'https://octelium.ci.computer',
      },
      client: {
        token: credentials.token,
        name: credentials.metadata?.deviceName || `hub-${credentials.tunnelId}`,
      },
      routing: {
        defaultTarget: 'http://traefik:80',
      },
    };

    const configPath = path.join(this.configPath, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.logger.debug('Octelium configuration written');
  }

  private createRouteConfig(app: AppInfo) {
    return {
      hostname: app.subdomain,
      target: `http://traefik:80`,
      headers: {
        Host: app.originServerName || app.hostname || `${app.name}.ci.lan`,
      },
      authentication: {
        required: true,
        methods: ['oidc'],
      },
    };
  }

  private async startOcteliumContainer(): Promise<void> {
    try {
      // Start the octelium-client container using docker-compose
      const composeFile = path.join(APP_DIR, '..', 'docker-compose.yml');
      execSync(`docker compose -f ${composeFile} --profile octelium up -d octelium-client`, {
        cwd: path.dirname(composeFile),
        stdio: 'pipe',
      });
      this.logger.info('Octelium client container started');
    } catch (error) {
      this.logger.error('Failed to start Octelium container:', error);
      throw error;
    }
  }

  private async stopOcteliumContainer(): Promise<void> {
    try {
      const composeFile = path.join(APP_DIR, '..', 'docker-compose.yml');
      execSync(`docker compose -f ${composeFile} stop octelium-client`, {
        cwd: path.dirname(composeFile),
        stdio: 'pipe',
      });
      this.logger.info('Octelium client container stopped');
    } catch (error) {
      this.logger.error('Failed to stop Octelium container:', error);
      throw error;
    }
  }

  private async isOcteliumContainerRunning(): Promise<boolean> {
    try {
      const result = execSync('docker ps --filter "name=octelium-client" --format "{{.Names}}"', {
        encoding: 'utf-8',
      });
      return result.includes('octelium-client');
    } catch (error) {
      return false;
    }
  }

  private async reloadOcteliumConfig(): Promise<void> {
    try {
      // Send HUP signal to Octelium container to reload configuration
      execSync('docker exec octelium-client kill -HUP 1', {
        stdio: 'pipe',
      });
      this.logger.debug('Sent reload signal to Octelium client');
    } catch (error) {
      this.logger.warn('Failed to reload Octelium config, container may need restart:', error);
      // Non-fatal - container will pick up changes on next restart
    }
  }
}
