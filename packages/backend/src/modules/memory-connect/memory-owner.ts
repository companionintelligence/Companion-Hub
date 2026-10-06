/**
 * Telling Companion Memory who its owner is.
 *
 * Companion Memory's first account becomes its administrator. Memory reads the owner from its
 * environment (`auth.applianceOwner`) and, while it has no account, lets only that person create
 * one, whether they arrive through this Hub, a Companion account sign-in or the Memory app. The
 * owner is this Hub's owner: the operator who claimed it (`UserRepository.getFirstOperator`).
 *
 * The variables, and how Memory matches each one:
 *
 * - `CI_OWNER_HUB_ISSUER` / `CI_OWNER_HUB_SUBJECT`: the owner's stable id, as forward auth signs it
 *   (`X-CI-Hub-User-Issuer` / `X-CI-Hub-User-Id`).
 * - `CI_OWNER_EMAIL`: the owner's username. Matches the username forward auth signs, or a Companion
 *   account address the Portal verified.
 * - `CI_OWNER_PORTAL_ISSUER` / `CI_OWNER_PORTAL_SUBJECT`: the owner's Companion account, when they
 *   have signed in to this Hub with it.
 *
 * Values that cannot be read are left out rather than guessed, and a Memory given none behaves as
 * it always has. Nothing here changes once Memory has its first account.
 */
export const MEMORY_OWNER_ENV = {
  email: 'CI_OWNER_EMAIL',
  hubIssuer: 'CI_OWNER_HUB_ISSUER',
  hubSubject: 'CI_OWNER_HUB_SUBJECT',
  portalIssuer: 'CI_OWNER_PORTAL_ISSUER',
  portalSubject: 'CI_OWNER_PORTAL_SUBJECT',
} as const;

/** One identity, as an (issuer, subject) pair. */
export interface OwnerIdentity {
  issuer: string;
  subject: string;
}

/** What this Hub knows about its owner. */
export interface MemoryOwner {
  /** The owner's Hub username (an email address). */
  username: string;
  /** The owner's stable id on this Hub, or null when it could not be read. */
  hub: OwnerIdentity | null;
  /** The owner's Companion account, or null when they have not signed in with one here. */
  portal: OwnerIdentity | null;
}

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * The owner's Companion account among their federated links: the one from the Portal this Hub
 * points Memory at, else the only link there is. Null when that is ambiguous or there is none.
 */
export function pickPortalIdentity(links: readonly OwnerIdentity[], portalIssuer: string | undefined): OwnerIdentity | null {
  const fromPortal = portalIssuer ? links.filter((link) => sameIssuer(link.issuer, portalIssuer)) : [];
  const candidates = fromPortal.length > 0 ? fromPortal : links;

  const [only, ...others] = candidates;

  return only && others.length === 0 ? { issuer: only.issuer, subject: only.subject } : null;
}

/** Write the owner into Companion Memory's environment, replacing whatever was there. */
export function applyMemoryOwnerEnv(envMap: Map<string, string>, owner: MemoryOwner | null): void {
  for (const key of Object.values(MEMORY_OWNER_ENV)) {
    envMap.delete(key);
  }

  if (!owner) {
    return;
  }

  if (owner.username.trim()) {
    envMap.set(MEMORY_OWNER_ENV.email, owner.username.trim());
  }

  if (owner.hub) {
    envMap.set(MEMORY_OWNER_ENV.hubIssuer, owner.hub.issuer);
    envMap.set(MEMORY_OWNER_ENV.hubSubject, owner.hub.subject);
  }

  if (owner.portal) {
    envMap.set(MEMORY_OWNER_ENV.portalIssuer, owner.portal.issuer);
    envMap.set(MEMORY_OWNER_ENV.portalSubject, owner.portal.subject);
  }
}
