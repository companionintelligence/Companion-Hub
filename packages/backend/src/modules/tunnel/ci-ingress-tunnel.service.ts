/**
 * CI Ingress Tunnel Service
 *
 * Implementation of ITunnelService for CI's custom ingress provider.
 * Uses WireGuard for secure connectivity between CI-Hub and the ingress VPS,
 * with Caddy/Traefik handling HTTP routing on the VPS.
 *
 * Architecture:
 *   Browser → Cloudflare DNS/CDN → CI Ingress VPS (Caddy/Traefik) → WireGuard → CI-Hub → Local Apps
 */

import { Injectable } from '@nestjs/common';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type ITunnelService, type TunnelCredentials, type TunnelResult, type TunnelStatus, type AppInfo, type TunnelProvider } from './tunnel.interface';

interface CIIngressMetadata {
  ingressUrl: string;  // https://ingress-us-west.ci.computer
  wireguardEndpoint: string;  // wg-us-west.ci.computer:51820
  wireguardPublicKey: string;
  wireguardServerIP: string;  // 10.44.0.1
  wireguardClientIP: string;  // 10.44.0.12
  wireguardPrivateKey?: string;  // Generated locally
}

@Injectable()
export class CIIngressTunnelService implements ITunnelService {
  private deviceId: string | null = null;
  private wireguardConfig: CIIngressMetadata | null = null;
  private configPath = path.join(APP_DIR, 'ci-ingress');

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  getProvider(): TunnelProvider {
    return 'ci-ingress';
  }

  async initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult> {
    this.logger.info(`Initializing CI Ingress tunnel for device: ${credentials.tunnelId}`);

    try {
      this.deviceId = credentials.tunnelId;
      const metadata = credentials.metadata as CIIngressMetadata;

      // Ensure ci-ingress directory exists
      if (!fs.existsSync(this.configPath)) {
        fs.mkdirSync(this.configPath, { recursive: true, mode: 0o700 });
      }

      // Generate WireGuard keypair if not provided
      let privateKey = metadata.wireguardPrivateKey;
      if (!privateKey) {
        privateKey = this.generateWireGuardPrivateKey();
        metadata.wireguardPrivateKey = privateKey;
      }

      const publicKey = this.getPublicKeyFromPrivate(privateKey);

      // Write WireGuard configuration
      await this.writeWireGuardConfig(metadata, privateKey, publicKey);

      // Save metadata
      this.wireguardConfig = metadata;
      const metadataPath = path.join(this.configPath, 'metadata.json');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });

      // Start WireGuard client container
      await this.startWireGuardContainer();

      // Register this device with CI Ingress VPS
      await this.registerDeviceWithIngress(credentials.tunnelId, publicKey, metadata);

      this.logger.info(`CI Ingress tunnel initialized successfully for device: ${credentials.tunnelId}`);

      return {
        success: true,
        tunnelId: credentials.tunnelId,
        publicUrl: credentials.domain ? `https://${credentials.domain}` : undefined,
        message: 'CI Ingress tunnel initialized successfully',
      };
    } catch (error) {
      this.logger.error('Failed to initialize CI Ingress tunnel:', error);
      return {
        success: false,
        tunnelId: credentials.tunnelId,
        message: `Failed to initialize CI Ingress tunnel: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    this.logger.info(`Syncing ${apps.length} apps to CI Ingress VPS`);

    try {
      if (!this.wireguardConfig || !this.deviceId) {
        throw new Error('CI Ingress not initialized');
      }

      // Build route table for this device
      const routes = apps.map(app => ({
        hostname: app.publicDomain || app.subdomain,
        deviceId: this.deviceId,
        wireguardIP: this.wireguardConfig!.wireguardClientIP,
        localPort: app.localPort,
        protocol: app.protocol || 'http',
        originServerName: app.originServerName || app.hostname || `${app.name}.ci.lan`,
        privilegedKind: app.privilegedKind,
      }));

      // Sync routes to CI Ingress VPS via API
      await this.syncRoutesToIngress(routes);

      this.logger.info(`Successfully synced ${apps.length} apps to CI Ingress`);
      return true;
    } catch (error) {
      this.logger.error('Failed to sync apps to CI Ingress:', error);
      return false;
    }
  }

  async ensureTunnelRunning(): Promise<boolean> {
    try {
      const isRunning = await this.isWireGuardContainerRunning();

      if (isRunning) {
        this.logger.debug('CI Ingress WireGuard tunnel is already running');
        return true;
      }

      this.logger.info('Starting CI Ingress WireGuard tunnel...');
      await this.startWireGuardContainer();
      return true;
    } catch (error) {
      this.logger.error('Failed to ensure CI Ingress tunnel is running:', error);
      return false;
    }
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    try {
      const connected = await this.isWireGuardContainerRunning();

      // Check actual WireGuard connectivity
      let wireguardConnected = false;
      if (connected) {
        try {
          const status = execSync('docker exec ci-ingress-wireguard wg show', {
            encoding: 'utf-8',
            timeout: 5000,
          });
          wireguardConnected = status.includes('latest handshake');
        } catch {
          wireguardConnected = false;
        }
      }

      const publicUrls: string[] = [];
      if (this.wireguardConfig) {
        publicUrls.push(this.wireguardConfig.ingressUrl);
      }

      return {
        connected: connected && wireguardConnected,
        lastCheck: new Date(),
        publicUrls,
        provider: 'ci-ingress',
      };
    } catch (error) {
      this.logger.error('Failed to get CI Ingress tunnel status:', error);
      return {
        connected: false,
        lastCheck: new Date(),
        publicUrls: [],
        provider: 'ci-ingress',
      };
    }
  }

  async disconnectTunnel(): Promise<boolean> {
    try {
      this.logger.info('Disconnecting CI Ingress tunnel...');
      await this.stopWireGuardContainer();

      // Unregister from CI Ingress VPS
      if (this.deviceId && this.wireguardConfig) {
        await this.unregisterDeviceFromIngress(this.deviceId);
      }

      return true;
    } catch (error) {
      this.logger.error('Failed to disconnect CI Ingress tunnel:', error);
      return false;
    }
  }

  async loadTunnelTokenFromDisk(tunnelId?: string): Promise<void> {
    try {
      const metadataPath = path.join(this.configPath, 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        this.wireguardConfig = metadata;
        this.deviceId = tunnelId || null;
        this.logger.info('Loaded CI Ingress configuration from disk');
      }
    } catch (error) {
      this.logger.warn('Failed to load CI Ingress configuration from disk:', error);
    }
  }

  getTunnelToken(): string | null {
    return this.wireguardConfig?.wireguardPrivateKey || null;
  }

  // Private helper methods

  private generateWireGuardPrivateKey(): string {
    try {
      const privateKey = execSync('wg genkey', { encoding: 'utf-8' }).trim();
      return privateKey;
    } catch (error) {
      // Fallback: use docker to generate key
      try {
        const privateKey = execSync('docker run --rm linuxserver/wireguard wg genkey', {
          encoding: 'utf-8',
        }).trim();
        return privateKey;
      } catch {
        throw new Error('Failed to generate WireGuard private key. Install wireguard-tools or use docker.');
      }
    }
  }

  private getPublicKeyFromPrivate(privateKey: string): string {
    try {
      const publicKey = execSync(`echo "${privateKey}" | wg pubkey`, { encoding: 'utf-8' }).trim();
      return publicKey;
    } catch (error) {
      // Fallback: use docker
      try {
        const publicKey = execSync(`docker run --rm -i linuxserver/wireguard wg pubkey`, {
          encoding: 'utf-8',
          input: privateKey,
        }).trim();
        return publicKey;
      } catch {
        throw new Error('Failed to derive WireGuard public key');
      }
    }
  }

  private async writeWireGuardConfig(metadata: CIIngressMetadata, privateKey: string, publicKey: string): Promise<void> {
    const config = `[Interface]
PrivateKey = ${privateKey}
Address = ${metadata.wireguardClientIP}/24
DNS = 1.1.1.1

[Peer]
PublicKey = ${metadata.wireguardPublicKey}
Endpoint = ${metadata.wireguardEndpoint}
AllowedIPs = ${metadata.wireguardServerIP}/32
PersistentKeepalive = 25
`;

    const configFilePath = path.join(this.configPath, 'wg0.conf');
    fs.writeFileSync(configFilePath, config, { mode: 0o600 });
    this.logger.debug('WireGuard configuration written');
  }

  private async registerDeviceWithIngress(deviceId: string, publicKey: string, metadata: CIIngressMetadata): Promise<void> {
    try {
      const ingressApiUrl = this.config.getConfig().ciIngressApiUrl || metadata.ingressUrl;
      const response = await fetch(`${ingressApiUrl}/api/v1/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.getConfig().ciHubApiKey}`,
        },
        body: JSON.stringify({
          deviceId,
          publicKey,
          wireguardIP: metadata.wireguardClientIP,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to register device with CI Ingress: ${response.statusText}`);
      }

      this.logger.info('Device registered with CI Ingress VPS');
    } catch (error) {
      this.logger.error('Failed to register device with CI Ingress:', error);
      throw error;
    }
  }

  private async syncRoutesToIngress(routes: any[]): Promise<void> {
    try {
      const ingressApiUrl = this.config.getConfig().ciIngressApiUrl || this.wireguardConfig?.ingressUrl;
      if (!ingressApiUrl) {
        throw new Error('CI Ingress API URL not configured');
      }

      const response = await fetch(`${ingressApiUrl}/api/v1/devices/${this.deviceId}/routes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.getConfig().ciHubApiKey}`,
        },
        body: JSON.stringify({ routes }),
      });

      if (!response.ok) {
        throw new Error(`Failed to sync routes to CI Ingress: ${response.statusText}`);
      }

      this.logger.debug(`Synced ${routes.length} routes to CI Ingress VPS`);
    } catch (error) {
      this.logger.error('Failed to sync routes to CI Ingress:', error);
      throw error;
    }
  }

  private async unregisterDeviceFromIngress(deviceId: string): Promise<void> {
    try {
      const ingressApiUrl = this.config.getConfig().ciIngressApiUrl || this.wireguardConfig?.ingressUrl;
      if (!ingressApiUrl) return;

      await fetch(`${ingressApiUrl}/api/v1/devices/${deviceId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.config.getConfig().ciHubApiKey}`,
        },
      });

      this.logger.info('Device unregistered from CI Ingress VPS');
    } catch (error) {
      this.logger.warn('Failed to unregister device from CI Ingress:', error);
    }
  }

  private async startWireGuardContainer(): Promise<void> {
    try {
      const composeFile = path.join(APP_DIR, '..', 'docker-compose.yml');
      execSync(`docker compose -f ${composeFile} --profile ci-ingress up -d ci-ingress-wireguard`, {
        cwd: path.dirname(composeFile),
        stdio: 'pipe',
      });
      this.logger.info('CI Ingress WireGuard container started');
    } catch (error) {
      this.logger.error('Failed to start CI Ingress WireGuard container:', error);
      throw error;
    }
  }

  private async stopWireGuardContainer(): Promise<void> {
    try {
      const composeFile = path.join(APP_DIR, '..', 'docker-compose.yml');
      execSync(`docker compose -f ${composeFile} stop ci-ingress-wireguard`, {
        cwd: path.dirname(composeFile),
        stdio: 'pipe',
      });
      this.logger.info('CI Ingress WireGuard container stopped');
    } catch (error) {
      this.logger.error('Failed to stop CI Ingress WireGuard container:', error);
      throw error;
    }
  }

  private async isWireGuardContainerRunning(): Promise<boolean> {
    try {
      const result = execSync('docker ps --filter "name=ci-ingress-wireguard" --format "{{.Names}}"', {
        encoding: 'utf-8',
      });
      return result.includes('ci-ingress-wireguard');
    } catch (error) {
      return false;
    }
  }
}
