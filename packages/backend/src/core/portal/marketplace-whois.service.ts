import { TranslatableError } from '@/common/error/translatable-error';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { describeNetworkError } from '@/common/helpers/network-error';
import { DatabaseService } from '@/core/database/database.service';
import { app, whoisCache } from '@/core/database/drizzle/schema';
import { LoggerService } from '@/core/logger/logger.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import { PORT_EXPOSE_KIND } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { and, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';

import {
  DEFAULT_MEMBER_ACTIONS,
  type HubAction,
  HUB_ACTIONS,
  HUB_CAPABILITY,
  isHubAction,
  MAX_WHOIS_APP_IDS,
  WHOIS_CACHE_TTL_MS,
} from './hub-actions';
import { type HubPrincipalFields, hubSessionOperatorUserId, isAppViewObserverPrincipal, isGrantExemptPrincipal } from './hub-session-operator';
import type { LifecycleActor } from './lifecycle-actor';
import { PortalClientService, type PortalWhoIsResponse } from './portal-client.service';
import { parseDbTimestampMs } from '@/common/helpers/db-timestamp';

export type GrantSurface = 'hub' | 'store';

/**
 * Verbs a logged-in operator may use on a port-expose row without a Portal grant.
 *
 * `configure` stays off this list too. The exposure editor is its own route and
 * does not consult WhoIs. The shared configure routes (`update-config`, Hub
 * access rotation) apply a catalog form, and a pass here would let that form
 * rewrite the row. `install`, `update`, `reset`, `restart`, `backup`, and
 * `restore` have no port-expose path and would run the catalog lifecycle.
 */
const PORT_EXPOSE_ACTIONS: readonly HubAction[] = ['view', 'start', 'stop', 'uninstall'];

/** The app row stores config as jsonb, so `kind` is checked before it is treated as a port expose. */
function storedConfigIsPortExpose(config: unknown): boolean {
  return typeof config === 'object' && config !== null && 'kind' in config && config.kind === PORT_EXPOSE_KIND;
}

type CachedWhoIs = {
  can: HubAction[];
  version: number;
  cachedAt: string;
};

/**
 * Hub UX cache of Portal org app grants (WhoIs / CapMap).
 *
 * Not commerce. A modified Hub can skip this. Portal POST install and
 * `app_entitlement` remain the gates. Device-key WhoIs names the operator
 * by federated `subject`. It also names this device's own `organizationId`,
 * which is not an identity claim: a Portal with the narrowing honours it only
 * when it is one of the organizations this device is registered to now, so it
 * chooses among the device's own registrations and can reach no other tenant.
 * A Portal that predates the narrowing ignores it and lists every organization
 * the subject shares with this device; there `pickOrg`'s match is what keeps
 * grants to our own tenant, so that match is not redundant.
 */
@Injectable()
export class MarketplaceWhoIsService {
  private readonly loggedUnlinked = new Set<number>();
  private readonly loggedOrgUnresolved = new Set<string>();

  constructor(
    private readonly portal: PortalClientService,
    private readonly database: DatabaseService,
    private readonly logger: LoggerService,
    private readonly federatedIdentities: FederatedIdentityRepository,
    private readonly registration: RegistrationService,
  ) {}

  async assertSessionAction(req: Request, appUrn: AppUrn, action: HubAction, surface: GrantSurface = 'hub'): Promise<void> {
    await this.assertSessionActions(req, [appUrn], action, surface);
  }

  /**
   * Assert the grant over a whole set of apps in ONE WhoIs round trip. Asserting
   * app-by-app in a loop costs a Portal request (and a federated-identity read) per
   * app, which `canMap` already batches at `MAX_WHOIS_APP_IDS`.
   *
   * Throws on the first app the operator is refused, so callers that must not touch
   * anything on a partial refusal get all-or-nothing by construction.
   */
  async assertSessionActions(req: Request, appUrns: AppUrn[], action: HubAction, surface: GrantSurface = 'hub'): Promise<void> {
    if (appUrns.length === 0) {
      return;
    }

    const userId = hubSessionOperatorUserId(req);

    if (userId == null) {
      // No person is not automatically "allow": the exemption is a named principal,
      // not the absence of a session. See `isGrantExemptPrincipal`.
      if (isGrantExemptPrincipal(req)) {
        return;
      }

      // `view` only: a `qa:read` key may read an app's status and nothing else. See `isAppViewObserverPrincipal`.
      if (action === 'view' && isAppViewObserverPrincipal(req)) {
        return;
      }

      this.logUnrecognisedPrincipal(req, action);
      // No `app` param: the message interpolates only `action`, and `extractAppUrn`
      // throws a bare `Error` (a 500) on a urn `castAppUrn` let through, such as `x:`.
      throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action }, HttpStatus.FORBIDDEN);
    }

    const map = await this.canMap(userId, appUrns, surface, action);
    for (const appUrn of appUrns) {
      // `null` (WhoIs missed, no fresh cache) is a refusal: these callers mutate.
      if (map.get(appUrn)?.includes(action) !== true) {
        throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action, app: extractAppUrn(appUrn).appName }, HttpStatus.FORBIDDEN);
      }
    }
  }

  /**
   * The apps in `appUrns` the operator may `action`, dropping the rest. For a caller
   * that acts on a set it did not name — a sweep, a repair-all — where refusing the
   * whole request over one ungranted app would put the remedy permanently out of
   * reach. Callers acting on a NAMED set want `assertSessionActions` instead: there
   * the operator chose the apps, so silently skipping one would be a lie.
   *
   * Fails CLOSED, unlike `filterSessionByView`: these callers mutate, so an app whose
   * grant could not be resolved is dropped rather than swept along.
   */
  async filterSessionByAction(req: Request, appUrns: AppUrn[], action: HubAction, surface: GrantSurface = 'hub'): Promise<AppUrn[]> {
    if (appUrns.length === 0) {
      return appUrns;
    }

    const userId = hubSessionOperatorUserId(req);

    if (userId == null) {
      // Exempt principals sweep everything, as before; an unrecognised one sweeps
      // nothing. See `isGrantExemptPrincipal`.
      if (isGrantExemptPrincipal(req)) {
        return appUrns;
      }

      this.logUnrecognisedPrincipal(req, action);
      return [];
    }

    const map = await this.canMap(userId, appUrns, surface, action);
    return appUrns.filter((appUrn) => map.get(appUrn)?.includes(action) === true);
  }

  async filterSessionByView<T>(req: Request, items: T[], urnOf: (item: T) => string | undefined, surface: GrantSurface): Promise<T[]> {
    if (items.length === 0) {
      return items;
    }

    const userId = hubSessionOperatorUserId(req);

    if (userId == null) {
      // Fails open even for an unrecognised principal, unlike the action variants
      // above: hiding a row from a read is how an operator loses sight of an app
      // they own.
      return items;
    }

    const urns = items.map((item) => urnOf(item)).filter((urn): urn is AppUrn => urn?.includes(':') ?? false);
    const map = await this.canMap(userId, urns, surface, 'view');
    return items.filter((item) => {
      const urn = urnOf(item);
      if (!urn) {
        return true;
      }
      const can = map.get(urn);
      // Unknown (Portal down, no fresh cache): keep the row so an outage
      // does not empty the house. Known empty `can` still hides.
      if (can == null) {
        return true;
      }
      return can.includes('view');
    });
  }

  /**
   * Whether the store listing for one app is shown.
   *
   * Same rule as `filterSessionByView`: an unknown grant stays visible, and a
   * known grant that omits `view` is refused. Callers still decide "not found"
   * from the catalog before asking, and they still refuse the private install
   * record on an unknown grant.
   */
  async catalogVisibility(req: Request, appUrn: AppUrn, surface: GrantSurface = 'store'): Promise<'visible' | 'refused'> {
    const userId = hubSessionOperatorUserId(req);

    if (userId == null) {
      return 'visible';
    }

    const can = (await this.canMap(userId, [appUrn], surface, 'view')).get(appUrn);
    if (can == null || can.includes('view')) {
      return 'visible';
    }

    return 'refused';
  }

  /**
   * Whether this operator is an owner or admin of this device's organization —
   * what changing which custom domain an app serves takes (R2-HUBDOMAINS-1).
   *
   * ⚠ A CUSTOM DOMAIN IS THE ORGANIZATION'S, NOT THE APP'S. In the portal,
   * connecting or retargeting one takes `MANAGING_ROLES`. Through the Hub it
   * took `configure` on any one app — which `DEFAULT_GRANTS` hands every member
   * — and the takeover "confirmation" was a form field ticked by the person
   * asking. So any member could move the org's production hostname onto an app
   * of their choosing.
   *
   * The role comes from the same WhoIs answer the grants do, for this device's
   * own organization (named in the request, matched by `pickOrg`), fresh — never
   * from the grant cache — and every way of not knowing it is a `false`: no
   * linked Portal subject, no organization of our own to name (the Portal is not
   * asked), no Portal configured, WhoIs down or answering non-2xx, or an org that
   * did not say. A custom domain cannot be bound without the Portal anyway. Who
   * the operator is, and that a named exempt principal needs no role, is the
   * lifecycle actor's to say (`lifecycleActor`); the service decides from that.
   */
  async hasManagingRole(userId: number, appUrn: AppUrn): Promise<boolean> {
    return this.readManagingRole(userId, appUrn, 'custom_domain');
  }

  /**
   * Whether this operator is an owner or admin of this device's organization,
   * asked about no app at all — for a decision no single app owns, such as who
   * may give an API key full capability.
   *
   * ⚠ IT NEEDS A PORTAL THAT ANSWERS A ROLE-ONLY DEVICE WHOIS. One that predates
   * it refuses an empty `appIds`, and that refusal is a `false` here like every
   * other way of not knowing: nobody but a grant-exempt principal gets the
   * answer "yes" until the Portal can give it.
   */
  async isOrgManager(userId: number): Promise<boolean> {
    return this.readManagingRole(userId, null, 'api_key_full');
  }

  /**
   * The role question both ask, and a change to a custom app (`localAppGrants`), about `appUrn` or, when
   * it is `null`, about no app: fresh, from this device's own organization, and `false` whenever it
   * cannot be answered.
   */
  private async readManagingRole(userId: number, appUrn: AppUrn | null, purpose: 'custom_domain' | 'api_key_full' | 'custom_app'): Promise<boolean> {
    // The identity read and the urn split inside the `try` too: a database error, or a urn
    // `extractAppUrn` rejects, is another way of not knowing, not a 500.
    try {
      const subject = await this.portalSubject(userId);

      if (!subject) {
        this.logUnlinked(userId);
        return false;
      }

      const appIds = appUrn === null ? [] : [extractAppUrn(appUrn).appName];
      const organizationId = await this.deviceOrganizationId();

      // With no organization of our own there is no answer a role could be read from, so the Portal is not asked.
      if (!organizationId) {
        this.logger.warn(`${purpose}_role_unverified userId=${userId} status=no-organization`);
        return false;
      }

      const response = await this.portal.whoisApps({ subject, appIds, surface: 'hub', organizationId });

      if (!response?.body || response.status < 200 || response.status >= 300) {
        // Refused all the same, but an owner turned away by an outage reads "owner or admin only", so the log says why.
        this.logger.warn(`${purpose}_role_unverified userId=${userId} status=${response ? response.status : 'no-portal'}`);
        return false;
      }

      const role = this.pickOrg(response.body, organizationId)?.user?.role;

      return role === 'owner' || role === 'admin';
    } catch (error) {
      this.logger.warn(`Could not read the organization role (${purpose}): ${describeNetworkError(error)}`);
      return false;
    }
  }

  /**
   * The person whose grants filter a sweep over apps the caller did not name, or
   * `undefined` for an exempt principal, which sweeps everything.
   *
   * The `*-all` lifecycle routes cannot use `filterSessionByAction` — they choose
   * their own set from the app table — so they resolve the operator here instead of
   * reading `hubSessionOperatorUserId` directly, which would read an unrecognised
   * principal as "no person to check, allow" all over again.
   */
  sweepOperatorUserId(req: HubPrincipalFields, action: HubAction): number | undefined {
    const userId = hubSessionOperatorUserId(req);

    if (userId == null && !isGrantExemptPrincipal(req)) {
      this.logUnrecognisedPrincipal(req, action);
      throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action }, HttpStatus.FORBIDDEN);
    }

    return userId;
  }

  /**
   * The lifecycle actor a request speaks for, or a 403 when it names none.
   *
   * Built on {@link sweepOperatorUserId}, which already refuses an unrecognised
   * principal: a session person becomes an `operator`, a grant-exempt principal
   * an `exempt`. The service then gates on the actor, so HTTP is no longer the
   * only transport that is checked.
   */
  lifecycleActor(req: HubPrincipalFields, action: HubAction): LifecycleActor {
    const userId = this.sweepOperatorUserId(req, action);

    if (userId != null) {
      return { kind: 'operator', userId };
    }

    // Only a grant-exempt principal is left, and each is named: one added to
    // `isGrantExemptPrincipal` later is refused here until it is named too,
    // rather than passing as another.
    switch (req.hubPrincipal) {
      case 'portal-device':
      case 'cli':
      case 'host-local':
        return { kind: 'exempt', principal: req.hubPrincipal };
      default:
        this.logUnrecognisedPrincipal(req, action);
        throw new TranslatableError('APP_ACTION_GRANT_DENIED', { action }, HttpStatus.FORBIDDEN);
    }
  }

  /**
   * A gated route reached with no recognised principal is a middleware bug, not a
   * grant verdict. The caller only ever sees a 403, so say which it was in the log.
   */
  private logUnrecognisedPrincipal(req: HubPrincipalFields, action: HubAction): void {
    this.logger.warn(`whois_unrecognised_principal principal=${req.hubPrincipal ?? 'none'} action=${action}`);
  }

  async has(userId: number, appUrn: AppUrn, action: HubAction, surface: GrantSurface = 'hub'): Promise<boolean> {
    const map = await this.canMap(userId, [appUrn], surface, action);
    return map.get(appUrn)?.includes(action) === true;
  }

  /**
   * `null` can means WhoIs missed and there is no fresh cache (fail closed on mutate, fail open on list).
   * `action` is the one verb the caller checks: changing a custom app takes a role lookup a view does not.
   */
  private async canMap(userId: number, appUrns: AppUrn[], surface: GrantSurface, action: HubAction): Promise<Map<string, HubAction[] | null>> {
    const unique = [...new Set(appUrns)];
    // Resolved on this Hub, never from the name alone, and never written into
    // the WhoIs cache: that cache is keyed by app name, which a catalog app can
    // share.
    const local = await this.localAppGrants(userId, unique, action);
    const rest = unique.filter((urn) => !local.has(urn));

    if (rest.length === 0) {
      return local;
    }

    const subject = await this.portalSubject(userId);

    if (!subject) {
      this.logUnlinked(userId);
      const out = new Map<string, HubAction[] | null>(rest.map((urn) => [urn, [...DEFAULT_MEMBER_ACTIONS]]));
      for (const [urn, can] of local) {
        out.set(urn, can);
      }
      return out;
    }

    const slugs = rest.map((urn) => extractAppUrn(urn).appName);
    const bySlug = await this.whoisSlugs(subject, slugs, surface);
    const out = new Map<string, HubAction[] | null>();
    for (const urn of rest) {
      const slug = extractAppUrn(urn).appName;
      const can = bySlug.get(slug);
      out.set(urn, can === undefined ? [] : can);
    }
    for (const [urn, can] of local) {
      out.set(urn, can);
    }
    return out;
  }

  /**
   * Apps in the `_user` store are made on this Hub: custom Docker apps and
   * port-expose workloads. They are not Portal catalog apps. WhoIs has no row
   * for them, and a missing catalog name is stored as no grants, which locked
   * everyone, the person who had just created the app included, out of it.
   *
   * So the Hub decides for every `_user` urn, and anyone signed in may view
   * one. A port-expose row also gets `PORT_EXPOSE_ACTIONS`. Every other change
   * to a `_user` app (start, stop, uninstall, configure and the rest) takes an
   * organization owner or admin, asked of the Portal as `hasManagingRole` asks
   * it, and a role that cannot be read refuses the change. A catalog app that
   * shares the name still goes to WhoIs, and nothing is cached under the bare
   * name.
   *
   * When the rows cannot be read, a port expose cannot be told from a custom
   * app, so only the view is granted.
   */
  private async localAppGrants(userId: number, urns: AppUrn[], action: HubAction): Promise<Map<AppUrn, HubAction[]>> {
    const out = new Map<AppUrn, HubAction[]>();
    const local = urns.filter((urn) => extractAppUrn(urn).appStoreId === '_user');
    if (local.length === 0) {
      return out;
    }

    // A view of any `_user` app needs neither the row nor a role, so the lists the UI polls cost nothing here.
    if (action === 'view') {
      for (const urn of local) {
        out.set(urn, ['view']);
      }
      return out;
    }

    const names = [...new Set(local.map((urn) => extractAppUrn(urn).appName))];
    let rows: Array<{ appName: string; config: unknown }> = [];
    try {
      rows = await this.database.db
        .select({ appName: app.appName, config: app.config })
        .from(app)
        .where(and(eq(app.appStoreSlug, '_user'), inArray(app.appName, names)));
    } catch (error) {
      this.logger.warn(`local_app_grant_lookup_failed: ${describeNetworkError(error)}`);
      for (const urn of local) {
        out.set(urn, ['view']);
      }
      return out;
    }

    const portExposeNames = new Set(rows.filter((row) => storedConfigIsPortExpose(row.config)).map((row) => row.appName));
    const [firstCustomApp] = local.filter((urn) => !portExposeNames.has(extractAppUrn(urn).appName));
    // The role is the organization's, not the app's, so one answer covers every custom app here.
    const managing = firstCustomApp !== undefined && (await this.readManagingRole(userId, firstCustomApp, 'custom_app'));
    for (const urn of local) {
      if (portExposeNames.has(extractAppUrn(urn).appName)) {
        out.set(urn, [...PORT_EXPOSE_ACTIONS]);
      } else {
        out.set(urn, managing ? [...HUB_ACTIONS] : ['view']);
      }
    }
    return out;
  }

  private async portalSubject(userId: number): Promise<string | null> {
    const links = await this.federatedIdentities.findByUserId(userId);
    const link = links[0];
    return link?.subject ?? null;
  }

  private logUnlinked(userId: number): void {
    if (this.loggedUnlinked.has(userId)) {
      return;
    }
    this.loggedUnlinked.add(userId);
    this.logger.warn(`whois_skipped_unlinked_operator userId=${userId}`);
  }

  /**
   * Warn once per distinct cause. `filterSessionByView` runs on the app lists
   * the UI polls, so a standing condition — an unregistered device, a subject
   * outside this device's organization — would otherwise write a line every
   * few seconds for as long as it lasts.
   */
  private warnOnce(key: string, message: string): void {
    if (this.loggedOrgUnresolved.has(key)) {
      return;
    }
    this.loggedOrgUnresolved.add(key);
    this.logger.warn(message);
  }

  private async whoisSlugs(subject: string, slugs: string[], surface: GrantSurface): Promise<Map<string, HubAction[] | null>> {
    const unique = [...new Set(slugs)];
    const out = new Map<string, HubAction[] | null>();

    for (let i = 0; i < unique.length; i += MAX_WHOIS_APP_IDS) {
      const batch = unique.slice(i, i + MAX_WHOIS_APP_IDS);
      const fetched = await this.fetchBatch(subject, batch, surface);
      for (const [slug, can] of fetched) {
        out.set(slug, can);
      }
    }

    return out;
  }

  private async fetchBatch(subject: string, slugs: string[], surface: GrantSurface): Promise<Map<string, HubAction[] | null>> {
    try {
      const organizationId = await this.deviceOrganizationId();

      /*
       * `null` is "this device's own organization could not be resolved" — not
       * "the organization granted nothing", and not worth a request: no answer
       * could be matched to it. Reading it as no grants would write an empty
       * `can` into the cache for every slug (poisoning it for the whole TTL, so
       * a later Portal outage serves the empty row as if it were fresh) and hand
       * callers `[]`, which `filterSessionByView` hides rather than failing
       * open. Unknown belongs on the same path as a WhoIs outage.
       */
      if (!organizationId) {
        return this.cacheFallback(subject, slugs);
      }

      const response = await this.portal.whoisApps({ subject, appIds: slugs, surface, organizationId });
      if (response === null) {
        return new Map(slugs.map((slug) => [slug, [...DEFAULT_MEMBER_ACTIONS]]));
      }

      if (response.status === 401) {
        return this.cacheFallback(subject, slugs);
      }

      if (response.status === 403) {
        const empty = new Map<string, HubAction[]>();
        for (const slug of slugs) {
          empty.set(slug, []);
          await this.writeCache(subject, slug, [], 0);
        }
        return empty;
      }

      if (response.status < 200 || response.status >= 300 || !response.body) {
        this.logger.warn(`Portal WhoIs returned HTTP ${response.status}`);
        return this.cacheFallback(subject, slugs);
      }

      const org = this.pickOrg(response.body, organizationId);
      const version = org?.version ?? 0;
      const bySlug = new Map<string, HubAction[]>();

      for (const app of org?.apps ?? []) {
        const can = this.canFromApp(app);
        bySlug.set(app.appId, can);
        await this.writeCache(subject, app.appId, can, version);
      }

      for (const slug of slugs) {
        if (!bySlug.has(slug)) {
          bySlug.set(slug, []);
          await this.writeCache(subject, slug, [], version);
        }
      }

      return bySlug;
    } catch (error) {
      this.logger.warn(`Portal WhoIs failed: ${describeNetworkError(error)}`);
      return this.cacheFallback(subject, slugs);
    }
  }

  /**
   * This device's own organization id, read before WhoIs is asked — the request
   * names it and the answer is matched against it — or `null` when it cannot be
   * learned: the registration read failed, or there is no organization id to
   * read. On `null` a caller takes its WhoIs-outage path without asking at all.
   *
   * ⚠ A FAILED READ IS "UNKNOWN", NOT AN ANSWER. A failed read once fell
   * through to an arbitrary pick of organization, so a transient failure to
   * learn our own identity silently widened every grant on the appliance. It
   * now ends here as `null`, before any Portal call, and logs as a failed read
   * rather than as a device with no organization.
   */
  private async deviceOrganizationId(): Promise<string | null> {
    let registration: Awaited<ReturnType<RegistrationService['getDeviceRegistrationInfo']>>;

    try {
      registration = await this.registration.getDeviceRegistrationInfo();
    } catch (error) {
      this.warnOnce(
        'read-failed',
        `whois_org_unresolved: could not read this device's registration: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }

    if (!registration?.id) {
      this.warnOnce('no-org-id', 'whois_org_unresolved: this device has no organization id; refusing to guess');

      return null;
    }

    return registration.id;
  }

  /**
   * This device's organization from a WhoIs body, or `undefined` — Portal
   * answered, and this device's organization grants nothing (or the subject is
   * in no organization at all). A real answer: "could not tell" never gets
   * here, because the organization is known before WhoIs is asked.
   */
  private pickOrg(body: PortalWhoIsResponse, organizationId: string): PortalWhoIsResponse['organizations'][number] | undefined {
    const organizations = body.organizations ?? [];
    if (organizations.length === 0) {
      return undefined;
    }

    /*
     * ⚠ THE DEVICE'S OWN ORGANIZATION, OR NONE — NEVER "THE FIRST ONE".
     *
     * `organizations[0]` is an arbitrary tenant from a response that may list
     * several, so a subject who belongs to two organizations could have this
     * Hub answer with the grants of whichever one Portal happened to serialize
     * first. That is a grant read from the wrong tenant, and it can be wider
     * than the real one.
     *
     * The request names this organization and a current Portal answers for no
     * other, but one that predates the narrowing accepts the field, ignores it,
     * and lists every organization the subject shares with this device. The
     * match is what keeps that answer to our own tenant.
     */
    const match = organizations.find((org) => org.organizationId === organizationId);

    if (!match) {
      this.warnOnce(`no-grants:${organizationId}`, `whois_org_unresolved: Portal did not return grants for organization ${organizationId}`);
    }

    return match;
  }

  private canFromApp(app: { appId: string; can?: unknown; capMap?: Record<string, unknown> }): HubAction[] {
    if (Array.isArray(app.can)) {
      return app.can.filter((verb): verb is HubAction => typeof verb === 'string' && isHubAction(verb));
    }

    const blobs = app.capMap?.[HUB_CAPABILITY];
    if (!Array.isArray(blobs)) {
      return [];
    }

    const verbs: HubAction[] = [];
    for (const blob of blobs) {
      if (!blob || typeof blob !== 'object' || !('can' in blob) || !Array.isArray(blob.can)) {
        continue;
      }
      for (const verb of blob.can) {
        if (typeof verb === 'string' && isHubAction(verb)) {
          verbs.push(verb);
        }
      }
    }
    return [...new Set(verbs)];
  }

  private async cacheFallback(subject: string, slugs: string[]): Promise<Map<string, HubAction[] | null>> {
    const out = new Map<string, HubAction[] | null>();
    const now = Date.now();

    for (const slug of slugs) {
      const cached = await this.readCache(subject, slug);
      const age = cached ? now - parseDbTimestampMs(cached.cachedAt) : Number.POSITIVE_INFINITY;
      if (cached && Number.isFinite(age) && age < WHOIS_CACHE_TTL_MS) {
        out.set(slug, cached.can);
      } else {
        out.set(slug, null);
      }
    }

    return out;
  }

  private async readCache(subject: string, appId: string): Promise<CachedWhoIs | null> {
    const rows = await this.database.db
      .select()
      .from(whoisCache)
      .where(and(eq(whoisCache.subject, subject), eq(whoisCache.appId, appId)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    let can: HubAction[] = [];
    try {
      const parsed: unknown = JSON.parse(row.canJson);
      if (Array.isArray(parsed)) {
        can = parsed.filter((verb): verb is HubAction => typeof verb === 'string' && isHubAction(verb));
      }
    } catch {
      can = [];
    }

    return { can, version: row.version, cachedAt: row.cachedAt };
  }

  /**
   * Drop every cached grant. The cache key is only `(subject, app)`, so a row
   * written for one organization still authorizes that person after this Hub
   * is reset or paired into another. Callers that can no longer ask Portal
   * would otherwise keep serving it until the 24 hour TTL.
   */
  async clearCache(): Promise<void> {
    await this.database.db.delete(whoisCache);
  }

  private async writeCache(subject: string, appId: string, can: HubAction[], version: number): Promise<void> {
    const cachedAt = new Date().toISOString();
    const canJson = JSON.stringify(can);

    await this.database.db
      .insert(whoisCache)
      .values({ subject, appId, canJson, version, cachedAt })
      .onConflictDoUpdate({
        target: [whoisCache.subject, whoisCache.appId],
        set: { canJson, version, cachedAt },
      });
  }
}
