import type { AvailableDomain } from '@ci-hub/common/types';

/**
 * The public domain the install form should switch to from what Companion Portal
 * preselects, or `null` to leave the field as it is.
 *
 * Companion Portal marks one domain `isDefault`: the Hub's own zone while it has
 * room, else the `.pw` zone that is filling. A new install takes it. Nothing else
 * does:
 *
 * - **An installed app** (`isEdit`) keeps the domain it serves from. The switch is
 *   silent (it does not dirty the field), so saving any other setting would move
 *   the app to a new address and release the old one.
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
}): string | null {
  const { availableDomains, currentPublicDomain, hubDomain, dirty, isEdit } = params;
  const preselected = availableDomains.find((entry) => entry.isDefault)?.domain || availableDomains[0]?.domain;

  if (!preselected || dirty || isEdit) {
    return null;
  }

  if (currentPublicDomain && currentPublicDomain !== hubDomain) {
    return null;
  }

  return preselected;
}
