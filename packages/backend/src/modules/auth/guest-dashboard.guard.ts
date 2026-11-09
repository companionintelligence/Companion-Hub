import { ConfigurationService } from '@/core/config/configuration.service';
import { type CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Turning the guest dashboard off closes its data too, not only the page.
 *
 * `GET /apps/guest` and `GET /links/guest` take no sign-in, because they feed the dashboard to
 * anyone who can reach the Hub. So the setting is the only thing standing between a caller and the
 * apps and links that were marked for guests. It has to be asked on each request because the
 * Settings page changes it on a running Hub.
 */
@Injectable()
export class GuestDashboardGuard implements CanActivate {
  constructor(private readonly configuration: ConfigurationService) {}

  canActivate(): boolean {
    if (!this.configuration.get('userSettings')?.guestDashboard) {
      throw new ForbiddenException('The guest dashboard is turned off');
    }

    return true;
  }
}
