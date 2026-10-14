import { TranslatableError } from '@/common/error/translatable-error';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';

/**
 * The WhoIs service, resolved when asked so the caller's module needn't import the Portal module, or
 * `null` when it can't be resolved. Every caller treats `null` as a refusal.
 */
export function resolveWhoisService(moduleRef: ModuleRef): MarketplaceWhoIsService | null {
  try {
    return moduleRef.get(MarketplaceWhoIsService, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * Admits only someone who may change what applies to the whole Hub, or read its own log: the operator
 * who claimed the Hub, whatever their organization role; an organization owner or admin; the CLI and
 * the host-local key (`MarketplaceWhoIsService.hubManageVerdict`). A member gets 403, and a role the
 * Portal couldn't confirm gets 503.
 *
 * Use it after `AuthGuard`, so a caller with no credential still gets 401. The WhoIs service is
 * resolved when asked (`resolveWhoisService`), the way `ApiKeyAdminController` resolves it, so a
 * guarded controller's module needn't import the Portal module. A service that can't be resolved is
 * a refusal.
 */
@Injectable()
export class HubManagerGuard implements CanActivate {
  constructor(private readonly moduleRef: ModuleRef) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const whois = resolveWhoisService(this.moduleRef);

    if (!whois) {
      throw new TranslatableError('HUB_MANAGE_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
    }

    await whois.assertSessionMayManageHub(context.switchToHttp().getRequest<Request>());
    return true;
  }
}
