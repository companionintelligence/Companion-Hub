import { Injectable, Optional } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import type { lifecycleOperationSchema } from '@ci-hub/common/schemas';
import type { z } from 'zod';
import { appCommandTimeoutMs } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

/** Lifecycle commands that can flow through the operation registry. */
export type OperationCommand = z.infer<typeof lifecycleOperationSchema>;

/**
 * Coarse cancellability tier, derived from the command when the op is registered.
 * - `safe`: can be aborted and cleanly compensated while in flight, up to the point of no return
 *   (`AppLifecycleService.cancelOperation` still refuses once the phase reaches `finalizing`/`committed`).
 * - `before_ponr`: cancellable only until a point-of-no-return phase is reached.
 * - `non_cancellable`: destructive with no safe midpoint; only a force-reset escape hatch applies.
 */
export type CancellabilityTier = 'safe' | 'before_ponr' | 'non_cancellable';

/**
 * Phase markers a command reports through {@link CommandExecutionContext.setPhase} as it executes,
 * so the cancel endpoint can decide whether an abort is still safe.
 * - `queued`: registered but not yet dequeued by the queue consumer.
 * - `preparing`: dequeued, before any destructive/irreversible work.
 * - `pulling`: image pull in flight.
 * - `composing`: `docker compose up/down` in flight.
 * - `finalizing`: post-compose work (Traefik, webhooks, status) — past the point of no return.
 * - `committed`: an explicit point-of-no-return crossed; cancel must be refused.
 */
export type OperationPhase = 'queued' | 'preparing' | 'pulling' | 'composing' | 'finalizing' | 'committed';

/** A single in-flight (or queued) lifecycle operation for one app. */
export interface OperationEntry {
  /** The operation's request id, used to guard against cancelling a newer op for the same app. */
  requestId: string;
  /** The lifecycle command being run. */
  command: OperationCommand;
  /** Cancellability tier derived from the command at registration time. */
  tier: CancellabilityTier;
  /** Abort controller whose signal is threaded into the running command and its docker spawns/pulls. */
  abortController: AbortController;
  /** Current execution phase, updated by the command as it progresses. */
  phase: OperationPhase;
  /** True once a cancel was requested while the op was still queued (tier-A short-circuit). */
  cancelRequestedWhileQueued: boolean;
  /** Wall-clock registration time (ms since epoch), for diagnostics. */
  createdAt: number;
}

/**
 * How long a lifecycle operation holds its app: as long as the queue waits for a command, which is
 * the events timeout or the image pull timeout, whichever is longer. Past that its caller has given
 * up on it, and an entry that never clears (a stop hung on Docker, say) must not hold the app for
 * good. The status sync judges a transitional row by the same window.
 */
export function operationStaleAfterMs(eventsTimeoutMinutes: number): number {
  return appCommandTimeoutMs(eventsTimeoutMinutes);
}

/** The operation an app has under way, as {@link AppOperationRegistry.liveOperation} reports it. */
export interface LiveOperation {
  command: OperationCommand;
  /** `claimed`: an entry method is still on its way to dispatching it. `dispatched`: the queue has it. */
  stage: 'claimed' | 'dispatched';
}

/** A claim on an app's slot, from {@link AppOperationRegistry.claim}. */
export type OperationClaim = { claimed: true; token: symbol } | { claimed: false; busy: LiveOperation };

/** An install still in the checks `AppLifecycleService.installApp` runs before it registers. */
export interface PreparingInstall {
  /** Set by a cancel that arrived during the checks; `installApp` stops before its next write. */
  cancelRequested: boolean;
}

/**
 * In-memory registry of active app lifecycle operations, keyed by app URN.
 *
 * The backend runs as a single process, so a process-local map is sufficient and authoritative:
 * the worker that owns a `docker compose` spawn and the HTTP handler that receives a cancel request
 * share this same instance. One active op per app is guaranteed by the transient DB status plus the
 * per-app mutex in {@link AppLifecycleService.invokeCommand}.
 */
@Injectable()
export class AppOperationRegistry {
  private readonly ops = new Map<AppUrn, OperationEntry>();

  /**
   * Installs that have not registered yet. The Portal bundle download and the image architecture
   * check run first and take seconds, while the page already offers Cancel. A cancel then has no
   * entry to abort, so it is held here for `installApp` to apply.
   */
  private readonly preparing = new Map<AppUrn, PreparingInstall>();

  /**
   * Request ids of queued installs that were cancelled and settled before a worker took them. Kept
   * apart from `ops`: the app can be installed again, which replaces its entry, before the
   * cancelled message is dequeued.
   */
  private readonly settledBeforeStart = new Set<string>();

  /**
   * Apps with a call to `AppLifecycleService.installApp` under way, from its first check until it
   * answers. Kept apart from `preparing`, which a reinstall leaves early to end its cancel window.
   */
  private readonly installCalls = new Set<AppUrn>();

  /**
   * Commands an entry method has claimed the app for and not dispatched yet. The method reads and
   * writes the row between its busy check and `register`, so without a claim a second command sent
   * in that time passed the check too, and the one that registered last took the slot.
   */
  private readonly claims = new Map<AppUrn, { command: OperationCommand; token: symbol; claimedAt: number }>();

  /** Callers waiting for an app to be free again (`whenMaybeFree`), woken whenever its slot empties. */
  private readonly freeWaiters = new Map<AppUrn, Set<() => void>>();

  /**
   * Install calls still in their grant check, before `beginInstallCall`, and whether a cancel came
   * for them meanwhile. A cancel in that window found neither an entry nor a preparing install and
   * was answered "nothing to cancel" while the install went on.
   */
  private readonly installGrantChecks = new Map<AppUrn, { calls: number; cancelRequested: boolean }>();

  constructor(
    private readonly logger: LoggerService,
    @Optional() private readonly configuration?: ConfigurationService,
  ) {}

  staleAfterMs(): number {
    return operationStaleAfterMs(this.configuration?.get('userSettings')?.eventsTimeout ?? 0);
  }

  /**
   * The lifecycle operation this app has under way, or `undefined` when it has none: a command an
   * entry method has claimed, or one dispatched to the queue that has not settled. An entry older
   * than {@link operationStaleAfterMs} no longer counts. An install still in its checks is not an
   * operation yet; see {@link isInstallCallUnderWay}.
   */
  liveOperation(appUrn: AppUrn, now = Date.now()): LiveOperation | undefined {
    const staleAfterMs = this.staleAfterMs();
    const entry = this.ops.get(appUrn);
    if (entry && now - entry.createdAt < staleAfterMs) {
      return { command: entry.command, stage: 'dispatched' };
    }

    const claim = this.claims.get(appUrn);
    if (claim && now - claim.claimedAt < staleAfterMs) {
      return { command: claim.command, stage: 'claimed' };
    }

    return undefined;
  }

  /**
   * Claim the app for `command`, or name the operation that already holds it. Checked and taken in
   * one synchronous step, so two callers cannot both get it. `register` takes the claim over; a
   * method that fails before it gets there hands it back with {@link releaseClaim}.
   */
  claim(appUrn: AppUrn, command: OperationCommand, now = Date.now()): OperationClaim {
    const busy = this.liveOperation(appUrn, now);
    if (busy) {
      return { claimed: false, busy };
    }

    const token = Symbol(command);
    this.claims.set(appUrn, { command, token, claimedAt: now });
    return { claimed: true, token };
  }

  /** Hand back a claim that was never dispatched. A claim `register` already took over is left alone. */
  releaseClaim(appUrn: AppUrn, token: symbol): void {
    if (this.claims.get(appUrn)?.token === token) {
      this.claims.delete(appUrn);
      this.wakeFreeWaiters(appUrn);
    }
  }

  /**
   * Resolves once something may have freed the app (an entry cleared or claimed, a claim handed
   * back), or after `timeoutMs`. A wake-up is not a claim: the caller claims again, and may have to
   * wait again if another caller claimed first.
   */
  whenMaybeFree(appUrn: AppUrn, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.freeWaiters.get(appUrn) ?? new Set<() => void>();
      this.freeWaiters.set(appUrn, waiters);
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0 && this.freeWaiters.get(appUrn) === waiters) {
          this.freeWaiters.delete(appUrn);
        }
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      waiters.add(wake);
    });
  }

  private wakeFreeWaiters(appUrn: AppUrn): void {
    for (const wake of [...(this.freeWaiters.get(appUrn) ?? [])]) {
      wake();
    }
  }

  /** An `installApp` call for this app begins its grant check. */
  beginInstallGrantCheck(appUrn: AppUrn): void {
    const checks = this.installGrantChecks.get(appUrn) ?? { calls: 0, cancelRequested: false };
    checks.calls += 1;
    this.installGrantChecks.set(appUrn, checks);
  }

  /** The grant check is over. True, once, when a cancel came for the install during it. */
  endInstallGrantCheck(appUrn: AppUrn): boolean {
    const checks = this.installGrantChecks.get(appUrn);
    if (!checks) {
      return false;
    }
    const cancelRequested = checks.cancelRequested;
    checks.cancelRequested = false;
    checks.calls -= 1;
    if (checks.calls <= 0) {
      this.installGrantChecks.delete(appUrn);
    }
    return cancelRequested;
  }

  /** Hold a cancel for an install still in its grant check. False when none is. */
  holdGrantCheckCancel(appUrn: AppUrn): boolean {
    const checks = this.installGrantChecks.get(appUrn);
    if (!checks) {
      return false;
    }
    checks.cancelRequested = true;
    this.logger.info(`[op-registry] cancel held for install ${appUrn}, which is still checking the caller's grant`);
    return true;
  }

  /** True from the start of an `installApp` call for this app until it answers. */
  isInstallCallUnderWay(appUrn: AppUrn): boolean {
    return this.installCalls.has(appUrn);
  }

  /** Begin an install call for this app. False, and nothing begun, while another one is under way. */
  beginInstallCall(appUrn: AppUrn): boolean {
    if (this.installCalls.has(appUrn)) {
      return false;
    }
    this.installCalls.add(appUrn);
    return true;
  }

  /** End the install call that {@link beginInstallCall} began. */
  endInstallCall(appUrn: AppUrn): void {
    this.installCalls.delete(appUrn);
  }

  /** Mark an install as running its pre-registration checks. */
  beginPreparingInstall(appUrn: AppUrn): PreparingInstall {
    const preparing: PreparingInstall = { cancelRequested: false };
    this.preparing.set(appUrn, preparing);
    return preparing;
  }

  /** End the pre-registration window. A later install of the same app that began since keeps its own. */
  endPreparingInstall(appUrn: AppUrn, preparing: PreparingInstall): void {
    if (this.preparing.get(appUrn) === preparing) {
      this.preparing.delete(appUrn);
    }
  }

  /** Hold a cancel for an install that has not registered yet. False when no install is preparing. */
  holdPreparingCancel(appUrn: AppUrn): boolean {
    const preparing = this.preparing.get(appUrn);
    if (!preparing) {
      return false;
    }
    preparing.cancelRequested = true;
    this.logger.info(`[op-registry] cancel held for install ${appUrn}, which has not been queued yet`);
    return true;
  }

  /** Drop an aborted, still-queued op whose cancel has been carried out, and remember it for the worker. */
  settleBeforeStart(appUrn: AppUrn, requestId: string): void {
    this.settledBeforeStart.add(requestId);
    this.clear(appUrn, requestId);
  }

  /** True once for a request settled before it started: the worker skips its message. */
  takeSettledBeforeStart(requestId: string): boolean {
    return this.settledBeforeStart.delete(requestId);
  }

  /**
   * Record a new operation for an app. Called by the service immediately before publishing the
   * command to the queue so that a cancel arriving during the publish→dequeue window can still be
   * honoured (tier-A). Replaces any existing entry for the app, so callers claim the app first
   * ({@link claim}); only a force stop, the way out of a stop hung on Docker, registers over a live one.
   * It does so with `takesOverClaim: false`, so a command another caller has claimed and not yet
   * dispatched keeps its claim.
   */
  register(
    appUrn: AppUrn,
    params: { requestId: string; command: OperationCommand; tier: CancellabilityTier },
    options: { takesOverClaim?: boolean } = {},
  ): OperationEntry {
    const entry: OperationEntry = {
      requestId: params.requestId,
      command: params.command,
      tier: params.tier,
      abortController: new AbortController(),
      phase: 'queued',
      cancelRequestedWhileQueued: false,
      createdAt: Date.now(),
    };
    this.ops.set(appUrn, entry);
    // The command now holds the slot itself.
    if (options.takesOverClaim !== false) {
      this.claims.delete(appUrn);
    }
    this.logger.info(`[op-registry] register ${params.command} ${appUrn} req=${params.requestId} tier=${params.tier}`);
    return entry;
  }

  /** Return the active operation for an app, if any. */
  get(appUrn: AppUrn): OperationEntry | undefined {
    return this.ops.get(appUrn);
  }

  /**
   * Update the execution phase of an app's active operation. No-op if there is no entry, or — when a
   * `requestId` is supplied — if the active entry belongs to a different op (so a stale/dequeued
   * message can never mutate the phase of a newer op that replaced it).
   */
  markPhase(appUrn: AppUrn, phase: OperationPhase, requestId?: string): void {
    const entry = this.ops.get(appUrn);
    if (!entry) {
      return;
    }
    if (requestId && entry.requestId !== requestId) {
      return;
    }
    entry.phase = phase;
    this.logger.debug(`[op-registry] phase ${appUrn} -> ${phase} (req=${entry.requestId})`);
  }

  /**
   * Abort an app's active operation. Idempotent (a second abort is a no-op on the controller).
   * Returns the aborted entry, or `undefined` if there is no entry or the `requestId` no longer
   * matches (the op already completed or was replaced by a newer one).
   */
  abort(appUrn: AppUrn, requestId?: string): OperationEntry | undefined {
    const entry = this.ops.get(appUrn);
    if (!entry) {
      return undefined;
    }
    if (requestId && entry.requestId !== requestId) {
      return undefined;
    }
    // A still-queued op cannot be interrupted mid-flight; flag it so the consumer skips it on dequeue.
    if (entry.phase === 'queued') {
      entry.cancelRequestedWhileQueued = true;
    }
    this.logger.info(`[op-registry] abort ${entry.command} ${appUrn} req=${entry.requestId} phase=${entry.phase}`);
    entry.abortController.abort();
    return entry;
  }

  /**
   * Remove an app's operation entry. RequestId-matched so a freshly-registered replacement op is
   * never deleted by a late `clear()` from a previous op for the same app.
   */
  clear(appUrn: AppUrn, requestId: string): void {
    const entry = this.ops.get(appUrn);
    if (entry && entry.requestId === requestId) {
      this.ops.delete(appUrn);
      this.logger.debug(`[op-registry] clear ${appUrn} req=${requestId}`);
      this.wakeFreeWaiters(appUrn);
    }
  }

  /** True when this requestId is still the latest dispatched command for the app. */
  ownsOutcome(appUrn: AppUrn, requestId: string): boolean {
    return this.ops.get(appUrn)?.requestId === requestId;
  }

  /**
   * Claim a command's completion and keep the app claimed while the caller writes the outcome, in
   * one step, so a command waiting for the app is not let in between. `null` when a newer command
   * superseded this one. The caller hands the claim back with {@link releaseClaim}.
   */
  settleCompletion(appUrn: AppUrn, requestId: string): symbol | null {
    const entry = this.ops.get(appUrn);
    if (!entry || entry.requestId !== requestId) {
      return null;
    }
    this.ops.delete(appUrn);
    const token = Symbol(entry.command);
    this.claims.set(appUrn, { command: entry.command, token, claimedAt: Date.now() });
    this.logger.debug(`[op-registry] settle ${appUrn} req=${requestId} command=${entry.command}`);
    return token;
  }

  /**
   * Claim a command's completion outcome. Returns false when a newer command superseded this one,
   * in which case no status write, SSE, or notification side-effects should run.
   */
  claimCompletion(appUrn: AppUrn, requestId: string): boolean {
    const entry = this.ops.get(appUrn);
    if (!entry || entry.requestId !== requestId) {
      return false;
    }
    this.ops.delete(appUrn);
    this.logger.debug(`[op-registry] claim ${appUrn} req=${requestId} command=${entry.command}`);
    this.wakeFreeWaiters(appUrn);
    return true;
  }
}
