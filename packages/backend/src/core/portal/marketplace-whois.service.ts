import { TranslatableError } from '@/common/error/translatable-error';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { DatabaseService } from '@/core/database/database.service';
import { whoisCache } from '@/core/database/drizzle/schema';
import { LoggerService } from '@/core/logger/logger.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { RegistrationService } from '@/modules/registration/registration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';

import { DEFAULT_MEMBER_ACTIONS, type HubAction, HUB_CAPABILITY, isHubAction, MAX_WHOIS_APP_IDS, WHOIS_CACHE_TTL_MS } from './hub-actions';
import { hubSessionOperatorUserId } from './hub-session-operator';
import { PortalClientService, type PortalWhoIsResponse } from './portal-client.service';

export type GrantSurface = 'hub' | 'store';

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
 * by federated `subject`; we never send `organizationId` as identity.
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
    const userId = hubSessionOperatorUserId(req);
    if (userId == null || appUrns.length === 0) {
      return;
    }

    const map = await this.canMap(userId, appUrns, surface);
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
    const userId = hubSessionOperatorUserId(req);
    if (userId == null || appUrns.length === 0) {
      return appUrns;
    }

    const map = await this.canMap(userId, appUrns, surface);
    return appUrns.filter((appUrn) => map.get(appUrn)?.includes(action) === true);
  }

  async filterSessionByView<T>(req: Request, items: T[], urnOf: (item: T) => string | undefined, surface: GrantSurface): Promise<T[]> {
    const userId = hubSessionOperatorUserId(req);
    if (userId == null || items.length === 0) {
      return items;
    }

    const urns = items.map((item) => urnOf(item)).filter((urn): urn is AppUrn => urn?.includes(':') ?? false);
    const map = await this.canMap(userId, urns, surface);
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

  async has(userId: number, appUrn: AppUrn, action: HubAction, surface: GrantSurface = 'hub'): Promise<boolean> {
    const map = await this.canMap(userId, [appUrn], surface);
    return map.get(appUrn)?.includes(action) === true;
  }

  /** `null` can means WhoIs missed and there is no fresh cache (fail closed on mutate, fail open on list). */
  private async canMap(userId: number, appUrns: AppUrn[], surface: GrantSurface): Promise<Map<string, HubAction[] | null>> {
    const unique = [...new Set(appUrns)];
    const subject = await this.portalSubject(userId);

    if (!subject) {
      this.logUnlinked(userId);
      return new Map(unique.map((urn) => [urn, [...DEFAULT_MEMBER_ACTIONS]]));
    }

    const slugs = unique.map((urn) => extractAppUrn(urn).appName);
    const bySlug = await this.whoisSlugs(subject, slugs, surface);
    const out = new Map<string, HubAction[] | null>();
    for (const urn of unique) {
      const slug = extractAppUrn(urn).appName;
      const can = bySlug.get(slug);
      out.set(urn, can === undefined ? [] : can);
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
      const response = await this.portal.whoisApps({ subject, appIds: slugs, surface });
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

      const org = await this.pickOrg(response.body);
      /*
       * `null` is "this device's own organization could not be resolved" — not
       * "the organization granted nothing". Falling through would write an
       * empty `can` into the cache for every slug (poisoning it for the whole
       * TTL, so a later Portal outage serves the empty row as if it were fresh)
       * and hand callers `[]`, which `filterSessionByView` hides rather than
       * failing open. Unknown belongs on the same path as a WhoIs outage.
       */
      if (org === null) {
        return this.cacheFallback(subject, slugs);
      }

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
      this.logger.warn(`Portal WhoIs failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.cacheFallback(subject, slugs);
    }
  }

  /**
   * This device's organization from a WhoIs body.
   *
   * `undefined` — Portal answered, and this device's organization grants
   * nothing (or the subject is in no organization at all). A real answer.
   * `null` — this device's own organization could not be resolved. Not an
   * answer; the caller must treat it the way it treats a WhoIs outage.
   */
  private async pickOrg(body: PortalWhoIsResponse): Promise<PortalWhoIsResponse['organizations'][number] | undefined | null> {
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
     * The registration read failing is the same problem wearing a different
     * hat: it used to be swallowed into `null` and fall through to the same
     * arbitrary pick, so a transient failure to learn our own identity silently
     * widened every grant on the appliance. It now returns `null` — "unknown",
     * which `fetchBatch` routes to the cache fallback — rather than
     * `undefined`, which means "asked, and the answer was no grants".
     */
    const registration = await this.registration.getDeviceRegistrationInfo().catch((error: unknown) => {
      this.warnOnce(
        'read-failed',
        `whois_org_unresolved: could not read this device's registration: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    });

    if (!registration?.id) {
      this.warnOnce('no-org-id', 'whois_org_unresolved: this device has no organization id; refusing to guess at grants');

      return null;
    }

    const match = organizations.find((org) => org.organizationId === registration.id);

    if (!match) {
      this.warnOnce(`no-grants:${registration.id}`, `whois_org_unresolved: Portal did not return grants for organization ${registration.id}`);
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
      const age = cached ? now - Date.parse(cached.cachedAt) : Number.POSITIVE_INFINITY;
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
