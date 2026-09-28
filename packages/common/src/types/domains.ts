export interface AvailableDomain {
  id: string;
  domain: string;
  isDefault: boolean;
  scope?: string;
  /**
   * Whether the install / port-expose picker should show this suffix for a new
   * hostname. Absent on an older Portal — treat as offered unless the suffix is
   * `ci.computer` (Portal's own zone). A grandfathered current selection stays
   * visible even when this is false.
   */
  offered?: boolean;
}

export interface AvailableDomainsResponse {
  /**
   * Whether Companion Portal answered with a list, as for the custom-domain list.
   * `false` is not "no domains": the Hub could not get the list (not paired,
   * offline, or the Portal failed), and the picker says so rather than showing
   * the Hub's own domain as though it were the only choice.
   */
  supported: boolean;
  domains: AvailableDomain[];
}

const PORTAL_APPLIANCE_ZONE = 'ci.computer';

/**
 * Suffixes the Hub picker may list. Always keeps `currentPublicDomain` so a
 * grandfathered Hub on `ci.computer` still sees the name it already serves.
 */
export function selectOfferedDomains(domains: readonly AvailableDomain[], currentPublicDomain?: string): AvailableDomain[] {
  const currentLower = currentPublicDomain?.trim().toLowerCase();

  return domains.filter((entry) => {
    if (currentLower && entry.domain.toLowerCase() === currentLower) {
      return true;
    }

    if (entry.offered === false) {
      return false;
    }

    if (entry.offered === true) {
      return true;
    }

    return entry.domain.toLowerCase() !== PORTAL_APPLIANCE_ZONE;
  });
}
