import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const execAsync = promisify(exec);
const SAMPLE_TIMEOUT_MS = 5_000;

export type GpuProcessVramSample = {
  pid: number;
  /** Kernel `comm` (argv[0] basename, truncated) — never contains spaces, per both tools' own output. */
  processName: string;
  vramMb: number;
};

/**
 * Host-written per-process VRAM, read through `FilesystemService` under the already-allowlisted
 * `DATA_DIR`, beside `hardware-inspector.service.ts`'s `nvidia.json` / `rocm.json` probes and the
 * pool's `gpu_pressure.json`.
 *
 * This is the source that actually answers on a fleet node. The Hub image is Alpine with neither
 * vendor tool and no GPU device access, so the shell-outs below return nothing there — measured on
 * beta-red 2026-09-21: `docker exec ci-hub which nvidia-smi` → not found, while the host's nvidia-smi
 * held 9 of 10 GiB in two engine processes. A bind mount cannot fix that (the host binary is glibc,
 * the image musl), so the host runs the query on a timer and writes it here instead —
 * `scripts/host-probes/cihub-gpu-processes.sh`, install steps in `docs/fleet-setup.md`.
 */
export const HOST_GPU_PROCESSES_FILE_PATH = '/data/state/hardware/gpu_processes.json';

/**
 * How old the host file may be before it is ignored. The writer runs every 15 s; four missed
 * ticks is a dead writer, and a dead writer's last file must read as *unmeasured*, never as the
 * card being empty — the memory budget would otherwise admit a model into VRAM a stale file says
 * is free.
 */
export const HOST_GPU_PROCESSES_FILE_MAX_AGE_MS = 60_000;

/** The `schemaVersion` this build understands; any other is ignored outright, not best-effort parsed. */
export const HOST_GPU_PROCESSES_FILE_SCHEMA_VERSION = 1;

export const hostGpuProcessesFileSchema = z.object({
  schemaVersion: z.number(),
  /** The writer's clock, ISO 8601. */
  sampledAt: z.string(),
  /** Free-form writer id (`nvidia-smi`, `rocm-smi`), for the operator. Never used to decide anything. */
  source: z.string().optional(),
  vendor: z.string().optional(),
  /** The vendor tool's own rows: `processName` verbatim, the same strings the parsers below produce. */
  processes: z.array(z.object({ pid: z.number(), processName: z.string(), vramMb: z.number() })),
});

export type HostGpuProcessesFile = z.infer<typeof hostGpuProcessesFileSchema>;

/**
 * Who answered. `host-file` is the probe on the host (`scripts/host-probes/cihub-gpu-processes.sh`,
 * rolled by `cihub fleet update --gpu-probe`); `tool` is the vendor CLI run by this process, which
 * only works for a Hub running outside Docker.
 */
export type GpuProcessSampleSource = 'host-file' | 'tool';

export type GpuProcessObservation = {
  samples: GpuProcessVramSample[];
  /**
   * Which source answered, or `null` when nothing on this node could. `null` with `[]` is "the
   * reading is absent here"; `'host-file'` or `'tool'` with `[]` is "measured, and nothing holds
   * VRAM". The runtime monitor puts this on its snapshot as `gpuVramSource`, and the dashboard
   * says the first in words rather than drawing it as the second.
   */
  source: GpuProcessSampleSource | null;
};

/**
 * Per-process GPU VRAM, sampled live — VRAM only, deliberately. See the doc comment on
 * {@link GpuProcessSamplerService.sampleVramByProcess} for why compute utilization is not here and
 * is not coming later without different hardware or driver support than this fleet has today.
 */
@Injectable()
export class GpuProcessSamplerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
  ) {}

  /** {@link sampleVramByProcess}, plus which source answered — for a consumer that reports provenance. */
  async observeVramByProcess(vendor: string | undefined): Promise<GpuProcessObservation> {
    const fromHost = await this.sampleHostFile();
    if (fromHost !== null) {
      return { samples: fromHost, source: 'host-file' };
    }
    const fromTool = vendor === 'amd' ? await this.sampleAmd() : vendor === 'nvidia' ? await this.sampleNvidia() : null;
    if (fromTool === null) {
      this.logger.debug(
        `Per-process GPU VRAM is absent on this node: no fresh ${HOST_GPU_PROCESSES_FILE_PATH} and no vendor tool answered for '${vendor ?? 'no GPU'}'`,
      );
      return { samples: [], source: null };
    }
    return { samples: fromTool, source: 'tool' };
  }

  /**
   * Per-process VRAM in use right now, or `[]` when nothing can measure it. Never throws: this
   * runs on the app-runtime-monitor's 60s tick, and a stalled or missing GPU tool must not stall
   * the CPU/memory sampling it rides alongside.
   *
   * Sources, in order: a fresh host-written {@link HOST_GPU_PROCESSES_FILE_PATH} (the only one that
   * answers inside the fleet's Hub container), then the vendor tool itself when this process can
   * reach it (a Hub run on the host). The file is consulted before the vendor is looked at because
   * it names its own vendor, and a node whose profile says `nvidia` but whose host writes nothing
   * still needs the shell-out tried.
   *
   * VRAM only, on purpose. Both `rocm-smi --showpids` (AMD) and `nvidia-smi
   * --query-compute-apps` (NVIDIA) were checked live against this fleet on 2026-09-15 — beta-max
   * (AMD Strix Halo, gfx1151) and beta-red (NVIDIA RTX 3080). Per-process VRAM is real on both.
   * Per-process compute UTILIZATION is not: rocm-smi's own `CU OCCUPANCY` column reads `UNKNOWN`
   * on every process row this fleet has ever produced, and `nvidia-smi pmon`'s sm/mem/enc/dec
   * columns are all `-` on this driver. That is a hardware/driver ceiling, not a parsing gap —
   * nothing here estimates one, and `workload-coverage.tsx` says so in the dashboard.
   */
  async sampleVramByProcess(vendor: string | undefined): Promise<GpuProcessVramSample[]> {
    return (await this.observeVramByProcess(vendor)).samples;
  }

  /**
   * The host file's rows, or `null` when it has nothing to say — absent, unreadable, malformed,
   * another schema, or older than {@link HOST_GPU_PROCESSES_FILE_MAX_AGE_MS}. `null` and not `[]`,
   * so the caller still tries the vendor tool: a Hub run on the host with no writer installed must
   * keep measuring the way it did before the file existed.
   */
  private async sampleHostFile(): Promise<GpuProcessVramSample[] | null> {
    try {
      const file = await this.filesystem.readJsonFile(HOST_GPU_PROCESSES_FILE_PATH, hostGpuProcessesFileSchema);
      if (!file) return null;
      const samples = samplesFromHostGpuProcessesFile(file);
      if (samples === null) {
        this.logger.debug(`Ignoring ${HOST_GPU_PROCESSES_FILE_PATH}: schema ${file.schemaVersion}, sampled ${file.sampledAt}`);
      }
      return samples;
    } catch (error) {
      this.logger.debug(`Host GPU process file unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The tool's rows, or `null` for every way it can fail to answer — absent, timed out, non-zero. */
  private async sampleAmd(): Promise<GpuProcessVramSample[] | null> {
    try {
      const { stdout } = await execAsync('rocm-smi --showpids', { timeout: SAMPLE_TIMEOUT_MS });
      return parseRocmSmiShowPids(stdout);
    } catch (error) {
      this.logToolFailure('rocm-smi --showpids', error);
      return null;
    }
  }

  private async sampleNvidia(): Promise<GpuProcessVramSample[] | null> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits', {
        timeout: SAMPLE_TIMEOUT_MS,
      });
      return parseNvidiaSmiComputeApps(stdout);
    } catch (error) {
      this.logToolFailure('nvidia-smi --query-compute-apps', error);
      return null;
    }
  }

  /**
   * A missing binary is the expected case inside the Hub container (`sh` exits 127), and is logged
   * as the absence it is — with the fix named — so the log does not read like a broken tool.
   */
  private logToolFailure(command: string, error: unknown): void {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 127 || code === 'ENOENT') {
      this.logger.debug(
        `${command}: not on this Hub's PATH and no fresh ${HOST_GPU_PROCESSES_FILE_PATH} — per-process GPU VRAM is absent on this node until the host probe timer is installed (cihub fleet update --gpu-probe)`,
      );
      return;
    }
    this.logger.debug(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The rows a host file contributes, or `null` when the file must be ignored: a schema this build
 * does not understand, an unparseable `sampledAt`, or a sample older than the max age. Rows are
 * filtered the same way the parsers below filter tool output — a zero-VRAM process is a process
 * that merely appears in the table, not a GPU workload. An empty list from a FRESH file is a
 * measurement ("nothing holds the GPU") and is returned as such.
 */
export function samplesFromHostGpuProcessesFile(file: HostGpuProcessesFile, now: number = Date.now()): GpuProcessVramSample[] | null {
  if (file.schemaVersion !== HOST_GPU_PROCESSES_FILE_SCHEMA_VERSION) {
    return null;
  }
  const sampledAt = Date.parse(file.sampledAt);
  // Symmetric, as gpu-pressure-sources.ts is: a writer whose clock runs ahead of ours would otherwise
  // be believed for the skew plus the max age after it died, which is the failure this window exists
  // to bound.
  if (!Number.isFinite(sampledAt) || Math.abs(now - sampledAt) > HOST_GPU_PROCESSES_FILE_MAX_AGE_MS) {
    return null;
  }
  return file.processes
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.processName.trim().length > 0 && Number.isFinite(row.vramMb) && row.vramMb > 0)
    .map((row) => ({ pid: row.pid, processName: row.processName.trim(), vramMb: Math.round(row.vramMb) }));
}

/**
 * Parses `rocm-smi --showpids`'s plain-text KFD process table. No `--csv`/`--json` mode is used
 * here — `--showpids` was confirmed live only in this table form, and guessing at an output mode
 * never run against real hardware is how a parser ships broken. Verified on beta-max, 2026-09-15
 * (ROCm-SMI 4.0.0, ROCM-SMI-LIB 7.8.0):
 * ```
 * KFD process information:
 * PID 	PROCESS NAME   	GPU(s)	VRAM USED  	SDMA USED	CU OCCUPANCY
 * 9399	VLLM::EngineCor	1     	329576448  	0        	UNKNOWN
 * 6566	vllm           	0     	0          	0        	UNKNOWN
 * 6534	dflash_server  	1     	18652127232	0        	UNKNOWN
 * ```
 * A process holding no VRAM (like `vllm` above — its `VLLM::EngineCor` child holds the real
 * allocation) is dropped: zero is not a workload using the GPU, it is a process that happens to
 * also appear in the KFD table. `CU OCCUPANCY` is read by nothing here — see the class doc comment.
 */
export function parseRocmSmiShowPids(stdout: string): GpuProcessVramSample[] {
  const results: GpuProcessVramSample[] = [];
  for (const rawLine of stdout.split('\n')) {
    const cells = rawLine.trim().split(/\s+/).filter(Boolean);
    // Columns: PID, PROCESS NAME, GPU(s), VRAM USED (bytes), SDMA USED, CU OCCUPANCY. The header
    // row's first cell is the literal word "PID", which fails the finite-PID check below same as
    // the banner/separator lines around it — no special-casing needed to skip either.
    if (cells.length < 4) continue;
    const pid = Number.parseInt(cells[0] ?? '', 10);
    const processName = cells[1] ?? '';
    const vramBytes = Number.parseInt(cells[3] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0 || !processName || !Number.isFinite(vramBytes) || vramBytes <= 0) continue;

    results.push({ pid, processName, vramMb: Math.round(vramBytes / (1024 * 1024)) });
  }
  return results;
}

/**
 * Parses `nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits`.
 * Verified on beta-red, 2026-09-15:
 * ```
 * 6975, VLLM::EngineCore, 6104
 * 286138, /usr/bin/baobab, 22
 * ```
 * `noheader` and `nounits` are load-bearing: with units, `used_memory` reads `"6104 MiB"`, a string
 * this parser would have to strip rather than a bare number it can `parseInt`.
 */
export function parseNvidiaSmiComputeApps(stdout: string): GpuProcessVramSample[] {
  const results: GpuProcessVramSample[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0] ?? '', 10);
    const processName = parts[1] ?? '';
    const vramMb = Number.parseInt(parts[2] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0 || !processName || !Number.isFinite(vramMb) || vramMb <= 0) continue;

    results.push({ pid, processName, vramMb });
  }
  return results;
}
