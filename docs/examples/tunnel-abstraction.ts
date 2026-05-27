/**
 * Example: Tunnel Service Abstraction
 *
 * This file demonstrates how to implement a pluggable tunnel service
 * architecture that supports multiple tunnel providers (Cloudflare,
 * Octelium, Tailscale) with a common interface.
 */

// ============================================================================
// Common Types and Interfaces
// ============================================================================

export type TunnelProvider = 'cloudflare' | 'octelium' | 'tailscale';

export interface TunnelCredentials {
  provider: TunnelProvider;
  tunnelId: string;
  token: string;
  domain?: string;
  metadata?: Record<string, unknown>;
}

export interface TunnelResult {
  success: boolean;
  tunnelId: string;
  publicUrl?: string;
  message?: string;
}

export interface TunnelStatus {
  connected: boolean;
  lastCheck: Date;
  publicUrls: string[];
  provider: TunnelProvider;
  metrics?: {
    uptime: number;
    bytesTransferred: number;
    activeConnections: number;
  };
}

export interface AppInfo {
  name: string;
  subdomain: string;
  publicDomain?: string;
  localPort: number;
  protocol?: 'http' | 'https';
  hostname?: string;
  originServerName?: string;
  privilegedKind?: 'hub' | 'vpn';
}

// ============================================================================
// Tunnel Service Interface
// ============================================================================

export interface ITunnelService {
  /**
   * Initialize the tunnel with the provided credentials.
   * Writes configuration files and starts the tunnel client.
   */
  initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult>;

  /**
   * Sync the list of exposed apps to the tunnel provider.
   * Updates routing rules, DNS, and access policies.
   */
  syncExposedApps(apps: AppInfo[]): Promise<boolean>;

  /**
   * Ensure the tunnel client is running and connected.
   * Idempotent - safe to call multiple times.
   */
  ensureTunnelRunning(): Promise<boolean>;

  /**
   * Get the current status of the tunnel connection.
   */
  getTunnelStatus(): Promise<TunnelStatus>;

  /**
   * Disconnect and clean up the tunnel.
   */
  disconnectTunnel(): Promise<boolean>;

  /**
   * Get the tunnel provider type.
   */
  getProvider(): TunnelProvider;
}

// ============================================================================
// Cloudflare Tunnel Implementation (Existing, Refactored)
// ============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';

@Injectable()
export class CloudflareTunnelService implements ITunnelService {
  private readonly logger = new Logger(CloudflareTunnelService.name);
  private tunnelId: string | null = null;
  private tunnelToken: string | null = null;

  constructor(
    private configService: ConfigurationService,
    private dockerService: DockerService,
  ) {}

  getProvider(): TunnelProvider {
    return 'cloudflare';
  }

  async initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult> {
    this.logger.log(`Initializing Cloudflare tunnel: ${credentials.tunnelId}`);

    this.tunnelId = credentials.tunnelId;
    this.tunnelToken = credentials.token;

    // Write tunnel token to file
    await this.writeTunnelToken(credentials.token);

    // Start cloudflared container
    await this.dockerService.ensureContainerRunning('cloudflared', {
      composeFile: this.getComposeFile(),
      profile: 'cloudflare',
    });

    return {
      success: true,
      tunnelId: credentials.tunnelId,
      publicUrl: `https://${credentials.domain}`,
    };
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    // Existing CloudflareClientService.syncState implementation
    // POST to CI-Portal which updates Cloudflare tunnel config
    return true;
  }

  async ensureTunnelRunning(): Promise<boolean> {
    const isRunning = await this.dockerService.isContainerRunning('cloudflared');
    if (isRunning) {
      return true;
    }

    await this.dockerService.ensureContainerRunning('cloudflared', {
      composeFile: this.getComposeFile(),
      profile: 'cloudflare',
    });

    return true;
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    const connected = await this.dockerService.isContainerRunning('cloudflared');

    return {
      connected,
      lastCheck: new Date(),
      publicUrls: [], // Would be populated from actual config
      provider: 'cloudflare',
    };
  }

  async disconnectTunnel(): Promise<boolean> {
    await this.dockerService.stopContainer('cloudflared');
    return true;
  }

  private async writeTunnelToken(token: string): Promise<void> {
    // Existing implementation
  }

  private getComposeFile(): string {
    // Existing implementation
    return '/data/docker-compose.yml';
  }
}

// ============================================================================
// Octelium Tunnel Implementation (New)
// ============================================================================

@Injectable()
export class OcteliumTunnelService implements ITunnelService {
  private readonly logger = new Logger(OcteliumTunnelService.name);
  private clusterId: string | null = null;
  private clientToken: string | null = null;

  constructor(
    private configService: ConfigurationService,
    private dockerService: DockerService,
  ) {}

  getProvider(): TunnelProvider {
    return 'octelium';
  }

  async initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult> {
    this.logger.log(`Initializing Octelium tunnel: ${credentials.tunnelId}`);

    this.clusterId = credentials.tunnelId;
    this.clientToken = credentials.token;

    // Write Octelium client configuration
    await this.writeOcteliumConfig(credentials);

    // Start Octelium client container
    await this.dockerService.ensureContainerRunning('octelium-client', {
      composeFile: this.getComposeFile(),
      profile: 'octelium',
    });

    return {
      success: true,
      tunnelId: credentials.tunnelId,
      publicUrl: `https://${credentials.domain}`,
    };
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    this.logger.log(`Syncing ${apps.length} apps to Octelium cluster`);

    // Update Octelium access policies via API
    const policies = apps.map(app => this.createAccessPolicy(app));

    // POST to Octelium cluster API or update local config
    await this.updateOcteliumPolicies(policies);

    return true;
  }

  async ensureTunnelRunning(): Promise<boolean> {
    const isRunning = await this.dockerService.isContainerRunning('octelium-client');
    if (isRunning) {
      return true;
    }

    await this.dockerService.ensureContainerRunning('octelium-client', {
      composeFile: this.getComposeFile(),
      profile: 'octelium',
    });

    return true;
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    const connected = await this.dockerService.isContainerRunning('octelium-client');

    // Could query Octelium API for detailed status
    return {
      connected,
      lastCheck: new Date(),
      publicUrls: [],
      provider: 'octelium',
    };
  }

  async disconnectTunnel(): Promise<boolean> {
    await this.dockerService.stopContainer('octelium-client');
    return true;
  }

  private async writeOcteliumConfig(credentials: TunnelCredentials): Promise<void> {
    // Write Octelium client configuration to disk
    const config = {
      cluster: {
        id: credentials.tunnelId,
        url: credentials.metadata?.clusterUrl || 'https://octelium.ci.cloud',
      },
      client: {
        token: credentials.token,
        name: credentials.metadata?.deviceName || 'ci-hub',
      },
      routing: {
        defaultTarget: 'http://traefik:80',
      },
    };

    // Write to /app/octelium/config.json or similar
    this.logger.debug(`Octelium config written: ${JSON.stringify(config)}`);
  }

  private createAccessPolicy(app: AppInfo) {
    return {
      hostname: app.subdomain,
      target: `http://traefik:80`,
      headers: {
        Host: app.originServerName || app.hostname,
      },
      authentication: {
        required: true,
        methods: ['oidc'],
      },
    };
  }

  private async updateOcteliumPolicies(policies: any[]): Promise<void> {
    // Update via Octelium API or local config file
    this.logger.debug(`Updated ${policies.length} Octelium policies`);
  }

  private getComposeFile(): string {
    return '/data/docker-compose.yml';
  }
}

// ============================================================================
// Tailscale Funnel Implementation (Enhanced)
// ============================================================================

@Injectable()
export class TailscaleTunnelService implements ITunnelService {
  private readonly logger = new Logger(TailscaleTunnelService.name);
  private hostname: string | null = null;

  constructor(
    private configService: ConfigurationService,
    private dockerService: DockerService,
  ) {}

  getProvider(): TunnelProvider {
    return 'tailscale';
  }

  async initializeTunnel(credentials: TunnelCredentials): Promise<TunnelResult> {
    this.logger.log(`Initializing Tailscale Funnel`);

    this.hostname = credentials.metadata?.hostname as string;

    // Ensure Tailscale container is running
    await this.dockerService.ensureContainerRunning('hub-tailscale', {
      composeFile: this.getComposeFile(),
      profile: 'private-vpn',
    });

    // Enable Tailscale Funnel for the hub
    await this.enableFunnel();

    return {
      success: true,
      tunnelId: credentials.tunnelId,
      publicUrl: `https://${this.hostname}.ts.net`,
    };
  }

  async syncExposedApps(apps: AppInfo[]): Promise<boolean> {
    this.logger.log(`Syncing ${apps.length} apps to Tailscale Funnel`);

    // Tailscale Funnel exposes ports, not individual apps
    // We would expose Traefik and rely on hostname-based routing
    for (const app of apps) {
      await this.enableFunnelForApp(app);
    }

    return true;
  }

  async ensureTunnelRunning(): Promise<boolean> {
    const isRunning = await this.dockerService.isContainerRunning('hub-tailscale');
    if (isRunning) {
      return true;
    }

    await this.dockerService.ensureContainerRunning('hub-tailscale', {
      composeFile: this.getComposeFile(),
      profile: 'private-vpn',
    });

    return true;
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    const connected = await this.dockerService.isContainerRunning('hub-tailscale');

    return {
      connected,
      lastCheck: new Date(),
      publicUrls: this.hostname ? [`https://${this.hostname}.ts.net`] : [],
      provider: 'tailscale',
    };
  }

  async disconnectTunnel(): Promise<boolean> {
    await this.disableFunnel();
    return true;
  }

  private async enableFunnel(): Promise<void> {
    // Execute: tailscale funnel on
    // This would be done via exec in the hub-tailscale container
    this.logger.debug('Enabled Tailscale Funnel');
  }

  private async enableFunnelForApp(app: AppInfo): Promise<void> {
    // Tailscale Funnel configuration
    // tailscale serve https / proxy http://traefik:80
    this.logger.debug(`Enabled Funnel for app: ${app.name}`);
  }

  private async disableFunnel(): Promise<void> {
    // Execute: tailscale funnel off
    this.logger.debug('Disabled Tailscale Funnel');
  }

  private getComposeFile(): string {
    return '/data/docker-compose.yml';
  }
}

// ============================================================================
// Tunnel Factory
// ============================================================================

@Injectable()
export class TunnelFactory {
  constructor(
    private readonly cloudflareService: CloudflareTunnelService,
    private readonly octeliumService: OcteliumTunnelService,
    private readonly tailscaleService: TailscaleTunnelService,
  ) {}

  create(provider: TunnelProvider): ITunnelService {
    switch (provider) {
      case 'cloudflare':
        return this.cloudflareService;
      case 'octelium':
        return this.octeliumService;
      case 'tailscale':
        return this.tailscaleService;
      default:
        throw new Error(`Unknown tunnel provider: ${provider}`);
    }
  }
}

// ============================================================================
// Updated Registration Service (Example Integration)
// ============================================================================

@Injectable()
export class RegistrationService {
  private activeTunnel: ITunnelService | null = null;

  constructor(
    private readonly tunnelFactory: TunnelFactory,
  ) {}

  async setupTunnel(
    provider: TunnelProvider,
    credentials: TunnelCredentials,
  ): Promise<TunnelResult> {
    // Create tunnel service for the selected provider
    this.activeTunnel = this.tunnelFactory.create(provider);

    // Initialize the tunnel
    const result = await this.activeTunnel.initializeTunnel(credentials);

    if (result.success) {
      // Ensure it's running
      await this.activeTunnel.ensureTunnelRunning();
    }

    return result;
  }

  async syncApps(apps: AppInfo[]): Promise<boolean> {
    if (!this.activeTunnel) {
      throw new Error('No active tunnel service');
    }

    return await this.activeTunnel.syncExposedApps(apps);
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    if (!this.activeTunnel) {
      throw new Error('No active tunnel service');
    }

    return await this.activeTunnel.getTunnelStatus();
  }

  async switchTunnelProvider(
    newProvider: TunnelProvider,
    credentials: TunnelCredentials,
  ): Promise<TunnelResult> {
    // Disconnect current tunnel
    if (this.activeTunnel) {
      await this.activeTunnel.disconnectTunnel();
    }

    // Setup new tunnel
    return await this.setupTunnel(newProvider, credentials);
  }
}

// ============================================================================
// Module Definition
// ============================================================================

import { Module } from '@nestjs/common';

@Module({
  providers: [
    CloudflareTunnelService,
    OcteliumTunnelService,
    TailscaleTunnelService,
    TunnelFactory,
  ],
  exports: [TunnelFactory],
})
export class TunnelModule {}
