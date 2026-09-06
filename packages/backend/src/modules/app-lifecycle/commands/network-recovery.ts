import { isAbortError, throwIfAborted } from '@/common/abort';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DockerService } from '@/modules/docker/docker.service';
import { cidrOverlaps } from '@/modules/network/cidr-overlap';
import { isDockerNetworkOverlapError } from '@/modules/network/docker-network-errors';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import { translateDockerNetworkOverlapError } from './app-lifecycle-errors';

/**
 * Compose regeneration and network cleanup are passed in as bound callbacks rather than imported
 * directly, so a subclass override or a `vi.spyOn(command, 'ensureAppDir')` in a test still wins.
 * Importing them here would silently bypass instance-level dispatch.
 */
export interface ComposeRecoveryDeps {
  moduleRef: ModuleRef;
  ensureAppDir: (appUrn: AppUrn, form: AppEventFormInput, options?: { excludeSubnets?: string[] }) => Promise<void>;
  removeStaleAppNetworks: (appUrn: AppUrn) => Promise<void>;
}

export async function removeAppProjectNetworks(moduleRef: ModuleRef, appUrn: AppUrn): Promise<void> {
  const dockerService = moduleRef.get(DockerService, { strict: false });
  await dockerService?.removeAppNetworks(appUrn);
}

/**
 * Run compose for an app, removing stale project networks first and retrying
 * with a fresh subnet when Docker reports overlapping bridge ranges.
 *
 * When a `signal` is supplied, an abort kills the underlying `docker compose` process and is
 * re-thrown immediately so a cancellation is never misclassified as a retryable network overlap.
 */
export async function runComposeWithNetworkRecovery(
  deps: ComposeRecoveryDeps,
  appUrn: AppUrn,
  form: AppEventFormInput,
  command: string,
  maxAttempts = 3,
  signal?: AbortSignal,
): Promise<void> {
  const { moduleRef } = deps;
  const dockerService = moduleRef.get(DockerService, { strict: false });
  const subnetManager = moduleRef.get(SubnetManagerService, { strict: false });
  const logger = moduleRef.get(LoggerService, { strict: false });

  if (!dockerService) {
    throw new Error('DockerService unavailable');
  }

  let lastError: unknown;
  const failedSubnets: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);
    await deps.removeStaleAppNetworks(appUrn);

    try {
      await dockerService.composeApp(appUrn, command, signal);
      return;
    } catch (error) {
      // A cancellation must propagate immediately, not be treated as a network-overlap retry.
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error;
      const canRetry = isDockerNetworkOverlapError(error) && attempt < maxAttempts;
      if (!canRetry) {
        if (isDockerNetworkOverlapError(error)) {
          const overlapError = translateDockerNetworkOverlapError(error, await describeNetworkOverlap(moduleRef, appUrn));
          if (overlapError) {
            throw overlapError;
          }
        }
        throw error;
      }

      logger.warn(`Docker network overlap for ${appUrn} on attempt ${attempt}/${maxAttempts}; releasing subnet and regenerating compose`);
      const appsRepository = moduleRef.get(AppsRepository, { strict: false });
      const app = appsRepository ? await appsRepository.getAppByUrn(appUrn).catch(() => null) : null;
      if (app?.subnet) {
        failedSubnets.push(app.subnet);
      }
      await subnetManager?.releaseSubnet(appUrn);
      await deps.ensureAppDir(appUrn, form, { excludeSubnets: failedSubnets });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function describeNetworkOverlap(moduleRef: ModuleRef, appUrn: AppUrn): Promise<string[]> {
  const subnetManager = moduleRef.get(SubnetManagerService, { strict: false });
  if (!subnetManager) {
    return [];
  }

  const occupied = await subnetManager.listOccupiedSubnets(appUrn);
  const appsRepository = moduleRef.get(AppsRepository, { strict: false });
  const app = appsRepository ? await appsRepository.getAppByUrn(appUrn).catch(() => null) : null;
  const candidateSubnet = app?.subnet;
  if (!candidateSubnet) {
    return occupied.map((entry) => entry.cidr);
  }

  return occupied.filter((entry) => cidrOverlaps(candidateSubnet, entry.cidr)).map((entry) => entry.cidr);
}
