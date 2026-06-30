import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';

/** Lifecycle commands that can flow through the operation registry. */
export type OperationCommand = 'install' | 'start' | 'stop' | 'restart' | 'update' | 'uninstall' | 'reset' | 'backup' | 'restore' | 'generate_env';

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

  constructor(private readonly logger: LoggerService) {}

  /**
   * Record a new operation for an app. Called by the service immediately before publishing the
   * command to the queue so that a cancel arriving during the publish→dequeue window can still be
   * honoured (tier-A). Replaces any existing entry for the app (the per-app mutex prevents real overlap).
   */
  register(appUrn: AppUrn, params: { requestId: string; command: OperationCommand; tier: CancellabilityTier }): OperationEntry {
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
    }
  }
}
