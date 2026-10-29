/**
 * The scheme, host and port of a Portal address or token issuer, lower-cased.
 *
 * Two values name the same Portal when their origins match: a Portal's token issuer can carry a
 * path (`https://hub.example.com/api/auth`), and a configured Portal URL can end in a slash.
 */
export function portalOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * The federated links to ask the Portal this Hub is paired with about.
 *
 * A person keeps a link for every Portal they have signed in from. Once the Hub moves to another
 * Portal, that Portal has never heard of the old subject and answers "not a member". Asking it about
 * the old link revoked the person a few seconds after every sign-in (#2178). So when the person has
 * a link from the current Portal, only those are asked.
 *
 * With no link from the current Portal, every link is asked, as before: access the current Portal
 * can't confirm still ends, and the person's next sign-in through it adds a link and lets them back
 * in. A link from another Portal is kept rather than deleted, so a Hub moved back still knows it.
 */
export function linksForCurrentPortal<T extends { issuer?: string | null }>(links: readonly T[], portalUrl: string | null | undefined): T[] {
  const current = portalOrigin(portalUrl);
  if (!current) {
    return [...links];
  }

  const fromCurrentPortal = links.filter((link) => portalOrigin(link.issuer) === current);
  return fromCurrentPortal.length > 0 ? fromCurrentPortal : [...links];
}
