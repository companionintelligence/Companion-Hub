/**
 * The custom-domain bindings CI-Cloud reports back on `POST /api/tunnels/state`.
 *
 * CI-Cloud filters this array against the ingress rules it actually produced, so
 * a row that is present is a hostname the tunnel answers for — the Hub treats it
 * as delivered rather than re-deriving entitlement or re-checking verification.
 */
export interface TunnelCustomDomain {
  /** CI-Cloud's row id for the connected domain. */
  id: string;
  /** The customer-owned hostname the browser arrives on (e.g. `comfy.acme.com`). */
  domain: string;
  /**
   * The platform hostname this domain aliases — the same
   * `<app>-<hub>-<org>.<root>` name `buildPublicWebIdentity` produces, which is
   * what makes it a direct join key against an app's own public hostname.
   */
  targetHostname: string;
}

export interface ParsedTunnelCustomDomains {
  entries: TunnelCustomDomain[];
  /** Entries CI-Cloud sent that were unusable and were dropped. */
  dropped: number;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate the `customDomains` field of a tunnel-state response.
 *
 * ⚠ THE ABSENT/EMPTY DISTINCTION IS LOAD-BEARING. `undefined` means "this
 * CI-Cloud does not report custom domains" — every version predating the feature
 * — and the caller must leave whatever bindings it already has alone. `[]` means
 * "this device has none", which is an instruction to unbind. Collapsing the two
 * would make every older Portal silently strip live custom domains off the apps
 * that are serving on them.
 *
 * Elements are validated individually and junk is DROPPED, not thrown on, for
 * the same reason `failures` is: this is a wire boundary between two
 * independently deployed services, and turning one malformed row into a hard
 * sync failure would misreport the blast radius of a partial sync.
 *
 * Hostnames are lowercased because DNS is case-insensitive but string equality
 * is not, and `targetHostname` is joined against a hostname the Hub composes
 * from slugs it stores verbatim.
 */
export function parseTunnelCustomDomains(value: unknown): ParsedTunnelCustomDomains | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    // Present but not an array: the field WAS sent, so this is a malformed
    // payload rather than an older Portal. Report it as "none delivered" with
    // everything dropped so the caller can log it, and so a device that really
    // has no custom domains is not left with stale bindings forever.
    return { entries: [], dropped: 1 };
  }

  const entries: TunnelCustomDomain[] = [];
  let dropped = 0;

  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      dropped += 1;
      continue;
    }

    const source = candidate as Record<string, unknown>;
    const id = readString(source, 'id');
    const domain = readString(source, 'domain');
    const targetHostname = readString(source, 'targetHostname');

    if (!id || !domain || !targetHostname) {
      dropped += 1;
      continue;
    }

    entries.push({ id, domain: domain.toLowerCase(), targetHostname: targetHostname.toLowerCase() });
  }

  return { entries, dropped };
}

/**
 * Index delivered bindings by the platform hostname they alias.
 *
 * Two domains can legitimately point at the same app — a rename in progress, an
 * apex plus its `www`. Only one can be the app's `APP_PUBLIC_URL`, so the choice
 * is made here, once, and made deterministically: the lexicographically first
 * domain wins, so the value does not flip between syncs on CI-Cloud's row order.
 */
export function indexCustomDomainsByTarget(entries: readonly TunnelCustomDomain[]): Map<string, string> {
  const byTarget = new Map<string, string>();

  for (const entry of entries) {
    const current = byTarget.get(entry.targetHostname);

    if (current === undefined || entry.domain < current) {
      byTarget.set(entry.targetHostname, entry.domain);
    }
  }

  return byTarget;
}
