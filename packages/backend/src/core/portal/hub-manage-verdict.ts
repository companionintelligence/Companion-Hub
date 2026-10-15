import { HttpStatus } from '@nestjs/common';
import { TranslatableError } from '@/common/error/translatable-error';

/**
 * Whether a request may change what applies to the whole Hub or read its own log. `unknown` is a
 * refusal too, but one the person can retry: the Portal couldn't say what their role is.
 */
export type HubManageVerdict = 'allowed' | 'refused' | 'unknown';

/**
 * The refusal the Hub-wide routes give for a verdict that isn't `allowed`: 503 when the Portal couldn't
 * say, else 403. The MCP tool registry gives the same one for a Hub-wide tool, naming it in `intlParams`.
 */
export function assertHubManageAllowed(verdict: HubManageVerdict, intlParams: Record<string, string> = {}): void {
  if (verdict === 'unknown') {
    throw new TranslatableError('HUB_MANAGE_ROLE_UNVERIFIED', intlParams, HttpStatus.SERVICE_UNAVAILABLE);
  }

  if (verdict !== 'allowed') {
    throw new TranslatableError('HUB_MANAGE_ROLE_REQUIRED', intlParams, HttpStatus.FORBIDDEN);
  }
}
