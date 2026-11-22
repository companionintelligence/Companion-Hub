import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { TranslatableError } from '@/common/error/translatable-error';
import type { LoggerService } from '@/core/logger/logger.service';
import { hubSessionOperatorUserId } from '@/core/portal/hub-session-operator';
import type { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';

/**
 * ⚠ FULL CAPABILITY IS THE ORGANIZATION'S TO GIVE. A key acts with its creator's grants, but `full`
 * also opens the destructive MCP tools, and some act on no app a per-app grant could bound: updating
 * the Hub, and adding, re-enabling or deleting an app store. So who may hand it out is an owner's or
 * admin's call, as it is in the Portal. Asked of WhoIs fresh and about no app (`isOrgManager`); every
 * way of not knowing is a no. The operator who claimed the Hub may too, whatever their role, as
 * `HubManagerGuard` lets them make every other Hub-wide change (`isClaimingOperator`).
 *
 * The exempt principals (the CLI, the Portal device push) are admitted by name, as
 * `MarketplaceWhoIsService.lifecycleActor` names them, not through `isGrantExemptPrincipal`: one
 * added to that list later is refused here until someone decides it may hand out `full` keys. Any
 * other principal is refused and logged the way the other gates log it, because all its caller
 * ever sees is a 403.
 *
 * Shared by the key screen (raising a key) and an app's Hub access section (granting the app's own
 * MCP key `full`), which hand out the same authority.
 */
export async function mayGrantFullCapability(req: Request, whois: MarketplaceWhoIsService | null, logger: LoggerService): Promise<boolean> {
  switch (req.hubPrincipal) {
    case 'cli':
    case 'host-local':
    case 'portal-device':
      return true;
    case 'session': {
      const userId = hubSessionOperatorUserId(req);

      return userId !== undefined && (await personMayGrantFullCapability(userId, whois));
    }
    default:
      logger.warn(`whois_unrecognised_principal principal=${req.hubPrincipal ?? 'none'} action=grant_full`);
      return false;
  }
}

/**
 * The same answer about a person the Hub knows by id: the operator who claimed it, or an organization
 * owner or admin. For a caller that holds a lifecycle actor rather than the request, as the install
 * service does for a signed-in person's run from the MCP tool runner. No WhoIs is a no.
 */
export async function personMayGrantFullCapability(
  userId: number,
  whois: Pick<MarketplaceWhoIsService, 'isClaimingOperator' | 'isOrgManager'> | null,
): Promise<boolean> {
  if (!whois) {
    return false;
  }

  return (await whois.isClaimingOperator(userId)) || (await whois.isOrgManager(userId));
}

export async function assertMayGrantFullCapability(req: Request, whois: MarketplaceWhoIsService | null, logger: LoggerService): Promise<void> {
  if (!(await mayGrantFullCapability(req, whois, logger))) {
    throw new TranslatableError('API_KEY_FULL_ROLE_REQUIRED', {}, HttpStatus.FORBIDDEN);
  }
}
