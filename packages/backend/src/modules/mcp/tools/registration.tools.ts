import { Injectable, type OnModuleInit } from '@nestjs/common';
import { assertSafeOutboundUrl } from '@/common/helpers/ssrf-url';
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
      category: 'Registration',
      name: 'hub_registration_status',
      access: 'read',
      description: 'Get the live registration status including phase and degraded reasons.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getRegistrationStatus(),
    });
    this.registry.register({
      category: 'Registration',
      name: 'hub_cloudflare_status',
      access: 'read',
      description: 'Get Cloudflare tunnel and DNS status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: () => this.getCloudflareStatus(),
    });
    this.registry.register({
      category: 'Registration',
      name: 'hub_probe_domain',
      access: 'read',
      description: 'Probe whether a URL is reachable and responding OK.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to probe (http or https only)' } }, required: ['url'] },
      handler: (p) => this.probeDomain(p as { url: string }),
    });
    this.registry.register({
      category: 'Registration',
      name: 'hub_check_url_availability',
      access: 'read',
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
  async probeDomain(params: { url: string }) {
    const safeUrl = await assertSafeOutboundUrl(params.url, { httpsOnly: true });
    const res = await fetch(safeUrl, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    return { ready: res?.ok };
  }
  async checkUrlAvailability(params: { url: string }) {
    try {
      const safeUrl = await assertSafeOutboundUrl(params.url);
      const res = await fetch(safeUrl, { signal: AbortSignal.timeout(10000) });
      return { available: res.ok, status: res.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { available: false, error: message, isDnsError: message.includes('ENOTFOUND') || message.includes('getaddrinfo') };
    }
  }
}
