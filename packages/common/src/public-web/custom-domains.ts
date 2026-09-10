import validator from 'validator';
import { sanitizeAppSubdomain } from './identity.js';

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

/**
 * The platform hostnames MORE THAN ONE app on this Hub resolves to.
 *
 * The mirror image of {@link collectAmbiguousCustomDomains}, and deliberately the
 * same conservative rule (R2-HUBDOMAINS-2): there, one domain names two targets
 * and the Hub cannot tell which app CI-Cloud is routing; here, two apps compose
 * one target and the Hub cannot tell which of them a delivered domain was bound
 * to. CI-Cloud answers with a hostname, not with an app id, so a contested target
 * makes the attribution a coin toss — and the wrong side of that toss writes a
 * customer's `custom_domain` onto an app it was never bound to, which then emits
 * `APP_PUBLIC_URL=https://shop.acme.com`, receives the domain as
 * `X-Forwarded-Host` and signs OAuth redirects for it.
 *
 * Uniqueness is enforced on write, so this is not the primary defence — it is the
 * one that still holds for the rows a Hub wrote before that check existed, and for
 * any future path that reaches the column without passing through it. Callers bind
 * NONE of the contesting apps and leave whatever each is already serving alone:
 * neither attribution is better than the other, and a wrong bind is not recoverable
 * by the app that lost it.
 *
 * Callers pass only the apps a domain could actually be delivered to
 * (`canServeOnCustomDomain`); an app with no public identity composes no ingress
 * rule and so contests nothing.
 */
export function collectContestedCustomDomainTargets(targets: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const contested = new Set<string>();

  for (const target of targets) {
    if (seen.has(target)) {
      contested.add(target);
    }
    seen.add(target);
  }

  return contested;
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
export function selectCustomDomain(
  delivered: readonly string[] | undefined,
  current: string | null,
  /**
   * What the operator asked for, when they asked for something.
   *
   * Only ever consulted against domains CI-Cloud has ALREADY DELIVERED for this
   * target, which is what keeps it from being the thing the split between
   * `custom_domain` and `custom_domain_intent` exists to prevent: the intent
   * never introduces a hostname here, it only breaks a tie between hostnames
   * CI-Cloud already reported serving this app.
   */
  intent?: string | null,
): string | null {
  if (!delivered || delivered.length === 0) {
    return null;
  }

  /*
   * ⚠ THE INTENT OUTRANKS STICKINESS, AND ONLY INSIDE `delivered`.
   *
   * Stickiness below exists to stop a newly added alias dragging an app off the
   * hostname it has served for months. It cannot tell that case apart from a
   * MOVE the operator deliberately asked for, and it used to lose to it every
   * time: binding B never unbinds A, so CI-Cloud reports both against this
   * target — legal, since an apex and its `www` are a normal pairing — and the
   * sticky pick returned A forever. The intent stayed permanently unsatisfied,
   * every later pass hit the "CI-Cloud already points it here" skip, and nothing
   * logged (CI-Engineering#208, defect 2).
   *
   * Asking for the intent first is what makes a move land, and it costs the
   * sticky rule nothing: an app with no intent, or one whose intent is already
   * what it serves, takes exactly the branch below.
   */
  if (intent && delivered.includes(intent)) {
    return intent;
  }

  if (current && delivered.includes(current)) {
    return current;
  }

  return delivered[0] ?? null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DOMAINS AN INSTALL DIALOG MAY OFFER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above is about domains CI-Cloud has ALREADY WIRED — what the tunnel
 * answers for today. This is the other direction: what the organization owns and
 * could be asked to wire, read from `GET /api/custom-domains/device` so a person
 * installing an app can pick one.
 *
 * The two must not be confused. A row here is a domain that EXISTS; only a
 * {@link TunnelCustomDomain} is a domain that SERVES. Nothing in this shape may
 * ever reach `APP_PUBLIC_URL` — an app told to emit a hostname CI-Cloud has not
 * wired would sign OAuth redirects for an address that resolves nowhere. The
 * binding an app actually serves on still comes from the tunnel sync, and only
 * from there.
 */
export interface AvailableCustomDomain {
  /** CI-Cloud's row id — the handle a bind request names. Required here. */
  id: string;
  /** The customer-owned hostname (e.g. `comfy.acme.com`). */
  domain: string;
  /**
   * What the domain is, as CI-Cloud sees it.
   *
   * `live` — verified and pointing at something. `parked` — verified and
   * pointing at nothing, the state connect-first/bind-later leaves behind.
   * `pending` — connected but not proved yet, so not routable. `securing` —
   * proved, but its certificate is still issuing (Cloudflare gates ownership and
   * TLS independently, so this is a real and common state). `drifted` — the
   * records the customer's zone held have changed since, and the monitor noticed.
   * `failed` — the certificate will never issue.
   *
   * ⚠ A LABEL, NOT A GATE. `bindable` is the only field that decides whether a
   * domain may be chosen — `securing` and `drifted` are both bindable, because a
   * certificate finishes on its own and drift is a fact about someone else's DNS
   * rather than about our permission to point the row somewhere.
   *
   * ⚠ AND `failed` IS BINDABLE TOO, WHICH IS WHY IT HAS TO BE READ. CI-Cloud
   * reports it on the same terms as the other two and says so at length: a gate
   * there would strand the row and tell us nothing. But unlike them it does NOT
   * clear itself — there is no in-place reissue, and the only remedy is
   * disconnect-and-reconnect — so a caller that treats `bindable` as the whole
   * answer offers a domain that can never serve. Callers must weigh this state
   * themselves; see the picker and the bind pass.
   *
   * `unknown` is this Hub meeting a CI-Cloud newer than itself. See
   * {@link parseAvailableCustomDomains} for why that must not hide the domain.
   */
  state: 'live' | 'parked' | 'pending' | 'securing' | 'drifted' | 'failed' | 'unknown';
  /** Whether CI-Cloud would accept a bind for it now. */
  bindable: boolean;
  /** The platform hostname it currently aliases, if any. */
  targetHostname: string | null;
  /** The app on THIS device it is bound to, when CI-Cloud could name one. */
  boundAppSlug: string | null;
  /** Bound to an app this Hub does not hold — another Hub in the org. */
  boundElsewhere: boolean;
}

/**
 * Would binding this domain to `appSlug` take it off something that is serving
 * it now?
 *
 * ⚠ THE ONE SPELLING, because three callers decide the same question and a
 * divergence between them is a choice that evaporates after a success toast:
 * the picker asks the operator to confirm a move, the bind pass refuses an
 * unconfirmed one, and the release refuses to unpoint a domain that has moved
 * on. A state the dialog does not warn about but the pass refuses, or the other
 * way round, is a defect in whichever one is the odd copy out.
 *
 * ⚠ AND THE SLUG IS CANONICALIZED ON BOTH SIDES. `boundAppSlug` is
 * `application.slug` as CI-Cloud stored it, which is
 * `canonicalizeAppSubdomain(<the subdomain the Hub sent>)` — lowercased, with
 * runs of separators collapsed. The Hub's own routing subdomain is the RAW
 * value (`resolveRoutingSubdomain` only trims), and `localSubdomain` accepts
 * `/^[a-zA-Z0-9-]{1,63}$/`, so `MyApp` and `my--app` both compare unequal to
 * the slug CI-Cloud is holding for the very same app. Left raw, an app whose
 * subdomain is not already canonical reads as somebody else's: its release is
 * refused forever with "serving something else now", and the picker asks the
 * operator to confirm moving a domain off themselves. CI-Portal canonicalizes
 * both sides of every comparison it makes for exactly this reason;
 * {@link sanitizeAppSubdomain} exists here to mirror that rule.
 *
 * A slug that survives neither side — absent, or punctuation that sanitizes to
 * nothing — answers "yes, another app". Ownership that cannot be established is
 * not ownership, and the conservative answer only ever costs a confirmation.
 */
export function customDomainServesAnotherApp(
  entry: Pick<AvailableCustomDomain, 'boundAppSlug' | 'boundElsewhere'>,
  appSlug: string | null | undefined,
): boolean {
  if (entry.boundElsewhere) {
    return true;
  }

  /*
   * CI-Cloud named no app on this device. That is a parked domain, or one whose
   * app was uninstalled (`application_id` is `ON DELETE SET NULL`) — not a
   * hostname being taken off somebody. Read through truthiness rather than
   * `=== null` so a payload that omits the field, or sends punctuation that
   * sanitizes to nothing, lands here instead of crashing the pass.
   */
  const theirs = entry.boundAppSlug ? sanitizeAppSubdomain(entry.boundAppSlug) : '';

  if (!theirs) {
    return false;
  }

  // No slug of our own is no claim to the domain, so the answer is "somebody
  // else's" — which only ever costs a confirmation.
  return (appSlug ? sanitizeAppSubdomain(appSlug) : '') !== theirs;
}

const DOMAIN_STATES = new Set(['live', 'parked', 'pending', 'securing', 'drifted', 'failed']);

/**
 * Validate the `domains` field of the device custom-domain listing.
 *
 * Elements are validated individually and junk is DROPPED, the same wire-boundary
 * discipline {@link parseTunnelCustomDomains} applies — this is the same pair of
 * independently deployed services, and one malformed row must not cost the
 * person the whole picker.
 *
 * `undefined` for a payload that could not be read AT ALL — an older CI-Cloud
 * with no such route, a shape that drifted — because "we could not ask" and "the
 * organization owns none" call for different sentences in the dialog. Offering
 * an empty picker for a failed read is how Gap 3 looked in the first place: the
 * Hub silently behaving as though the customer's domains did not exist.
 */
export function parseAvailableCustomDomains(value: unknown): AvailableCustomDomain[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const domains: AvailableCustomDomain[] = [];
  let dropped = 0;

  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      dropped += 1;
      continue;
    }

    const source = candidate as Record<string, unknown>;
    const id = readString(source, 'id');
    const domain = readString(source, 'domain');
    const state = readString(source, 'state');

    if (!id || !domain || !state) {
      dropped += 1;
      continue;
    }

    const normalizedDomain = normalizeHostname(domain);

    if (!isHostname(normalizedDomain)) {
      dropped += 1;
      continue;
    }

    const rawTarget = readString(source, 'targetHostname');
    /*
     * Shape-checked like the domain itself, for the reason
     * {@link parseTunnelCustomDomains} checks it: this value is compared against a
     * hostname the Hub composes, and a string that is not a hostname can never
     * equal one — so keeping it would make the "CI-Cloud already points it here"
     * check miss forever and re-issue a bind on every sync. Nulled rather than
     * dropped, because dropping the row would send the choice into the "the
     * organization no longer holds this domain" branch and clear it.
     */
    const normalizedTarget = rawTarget ? normalizeHostname(rawTarget) : null;
    const targetHostname = normalizedTarget && isHostname(normalizedTarget) ? normalizedTarget : null;

    domains.push({
      id,
      domain: normalizedDomain,
      /*
       * ⚠ AN UNRECOGNISED STATE MUST NOT HIDE THE DOMAIN.
       *
       * CI-Cloud added `securing` and `drifted` after this Hub's first release,
       * and dropping every row whose state this build had not heard of made
       * exactly the failure the picker exists to end: a connected, BINDABLE
       * domain silently absent, reading as "the Hub cannot see my domain". A
       * Hub is older than the Portal it talks to for most of its life, so this
       * is the ordinary case, not an edge one.
       *
       * The state is a label; `bindable` is the gate. So an unknown one keeps
       * the row, keeps whatever CI-Cloud said about bindability, and simply has
       * nothing to add in the dialog.
       */
      state: DOMAIN_STATES.has(state) ? (state as AvailableCustomDomain['state']) : 'unknown',
      /*
       * ⚠ DEFAULTS TO FALSE, NOT TRUE. An absent or non-boolean `bindable` means
       * an answer we did not get, and offering a domain the server would refuse
       * spends a person's attention on a choice that cannot be honoured. The
       * dialog can always say "manage it in the portal".
       */
      bindable: source.bindable === true,
      targetHostname,
      boundAppSlug: readString(source, 'boundAppSlug'),
      boundElsewhere: source.boundElsewhere === true,
    });
  }

  /*
   * ⚠ EVERYTHING CI-CLOUD SENT WAS JUNK — WHICH IS NOT "THE ORGANIZATION OWNS
   * NONE". The same guard {@link parseTunnelCustomDomains} applies, and here it
   * is destructive rather than merely misleading: the bind pass reads a listing
   * it could read as the organization's FULL set, and clears every intent naming
   * a domain absent from it. A payload whose shape drifted — a fourth `state`, an
   * `id` that arrives as a number, as CI-Cloud's sibling domain endpoint already
   * sends — would otherwise wipe every custom-domain choice on the Hub in one
   * pass. Understanding nothing means changing nothing.
   */
  if (domains.length === 0 && dropped > 0) {
    return undefined;
  }

  return domains;
}
