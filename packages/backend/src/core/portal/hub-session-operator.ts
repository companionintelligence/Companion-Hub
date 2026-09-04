import type { Request } from 'express';

/**
 * Hub-session person for org grants. Portal-pushed installs authenticate
 * with `ciHubApiKey` and never set `hubSessionId` — those stay Portal's
 * GRANT_DENIED gate, not the local operator's CapMap.
 */
export function hubSessionOperatorUserId(req: Request): number | undefined {
  if (!req.hubSessionId) {
    return undefined;
  }

  return typeof req.user?.id === 'number' ? req.user.id : undefined;
}
