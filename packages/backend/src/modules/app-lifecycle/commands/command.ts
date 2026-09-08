import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import Dockerode from 'dockerode';
import type { AppCommandFailureResult } from './app-lifecycle-errors';
import type { OperationPhase } from '../app-operation-registry';
import { prepareAppComposeDir } from './compose-preparation';
import { reportAndTranslateAppError } from './failure-reporting';
import { assertHostDevicesAvailable } from './host-device-preflight';
import { removeAppProjectNetworks, runComposeWithNetworkRecovery } from './network-recovery';

/**
 * Optional cancellation context threaded into a command's `execute()`.
 * Commands that support cancellation observe `signal` (passed down to killable docker spawns/pulls)
 * and report progress via `setPhase` so the cancel endpoint can decide whether an abort is still safe.
 */
export interface CommandExecutionContext {
  /** Aborted when the user cancels the operation. */
  signal: AbortSignal;
  /** Report the current execution phase to the operation registry. */
  setPhase(phase: OperationPhase): void;
  /** Durable lifecycle job ID if tracked. */
  jobId?: string;
  /** Report progress percentage to durable job tracking. */
  updateProgress?(percent: number): Promise<void>;
}

/**
 * Shared shape for a lifecycle command. `execute` accepts an optional {@link CommandExecutionContext}
 * as its last argument; commands that don't support cancellation simply ignore it.
 */
export interface LifecycleCommand {
  execute(appUrn: AppUrn, form: AppEventFormInput, ctx?: CommandExecutionContext): Promise<unknown>;
}

/**
 * Base class the ten lifecycle commands extend.
 *
 * The bodies of these members live in sibling modules so each can be read and tested on its own;
 * what stays here are thin wrappers. They are not ceremony: subclasses call them as `this.<name>()`
 * and tests install instance spies over them (`vi.spyOn(command, 'ensureAppDir')`), so the methods
 * have to remain on the prototype for that dispatch to work.
 */
export class AppLifecycleCommand {
  constructor(
    protected moduleRef: ModuleRef,
    protected docker: Dockerode,
  ) {}

  protected async assertMarketplaceEntitlement(appUrn: AppUrn, mode: 'install' | 'start' | 'update'): Promise<void> {
    const entitlements = this.moduleRef.get(MarketplaceEntitlementService, { strict: false });
    if (!entitlements) {
      return;
    }
    if (mode === 'start') {
      await entitlements.assertForStart(appUrn);
      return;
    }
    if (mode === 'update') {
      await entitlements.assertForUpdate(appUrn);
      return;
    }
    await entitlements.assertForInstall(appUrn);
  }

  protected async ensureAppDir(appUrn: AppUrn, form: AppEventFormInput, options?: { excludeSubnets?: string[] }): Promise<void> {
    return prepareAppComposeDir(this.moduleRef, this.docker, appUrn, form, options);
  }

  protected async assertRequiredHostDevices(appUrn: AppUrn): Promise<void> {
    return assertHostDevicesAvailable(this.moduleRef, appUrn);
  }

  protected async removeStaleAppNetworks(appUrn: AppUrn): Promise<void> {
    return removeAppProjectNetworks(this.moduleRef, appUrn);
  }

  protected async composeAppWithNetworkRecovery(
    appUrn: AppUrn,
    form: AppEventFormInput,
    command: string,
    maxAttempts = 3,
    signal?: AbortSignal,
  ): Promise<void> {
    // Bound to `this` so a subclass override or an instance spy still wins over the base method.
    const deps = {
      moduleRef: this.moduleRef,
      ensureAppDir: (urn: AppUrn, f: AppEventFormInput, options?: { excludeSubnets?: string[] }) => this.ensureAppDir(urn, f, options),
      removeStaleAppNetworks: (urn: AppUrn) => this.removeStaleAppNetworks(urn),
    };
    return runComposeWithNetworkRecovery(deps, appUrn, form, command, maxAttempts, signal);
  }

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<AppCommandFailureResult> => {
    return reportAndTranslateAppError(this.moduleRef, err, appId, event);
  };
}
