import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';
import { McpToolRegistry } from '../mcp-tool-registry.service';

@Injectable()
export class RegistrationTools implements OnModuleInit {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly cloudflareClientService: CloudflareClientService,
    private readonly registry: McpToolRegistry,
  ) {}

  onModuleInit() {
    this.registry.register({
      name: 'hub_registration_status',
      description: 'Get the live registration status including phase and degraded reasons.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getRegistrationStatus(),
    });
    this.registry.register({
      name: 'hub_cloudflare_status',
      description: 'Get Cloudflare tunnel and DNS status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getCloudflareStatus(),
    });
    this.registry.register({
      name: 'hub_probe_domain',
      description: 'Probe whether a URL is reachable and responding OK.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to probe (http or https only)' } }, required: ['url'] },
      handler: (p) => this.probeDomain(p as { url: string }),
    });
    this.registry.register({
      name: 'hub_check_url_availability',
      description: 'Check URL availability with detailed error info including DNS status.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to check (http or https only)' } }, required: ['url'] },
      handler: (p) => this.checkUrlAvailability(p as { url: string }),
    });
  }

  async getRegistrationStatus() {
    return this.registrationService.getLiveRegistrationStatus();
  }
  async getCloudflareStatus() {
    const token = this.cloudflareClientService.getTunnelToken();
    return { tunnelEnabled: !!token, tunnelId: this.cloudflareClientService.getTunnelId() || null, dnsEnabled: true };
  }
  private validateUrl(url: string): void {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https protocols are allowed');
    }
  }
  async probeDomain(params: { url: string }) {
    this.validateUrl(params.url);
    const res = await fetch(params.url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    return { ready: res?.ok };
  }
  async checkUrlAvailability(params: { url: string }) {
    this.validateUrl(params.url);
    try {
      const res = await fetch(params.url, { signal: AbortSignal.timeout(10000) });
      return { available: res.ok, status: res.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { available: false, error: message, isDnsError: message.includes('ENOTFOUND') || message.includes('getaddrinfo') };
    }
  }
}
