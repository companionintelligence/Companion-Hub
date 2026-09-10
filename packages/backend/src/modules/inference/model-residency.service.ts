import { LoggerService } from '@/core/logger/logger.service';
import type { BackendResidency, InferenceBackendType, ResidencyReport } from '@ci-hub/common/types';
import { Injectable } from '@nestjs/common';

import type { InferenceBackend } from './backends/backend.interface';
import { InferenceBackendRegistry } from './backends/backend-registry';

/**
 * What is actually in memory across every inference backend on this node.
 *
 * This service exists because nothing else in the product could answer the question. Every
 * surface that looked like it could — `BackendHealthStatus.modelsLoaded`,
 * `BackendModelInfo.loaded`, `GET /api/inference/models/runtime` — reports the on-disk
 * inventory under a residency-sounding name. Measured on a live fleet node, those said 11
 * models while the engine's own `/api/ps` said zero were resident.
 *
 * The rule this service is built around: a backend that cannot answer says so. `models: null`
 * with a `source` explaining why is always preferred to an empty array, because "nothing is
 * loaded" is a fact about the machine and "this engine has no such concept" is a fact about
 * the software, and an operator acts differently on each.
 */
@Injectable()
export class ModelResidencyService {
  constructor(
    private readonly backends: InferenceBackendRegistry,
    private readonly logger: LoggerService,
  ) {}

  async getReport(sampledAt: string): Promise<ResidencyReport> {
    const entries = await Promise.all(this.backends.entries().map(([, backend]) => this.forBackend(backend)));

    // Summed only over backends that actually reported a number. If none did, the total is
    // null rather than 0 — a dashboard must be able to render "not measured" here, and a
    // zero would claim the GPUs are empty.
    const reported = entries.flatMap((entry) => entry.models ?? []).map((model) => model.vramBytes);
    const measured = reported.filter((bytes): bytes is number => typeof bytes === 'number');

    return {
      backends: entries,
      totalVramBytes: measured.length > 0 ? measured.reduce((sum, bytes) => sum + bytes, 0) : null,
      residentCount: entries.reduce((count, entry) => count + (entry.models?.length ?? 0), 0),
      sampledAt,
    };
  }

  private async forBackend(backend: InferenceBackend): Promise<BackendResidency> {
    if (!backend.listResident) {
      return { backend: backend.type, source: 'unsupported', models: null };
    }

    try {
      return await backend.listResident();
    } catch (err) {
      // A throwing backend must not take the whole report down with it — the other engines'
      // answers are still true, and a node with one broken engine is exactly when someone is
      // reading this page.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.debug(`[Residency] ${backend.type} failed to report residency: ${message}`);

      return { backend: backend.type, source: 'unreachable', models: null, error: message };
    }
  }

  /** Backends whose residency this node can actually establish, for callers that need to know first. */
  supportedBackends(): InferenceBackendType[] {
    return this.backends
      .entries()
      .filter(([, backend]) => typeof backend.listResident === 'function')
      .map(([type]) => type);
  }
}
