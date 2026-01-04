import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CloudflareTunnelService } from './cloudflare-tunnel.service';
import { ApiResponse } from '@nestjs/swagger';

@UseGuards(AuthGuard)
@Controller('cloudflare')
export class CloudflareController {
  constructor(private readonly cloudflareTunnelService: CloudflareTunnelService) {}

  @Get('check-dns-availability')
  @ApiResponse({ type: Object })
  async checkDnsAvailability(@Query('subdomain') subdomain: string) {
    if (!subdomain) {
      return { available: true };
    }

    const result = await this.cloudflareTunnelService.checkDnsAvailability(subdomain);
    return result;
  }

  /**
   * Get the current status of Cloudflare integration
   */
  @Get('status')
  @ApiResponse({ type: Object })
  async getStatus() {
    const credentials = this.cloudflareTunnelService.getApiCredentials();
    const tunnelConfig = credentials ? await this.cloudflareTunnelService.getTunnelConfig() : null;
    
    return {
      tunnelEnabled: this.cloudflareTunnelService.isEnabled(),
      dnsEnabled: this.cloudflareTunnelService.isDnsEnabled(),
      tunnelId: credentials?.tunnelId || null,
      accountId: credentials?.accountId || null,
      zoneId: credentials?.zoneId || null,
      routes: tunnelConfig?.ingress?.map((rule) => ({
        hostname: rule.hostname || '(no hostname)',
        service: rule.service,
        httpHostHeader: rule.originRequest?.httpHostHeader || null,
      })) || [],
      // Note: This doesn't check if the tunnel daemon (cloudflared) is actually running
      // The daemon must be started separately: cloudflared tunnel run <tunnel-id>
    };
  }

  /**
   * Check if a URL is accessible (for app availability checking)
   */
  @Get('check-url-availability')
  @ApiResponse({ type: Object })
  async checkUrlAvailability(@Query('url') url: string) {
    if (!url) {
      return { available: false, error: 'URL parameter is required' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // Increased to 10 seconds for DNS resolution

      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      // Consider 2xx, 3xx, and 4xx as "available" (server is responding)
      // Only 5xx or network errors mean unavailable
      const available = response.status < 500;
      return {
        available,
        status: response.status,
        statusText: response.statusText,
      };
    } catch (error) {
      // Network errors, timeouts, DNS errors, etc. mean unavailable
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isDnsError = errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo') || errorMessage.includes('DNS');
      
      return {
        available: false,
        error: errorMessage,
        isDnsError,
        suggestion: isDnsError ? 'DNS record may not exist or may not have propagated yet. Check Cloudflare dashboard or try syncing DNS records.' : undefined,
      };
    }
  }

  /**
   * Sync missing DNS records for all tunnel routes
   * This creates CNAME records for any tunnel routes that don't have DNS records yet
   */
  @Post('sync-dns')
  @ApiResponse({ type: Object })
  async syncMissingDnsRecords() {
    if (!this.cloudflareTunnelService.isDnsEnabled()) {
      return {
        success: false,
        message: 'DNS management not enabled. Set CLOUDFLARE_ZONE_ID environment variable.',
        synced: [],
        failed: [],
        skipped: [],
      };
    }

    const result = await this.cloudflareTunnelService.syncMissingDnsRecords();
    return {
      success: result.failed.length === 0,
      message: `Synced ${result.synced.length} DNS records, ${result.failed.length} failed, ${result.skipped.length} already existed`,
      ...result,
    };
  }

  /**
   * Remove originRequest configuration from all existing tunnel routes
   * We don't want any origin request headers or settings
   */
  @Post('remove-origin-request')
  @ApiResponse({ type: Object })
  async removeOriginRequestFromAllRoutes() {
    if (!this.cloudflareTunnelService.isEnabled()) {
      return {
        success: false,
        message: 'Cloudflare Tunnel integration is not enabled',
        updated: [],
        skipped: [],
        failed: [],
      };
    }

    const result = await this.cloudflareTunnelService.removeOriginRequestFromAllRoutes();
    return {
      success: result.failed.length === 0,
      message:
        `Removed originRequest from ${result.updated.length} routes. ` +
        `${result.skipped.length} routes already had no originRequest configuration.`,
      ...result,
    };
  }

  /**
   * Remove all catch-all routes from tunnel configuration
   * Catch-all routes (routes without hostnames) can cause routing issues
   * and are no longer needed with direct app routing
   */
  @Post('remove-catch-all-routes')
  @ApiResponse({ type: Object })
  async removeCatchAllRoutes(@Query('tunnelId') tunnelId?: string) {
    if (!this.cloudflareTunnelService.isEnabled()) {
      return {
        success: false,
        message: 'Cloudflare Tunnel integration is not enabled',
        removed: 0,
        remainingRoutes: 0,
      };
    }

    const result = await this.cloudflareTunnelService.removeCatchAllRoutes(tunnelId || undefined);
    return result;
  }
}
