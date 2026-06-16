import { castAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import { type AppUrn, buildPublicWebIdentity } from '@ci-hub/common/types';
import { AppsRepository } from '../apps/apps.repository';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';

@Injectable()
export class CloudflareHostnameService {
  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    private readonly configurationService: ConfigurationService,
  ) {}

  async resolvesToExistingAppHostname(subdomain: string, domain?: string, appUrn?: AppUrn) {
    if (!appUrn) {
      return false;
    }

    const app = await this.appsRepository.getAppByUrn(castAppUrn(appUrn));
    if (!app || app.exposureMode !== 'cloudflare') {
      return false;
    }

    const registration = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const defaultDomain = this.configurationService.getConfig().domain;
    const requestedIdentity = buildPublicWebIdentity({
      appSubdomain: subdomain,
      hubSubdomain: registration?.hubSubdomain ?? undefined,
      orgSlug: registration?.slug ?? undefined,
      publicDomainRoot: domain || app.publicDomain?.trim() || defaultDomain,
    });
    const currentIdentity = buildPublicWebIdentity({
      appSubdomain: app.localSubdomain || `${app.appName}-${app.appStoreSlug}`,
      hubSubdomain: registration?.hubSubdomain ?? undefined,
      orgSlug: registration?.slug ?? undefined,
      publicDomainRoot: app.publicDomain?.trim() || domain || defaultDomain,
    });

    return requestedIdentity.hostname === currentIdentity.hostname;
  }
}
