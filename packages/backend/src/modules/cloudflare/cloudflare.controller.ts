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
    return {
      tunnelEnabled: this.cloudflareTunnelService.isEnabled(),
      dnsEnabled: this.cloudflareTunnelService.isDnsEnabled(),
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
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

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
      // Network errors, timeouts, etc. mean unavailable
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error',
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
   * Update all existing tunnel routes with originRequest configuration
   * This ensures apps work properly behind Cloudflare Tunnel by setting proper Host headers
   * and connection settings for external access
   */
  @Post('update-routes-origin-request')
  @ApiResponse({ type: Object })
  async updateAllRoutesWithOriginRequest() {
    if (!this.cloudflareTunnelService.isEnabled()) {
      return {
        success: false,
        message: 'Cloudflare Tunnel integration is not enabled',
        updated: [],
        skipped: [],
        failed: [],
      };
    }

    const result = await this.cloudflareTunnelService.updateAllRoutesWithOriginRequest();
    return {
      success: result.failed.length === 0,
      message: `Updated ${result.updated.length} routes with originRequest configuration. ` +
        `${result.skipped.length} routes already had proper configuration.`,
      ...result,
    };
  }
}

