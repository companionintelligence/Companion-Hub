import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { AppsController } from '@/modules/apps/apps.controller';
import { LinksController } from '@/modules/links/links.controller';
import { GuestDashboardGuard } from '../guest-dashboard.guard';

function guardWith(userSettings: unknown) {
  const configuration = mock<ConfigurationService>();
  configuration.get.mockReturnValue(userSettings as never);

  return new GuestDashboardGuard(configuration);
}

describe('GuestDashboardGuard', () => {
  it('lets a visitor through while the guest dashboard is on', () => {
    expect(guardWith({ guestDashboard: true }).canActivate()).toBe(true);
  });

  it.each([{ guestDashboard: false }, {}, undefined])('refuses when the setting is %j', (settings) => {
    expect(() => guardWith(settings).canActivate()).toThrow(ForbiddenException);
  });

  it('asks the setting on every request, so turning it off applies at once', () => {
    const configuration = mock<ConfigurationService>();
    configuration.get.mockReturnValueOnce({ guestDashboard: true } as never);
    configuration.get.mockReturnValueOnce({ guestDashboard: false } as never);
    const guard = new GuestDashboardGuard(configuration);

    expect(guard.canActivate()).toBe(true);
    expect(() => guard.canActivate()).toThrow(ForbiddenException);
  });

  it.each([
    ['GET /apps/guest', AppsController.prototype.getGuestApps],
    ['GET /links/guest', LinksController.prototype.getGuestLinks],
  ])('guards %s', (_route, handler) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([GuestDashboardGuard]);
  });
});
