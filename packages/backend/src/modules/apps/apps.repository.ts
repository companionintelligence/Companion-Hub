import { extractAppUrn } from '@/common/helpers/app-helpers';
import { DATABASE, type Database } from '@/core/database/database.module';
import { app } from '@/core/database/drizzle/schema';
import type { AppStatus, NewApp } from '@/core/database/drizzle/types';
import { Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { normalizeStoredHostname } from '@ci-hub/common/types';
import { and, asc, eq, ne, notInArray, or, sql } from 'drizzle-orm';

@Injectable()
export class AppsRepository {
  constructor(@Inject(DATABASE) private db: Database) {}

  /**
   * Given an app id, return the app
   *
   * @param {string} appId - The id of the app to return
   */
  public async getAppById(appId: number) {
    return this.db.query.app.findFirst({ where: eq(app.id, appId), with: { appStore: true } });
  }

  public async getAppByUrn(appUrn: AppUrn) {
    const { appStoreId, appName } = extractAppUrn(appUrn);

    return this.db.query.app.findFirst({ where: and(eq(app.appName, appName), eq(app.appStoreSlug, appStoreId)), with: { appStore: true } });
  }

  /**
   * The custom hostname bound to this app, or `null` when it serves on its
   * platform hostname (and when the row does not exist yet, which is the state
   * every install starts from).
   *
   * Deliberately NOT `getAppByUrn`: env generation needs this one `varchar` on
   * every install/start/stop/restart/update/reset, and the joined read ships the
   * whole `config` jsonb plus every `app_store` column to get it.
   */
  public async getAppCustomDomain(appUrn: AppUrn): Promise<string | null> {
    const { appStoreId, appName } = extractAppUrn(appUrn);

    const [row] = await this.db
      .select({ customDomain: app.customDomain })
      .from(app)
      .where(and(eq(app.appName, appName), eq(app.appStoreSlug, appStoreId)))
      .limit(1)
      .execute();

    return row?.customDomain ?? null;
  }

  /**
   * Given an app id, update the app with the given data
   *
   * @param {string} appId - The id of the app to update
   * @param {Partial<NewApp>} data - The data to update the app with
   */
  public async updateAppById(appId: number, data: Partial<NewApp>) {
    const updatedApps = await this.db
      .update(app)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(app.id, appId))
      .returning()
      .execute();
    return updatedApps[0];
  }

  /**
   * Make a custom-domain choice exclusive: clear this intent from every OTHER
   * app.
   *
   * A domain serves exactly one app, and two rows naming it turns every sync
   * into a tug of war — whichever binds last takes it, the delivery reconcile
   * unbinds the loser, the loser becomes a candidate again, and both apps are
   * asked to restart, forever. Enforced HERE, where the choice is written,
   * because that is the only moment the intent is a decision somebody just made:
   * the newest choice wins, which is what a person picking a domain already
   * serving another app plainly means (the picker names that app beside it).
   *
   * Deliberately does NOT touch `custom_domain`. That column is what Companion Portal
   * reported delivered, and the app losing the choice keeps serving on the
   * hostname it was actually wired to until Companion Portal says otherwise — which it
   * will, on the sync after the new binding lands.
   *
   * Matching is case-insensitive because DNS is: the value is stored normalized,
   * but a row written before that was, or by hand, must not escape the rule.
   */
  public async clearCustomDomainIntentElsewhere(appId: number, customDomain: string) {
    // The one spelling, not a second hand-rolled one: `normalizeStoredHostname`
    // also strips the trailing dot, which every reader of this column applies —
    // a local trim+lowercase would let `comfy.acme.com.` escape the rule and
    // leave two apps chasing the same domain.
    const normalized = normalizeStoredHostname(customDomain);

    if (!normalized) {
      return [];
    }

    return this.db
      .update(app)
      .set({ customDomainIntent: null, updatedAt: new Date().toISOString() })
      .where(and(ne(app.id, appId), sql`lower(${app.customDomainIntent}) = ${normalized}`))
      .returning({ id: app.id, appName: app.appName, appStoreSlug: app.appStoreSlug })
      .execute();
  }

  /**
   * Update an app's row only if its status is still `expectedStatus`. The
   * compare-and-set the detached lifecycle completion handlers use, so a
   * command finishing late cannot clobber the status a newer command has
   * already claimed (e.g. a start's success handler overwriting the
   * 'restarting' a just-scheduled restart set while queued behind it).
   * Returns whether the update was applied.
   */
  public async updateAppByIdIfStatus(appId: number, expectedStatus: AppStatus, data: Partial<NewApp>): Promise<boolean> {
    // Return only the id: callers use this solely as an applied/not-applied
    // boolean, so there is no need to ship the whole row (including the config
    // jsonb) back over the wire on every start/restart completion.
    const updatedApps = await this.db
      .update(app)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(and(eq(app.id, appId), eq(app.status, expectedStatus)))
      .returning({ id: app.id })
      .execute();
    return updatedApps.length > 0;
  }

  /**
   * Given an app id, delete the app
   *
   * @param {string} appId - The id of the app to delete
   */
  public async deleteAppById(appId: number) {
    await this.db.delete(app).where(eq(app.id, appId)).execute();
  }

  /**
   * Given app data, creates a new app
   *
   * @param {NewApp} data - The data to create the app with
   */
  public async createApp(data: NewApp) {
    const newApps = await this.db.insert(app).values(data).returning().execute();

    const createdApp = newApps[0];

    if (!createdApp) {
      throw new Error('Failed to create app');
    }

    return createdApp;
  }

  /**
   * Returns all apps installed with the given status sorted by id ascending
   *
   * @param {AppStatus} status - The status of the apps to return
   */
  public async getAppsByStatus(status: AppStatus) {
    return this.db.query.app.findMany({ where: eq(app.status, status), orderBy: asc(app.appName) });
  }

  /**
   * Returns all apps installed sorted by id ascending
   */
  public async getApps() {
    return this.db.query.app.findMany({ orderBy: asc(app.appName), with: { appStore: true } });
  }

  /**
   * Returns all apps that are running and visible on guest dashboard sorted by id ascending
   */
  public async getGuestDashboardApps() {
    return this.db.query.app.findMany({
      where: and(eq(app.status, 'running'), eq(app.isVisibleOnGuestDashboard, true)),
      orderBy: asc(app.appName),
      with: { appStore: true },
    });
  }

  /**
   * Given a domain, return all apps that have this domain, are exposed and not the given id
   *
   * @param {string} domain - The domain to search for
   * @param {string} id - The id of the app to exclude
   */
  public async getAppsByDomain(domain: string, id?: number) {
    if (!id) {
      return this.db.query.app.findMany({ where: and(eq(app.domain, domain), eq(app.exposed, true)) });
    }
    return this.db.query.app.findMany({ where: and(eq(app.domain, domain), eq(app.exposed, true), ne(app.id, id)) });
  }

  /**
   * Given a local subdomain, return all apps that have this subdomain, have exposedLocal enabled and not the given id
   *
   * @param {string} localSubdomain - The local subdomain to search for
   * @param {number} id - The id of the app to exclude
   */
  public async getAppsByLocalSubdomain(localSubdomain: string, id?: number) {
    if (!id) {
      return this.db.query.app.findMany({
        where: and(eq(app.localSubdomain, localSubdomain), eq(app.exposedLocal, true)),
      });
    }
    return this.db.query.app.findMany({
      where: and(eq(app.localSubdomain, localSubdomain), eq(app.exposedLocal, true), ne(app.id, id)),
    });
  }

  /**
   * Apps that bind this host port (openPort, local exposure, or exposedLocal LAN publishing).
   */
  public async getAppsByPort(port: number, id?: number) {
    const publishesHostPortCondition = or(eq(app.openPort, true), eq(app.exposedLocal, true), eq(app.exposureMode, 'local'));
    const where = id ? and(eq(app.port, port), publishesHostPortCondition, ne(app.id, id)) : and(eq(app.port, port), publishesHostPortCondition);

    return this.db.query.app.findMany({ where });
  }

  /**
   * Given an array of app status, update all apps that have a status not in the array with new values
   *
   * @param {AppStatus[]} statuses - The statuses to exclude from the update
   * @param {Partial<NewApp>} data - The data to update the apps with
   */
  public async updateAppsByStatusNotIn(statuses: AppStatus[], data: Partial<NewApp>) {
    return this.db
      .update(app)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(notInArray(app.status, statuses))
      .returning()
      .execute();
  }
}
