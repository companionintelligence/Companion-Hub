/**
 * Tunnel Service Interface
 *
 * Provides a common abstraction for different tunnel providers (Cloudflare, Octelium, Tailscale)
 * allowing the CI-Hub to work with multiple tunnel implementations.
 */

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

/**
 * Common interface for all tunnel service implementations.
 * Each tunnel provider (Cloudflare, Octelium, Tailscale) implements this interface.
 */
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

  /**
   * Load tunnel token from disk into memory (for recovery scenarios).
   */
  loadTunnelTokenFromDisk(tunnelId?: string): Promise<void>;

  /**
   * Get the current tunnel token (if available).
   */
  getTunnelToken(): string | null;
}
