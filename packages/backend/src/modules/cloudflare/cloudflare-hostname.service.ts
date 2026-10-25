import { castAppUrn, createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import { type AppUrn, buildPublicWebIdentity, resolveRoutingSubdomain, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { restoreRanSince } from '../app-lifecycle/app-rehydration';
import { readPairingAppCheck, readRehydrationState } from '../app-lifecycle/registration-recovery-state';
import { getEffectiveExposureMode } from '../apps/app-exposure.helpers';
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
    const effectiveExposureMode = app
      ? getEffectiveExposureMode({
          exposureMode:
            app.exposureMode === 'cloudflare' || app.exposureMode === 'tailscale' || app.exposureMode === 'local' ? app.exposureMode : undefined,
          exposedLocal: app.exposedLocal,
        })
      : 'local';
    if (!app || effectiveExposureMode !== 'cloudflare') {
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

  /**
   * Whether a name CI Portal still holds for this device is one this Hub had before it was paired again,
   * and may take back now (#2133). Asked only about a name the Portal says the device's own row holds
   * (`heldByCaller`).
   *
   * After a pairing the Hub holds its tunnel sync until the apps it restores have settled, up to two
   * hours. Until that sync the Portal still has every row from before the reinstall, so a person who
   * set up an app again under its old name was told "DNS record already exists". Taking the name back
   * costs nothing. An app serving it at the first sync after the hold keeps the row and its record.
   * One that is not serving yet (an install still running) has the record released by that sync and
   * claims the name again as a new one when it runs. The Portal flags a name only in a zone that takes
   * new names, so that second claim is not refused.
   *
   * ⚠ ONLY ONCE THIS PAIRING'S RESTORE HAS RUN. Before that, an app the restore is about to bring back
   * has no row here yet, and its name would look free. Once the run is recorded, every app it brought
   * back has a row, and a name no other app here routes on is one that is not coming back.
   *
   * The app being set up (`appUrn`) does not count against its own name. A restore puts an app back
   * as local when the Portal kept no domain for it, and an install that failed keeps its row. Either
   * one exposed again under its old name was told the name was taken.
   */
  async isOwnNameFromBeforePairing(subdomain: string, appUrn?: AppUrn): Promise<boolean> {
    const check = await readPairingAppCheck();
    if (!check?.restore || !restoreRanSince(await readRehydrationState(), check.markedAt)) {
      return false;
    }

    const wanted = sanitizeAppSubdomain(subdomain);
    if (!wanted) {
      return false;
    }

    const apps = await this.appsRepository.getApps();
    return !apps.some(
      (app) =>
        createAppUrn(app.appName, app.appStoreSlug) !== appUrn &&
        sanitizeAppSubdomain(resolveRoutingSubdomain(app.localSubdomain, app.appName, app.appStoreSlug)) === wanted,
    );
  }
}
