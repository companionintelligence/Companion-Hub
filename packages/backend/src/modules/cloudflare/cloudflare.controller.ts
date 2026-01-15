import { Controller, Get, Post, Query, UseGuards, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CloudflareClientService } from './cloudflare-client.service';
import { ApiResponse } from '@nestjs/swagger';
import axios from 'axios';
import * as https from 'https';

@UseGuards(AuthGuard)
@Controller('cloudflare')
export class CloudflareController {
  constructor(private readonly cloudflareClientService: CloudflareClientService) {}

  @Get('check-dns-availability')
  @ApiResponse({ type: Object })
  async checkDnsAvailability(@Query('subdomain') subdomain: string) {
    if (!subdomain) {
      return { available: true };
    }
    
    return { available: true, message: 'Availability check delegated to CI-Cloud (Not implemented yet)' };
  }

  @Get('status')
  @ApiResponse({ type: Object })
  async getStatus() {
    const token = this.cloudflareClientService.getTunnelToken();
    
    return {
      tunnelEnabled: !!token,
      dnsEnabled: true, 
      tunnelId: this.cloudflareClientService['tunnelId'] || null, 
      accountId: null,
      zoneId: null,
      routes: [], 
      message: 'Tunnel is managed by CI-Cloud.'
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
      // Use axios with relaxed SSL verification to handle self-signed certs or local dev environments
      const agent = new https.Agent({
        rejectUnauthorized: false,
      });

      const response = await axios.head(url, {
        httpsAgent: agent,
        timeout: 10000,
        validateStatus: (status) => status < 500, // resolved for status < 500
      });

      return {
        available: true,
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
        suggestion: isDnsError
          ? 'DNS record may not exist or may not have propagated yet. Check Cloudflare dashboard or try syncing DNS records.'
          : undefined,
      };
    }
  }

  @Post('sync-dns')
  @ApiResponse({ type: Object })
  async syncMissingDnsRecords() {
    return {
      success: true,
      message: 'DNS sync is handled automatically by CI-Cloud when apps change.',
      synced: [],
      failed: [],
      skipped: [],
    };
  }

  @Post('remove-origin-request')
  @ApiResponse({ type: Object })
  async removeOriginRequestFromAllRoutes() {
    return {
      success: true,
      message: 'Configuration is managed by CI-Cloud.',
      updated: [],
      skipped: [],
      failed: [],
    };
  }

  @Post('remove-catch-all-routes')
  @ApiResponse({ type: Object })
  async removeCatchAllRoutes(@Query('tunnelId') tunnelId?: string) {
    return {
      success: true,
      message: 'Configuration is managed by CI-Cloud.',
      removed: 0,
      remainingRoutes: 0,
    };
  }
}
