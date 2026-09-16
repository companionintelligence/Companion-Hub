import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';

const execAsync = promisify(exec);
const SAMPLE_TIMEOUT_MS = 5_000;

export type GpuProcessVramSample = {
  pid: number;
  /** Kernel `comm` (argv[0] basename, truncated) — never contains spaces, per both tools' own output. */
  processName: string;
  vramMb: number;
};

/**
 * Per-process GPU VRAM, sampled live — VRAM only, deliberately. See the doc comment on
 * {@link GpuProcessSamplerService.sampleVramByProcess} for why compute utilization is not here and
 * is not coming later without different hardware or driver support than this fleet has today.
 */
@Injectable()
export class GpuProcessSamplerService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * Per-process VRAM in use right now, or `[]` when the vendor's tool is absent, times out, or
   * reports nothing. Never throws: this runs on the app-runtime-monitor's 60s tick, and a stalled
   * or missing GPU tool must not stall the CPU/memory sampling it rides alongside.
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
    if (vendor === 'amd') {
      return this.sampleAmd();
    }
    if (vendor === 'nvidia') {
      return this.sampleNvidia();
    }
    return [];
  }

  private async sampleAmd(): Promise<GpuProcessVramSample[]> {
    try {
      const { stdout } = await execAsync('rocm-smi --showpids', { timeout: SAMPLE_TIMEOUT_MS });
      return parseRocmSmiShowPids(stdout);
    } catch (error) {
      this.logger.debug(`rocm-smi --showpids failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async sampleNvidia(): Promise<GpuProcessVramSample[]> {
    try {
      const { stdout } = await execAsync('nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits', {
        timeout: SAMPLE_TIMEOUT_MS,
      });
      return parseNvidiaSmiComputeApps(stdout);
    } catch (error) {
      this.logger.debug(`nvidia-smi --query-compute-apps failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
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
