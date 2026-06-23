import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import type { AppUrn } from '@ci-hub/common/types';
import type { z } from 'zod';
import type { appFormSchema } from './dto/app-lifecycle.dto';

export interface PortalDeviceApplication {
  id: string;
  name: string;
  slug: string;
  port: number;
  publicDomain: string | null;
}

export interface LocalAppDataEntry {
  storeId: string;
  appName: string;
  hasDataDir: boolean;
  hasAppEnv: boolean;
}

export type RehydrationAction = 'install' | 'start' | 'skip_running' | 'skip_unresolved';

export interface RehydrationPlanItem {
  portalApp: PortalDeviceApplication;
  appUrn?: AppUrn;
  action: RehydrationAction;
  reason?: string;
  form?: z.infer<typeof appFormSchema>;
  hasExistingData: boolean;
  hasInstalledCompose: boolean;
}

export interface RehydrationPlan {
  items: RehydrationPlanItem[];
  portalAppCount: number;
  localAppDataCount: number;
}

export interface RehydrationStateFile {
  completedAt: string;
  queuedUrns: string[];
  startedUrns: string[];
  skipped: Array<{ name: string; reason: string }>;
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
    for (const storeSlug of storeSlugs) {
      if (localEntries.some((entry) => entry.storeId === storeSlug && entry.appName === portalApp.name && entry.hasDataDir)) {
        candidates.push({ urn: createAppUrn(portalApp.name, storeSlug), score: 3 });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.urn ?? null;
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

  for (const portalApp of input.portalApps) {
    const appUrn = resolvePortalAppToUrn(portalApp, input.storeSlugs, input.localEntries);
    const hasExistingData = appUrn
      ? input.localEntries.some((entry) => {
          const [appName, storeId] = appUrn.split(':');
          return entry.storeId === storeId && entry.appName === appName && entry.hasDataDir;
        })
      : false;
    const hasInstalledCompose = appUrn ? input.installedComposeUrns.has(appUrn) : false;

    if (!appUrn) {
      items.push({
        portalApp,
        action: 'skip_unresolved',
        reason: 'No matching marketplace app found for Portal application',
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
    localAppDataCount: input.localEntries.filter((entry) => entry.hasDataDir || entry.hasAppEnv).length,
  };
}
