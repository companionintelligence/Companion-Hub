import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';

type FederationSettings = {
  federationEnabled?: boolean;
  federationDisplayName?: string;
  federationSummary?: string;
  federationPreferredUsername?: string;
  federationManualApproval?: boolean;
  federationPublishAppInstalls?: boolean;
  federationPublishAppUpdates?: boolean;
  federationPublishHubStatus?: boolean;
  federationPublishAgentActivity?: boolean;
  federationPublishSystemMetrics?: boolean;
  federationRelayGhost?: boolean;
  federationRelayForgejo?: boolean;
  federationRelayNextcloud?: boolean;
};

@Injectable()
export class FederationConfigService {
  constructor(
    private readonly configuration: ConfigurationService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
  ) {}

  getSettings(): Required<FederationSettings> {
    const settings = this.configuration.getConfig().userSettings as FederationSettings;

    return {
      federationEnabled: settings.federationEnabled === true,
      federationDisplayName: settings.federationDisplayName || 'Companion Hub',
      federationSummary: settings.federationSummary || '',
      federationPreferredUsername: settings.federationPreferredUsername || 'hub',
      federationManualApproval: settings.federationManualApproval === true,
      federationPublishAppInstalls: settings.federationPublishAppInstalls === true,
      federationPublishAppUpdates: settings.federationPublishAppUpdates === true,
      federationPublishHubStatus: settings.federationPublishHubStatus !== false,
      federationPublishAgentActivity: settings.federationPublishAgentActivity === true,
      federationPublishSystemMetrics: settings.federationPublishSystemMetrics === true,
      federationRelayGhost: settings.federationRelayGhost !== false,
      federationRelayForgejo: settings.federationRelayForgejo !== false,
      federationRelayNextcloud: settings.federationRelayNextcloud === true,
    };
  }

  ensureEnabled(): void {
    if (!this.getSettings().federationEnabled) {
      throw new NotFoundException();
    }
  }

  isHttpsRequest(req: Request): boolean {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    const normalizedProto = proto?.split(',')[0]?.trim() || req.protocol;
    return normalizedProto === 'https';
  }

  getHostFromRequest(req: Request): string {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
    return (host || req.get('host') || this.configuration.getConfig().domain).trim();
  }

  async getPublicHost(preferredHost?: string): Promise<string> {
    if (preferredHost?.trim()) {
      return preferredHost.trim();
    }

    const registration = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const { domain } = this.configuration.getConfig();
    if (registration?.hubSubdomain?.trim() && domain?.trim()) {
      return `${registration.hubSubdomain.trim()}.${domain.trim()}`;
    }

    return domain;
  }

  async getBaseUrl(preferredHost?: string): Promise<string> {
    return `https://${await this.getPublicHost(preferredHost)}`;
  }
}
