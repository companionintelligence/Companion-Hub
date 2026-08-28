import validator from 'validator';

/**
 * The custom-domain bindings CI-Cloud reports back on `POST /api/tunnels/state`.
 *
 * CI-Cloud filters this array against the ingress rules it actually produced, so
 * a row that is present is a hostname the tunnel answers for — the Hub treats it
 * as delivered rather than re-deriving entitlement or re-checking verification.
 */
export interface TunnelCustomDomain {
  /**
   * CI-Cloud's row id for the connected domain, when it sent one.
   *
   * Nothing in the Hub reads it — the join is on `targetHostname` — so it must
   * NOT gate acceptance. Dropping an entry over an id no consumer wants would
   * take a live customer domain off the air (CI-Cloud's own `AvailableDomain`
   * ids arrive as numbers on a sibling endpoint, so the shape is not guaranteed).
   */
  id?: string;
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
  /**
   * The bindings CI-Cloud delivered, or `undefined` when the payload could not
   * be understood at all.
   *
   * ⚠ `undefined` and `[]` MEAN DIFFERENT THINGS, and the difference is what
   * stops this feature taking live domains off the air. `[]` is CI-Cloud saying
   * "this device has none", which is an instruction to unbind. `undefined` is
   * "nothing usable arrived" — an older Portal, or a payload whose shape drifted
   * — and the caller must leave every binding it already has alone.
   */
  entries: TunnelCustomDomain[] | undefined;
  /** Entries CI-Cloud sent that were unusable and were dropped. */
  dropped: number;
}

/**
 * The one spelling: trimmed, lowercased, trailing dot removed — the same
 * normalization CI-Cloud stores these under, so the two sides compare equal.
 */
export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The one spelling for a value read back off an app row.
 *
 * Every consumer of `app.custom_domain` — env generation, the app's link and
 * availability probe, public-web diagnostics, the access-points card — must
 * agree on it, or they compare unequal against each other and against the env
 * they just wrote. `null` for absent/blank so callers can compare with `===`.
 */
export function normalizeStoredHostname(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = normalizeHostname(value);

  return normalized.length > 0 ? normalized : null;
}

/**
 * Is this a hostname at all?
 *
 * ⚠ DELIBERATELY THE SAME RULE CI-CLOUD ALREADY APPLIED, AND NO STRICTER. This
 * runs on a value that CI-Cloud validated on the way in and then wired into a
 * live tunnel, so anything rejected here is a domain that IS serving and that
 * the Hub would silently refuse to tell its app about. Mirroring the rule
 * CI-Cloud applies can only reject strings CI-Cloud would have rejected too.
 *
 * What it is here for is the other direction: the value is interpolated into
 * `https://<domain>` and written into an app's compose env, so a string that is
 * not a hostname would produce a malformed `APP_PUBLIC_URL` — an app signing
 * OAuth redirects for an address that cannot resolve. Dropping the entry leaves
 * the app on its platform hostname, which works.
 *
 * `validator.isFQDN` is the SAME check the rest of the Hub already applies to a
 * domain — `validateDomain` in `validation/form-fields.ts`, and the
 * `publicDomain` field of `appFormSchema` — which is what keeps the two from
 * drifting: a second, hand-rolled definition of "is this a domain name" only has
 * to disagree once to drop a live customer domain that the operator-facing side
 * accepts. `require_tld` rejects a bare `localhost`; the trailing dot is already
 * removed by {@link normalizeHostname} before this runs.
 */
function isHostname(value: string): boolean {
  return validator.isFQDN(value, { require_tld: true });
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
 * Hostnames are normalized because DNS is case-insensitive but string equality
 * is not, and `targetHostname` is joined against a hostname the Hub composes
 * from slugs it stores verbatim. They are also shape-checked — see
 * {@link isHostname} for why that check is deliberately no stricter than the one
 * CI-Cloud already applied.
 */
export function parseTunnelCustomDomains(value: unknown): ParsedTunnelCustomDomains | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    /*
     * Present but not an array. The field WAS sent, so this is a shape drift
     * rather than an older Portal — but "we could not read this payload" is NOT
     * the same instruction as "this device has none". Reporting it as an empty
     * array would hand the reconcile a fleet-wide unbind on the strength of a
     * response nobody could parse, so it is reported as not-delivered and the
     * caller keeps the bindings it has. `dropped` still lets it log.
     */
    return { entries: undefined, dropped: 1 };
  }

  const entries: TunnelCustomDomain[] = [];
  let dropped = 0;

  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      dropped += 1;
      continue;
    }

    const source = candidate as Record<string, unknown>;
    // `id` is informational — see TunnelCustomDomain.id for why it must not gate.
    const id = readString(source, 'id') ?? undefined;
    const domain = readString(source, 'domain');
    const targetHostname = readString(source, 'targetHostname');

    if (!domain || !targetHostname) {
      dropped += 1;
      continue;
    }

    const normalizedDomain = normalizeHostname(domain);
    const normalizedTarget = normalizeHostname(targetHostname);

    if (!isHostname(normalizedDomain) || !isHostname(normalizedTarget)) {
      dropped += 1;
      continue;
    }

    entries.push({ id, domain: normalizedDomain, targetHostname: normalizedTarget });
  }

  /*
   * Everything CI-Cloud sent was junk. Same reasoning as the non-array branch:
   * a payload that arrived with rows in it and yielded none is a Portal whose
   * wire shape moved, not a device that has no custom domains, and the safe
   * reading of "we understood nothing" is to change nothing.
   */
  if (entries.length === 0 && dropped > 0) {
    return { entries: undefined, dropped };
  }

  return { entries, dropped };
}

/**
 * Index delivered bindings by the platform hostname they alias.
 *
 * Two domains can legitimately point at the same app — a rename in progress, an
 * apex plus its `www` — so every delivered domain for a target is returned,
 * sorted, and the choice between them is left to {@link selectCustomDomain},
 * which can see what the app is already serving on.
 *
 * A domain aliasing MORE THAN ONE target is dropped from all of them. That is a
 * rebind caught in flight (a customer moving `comfy.acme.com` from one app to
 * another), and the Hub cannot tell which side Cloudflare is actually routing.
 * Binding both would have the app that is NOT being routed emit
 * `APP_PUBLIC_URL=https://comfy.acme.com` and sign OAuth redirects that land the
 * user in a sibling app; leaving both on their platform hostnames works.
 */
/**
 * The domains {@link indexCustomDomainsByTarget} refused to attribute, because
 * CI-Cloud reported them against more than one target.
 *
 * The caller needs these separately from the index: dropping such a domain from
 * `byTarget` makes an affected app look like one whose target was never
 * delivered, and for an app ALREADY serving on that hostname the two are not the
 * same instruction. "No domain was delivered for you" is an unbind; "the domain
 * you are on is mid-rebind" is a reason to hold still until CI-Cloud settles.
 */
export function collectAmbiguousCustomDomains(entries: readonly TunnelCustomDomain[]): Set<string> {
  const targetsByDomain = new Map<string, Set<string>>();

  for (const entry of entries) {
    const targets = targetsByDomain.get(entry.domain) ?? new Set<string>();
    targets.add(entry.targetHostname);
    targetsByDomain.set(entry.domain, targets);
  }

  return new Set([...targetsByDomain].filter(([, targets]) => targets.size > 1).map(([domain]) => domain));
}

export function indexCustomDomainsByTarget(entries: readonly TunnelCustomDomain[]): Map<string, string[]> {
  const ambiguous = collectAmbiguousCustomDomains(entries);
  const byTarget = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (ambiguous.has(entry.domain)) {
      continue;
    }

    const domains = byTarget.get(entry.targetHostname) ?? new Set<string>();
    domains.add(entry.domain);
    byTarget.set(entry.targetHostname, domains);
  }

  // Sorted so the fallback pick below cannot flip between syncs on CI-Cloud's
  // row order, which would ask for a restart on every heartbeat.
  return new Map([...byTarget].map(([target, domains]) => [target, [...domains].sort()]));
}

/**
 * Choose which of a target's delivered domains the app should be served on.
 *
 * STICKY BY DESIGN. Deterministic is not enough: an app bound to `zzz.acme.com`
 * for months, whose customer then adds `aaa.acme.com` as a second alias, would
 * be moved off the hostname it is already serving on by a plain lexicographic
 * pick — rewriting `APP_PUBLIC_URL` and `APP_BASE_URL`, and breaking every OAuth
 * `redirect_uri` registered against the old name. So the domain already bound
 * wins for as long as CI-Cloud keeps delivering it, and the sort order only
 * decides the FIRST binding.
 */
export function selectCustomDomain(delivered: readonly string[] | undefined, current: string | null): string | null {
  if (!delivered || delivered.length === 0) {
    return null;
  }

  if (current && delivered.includes(current)) {
    return current;
  }

  return delivered[0] ?? null;
}
