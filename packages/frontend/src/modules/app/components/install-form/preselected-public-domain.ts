import type { AvailableDomain } from '@ci-hub/common/types';

/**
 * The public domain the install form should switch to from what Companion Portal
 * preselects, or `null` to leave the field as it is.
 *
 * Companion Portal marks one domain `isDefault`: the Hub's own zone while it has
 * room, else the `.pw` zone that is filling. A new install takes it. Nothing else
 * does:
 *
 * - **An installed app served on the Web** (`isEdit`, saved with an exposure mode
 *   other than local or Tailscale) keeps the domain it serves from. The switch is
 *   silent (it does not dirty the field), so saving any other setting would move
 *   the app to a new address and release the old one. An installed app kept on
 *   this device or the tailnet has no public address yet: switching it to the Web
 *   is its first, and it takes the preselection like a new install.
 * - **A domain the operator picked** (`dirty`) stays picked.
 * - **A value that is not the implicit Hub-domain fallback** — something the form
 *   opened with — stays too.
 */
export function preselectedPublicDomain(params: {
  availableDomains: readonly AvailableDomain[];
  currentPublicDomain: string | undefined;
  hubDomain: string | undefined;
  dirty: boolean;
  isEdit: boolean;
  /** The exposure mode the installed app was saved with. Only read when `isEdit`. */
  initialExposureMode?: string;
}): string | null {
  const { availableDomains, currentPublicDomain, hubDomain, dirty, isEdit, initialExposureMode } = params;
  const preselected = availableDomains.find((entry) => entry.isDefault)?.domain || availableDomains[0]?.domain;
  const servesOnWeb = isEdit && initialExposureMode !== 'local' && initialExposureMode !== 'tailscale';

  if (!preselected || dirty || servesOnWeb) {
    return null;
  }

  if (currentPublicDomain && currentPublicDomain !== hubDomain) {
    return null;
  }

  return preselected;
}
