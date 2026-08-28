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
  /** Custom hostname CI-Cloud has wired for this app, when it has one. */
  customDomain: string | null;
  /**
   * The app is already flagged for a restart that will regenerate this env, so
   * an `envMismatch` here is a scheduled change rather than drift.
   */
  pendingRestart: boolean;
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
       * this feature DESIGNS for: the sync deliberately does not recreate a
       * running container, it raises `pendingRestart` and lets the user choose
       * when. Calling that "repair" would report a healthy, freshly bound app as
       * broken — and `repair()` with no `appUrns` restarts everything it finds,
       * so an operator running the CLI's suggested repair would restart apps they
       * never selected, for a change already scheduled.
       *
       * The mismatch is still reported (it is real, and it is what the badge is
       * about); only the verdict waits for the restart the user was asked for.
       *
       * ⚠ NARROWED TO THAT ONE WINDOW ON PURPOSE. `pendingRestart` is raised for
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
      });
    }

    return {
      apps: entries,
      mismatchCount: entries.filter((entry) => entry.action === 'repair').length,
    };
  }

  public async repair(request: PublicWebRepairRequest = {}): Promise<PublicWebRepairResponse> {
    const diagnostics = await this.getDiagnostics();
    const targetUrns = new Set(request.appUrns ?? []);
    const toRepair = diagnostics.apps.filter((entry) => {
      if (targetUrns.size > 0) {
        // Explicitly named: repair it even if it is only awaiting its scheduled
        // restart — the operator asked for this app by name.
        return targetUrns.has(entry.appUrn) && entry.envMismatch;
      }
      return entry.action === 'repair';
    });

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

        if (['running', 'starting', 'restarting'].includes(app.status)) {
          await this.appLifecycleService.restartApp({ appUrn: entry.appUrn, skipPull: true });
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
    if (results.some((result) => result.success)) {
      await this.appLifecycleService.triggerCloudflareSync();
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
