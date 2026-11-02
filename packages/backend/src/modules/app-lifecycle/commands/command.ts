import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { DockerService } from '@/modules/docker/docker.service';
import type { PortAllocation } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import Dockerode from 'dockerode';
import { type AppCommandFailureResult, AppLifecycleError } from './app-lifecycle-errors';
import type { OperationPhase } from '../app-operation-registry';
import { prepareAppComposeDir } from './compose-preparation';
import { reportAndTranslateAppError } from './failure-reporting';
import { assertHostDevicesAvailable } from './host-device-preflight';
import { moveMainPortOffHostConflict, writeMainHostPort } from './main-host-port';
import { type ComposeRecoveryDeps, removeAppProjectNetworks, runComposeWithNetworkRecovery } from './network-recovery';
import { recordComposeUpPulls } from './pull-app-images';

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
  /**
   * The one time limit for the whole command, counted from when it was queued
   * (`AppCommandDeadline.untilReply`). A long command fits every step inside it, the root helpers
   * of a backup or restore included.
   */
  deadline?: AppCommandDeadline;
}

/**
 * Shared shape for a lifecycle command. `execute` accepts an optional {@link CommandExecutionContext}
 * as its last argument; commands that don't support cancellation simply ignore it.
 */
export interface LifecycleCommand {
  execute(appUrn: AppUrn, form: AppEventFormInput, ctx?: CommandExecutionContext): Promise<unknown>;
  /**
   * Tidying up the command left for after its reply has been sent (an update's snapshot it no longer
   * needs). It must not delay the reply; the worker does not wait for it.
   */
  afterReply?(): Promise<void>;
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
    recovery?: Pick<ComposeRecoveryDeps, 'recoverHostPortConflict'>,
  ): Promise<void> {
    // Bound to `this` so a subclass override or an instance spy still wins over the base method.
    const deps: ComposeRecoveryDeps = {
      moduleRef: this.moduleRef,
      ensureAppDir: (urn: AppUrn, f: AppEventFormInput, options?: { excludeSubnets?: string[] }) => this.ensureAppDir(urn, f, options),
      removeStaleAppNetworks: (urn: AppUrn) => this.removeStaleAppNetworks(urn),
      recoverHostPortConflict: recovery?.recoverHostPortConflict,
    };
    return runComposeWithNetworkRecovery(deps, appUrn, form, command, maxAttempts, signal);
  }

  /** `composeAppWithNetworkRecovery` for an `up` that can pull images, which records them for the uninstall; see `recordComposeUpPulls`. */
  protected async composeUpRecordingPulls(...args: Parameters<AppLifecycleCommand['composeAppWithNetworkRecovery']>): Promise<void> {
    return recordComposeUpPulls(this.moduleRef, args[0], () => this.composeAppWithNetworkRecovery(...args), {
      forced: args[2].includes('--pull always'),
    });
  }

  /** Point the app at the host port of its main allocation; see `writeMainHostPort`. */
  protected async applyMainHostPort(
    appUrn: AppUrn,
    form: AppEventFormInput,
    main: Pick<PortAllocation, 'hostPort' | 'containerPort'>,
  ): Promise<void> {
    return writeMainHostPort(this.moduleRef, appUrn, form, main);
  }

  /**
   * Move the app's main port off a host port another program holds, once Docker has refused it. Install,
   * start and restart pass it to `composeAppWithNetworkRecovery`; see `moveMainPortOffHostConflict`.
   */
  protected async moveMainPortOffConflict(appUrn: AppUrn, form: AppEventFormInput, error: unknown, refused: Set<number>): Promise<boolean> {
    return moveMainPortOffHostConflict(this.moduleRef, appUrn, form, error, refused);
  }

  /**
   * The error to fail with if the app did not come up after `compose up`, or null if it did. Install,
   * retry, start and restart all ask this. A check Docker could not answer says nothing against the
   * app, so it counts as up: the status sync reads the containers again.
   */
  protected async appCameUpError(appUrn: AppUrn): Promise<AppLifecycleError | null> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    try {
      const verification = await this.moduleRef.get(DockerService, { strict: false }).waitForManagedAppContainersReady(appUrn);
      if (verification.ok) {
        return null;
      }
      logger.error(`[AppDiag] ${appUrn} did not come up: ${verification.message}${verification.errorDetail ? `\n${verification.errorDetail}` : ''}`);
      return new AppLifecycleError(verification.message, {
        detail: verification.errorDetail ?? verification.message,
        serviceFailure: verification.serviceFailure,
      });
    } catch (error) {
      logger.warn(`Could not check whether ${appUrn} came up: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<AppCommandFailureResult> => {
    return reportAndTranslateAppError(this.moduleRef, err, appId, event);
  };
}
