import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { HardwareInspectorService } from '@/modules/inference/hardware-inspector.service';
import { MAX_PRESSURE_BAND } from '@/common/helpers/hub-pool';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';
import {
  HOST_PRESSURE_FILE_PATH,
  hostPressureFileSchema,
  occupancyFromHostPressureFile,
  readAmdDrmOccupancy,
  type PressureReading,
} from './gpu-pressure-sources';
import type { PoolPressureSource } from './hub-pool.types';

/**
 * How often a sample is taken.
 *
 * A module constant, not an operator setting, and deliberately: the consumers are a 30s health poll
 * and a per-request ranker whose other inputs only move on request boundaries, so finer resolution
 * buys nothing, and one more knob nobody can calibrate is worse than none.
 */
const SAMPLE_INTERVAL_MS = 10_000;

/**
 * How long the last sample stays believable. Three intervals, matching the three-polls convention
 * `CAPABILITIES_FRESHNESS_POLLS` already uses for a peer's snapshot.
 *
 * This one constant covers every way sampling can stop — a wedged source, a stalled event loop, the
 * last peer being unpaired, the kill switch being flipped — with no reset bookkeeping anywhere: the
 * band simply ages back to `null`, which reads as unmeasured, which ranks neutral.
 */
const SAMPLE_STALE_MS = SAMPLE_INTERVAL_MS * 3;

/**
 * EWMA weight on the newest sample. At a 10s interval this reaches ~64% of a step in 30s (one
 * health-poll period) and ~92% in 60s: fast enough that a peer's next poll sees a real change,
 * slow enough that one spike does not move the band.
 */
const EWMA_ALPHA = 0.4;

/**
 * A single sample is a spike, not a level — and a node that has just started one generation must
 * not read as permanently saturated the instant it boots. Below this the band is `null`.
 */
const MIN_SAMPLES_FOR_BAND = 2;

/** Occupancy at which a node ENTERS band 1 / 2 / 3. PAIR's thresholds. */
const BAND_UP = [0.4, 0.7, 0.85];
/** Occupancy it must fall BELOW to leave band 1 / 2 / 3. The 5-point deadband is what stops 0.68↔0.72 flapping 1↔2. */
const BAND_DOWN = [0.35, 0.65, 0.8];

/**
 * How long the hardware profile is reused for the AMD check.
 *
 * `HardwareInspectorService.getProfile()` is not free: on an incomplete discrete-GPU profile — which
 * is exactly the NVIDIA-in-a-container case — it re-runs the full `detect()`, forking nvidia-smi,
 * rocm-smi, `system_profiler` and `docker info` behind 5s timeouts, every 5 minutes. Calling it on a
 * 10s tick would put that cost on a permanent loop for a boolean that changes when someone opens the
 * case. Long TTL, and never `rescan()`.
 */
const PROFILE_TTL_MS = 30 * 60_000;

/**
 * Samples this node's real GPU busy-ness off the request path and smooths it into a 0-3 band.
 *
 * Three things about this service are load-bearing and should survive any refactor:
 *
 * 1. **`null` is a first-class value and is never coerced to 0.** "I could not measure" and "I am
 *    idle" are different claims, and on this fleet the first is the common case — the signal is
 *    AMD-only, because the AMD driver is the only one that exposes a duty-cycle counter the Hub
 *    container can read without a GPU passthrough it does not have. Callers turn `null` into
 *    `UNKNOWN_PRESSURE`, which is mid-band.
 * 2. **Nothing here runs on the request path.** `band()` is a field read. No process is forked, no
 *    socket is opened and no file is stat'd while a request is being routed.
 * 3. **Sampling is gated on there being a connected peer**, not on `poolEnabled` (which defaults
 *    true). The band only exists to be compared against another node's, so on a single-node Hub —
 *    the overwhelming majority of deployments — this service does one indexed SELECT every 10s and
 *    nothing else, and its band stays `null` forever.
 */
@Injectable()
export class HubPoolPressureService implements OnModuleInit, OnModuleDestroy {
  private timerHandle: NodeJS.Timeout | null = null;
  private stopped = false;

  /** Smoothed occupancy in [0,1], or `null` before the first sample lands. */
  private ewma: number | null = null;
  private sampleCount = 0;
  private lastSampleAt = 0;
  private lastSource: PoolPressureSource | null = null;
  /** The banded value, recomputed with hysteresis as each sample lands so `band()` stays a pure read. */
  private currentBand = 0;
  private cachedIsAmd: { value: boolean; expiresAt: number } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly hardwareInspector: HardwareInspectorService,
    private readonly repo: HubPoolPeerRepository,
  ) {}

  onModuleInit(): void {
    this.scheduleNextTick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /**
   * This node's smoothed pressure band, or `null` when it is unmeasured.
   *
   * `null` is returned for three distinct reasons that all mean the same thing to a caller: no
   * source answered, fewer than {@link MIN_SAMPLES_FOR_BAND} samples have landed, or the newest
   * sample has aged past {@link SAMPLE_STALE_MS}.
   */
  band(): number | null {
    if (this.ewma === null || this.sampleCount < MIN_SAMPLES_FOR_BAND) {
      return null;
    }
    if (Date.now() - this.lastSampleAt > SAMPLE_STALE_MS) {
      return null;
    }
    return this.currentBand;
  }

  /** Which source produced the current band, for the operator surfaces only. Never read by the ranker. */
  source(): PoolPressureSource | null {
    return this.band() === null ? null : this.lastSource;
  }

  /**
   * Self-rescheduling `setTimeout` rather than `setInterval`, following `HubPoolPeerService`: a slow
   * source must not stack overlapping ticks. Chaining after the work is what guarantees that.
   */
  private scheduleNextTick(): void {
    this.timerHandle = setTimeout(() => {
      void (async () => {
        try {
          await this.tick();
        } catch (error) {
          // Never lets a source failure kill the loop: the band ages out on its own, which is the
          // correct degraded state, and a permanently dead timer would freeze it at its last value.
          this.logger.debug(`[HubPool] pressure sample failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!this.stopped) {
          this.scheduleNextTick();
        }
      })();
    }, SAMPLE_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (!(await this.hasConnectedPeers())) {
      return;
    }
    const reading = await this.read();
    if (!reading) {
      return;
    }
    this.ewma = this.ewma === null ? reading.occupancy : EWMA_ALPHA * reading.occupancy + (1 - EWMA_ALPHA) * this.ewma;
    this.sampleCount += 1;
    this.lastSampleAt = Date.now();
    this.lastSource = reading.source;
    this.applyBand(this.ewma);
  }

  /**
   * Gated on peers rather than on the kill switch, and this is the difference between a feature that
   * costs nothing on a single-node Hub and one that runs a sampling loop on every appliance forever.
   * `poolEnabled` defaults to `true`, so gating on it would have gated nothing.
   */
  private async hasConnectedPeers(): Promise<boolean> {
    const peers = await this.repo.listByStatuses(['connected']);
    return peers.length > 0;
  }

  /**
   * The source ladder: the host file first, then AMD DRM sysfs. First answer wins; a source that
   * throws or declines falls through to the next.
   *
   * There is no third rung. The `/api/ps` residency source the original design carried was cut in
   * review: it is byte-identical whether an engine is generating or idle with `keep_alive` counting
   * down, so its band 0 meant "coldest node", and shipping it would have made the pool prefer cold
   * nodes over warm ones — the precise inversion `poolLocalAffinity` exists to prevent.
   */
  private async read(): Promise<PressureReading | null> {
    const fromFile = await this.readHostFile();
    if (fromFile !== null) {
      return { occupancy: fromFile, source: 'host-file' };
    }
    if (!(await this.isAmdGpu())) {
      return null;
    }
    const fromDrm = await readAmdDrmOccupancy();
    return fromDrm === null ? null : { occupancy: fromDrm, source: 'amd-drm' };
  }

  private async readHostFile(): Promise<number | null> {
    try {
      const parsed = await this.filesystem.readJsonFile(HOST_PRESSURE_FILE_PATH, hostPressureFileSchema);
      return parsed ? occupancyFromHostPressureFile(parsed) : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the DRM source is worth trying at all, from the GPU detection that already exists rather
   * than from a second probe of our own. Cached hard — see {@link PROFILE_TTL_MS}.
   */
  private async isAmdGpu(): Promise<boolean> {
    const cached = this.cachedIsAmd;
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    let value = false;
    try {
      const profile = await this.hardwareInspector.getProfile();
      value = profile.gpu.available && profile.gpu.vendor === 'amd';
    } catch (error) {
      this.logger.debug(`[HubPool] could not read hardware profile for pressure sampling: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.cachedIsAmd = { value, expiresAt: Date.now() + PROFILE_TTL_MS };
    return value;
  }

  /**
   * Quantise the smoothed occupancy, with hysteresis.
   *
   * Rises are immediate and may skip bands — a card that just filled is saturated now, and making it
   * climb one band per 10s tick would mean a third of a minute of routing work onto a machine that
   * is already full. Falls walk down one band at a time and only once occupancy is under that band's
   * DOWN threshold, which is what stops an occupancy oscillating either side of a boundary from
   * flapping the value every peer is ranking on.
   */
  private applyBand(ewma: number): void {
    let target = 0;
    for (let index = BAND_UP.length - 1; index >= 0; index -= 1) {
      if (ewma >= (BAND_UP[index] as number)) {
        target = index + 1;
        break;
      }
    }
    if (target > this.currentBand) {
      this.currentBand = Math.min(MAX_PRESSURE_BAND, target);
      return;
    }
    if (this.currentBand > 0 && ewma < (BAND_DOWN[this.currentBand - 1] as number)) {
      this.currentBand -= 1;
    }
  }
}
