import type { AppUrn } from '@ci-hub/common/types';

/**
 * What moved an app's custom domain: CI-Cloud's answer on a sync, the app's own
 * routing settings, or an operator on this Hub giving the domain up.
 */
type CustomDomainChangeCause = 'ci-cloud' | 'settings' | 'release';

/**
 * The one greppable line for a change to the custom domain an app is served on
 * (R2-HUBREGISTRATION-2). That binding is the app's public identity — its env,
 * `X-Forwarded-Host` and edge-SSO return host all follow it — so every write of
 * `app.custom_domain` logs this line, naming both hostnames, CI-Cloud's record
 * for each (`unknown` when the answer carried none, `none` for no hostname), and
 * what caused the move.
 */
export function customDomainAuditLine(change: {
  appUrn: AppUrn;
  previous: string | null;
  next: string | null;
  previousPortalRowId?: string;
  nextPortalRowId?: string;
  cause: CustomDomainChangeCause;
}): string {
  const rowId = (hostname: string | null, id: string | undefined) => (hostname ? (id ?? 'unknown') : 'none');

  return (
    `custom_domain_audit app=${change.appUrn} previous=${change.previous ?? 'none'} next=${change.next ?? 'none'} ` +
    `previousPortalRowId=${rowId(change.previous, change.previousPortalRowId)} ` +
    `nextPortalRowId=${rowId(change.next, change.nextPortalRowId)} cause=${change.cause}`
  );
}
