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
import { buildPublicWebIdentity, resolvePublicDomainRoot } from '@ci-hub/common/types';

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

      const envMismatch = envHostname !== identity.hostname;

      entries.push({
        appUrn,
        appName: app.appName,
        status: app.status,
        dbPublicDomain: app.publicDomain,
        dbLocalSubdomain: app.localSubdomain,
        computedHostname: identity.hostname,
        computedPublicUrl: identity.publicUrl,
        envHostname,
        envMismatch,
        action: envMismatch ? 'repair' : 'ok',
      });
    }

    return {
      apps: entries,
      mismatchCount: entries.filter((entry) => entry.envMismatch).length,
    };
  }

  public async repair(request: PublicWebRepairRequest = {}): Promise<PublicWebRepairResponse> {
    const diagnostics = await this.getDiagnostics();
    const targetUrns = new Set(request.appUrns ?? []);
    const toRepair = diagnostics.apps.filter((entry) => {
      if (targetUrns.size > 0 && !targetUrns.has(entry.appUrn)) {
        return false;
      }
      return entry.envMismatch;
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
