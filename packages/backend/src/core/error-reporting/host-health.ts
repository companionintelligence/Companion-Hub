import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * What the host looked like at the moment an app operation failed, for the Sentry event's
 * `host_health` context.
 *
 * Every number here answers one question the failure message cannot: could this process have
 * driven a socket just now? A request that "timed out" from a hub whose load average is three
 * times its core count and whose event loop stalled for seconds is a starved host, not a broken
 * network, and the fix is different. The hub runs on hardware we cannot log in to, so the
 * reading has to travel with the report.
 *
 * Event-loop delay is sampled continuously from module load and the histogram is reset at every
 * snapshot, so the figures describe the stretch since the previous report rather than the whole
 * uptime. The sampler is unref'd by Node and does not hold the process open.
 */
const EVENT_LOOP_SAMPLE_MS = 20;

let eventLoopDelay: IntervalHistogram | null = null;

function eventLoopHistogram(): IntervalHistogram | null {
  if (eventLoopDelay) {
    return eventLoopDelay;
  }
  try {
    eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_SAMPLE_MS });
    eventLoopDelay.enable();
  } catch {
    // Not available on this runtime; the rest of the snapshot still stands.
    eventLoopDelay = null;
  }
  return eventLoopDelay;
}

// Start sampling as soon as the module is loaded so the first report already has a window.
eventLoopHistogram();

const NS_PER_MS = 1_000_000;

function ms(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? Math.round(nanoseconds / NS_PER_MS) : 0;
}

function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export type HostHealthSnapshot = {
  cpu_count: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
  /** `load_avg_1m / cpu_count`, so 1.0 is every core busy regardless of how many there are. */
  load_per_core_1m: number;
  mem_total_mib: number;
  mem_free_mib: number;
  process_rss_mib: number;
  process_uptime_s: number;
  /** Event-loop delay over the window since the previous snapshot, in milliseconds. */
  event_loop_delay_mean_ms: number;
  event_loop_delay_p99_ms: number;
  event_loop_delay_max_ms: number;
};

export function snapshotHostHealth(): HostHealthSnapshot {
  const cpuCount = Math.max(1, os.cpus().length);
  const [load1 = 0, load5 = 0, load15 = 0] = os.loadavg();
  const histogram = eventLoopHistogram();

  const snapshot: HostHealthSnapshot = {
    cpu_count: cpuCount,
    load_avg_1m: round2(load1),
    load_avg_5m: round2(load5),
    load_avg_15m: round2(load15),
    load_per_core_1m: round2(load1 / cpuCount),
    mem_total_mib: mib(os.totalmem()),
    mem_free_mib: mib(os.freemem()),
    process_rss_mib: mib(process.memoryUsage().rss),
    process_uptime_s: Math.round(process.uptime()),
    event_loop_delay_mean_ms: histogram ? ms(histogram.mean) : 0,
    event_loop_delay_p99_ms: histogram ? ms(histogram.percentile(99)) : 0,
    event_loop_delay_max_ms: histogram ? ms(histogram.max) : 0,
  };

  histogram?.reset();

  return snapshot;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
