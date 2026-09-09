import path from 'node:path';
import fs from 'node:fs/promises';
import { Injectable, Optional } from '@nestjs/common';

import { DATA_DIR } from '@/common/constants';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import type { InferenceStatus } from '@ci-hub/common/types';
import { AppsReadService } from '../apps/apps-read.service';
import { HardwareInspectorService } from '../inference/hardware-inspector.service';
import { HubPoolIdentityService } from '../hub-pool/hub-pool-identity.service';
import { InferenceRouterService } from '../inference/inference-router.service';
import { RegistrationService } from '../registration/registration.service';
import { SystemInspectorService } from '../system/system-inspector.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { renderHubStatusMarkdown } from './status-report.render';
import type { HubStatusReport, StatusBackend, StatusModel, StatusSystem, StatusWorkload } from './status-report.types';

/** Where the file lands. `state/` is already bind-mounted to the host, so this needs no new mount. */
export const STATUS_REPORT_FILENAME = 'CI_HUB_STATUS.md';

export function statusReportPath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'state', STATUS_REPORT_FILENAME);
}

/**
 * Writes `CI_HUB_STATUS.md` — the operator-facing inventory of what this node is
 * running, for auditing a fleet without opening a dashboard per box.
 *
 * It lives in the backend rather than in `cihub` for one reason: every service
 * that knows the answers is in this process. The CLI holds no credential for the
 * guarded routes (`pool/status`, `apps/installed`, `system-inspector` are all
 * behind `AuthGuard`), so a CLI-side composer would mean provisioning an API key
 * on every node just to audit it.
 *
 * **Each source is isolated.** A dead inference backend or an unreachable Docker
 * socket degrades its own section and is named in `problems`; it never costs the
 * whole file. A report that silently omitted the section it failed to read would
 * be indistinguishable from one where that section is genuinely empty.
 */
@Injectable()
export class StatusReportService {
  constructor(
    private readonly logger: LoggerService,
    private readonly apps: AppsReadService,
    private readonly hardware: HardwareInspectorService,
    @Optional() private readonly poolIdentity: HubPoolIdentityService | undefined,
    private readonly inference: InferenceRouterService,
    private readonly registration: RegistrationService,
    private readonly systemInspector: SystemInspectorService,
    private readonly tailscale: TailscaleService,
  ) {}

  /** Run one source, returning `null` and recording why rather than throwing. */
  private async section<T>(name: string, problems: string[], read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${name}: ${message}`);
      this.logger.warn(`Status report could not read ${name}: ${message}`);
      return null;
    }
  }

  async buildReport(now: Date = new Date()): Promise<HubStatusReport> {
    const problems: string[] = [];

    const [connection, system, inference, workloads] = await Promise.all([
      this.section('connection', problems, () => this.readConnection()),
      this.section('system', problems, () => this.readSystem()),
      this.section('inference', problems, () => this.readInference()),
      this.section('workloads', problems, () => this.readWorkloads()),
    ]);

    return {
      generatedAt: now.toISOString(),
      hubVersion: process.env.TIPI_VERSION ?? process.env.CI_HUB_VERSION ?? null,
      connection,
      system,
      backends: inference?.backends ?? null,
      models: inference?.models ?? null,
      workloads,
      problems,
    };
  }

  /** Render and write. Returns the path written, so a caller can report it. */
  async writeReport(targetPath: string = statusReportPath()): Promise<string> {
    const report = await this.buildReport();
    const markdown = renderHubStatusMarkdown(report);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Write-then-rename: a reader (or the host-side copy) must never observe a
    // half-written file, and this one is read by a timer on a cadence of its own.
    const temporary = `${targetPath}.tmp`;
    await fs.writeFile(temporary, markdown, 'utf8');
    await fs.rename(temporary, targetPath);

    return targetPath;
  }

  private async readConnection() {
    const [registrationStatus, registrationInfo, deviceId, tailscaleStatus, poolIdentity] = await Promise.all([
      this.registration.getLiveRegistrationStatus().catch(() => null),
      this.registration.getDeviceRegistrationInfo().catch(() => null),
      this.registration.getDeviceId().catch(() => null),
      this.tailscale.getStatusCached().catch(() => null),
      // Absent on a build without pooling, and on one that has never minted an
      // identity. Either way the row reads as unknown rather than as "no pool".
      this.poolIdentity?.summary().catch(() => null) ?? Promise.resolve(null),
    ]);

    const apiPort = Number(process.env.API_PORT ?? process.env.BACKEND_PORT ?? '');

    return {
      hostname: process.env.HOSTNAME ?? null,
      deviceId,
      registered: Boolean(registrationStatus?.registered ?? registrationInfo?.id),
      organization: registrationInfo?.name ?? registrationInfo?.slug ?? null,
      apiPort: Number.isFinite(apiPort) && apiPort > 0 ? apiPort : null,
      publicHostname: registrationInfo?.hubSubdomain ?? null,
      tailscale: tailscaleStatus
        ? {
            connected: Boolean(tailscaleStatus.connected),
            nodeFqdn: tailscaleStatus.nodeFqdn ?? null,
            tailnet: tailscaleStatus.tailnet ?? null,
          }
        : null,
      poolNodeUuid: poolIdentity?.nodeUuid ?? null,
    };
  }

  private async readSystem(): Promise<StatusSystem> {
    const [health, profile] = await Promise.all([this.systemInspector.getSystemHealth(), this.hardware.getProfile().catch(() => null)]);

    return {
      platform: health.platform ?? null,
      uptimeSeconds: typeof health.uptime === 'number' ? health.uptime : null,
      cpu: health.cpu ? { model: health.cpu.model ?? null, cores: health.cpu.cores ?? null, loadPercent: health.cpu.load ?? null } : null,
      memory: health.memory ? { totalBytes: health.memory.total, usedBytes: health.memory.used, percent: health.memory.percent } : null,
      disk: health.disk
        ? { totalBytes: health.disk.total, usedBytes: health.disk.used, freeBytes: health.disk.free, percent: health.disk.percent }
        : null,
      dockerVersion: health.dockerVersion ?? null,
      containerCount: health.containerCount ?? null,
      gpu: profile?.gpu?.available
        ? {
            vendor: profile.gpu.vendor ?? null,
            model: profile.gpu.model ?? null,
            vramMb: profile.gpu.vramMb ?? null,
            // A card that is present with a broken driver is a finding, not an absence.
            driverWorking: profile.gpu.runtimeAvailable !== false,
          }
        : null,
      hardwareTier: profile?.tier ?? null,
    };
  }

  private async readInference(): Promise<{ backends: StatusBackend[]; models: StatusModel[] }> {
    const status: InferenceStatus = await this.inference.getStatus();
    const unservable = new Set(status.backends.flatMap((backend) => backend.unservableModels ?? []));

    const backends: StatusBackend[] = status.backends.map((backend) => ({
      type: backend.type,
      running: backend.running,
      healthy: backend.healthy,
      url: backend.url || null,
      modelsLoaded: typeof backend.modelsLoaded === 'number' ? backend.modelsLoaded : null,
    }));

    const models: StatusModel[] = status.models
      // Cloud models are not installed on this box, and this file is an inventory
      // of this box.
      .filter((model) => model.local)
      .map((model) => ({
        name: model.id,
        backend: model.backend ?? null,
        sizeBytes: null,
        unservable: unservable.has(model.id),
      }));

    return { backends, models };
  }

  private async readWorkloads(): Promise<StatusWorkload[]> {
    const [installed, containers] = await Promise.all([this.apps.getInstalledApps(), this.systemInspector.getContainers()]);

    const byUrn = new Map<string, typeof containers>();
    for (const container of containers) {
      if (!container.appUrn) continue;
      const list = byUrn.get(container.appUrn) ?? [];
      list.push(container);
      byUrn.set(container.appUrn, list);
    }

    return installed.map((entry) => {
      // The URN is derived, not a column — `app.id` is the numeric primary key and
      // is not what a container is labelled with.
      const urn = entry.app ? createAppUrn(entry.app.appName, entry.app.appStoreSlug) : null;
      const own = urn ? (byUrn.get(urn) ?? []) : [];

      return {
        name: entry.info?.name ?? entry.app?.appName ?? 'unknown',
        urn,
        desiredStatus: entry.app?.status ?? null,
        containers: own.map((container) => ({
          name: container.name,
          state: container.state,
          status: container.status,
          ports: container.ports,
        })),
      };
    });
  }
}
