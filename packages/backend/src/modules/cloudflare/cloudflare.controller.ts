import { castAppUrn } from '@/common/helpers/app-helpers';
import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { assertSafeOutboundUrl } from '@/common/helpers/ssrf-url';
import { CloudflareClientService } from './cloudflare-client.service';
import { CloudflareHostnameService } from './cloudflare-hostname.service';
import { ApiResponse } from '@nestjs/swagger';
import axios from 'axios';
import * as https from 'node:https';

@UseGuards(AuthGuard)
@Controller('cloudflare')
export class CloudflareController {
  constructor(
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly cloudflareHostnameService: CloudflareHostnameService,
  ) {}

  private parseOptionalAppUrn(appUrn?: string) {
    if (!appUrn?.includes(':') || appUrn.startsWith(':') || appUrn.endsWith(':')) {
      return undefined;
    }

    return castAppUrn(appUrn);
  }

  @Get('check-dns-availability')
  @ApiResponse({ type: Object })
  async checkDnsAvailability(@Query('subdomain') subdomain: string, @Query('domain') domain?: string, @Query('appUrn') appUrn?: string) {
    if (!subdomain) {
      return { available: true };
    }

    if (await this.cloudflareHostnameService.resolvesToExistingAppHostname(subdomain, domain, this.parseOptionalAppUrn(appUrn))) {
      return { available: true };
    }

    return this.cloudflareClientService.checkDnsAvailability(subdomain, domain);
  }

  @Get('domains')
  @ApiResponse({ type: Object })
  async getDomains() {
    return this.cloudflareClientService.fetchAvailableDomains();
  }

  /**
   * The organization's connected custom domains, for the install dialog's picker.
   *
   * `supported: false` is NOT "none connected". It is "this CI-Cloud cannot be
   * asked" — a deployment predating the feature, or one that did not answer — and
   * the dialog says something different for each: an empty list invites you to
   * connect one in the portal, an unanswerable question must not. Gap 3 of
   * CI-Hub#1181 was precisely the Hub behaving as though domains it could not see
   * did not exist.
   */
  @Get('custom-domains')
  @ApiResponse({ type: Object })
  async getCustomDomains() {
    const domains = await this.cloudflareClientService.fetchOrganizationCustomDomains();

    return { supported: domains !== undefined, domains: domains ?? [] };
  }

  @Get('status')
  @ApiResponse({ type: Object })
  async getStatus() {
    const token = this.cloudflareClientService.getTunnelToken();

    return {
      tunnelEnabled: !!token,
      dnsEnabled: true,
      tunnelId: this.cloudflareClientService.getTunnelId() || null,
      accountId: null,
      zoneId: null,
      routes: [],
      message: 'Tunnel is managed by CI-Cloud.',
    };
  }

  /**
   * Check if a URL is accessible (for app availability checking)
   */
  @Get('check-url-availability')
  @ApiResponse({ type: Object })
  async checkUrlAvailability(@Query('url') url: string) {
    if (process.env.E2E_TEST === 'true') {
      return { available: true, status: 200, statusText: 'OK' };
    }

    if (!url) {
      return { available: false, error: 'URL parameter is required' };
    }

    try {
      const safeUrl = await assertSafeOutboundUrl(url);
      const agent = new https.Agent({
        rejectUnauthorized: false,
      });

      const response = await axios.head(safeUrl.toString(), {
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
  async removeCatchAllRoutes(@Query('tunnelId') _tunnelId?: string) {
    return {
      success: true,
      message: 'Configuration is managed by CI-Cloud.',
      removed: 0,
      remainingRoutes: 0,
    };
  }
}
