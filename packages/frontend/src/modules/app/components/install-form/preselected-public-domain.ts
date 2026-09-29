import type { AvailableDomain } from '@ci-hub/common/types';
import type { DomainListNote } from './domain-list-note';

/**
 * Whether a form edits an app already published on the Web: an installed app
 * (`isEdit`) saved with an exposure mode other than local or Tailscale. Its name
 * exists, so it keeps the domain it serves from, and none of the rules for a NEW
 * name below apply to it. An installed app kept on this device or the tailnet has
 * no public address yet: switching it to the Web publishes its first, like a new
 * install.
 */
export function keepsPublishedDomain(isEdit: boolean, initialExposureMode?: string): boolean {
  return isEdit && initialExposureMode !== 'local' && initialExposureMode !== 'tailscale';
}

const listsDomain = (availableDomains: readonly AvailableDomain[], domain: string) =>
  availableDomains.some((entry) => entry.domain.toLowerCase() === domain.toLowerCase());

/**
 * The public domain the install form should switch to from what Companion Portal
 * preselects, or `null` to leave the field as it is.
 *
 * Companion Portal marks one domain `isDefault`: the Hub's own zone while it has
 * room, else the `.pw` zone that is filling. A new name takes it. Nothing else
 * does:
 *
 * - **An installed app served on the Web** ({@link keepsPublishedDomain}) keeps the
 *   domain it serves from. The switch is silent (it does not dirty the field), so
 *   saving any other setting would move the app to a new address and release the
 *   old one.
 * - **A domain the operator picked** (`dirty`) stays picked.
 * - **A domain the form opened with that Companion Portal offers** — a retried
 *   install's earlier choice — stays too. One it does not offer is replaced: a
 *   new name there would be refused, as it is on a Portal zone (`ci.computer`).
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

  if (!preselected || dirty || keepsPublishedDomain(isEdit, initialExposureMode)) {
    return null;
  }

  const current = currentPublicDomain?.trim();

  if (current && current.toLowerCase() !== hubDomain?.toLowerCase() && listsDomain(availableDomains, current)) {
    return null;
  }

  return preselected;
}

/**
 * The public domain a form shows, checks and saves — or `undefined` while it has
 * none it can offer.
 *
 * An app already on the Web keeps its domain: the one it saved, else the Hub's own.
 *
 * A form about to publish a NEW name waits for Companion Portal's domain list and
 * uses only a domain from it. The Hub's own domain never stands in while the list
 * is on its way: on a Portal zone (`ci.computer`) it takes no new names, and
 * checking it before the list arrived told the operator "We can't serve any more
 * apps from this domain" about a domain the form was about to leave. With no
 * domain known — the list is loading or failed, or nothing is picked yet — the
 * form checks nothing and saves no domain, and Companion Portal places the app,
 * as it places any app that names none.
 *
 * Where Companion Portal answered and offers nothing, or a Hub too old to say
 * whether it got an answer sent no list, the form keeps what it holds, else the
 * Hub's own domain: the one domain there is.
 */
export function publicDomainToUse(params: {
  /** What the form's domain field holds. */
  chosen: string | undefined;
  hubDomain: string | undefined;
  /** {@link keepsPublishedDomain}. */
  keepsPublished: boolean;
  /** The domains the picker offers. For a new name, only ones Companion Portal offers. */
  availableDomains: readonly AvailableDomain[];
  /** `domainListNoteFor` the list query. */
  listNote: DomainListNote;
}): string | undefined {
  const chosen = params.chosen?.trim() || undefined;

  if (params.keepsPublished) {
    return chosen ?? (params.hubDomain || undefined);
  }

  if (params.availableDomains.length > 0) {
    return chosen && listsDomain(params.availableDomains, chosen) ? chosen : undefined;
  }

  if (params.listNote === 'loading' || params.listNote === 'unavailable') {
    return undefined;
  }

  return chosen ?? (params.hubDomain || undefined);
}
