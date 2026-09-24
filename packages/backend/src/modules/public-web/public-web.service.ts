import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { EnvUtils } from '@/modules/env/env.utils';
import { RegistrationService } from '@/modules/registration/registration.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildPublicWebIdentity, normalizeStoredHostname, resolvePublicDomainRoot } from '@ci-hub/common/types';

export interface PublicWebDiagnosticEntry {
  appUrn: AppUrn;
  appName: string;
  status: string;
  dbPublicDomain: string | null;
  dbLocalSubdomain: string | null;
  computedHostname: string;
  computedPublicUrl: string;
  envHostname: string | null;
  envMismatch: boolean;
  action: 'ok' | 'repair';
  /** Custom hostname Companion Portal has wired for this app, when it has one. */
  customDomain: string | null;
  /**
   * The app is already flagged for a restart that will regenerate this env, so
   * an `envMismatch` here is a scheduled change rather than drift.
   */
  pendingRestart: boolean;
  /**
   * THE ONE STATE A CUSTOMER CAN SEE AND NOBODY IS TOLD ABOUT: a custom domain is
   * bound, and this app is still answering on its platform hostname. Their domain
   * is dark until someone restarts the app.
   *
   * Narrower than `pendingRestart`, which any settings change raises. A surface
   * that promises "your domain will not serve" must key on this, or it makes that
   * claim every time an unrelated setting is saved and stops being read.
   */
  awaitingCustomDomainRestart: boolean;
}

export interface PublicWebDiagnosticsResponse {
  apps: PublicWebDiagnosticEntry[];
  mismatchCount: number;
}

export interface PublicWebRepairRequest {
  appUrns?: AppUrn[];
}

export interface PublicWebRepairResult {
  appUrn: AppUrn;
  success: boolean;
  message?: string;
  repairedHostname?: string;
}

export interface PublicWebRepairResponse {
  results: PublicWebRepairResult[];
  synced: boolean;
}

@Injectable()
export class PublicWebService {
  constructor(
    private readonly appsRepository: AppsRepository,
    private readonly appFilesManager: AppFilesManager,
    private readonly appHelpers: AppHelpers,
    private readonly appLifecycleService: AppLifecycleService,
    private readonly registrationService: RegistrationService,
    private readonly config: ConfigurationService,
    private readonly envUtils: EnvUtils,
    private readonly logger: LoggerService,
  ) {}

  public async getDiagnostics(): Promise<PublicWebDiagnosticsResponse> {
    const org = await this.registrationService.getDeviceRegistrationInfo();
    const apps = await this.appsRepository.getApps();
    const entries: PublicWebDiagnosticEntry[] = [];

    for (const app of apps) {
      const exposureMode = app.exposureMode || (app.exposedLocal ? 'cloudflare' : 'local');
      if (exposureMode !== 'cloudflare' || app.openPort) {
        continue;
      }

      const appUrn = createAppUrn(app.appName, app.appStoreSlug);
      let envHostname: string | null = null;
      let envMap = new Map<string, string>();
      try {
        const appEnv = await this.appFilesManager.getAppEnv(appUrn);
        envMap = this.envUtils.envStringToMap(appEnv.content || '');
        envHostname = envMap.get('APP_PUBLIC_HOSTNAME') || null;
      } catch {
        envHostname = null;
      }

      const identity = this.buildIdentityForApp({
        appSubdomain: app.localSubdomain || `${app.appName}-${app.appStoreSlug}`,
        publicDomain: app.publicDomain,
        hubSubdomain: org?.hubSubdomain,
        orgSlug: org?.slug,
        envDomain: envMap.get('APP_PUBLIC_DOMAIN') || envMap.get('DOMAIN'),
      });

      /*
       * A bound custom domain is what `generateEnvFile` will emit, so it is what
       * "correct" means here. Comparing against the platform hostname instead
       * would report every app on a custom domain as permanently broken and have
       * repair rewrite the very value the sync just set — the two would fight,
       * and the app would flip hostname on every repair.
       */
      const customDomain = normalizeStoredHostname(app.customDomain);
      const expectedHostname = customDomain ?? identity.hostname;
      const expectedPublicUrl = customDomain ? `https://${customDomain}` : identity.publicUrl;

      const envMismatch = envHostname !== expectedHostname;

      /*
       * A binding that has landed on the row but not yet in the env is the state
       * this feature DESIGNS for: on a FIRST bind the sync does not recreate a
       * running container, it raises `pendingRestart` and lets the user choose
       * when. Calling that "repair" would report a healthy, freshly bound app as
       * broken — and `repair()` with no `appUrns` restarts everything it finds,
       * so an operator running the CLI's suggested repair would restart apps they
       * never selected, for a change already scheduled.
       *
       * The mismatch is still reported (it is real, and it is what the badge is
       * about); only the verdict waits for the restart the user was asked for.
       *
       * This suppression is deliberately narrowed to that one window. `pendingRestart` is raised for
       * ANY settings change (`updateAppConfig`), and it survives when the app is
       * not running to be auto-restarted. Suppressing on the flag alone would
       * hide genuine hostname drift on any app that happens to carry it — the
       * count would read clean and `repair()` with no `appUrns` would skip the
       * app entirely, leaving an operator with a mismatch the CLI reports and
       * offers no way to fix. So the verdict only waits when the env is still on
       * the platform hostname and a custom domain is what it is waiting for,
       * which is exactly the state the bind deliberately leaves behind.
       *
       * The unbind window is deliberately NOT suppressed: once the binding is
       * gone the env holds a hostname that is indistinguishable from ordinary
       * drift, and repairing it is the right answer anyway — it regenerates the
       * platform identity and restarts, which is the pending restart itself.
       *
       * The reconcile now usually gets there first, restarting the app itself
       * when it loses a bound hostname (CI-Hub#1207). Reporting `repair` during
       * that window is still correct: it is the same verdict for the same real
       * drift, `repair()` restarts only apps whose env is still wrong, and the
       * reconcile declines in cases this cannot see — an identity move, a
       * hostname the Hub is still asking for, a dispatch that failed.
       */
      const awaitingScheduledRestart = envMismatch && app.pendingRestart && customDomain !== null && envHostname === identity.hostname;
      const action: PublicWebDiagnosticEntry['action'] = envMismatch && !awaitingScheduledRestart ? 'repair' : 'ok';

      entries.push({
        appUrn,
        appName: app.appName,
        status: app.status,
        dbPublicDomain: app.publicDomain,
        dbLocalSubdomain: app.localSubdomain,
        computedHostname: expectedHostname,
        computedPublicUrl: expectedPublicUrl,
        envHostname,
        envMismatch,
        action,
        customDomain,
        pendingRestart: app.pendingRestart,
        awaitingCustomDomainRestart: awaitingScheduledRestart,
      });
    }

    return {
      apps: entries,
      mismatchCount: entries.filter((entry) => entry.action === 'repair').length,
    };
  }

  /**
   * @param authorize Resolves which of `appUrns` this run may touch, BEFORE any of
   *   them is touched, so a refusal cannot leave half the fleet already repaired
   *   behind a 403. `named` says whether the caller chose the apps: a named set is
   *   all-or-nothing (silently skipping an app the operator asked for would be a
   *   lie), while an unnamed sweep is filtered to what the caller may act on, so one
   *   ungranted app cannot put the whole remedy out of reach.
   */
  public async repair(
    request: PublicWebRepairRequest = {},
    authorize?: (appUrns: AppUrn[], named: boolean) => Promise<AppUrn[]>,
  ): Promise<PublicWebRepairResponse> {
    const diagnostics = await this.getDiagnostics();
    const targetUrns = new Set(request.appUrns ?? []);
    const named = targetUrns.size > 0;
    const candidates = diagnostics.apps.filter((entry) => {
      if (named) {
        // Explicitly named: repair it even if it is only awaiting its scheduled
        // restart — the operator asked for this app by name.
        return targetUrns.has(entry.appUrn) && entry.envMismatch;
      }
      return entry.action === 'repair';
    });

    let toRepair = candidates;
    if (authorize) {
      /*
       * Named apps are authorized even when they are not currently drifted. Checking
       * only the drifted ones would let a caller with no grant on an app probe its
       * drift state — 403 when it is drifted, 200 when it is not — and would silently
       * accept a request the operator was never entitled to make.
       */
      const permitted = new Set(await authorize(named ? [...targetUrns] : candidates.map((entry) => entry.appUrn), named));
      toRepair = candidates.filter((entry) => permitted.has(entry.appUrn));
    }

    const results: PublicWebRepairResult[] = [];

    for (const entry of toRepair) {
      try {
        const app = await this.appsRepository.getAppByUrn(entry.appUrn);
        if (!app) {
          results.push({ appUrn: entry.appUrn, success: false, message: 'App not found' });
          continue;
        }

        const form = {
          ...app.config,
          exposedLocal: app.exposedLocal,
          exposureMode: (app.exposureMode || 'cloudflare') as 'local' | 'cloudflare' | 'tailscale',
          openPort: app.openPort,
          localSubdomain: app.localSubdomain ?? undefined,
          publicDomain: app.publicDomain ?? undefined,
          enableAuth: app.enableAuth,
          port: app.port ?? undefined,
        };

        await this.appHelpers.generateEnvFile(entry.appUrn, form);

        const appEnv = await this.appFilesManager.getAppEnv(entry.appUrn);
        const envMap = this.envUtils.envStringToMap(appEnv.content || '');
        envMap.delete('APP_PUBLIC_DOMAIN');
        await this.appFilesManager.writeAppEnv(entry.appUrn, this.envUtils.envMapToString(envMap));

        /*
         * `restartAppAndWait`, not `restartApp`: the env rewrite above only reaches the
         * running container through the restart, so reporting success the moment the
         * restart is *queued* tells the operator a repair landed that may still fail —
         * and the UI clears its drift banner on that word while the app serves the old
         * hostname, or is left stopped.
         */
        if (['running', 'starting', 'restarting'].includes(app.status)) {
          const restarted = await this.appLifecycleService.restartAppAndWait({ appUrn: entry.appUrn, skipPull: true });
          if (!restarted) {
            results.push({ appUrn: entry.appUrn, success: false, message: 'Routing was rewritten but the app failed to restart' });
            continue;
          }
        }

        results.push({
          appUrn: entry.appUrn,
          success: true,
          repairedHostname: entry.computedHostname,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[PublicWeb] Repair failed for ${entry.appUrn}: ${message}`);
        results.push({ appUrn: entry.appUrn, success: false, message });
      }
    }

    let synced = false;
    const restarted = results.filter((result) => result.success).map((result) => result.appUrn);
    if (restarted.length > 0) {
      /*
       * `skipAutoRestartAppUrns` for what this run just restarted. The reconcile
       * recreates an app that lost its bound hostname (CI-Hub#1220), and a repair is
       * the same caller shape that option exists for: it has already rewritten the env
       * and restarted the app, so letting the reconcile dispatch its own restart on the
       * way out would recreate the container twice for one repair.
       */
      await this.appLifecycleService.triggerCloudflareSync({ skipAutoRestartAppUrns: restarted });
      synced = true;
    }

    return { results, synced };
  }

  public buildIdentityForApp(params: {
    appSubdomain: string;
    publicDomain?: string | null;
    hubSubdomain?: string | null;
    orgSlug?: string | null;
    selectedPublicDomain?: string | null;
    envDomain?: string | null;
  }) {
    const configDomain = this.config.getConfig().domain;
    const publicDomainRoot = resolvePublicDomainRoot({
      selectedPublicDomain: params.selectedPublicDomain ?? params.publicDomain,
      envDomain: params.envDomain,
      configDomain,
    });

    return buildPublicWebIdentity({
      appSubdomain: params.appSubdomain,
      hubSubdomain: params.hubSubdomain,
      orgSlug: params.orgSlug,
      publicDomainRoot,
    });
  }
}
