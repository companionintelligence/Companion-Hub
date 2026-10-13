import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';

/**
 * Admits only someone who may change what applies to the whole Hub, or read its own log: an
 * organization owner or admin, the operator who claimed a Hub that has no role to ask about, the CLI
 * and the host-local key (`MarketplaceWhoIsService.hubManageVerdict`). A member gets 403, and a role
 * the Portal couldn't confirm gets 503.
 *
 * Use it after `AuthGuard`, so a caller with no credential still gets 401. The WhoIs service is
 * resolved when asked, the way `ApiKeyAdminController` resolves it, so a guarded controller's module
 * needn't import the Portal module. A service that can't be resolved is a refusal.
 */
@Injectable()
export class HubManagerGuard implements CanActivate {
  constructor(private readonly moduleRef: ModuleRef) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const whois = this.resolveWhois();

    if (!whois) {
      throw new TranslatableError('HUB_MANAGE_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
    }

    await whois.assertSessionMayManageHub(context.switchToHttp().getRequest<Request>());
    return true;
  }

  private resolveWhois(): MarketplaceWhoIsService | null {
    try {
      return this.moduleRef.get(MarketplaceWhoIsService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }
}
