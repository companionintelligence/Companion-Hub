import type { AppCommandDeadline } from '@/common/helpers/app-command-deadline';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceEntitlementService } from '@/core/portal/marketplace-entitlement.service';
import { getEffectiveExposureMode } from '@/modules/apps/app-exposure.helpers';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { DockerService } from '@/modules/docker/docker.service';
import { APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN, type AppCameUpTiming, type AppContainerLook } from '@/modules/docker/managed-app-containers';
import { TraefikConfigService } from '@/modules/docker/traefik-config.service';
import type { PortAllocation } from '@/modules/network/port-manager.service';
import type { AppEventFormInput } from '@/modules/queue/entities/app-events';
import type { AppUrn } from '@ci-hub/common/types';
import type { ModuleRef } from '@nestjs/core';
import Dockerode from 'dockerode';
import { APP_SERVICE_FAILED_CODE, type AppCommandFailureResult, AppLifecycleError } from './app-lifecycle-errors';
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
 * Whether a failed `compose up` left this container failing. A crash loop reads `running` between two crashes
 * with its health check back at `starting`, so a restart count counts then. A count alone says nothing: `up`
 * can fail before it recreates anything, as a pull does, and the service may have been fine for weeks since.
 */
function isLeftFailing({ state, health, restartCount }: AppContainerLook): boolean {
  return state === 'restarting' || health === 'unhealthy' || (health === 'starting' && (restartCount ?? 0) > 0);
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
  protected async appCameUpError(appUrn: AppUrn, timing?: AppCameUpTiming): Promise<AppLifecycleError | null> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    try {
      const verification = await this.moduleRef.get(DockerService, { strict: false }).waitForManagedAppContainersReady(appUrn, timing);
      if (verification.ok) {
        return null;
      }
      logger.error(`[AppDiag] ${appUrn} did not come up: ${verification.message}${verification.errorDetail ? `\n${verification.errorDetail}` : ''}`);
      return new AppLifecycleError(verification.message, {
        code: APP_SERVICE_FAILED_CODE,
        detail: verification.errorDetail ?? verification.message,
        serviceFailure: verification.serviceFailure,
      });
    } catch (error) {
      logger.warn(`Could not check whether ${appUrn} came up: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The check after `compose up` in a Start or Restart: {@link appCameUpError}, but one someone asked for
   * gets the longer window and takes the app down if it did not come up.
   */
  protected async appCameUpErrorAfterStart(appUrn: AppUrn, form: AppEventFormInput): Promise<AppLifecycleError | null> {
    const notUp = await this.appCameUpError(appUrn, form.stopIfNotUp ? APP_CAME_UP_TIMING_BEFORE_TAKING_DOWN : undefined);
    if (notUp && form.stopIfNotUp) {
      await this.stopAppThatDidNotComeUp(appUrn);
    }
    return notUp;
  }

  /**
   * Take down an app whose Start or Restart did not come up, as Stop does. The app is reported as stopped, but
   * Docker would go on restarting the crashing container behind that and the app could come up by itself with
   * the page still saying Stopped. Removing the containers rather than stopping them keeps a `restart: always`
   * service from coming back when Docker restarts.
   *
   * Only for a start someone asked for. The Hub's own starts leave the containers alone, since an app at boot
   * can be waiting on something that comes up later and Docker's retries are what brings it back.
   */
  protected async stopAppThatDidNotComeUp(appUrn: AppUrn): Promise<void> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    try {
      await this.moduleRef.get(DockerService, { strict: false }).composeApp(appUrn, 'down --remove-orphans');
      logger.info(`Took down the containers of ${appUrn}, which did not come up`);
    } catch (error) {
      logger.warn(`Could not take down ${appUrn} after it did not come up: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The routes after a Start or Restart failed: either the other containers stay up and go on serving or they
   * just went down, and the routes follow both. A rebuild that fails must not replace the failure being reported.
   */
  protected async rebuildRoutesAfterFailure(appUrn: AppUrn, form: AppEventFormInput): Promise<void> {
    if (getEffectiveExposureMode(form) === 'local') {
      return;
    }
    await this.moduleRef
      .get(TraefikConfigService, { strict: false })
      .regenerateTraefikConfig(0)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.moduleRef.get(LoggerService, { strict: false }).warn(`Could not rebuild the routes after ${appUrn} failed: ${detail}`);
      });
  }

  /**
   * `compose up` failed in a Start or Restart. Rethrows the failure. One someone asked for first takes the app
   * down if a dependency was left failing, with the routes following as they do after a failed check.
   */
  protected async failComposeUp(appUrn: AppUrn, form: AppEventFormInput, error: unknown): Promise<never> {
    if (form.stopIfNotUp && (await this.stopAppLeftFailing(appUrn))) {
      await this.rebuildRoutesAfterFailure(appUrn, form);
    }
    throw error;
  }

  /**
   * A dependency that does not get healthy fails the `up` ("dependency failed to start"). Compose leaves it
   * crash-looping or running with its health check failing and Docker keeps it alive either way, so the app goes
   * down as after a failed check. The container's log goes with it, so its end is kept in the Hub's log first.
   * An `up` that failed with no container failing, as a pull usually does, leaves the app as it is.
   * Returns whether the app was taken down.
   */
  private async stopAppLeftFailing(appUrn: AppUrn): Promise<boolean> {
    const logger = this.moduleRef.get(LoggerService, { strict: false });
    const dockerRead = this.moduleRef.get(DockerReadFacade, { strict: false });
    const containers = await dockerRead.lookAtManagedAppContainers(appUrn).catch((error: unknown) => {
      logger.warn(`Could not look for failing containers of ${appUrn}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    const failing = containers.filter(isLeftFailing);
    if (failing.length === 0) {
      return false;
    }

    const { errorDetail } = await dockerRead.describeAppCameUpFailure({
      outcome: 'failed',
      kind: 'restarting',
      containers: failing,
      containersSeen: containers.length,
    });
    logger.warn(`[AppDiag] ${appUrn} left failing by compose up:\n${errorDetail ?? ''}`);
    await this.stopAppThatDidNotComeUp(appUrn);
    return true;
  }

  protected handleAppError = async (err: unknown, appId: string, event: string): Promise<AppCommandFailureResult> => {
    return reportAndTranslateAppError(this.moduleRef, err, appId, event);
  };
}
