import { Injectable } from '@nestjs/common';
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';

@Injectable()
export class RegistrationTools {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly cloudflareClientService: CloudflareClientService,
  ) {}

  async getRegistrationStatus() {
    return this.registrationService.getLiveRegistrationStatus();
  }

  async getCloudflareStatus() {
    const token = this.cloudflareClientService.getTunnelToken();
    return {
      tunnelEnabled: !!token,
      tunnelId: this.cloudflareClientService.getTunnelId() || null,
      dnsEnabled: true,
    };
  }

  async probeDomain(params: { url: string }) {
    const res = await fetch(params.url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    return { ready: res !== null && res.ok };
  }

  async checkUrlAvailability(params: { url: string }) {
    try {
      const res = await fetch(params.url, { signal: AbortSignal.timeout(10000) });
      return {
        available: res.ok,
        status: res.status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const isDnsError = message.includes('ENOTFOUND') || message.includes('getaddrinfo');
      return {
        available: false,
        error: message,
        isDnsError,
      };
    }
  }
}
