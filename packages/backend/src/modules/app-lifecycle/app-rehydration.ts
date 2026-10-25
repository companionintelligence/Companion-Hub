import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { PortalDeviceApplication } from '@/modules/cloudflare/cloudflare-client.service';
import { PORT_EXPOSE_KIND } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { deriveAppSlug, RESERVED_APP_NAMES, sanitizeAppSubdomain } from '@ci-hub/common/types';
import type { z } from 'zod';
import type { appFormSchema } from './dto/app-lifecycle.dto';

export type { PortalDeviceApplication };

export interface LocalAppDataEntry {
  storeId: string;
  appName: string;
  hasDataDir: boolean;
  hasAppEnv: boolean;
}

export type RehydrationAction = 'install' | 'start' | 'expose' | 'skip_running' | 'skip_busy' | 'skip_unresolved';

/** The store a port made with "Expose a port" lives in. */
export const EXPOSED_PORT_STORE = '_user';

/** Where a port this Hub exposed before a reinstall comes back. */
export interface ExposedPortTarget {
  port: number;
  exposureMode: 'cloudflare' | 'local' | 'tailscale';
  localSubdomain: string;
  publicDomain?: string;
}

/** A Portal app that is a port this device exposed, with where it comes back. */
export interface ExposedPortEntry {
  portalApp: PortalDeviceApplication;
  target: ExposedPortTarget;
}

/** Why an exposed port the Portal lists was left alone by a rehydrate that is not the restore after a pairing. */
export const EXPOSED_PORT_OUTSIDE_RESTORE_REASON = 'Exposed ports are put back only by the restore after pairing';

/** App statuses with an operation still under way. Rehydrate leaves these apps to it, and a restore after pairing waits for them. */
export const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  'installing',
  'uninstalling',
  'stopping',
  'starting',
  'updating',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
]);

export interface RehydrationPlanItem {
  portalApp: PortalDeviceApplication;
  appUrn?: AppUrn;
  action: RehydrationAction;
  reason?: string;
  form?: z.infer<typeof appFormSchema>;
  /** Where an `expose` item puts the port back. */
  exposedPort?: ExposedPortTarget;
  hasExistingData: boolean;
  hasInstalledCompose: boolean;
}

export interface RehydrationPlan {
  items: RehydrationPlanItem[];
  portalAppCount: number;
  localAppDataCount: number;
}

/**
 * Why a restore left an app alone. `already_running` and `busy` are apps that are on the Hub anyway;
 * the rest were not restored.
 */
export type RehydrationSkipCode = 'already_running' | 'busy' | 'unlisted' | 'no_target' | 'refused' | 'failed';

export interface RehydrationSkipped {
  /** The app's name as Companion Portal lists it for the device. */
  name: string;
  /** A message key when the install refused with one (`APP_INSTALL_FORM_ERROR_INVALID`), else plain text. */
  reason: string;
  appUrn?: string;
  code?: RehydrationSkipCode;
  /** The values the message key is written with, such as the `fields` an install form was missing. */
  params?: Record<string, string>;
}

export interface RehydrationStateFile {
  completedAt: string;
  queuedUrns: string[];
  startedUrns: string[];
  skipped: RehydrationSkipped[];
}

/**
 * Whether the restore on record finished at or after `since`, a pairing's `markedAt`, and so ran for
 * that pairing. A record an earlier pairing left finished before it. A date that cannot be read counts
 * as no run.
 */
export function restoreRanSince(run: RehydrationStateFile | null, since: string): boolean {
  return Boolean(run?.completedAt && Date.parse(run.completedAt) >= Date.parse(since));
}

/** Why an app the Portal lists for this device was not restored when no store on this Hub lists it. */
export const UNLISTED_REASON = 'No matching marketplace app found for Portal application';

/**
 * The restore met an app catalog download under way, which may not list every app yet. The download
 * ends on its own, so the restore after pairing asks again at its next pass instead of backing off.
 */
export class CatalogStillDownloadingError extends Error {}

/**
 * How long a restore waits for a catalog download under way to end before it gives up for this pass.
 * The restore page's request waits with it. A tunnel ends a request that has no answer in 100 s.
 */
export const CATALOG_DOWNLOAD_WAIT_MS = 60_000;

/** An app the restore left alone because it is on the Hub already, which is not a failure to restore it. */
export function isKeptAppSkip(entry: RehydrationSkipped): boolean {
  return entry.code === 'already_running' || entry.code === 'busy';
}

const SKIP_CODES: Partial<Record<RehydrationAction, RehydrationSkipCode>> = {
  skip_running: 'already_running',
  skip_busy: 'busy',
  skip_unresolved: 'unlisted',
};

/** The code a plan item that is not acted on is recorded with. */
export function skipCodeForAction(action: RehydrationAction): RehydrationSkipCode {
  return SKIP_CODES[action] ?? 'no_target';
}

/** Walk APP_DATA_DIR for installable app folders with optional data/ or app.env. */
export function scanLocalAppData(appDataDir: string): LocalAppDataEntry[] {
  const entries: LocalAppDataEntry[] = [];

  let storeEntries: fs.Dirent[];
  try {
    storeEntries = fs.readdirSync(appDataDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const storeEntry of storeEntries) {
    if (!storeEntry.isDirectory()) {
      continue;
    }

    const storePath = path.join(appDataDir, storeEntry.name);
    let appEntries: fs.Dirent[];
    try {
      appEntries = fs.readdirSync(storePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const appEntry of appEntries) {
      if (!appEntry.isDirectory()) {
        continue;
      }

      const appPath = path.join(storePath, appEntry.name);
      entries.push({
        storeId: storeEntry.name,
        appName: appEntry.name,
        hasDataDir: fs.existsSync(path.join(appPath, 'data')),
        hasAppEnv: fs.existsSync(path.join(appPath, 'app.env')),
      });
    }
  }

  return entries;
}

export function defaultLocalSubdomain(appName: string, storeSlug: string): string {
  return `${appName}-${storeSlug}`;
}

export function slugMatchesPortalApp(portalSlug: string, appName: string, storeSlug: string): boolean {
  return portalSlug === appName || portalSlug === defaultLocalSubdomain(appName, storeSlug);
}

export function buildRestoreInstallForm(portalApp: PortalDeviceApplication): z.infer<typeof appFormSchema> {
  const useCloudflare = Boolean(portalApp.publicDomain?.trim());

  return {
    localSubdomain: portalApp.slug,
    publicDomain: portalApp.publicDomain?.trim() || undefined,
    exposureMode: useCloudflare ? 'cloudflare' : 'local',
    exposedLocal: useCloudflare,
    openPort: !useCloudflare,
    port: portalApp.port >= 1024 && portalApp.port <= 65535 ? portalApp.port : undefined,
    skipEnv: false,
    skipPull: false,
    skipRun: false,
  };
}

export function resolvePortalAppToUrn(portalApp: PortalDeviceApplication, storeSlugs: string[], localEntries: LocalAppDataEntry[]): AppUrn | null {
  const candidates: Array<{ urn: AppUrn; score: number }> = [];

  for (const storeSlug of storeSlugs) {
    if (!slugMatchesPortalApp(portalApp.slug, portalApp.name, storeSlug)) {
      continue;
    }

    const urn = createAppUrn(portalApp.name, storeSlug);
    const hasData = localEntries.some((entry) => entry.storeId === storeSlug && entry.appName === portalApp.name && entry.hasDataDir);
    candidates.push({ urn, score: hasData ? 2 : 1 });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.urn ?? null;
}

/**
 * Where to put back an app the Portal lists as a port this device exposed, or `null` when it is not one
 * or the Portal's details cannot be trusted to rebuild it (#2131).
 *
 * ⚠ PUBLIC ONLY UNDER A NAME THAT WAS ALREADY PUBLIC. The restore publishes a program on this machine
 * on the Portal's word, so each detail is held to what the Portal route that wrote it can have written.
 * A row the tunnel sync wrote is not pinned and was public. A row the registry wrote is pinned and was
 * This Machine Only or on the Private VPN. Anything else is not an exposed port to the restore. Nor is a
 * row from a Portal that predates these details.
 */
export function exposedPortTarget(portalApp: PortalDeviceApplication): ExposedPortTarget | null {
  if (portalApp.kind !== PORT_EXPOSE_KIND) {
    return null;
  }

  const port = portalApp.upstreamPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return null;
  }

  // The name is the app's id here. `createPortExposeApp` derives the id from it, so a name that derives
  // to something else, or to a reserved route, would come back as a different app.
  if (deriveAppSlug(portalApp.name) !== portalApp.name || RESERVED_APP_NAMES.includes(portalApp.name)) {
    return null;
  }

  const localSubdomain = sanitizeAppSubdomain(portalApp.slug);
  if (!localSubdomain) {
    return null;
  }

  if (portalApp.pinned === false && portalApp.exposureMode === 'cloudflare') {
    const publicDomain = portalApp.publicDomain?.trim();
    return { port, exposureMode: 'cloudflare', localSubdomain, ...(publicDomain ? { publicDomain } : {}) };
  }

  if (portalApp.pinned === true && (portalApp.exposureMode === 'local' || portalApp.exposureMode === 'tailscale')) {
    return { port, exposureMode: portalApp.exposureMode, localSubdomain };
  }

  return null;
}

/**
 * Plan items for the ports the Portal lists as exposed on this device. One this Hub already has is left
 * alone. A missing one is put back only when `restore` says this is the restore after a pairing, the
 * one time the Hub takes the Portal's word for what to publish.
 */
export function planExposedPorts(input: {
  exposed: ReadonlyArray<ExposedPortEntry>;
  dbAppsByUrn: ReadonlyMap<string, { status: string }>;
  restore: boolean;
}): RehydrationPlanItem[] {
  return input.exposed.map(({ portalApp, target }): RehydrationPlanItem => {
    const appUrn = createAppUrn(portalApp.name, EXPOSED_PORT_STORE);
    const dbApp = input.dbAppsByUrn.get(appUrn);
    const item = { portalApp, appUrn, exposedPort: target, hasExistingData: false, hasInstalledCompose: false };

    if (dbApp && IN_FLIGHT_STATUSES.has(dbApp.status)) {
      return { ...item, action: 'skip_busy', reason: `An operation is already in progress for this app (${dbApp.status})` };
    }
    if (dbApp) {
      return { ...item, action: 'skip_running', reason: 'App is already running locally' };
    }
    if (!input.restore) {
      return { ...item, action: 'skip_unresolved', reason: EXPOSED_PORT_OUTSIDE_RESTORE_REASON };
    }
    return { ...item, action: 'expose' };
  });
}

/** Keep only app-data folders that correspond to a Portal-listed app URN. */
export function filterLocalEntriesForPortalUrns(localEntries: LocalAppDataEntry[], portalUrns: Set<string>): LocalAppDataEntry[] {
  return localEntries.filter((entry) => portalUrns.has(createAppUrn(entry.appName, entry.storeId)));
}

export function buildRehydrationPlan(input: {
  portalApps: PortalDeviceApplication[];
  storeSlugs: string[];
  localEntries: LocalAppDataEntry[];
  installedComposeUrns: Set<string>;
  dbAppsByUrn: Map<
    AppUrn,
    {
      status: string;
    }
  >;
}): RehydrationPlan {
  const items: RehydrationPlanItem[] = [];
  const portalUrns = new Set<string>();

  for (const portalApp of input.portalApps) {
    const resolved = resolvePortalAppToUrn(portalApp, input.storeSlugs, input.localEntries);
    if (resolved) {
      portalUrns.add(resolved);
    }
  }

  const scopedLocalEntries = filterLocalEntriesForPortalUrns(input.localEntries, portalUrns);

  for (const portalApp of input.portalApps) {
    const appUrn = resolvePortalAppToUrn(portalApp, input.storeSlugs, scopedLocalEntries);
    const hasExistingData = appUrn
      ? scopedLocalEntries.some((entry) => {
          const [appName, storeId] = appUrn.split(':');
          return entry.storeId === storeId && entry.appName === appName && entry.hasDataDir;
        })
      : false;
    const hasInstalledCompose = appUrn ? input.installedComposeUrns.has(appUrn) : false;

    if (!appUrn) {
      items.push({
        portalApp,
        action: 'skip_unresolved',
        reason: UNLISTED_REASON,
        hasExistingData: false,
        hasInstalledCompose: false,
      });
      continue;
    }

    const dbApp = input.dbAppsByUrn.get(appUrn);
    const form = buildRestoreInstallForm(portalApp);

    if (dbApp?.status === 'running') {
      items.push({
        portalApp,
        appUrn,
        action: 'skip_running',
        reason: 'App is already running locally',
        form,
        hasExistingData,
        hasInstalledCompose,
      });
      continue;
    }

    /*
     * ⚠ A RETRY REACHES APPS THE LAST RUN IS STILL WORKING ON. A rehydrate that hit a grant refusal is
     * not recorded as done, so the restore page's Retry — or a reload — plans again while the first
     * run's installs are still going. `installApp` hands an existing row to `startApp`, which has no
     * in-flight guard, so an app mid-install would be started underneath its own install.
     */
    if (dbApp && IN_FLIGHT_STATUSES.has(dbApp.status)) {
      items.push({
        portalApp,
        appUrn,
        action: 'skip_busy',
        reason: `An operation is already in progress for this app (${dbApp.status})`,
        form,
        hasExistingData,
        hasInstalledCompose,
      });
      continue;
    }

    if (dbApp && dbApp.status === 'stopped' && hasInstalledCompose) {
      items.push({
        portalApp,
        appUrn,
        action: 'start',
        form,
        hasExistingData,
        hasInstalledCompose,
      });
      continue;
    }

    items.push({
      portalApp,
      appUrn,
      action: 'install',
      form,
      hasExistingData,
      hasInstalledCompose,
    });
  }

  return {
    items,
    portalAppCount: input.portalApps.length,
    localAppDataCount: scopedLocalEntries.filter((entry) => entry.hasDataDir || entry.hasAppEnv).length,
  };
}
