import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import {
  GpuProcessSamplerService,
  HOST_GPU_PROCESSES_FILE_MAX_AGE_MS,
  HOST_GPU_PROCESSES_FILE_PATH,
  type HostGpuProcessesFile,
  parseNvidiaSmiComputeApps,
  parseRocmSmiShowPids,
  samplesFromHostGpuProcessesFile,
} from '../gpu-process-sampler.service';

// The vendor shell-outs, so the precedence tests can see whether the tool was asked at all.
const execMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ exec: execMock }));

// Captured live from beta-max (AMD Strix Halo, gfx1151), 2026-09-15, ROCm-SMI 4.0.0 / ROCM-SMI-LIB 7.8.0.
const ROCM_SMI_SHOWPIDS_OUTPUT = `

============================ ROCm System Management Interface ============================
===================================== KFD Processes ======================================
KFD process information:
PID 	PROCESS NAME   	GPU(s)	VRAM USED  	SDMA USED	CU OCCUPANCY
9399	VLLM::EngineCor	1     	329576448  	0        	UNKNOWN
6566	vllm           	0     	0          	0        	UNKNOWN
6534	dflash_server  	1     	18652127232	0        	UNKNOWN
==========================================================================================
================================== End of ROCm SMI Log ===================================
`;

// Captured live from beta-red (NVIDIA RTX 3080), 2026-09-15.
const NVIDIA_SMI_COMPUTE_APPS_OUTPUT = `6975, VLLM::EngineCore, 6104
286138, /usr/bin/baobab, 22
`;

describe('parseRocmSmiShowPids', () => {
  it('parses the live-captured beta-max table into per-process VRAM in MB', () => {
    expect(parseRocmSmiShowPids(ROCM_SMI_SHOWPIDS_OUTPUT)).toEqual([
      { pid: 9399, processName: 'VLLM::EngineCor', vramMb: Math.round(329576448 / (1024 * 1024)) },
      { pid: 6534, processName: 'dflash_server', vramMb: Math.round(18652127232 / (1024 * 1024)) },
    ]);
  });

  it('drops a process holding zero VRAM rather than reporting it as a GPU workload', () => {
    const result = parseRocmSmiShowPids(ROCM_SMI_SHOWPIDS_OUTPUT);
    expect(result.find((entry) => entry.processName === 'vllm')).toBeUndefined();
  });

  it('returns an empty list for output with no process rows', () => {
    expect(parseRocmSmiShowPids('\nKFD process information:\nPID \tPROCESS NAME\tGPU(s)\tVRAM USED\tSDMA USED\tCU OCCUPANCY\n')).toEqual([]);
  });

  it('never throws on garbage input', () => {
    expect(() => parseRocmSmiShowPids('rocm-smi: command not found\n')).not.toThrow();
    expect(parseRocmSmiShowPids('')).toEqual([]);
  });
});

describe('parseNvidiaSmiComputeApps', () => {
  it('parses the live-captured beta-red CSV into per-process VRAM in MB', () => {
    expect(parseNvidiaSmiComputeApps(NVIDIA_SMI_COMPUTE_APPS_OUTPUT)).toEqual([
      { pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 },
      { pid: 286138, processName: '/usr/bin/baobab', vramMb: 22 },
    ]);
  });

  it('returns an empty list for no compute apps running', () => {
    expect(parseNvidiaSmiComputeApps('')).toEqual([]);
  });

  it('never throws on garbage input', () => {
    expect(() => parseNvidiaSmiComputeApps('NVIDIA-SMI has failed\n')).not.toThrow();
  });
});

// The file the host timer on beta-red wrote on 2026-09-21 — every row nvidia-smi listed, verbatim.
const BETA_RED_HOST_FILE: HostGpuProcessesFile = {
  schemaVersion: 1,
  sampledAt: '2026-09-21T05:30:53Z',
  source: 'nvidia-smi',
  vendor: 'nvidia',
  processes: [
    { pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 },
    { pid: 286138, processName: '/usr/bin/baobab', vramMb: 22 },
    { pid: 3161051, processName: '/usr/local/lib/ollama/llama-server', vramMb: 2926 },
  ],
};
const WRITTEN_AT = Date.parse(BETA_RED_HOST_FILE.sampledAt);

describe('samplesFromHostGpuProcessesFile', () => {
  it('hands back the rows of a fresh file as the sampler would have parsed them itself', () => {
    expect(samplesFromHostGpuProcessesFile(BETA_RED_HOST_FILE, WRITTEN_AT + 10_000)).toEqual([
      { pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 },
      { pid: 286138, processName: '/usr/bin/baobab', vramMb: 22 },
      { pid: 3161051, processName: '/usr/local/lib/ollama/llama-server', vramMb: 2926 },
    ]);
  });

  it('ignores a file older than the max age: a dead writer must not leave "the card is empty" behind', () => {
    expect(samplesFromHostGpuProcessesFile(BETA_RED_HOST_FILE, WRITTEN_AT + HOST_GPU_PROCESSES_FILE_MAX_AGE_MS + 1)).toBeNull();
    expect(samplesFromHostGpuProcessesFile(BETA_RED_HOST_FILE, WRITTEN_AT + HOST_GPU_PROCESSES_FILE_MAX_AGE_MS)).not.toBeNull();
  });

  it('ignores a schema it does not understand rather than guessing at the columns', () => {
    expect(samplesFromHostGpuProcessesFile({ ...BETA_RED_HOST_FILE, schemaVersion: 2 }, WRITTEN_AT)).toBeNull();
  });

  it('ignores a file whose timestamp cannot be read, since its age cannot be either', () => {
    expect(samplesFromHostGpuProcessesFile({ ...BETA_RED_HOST_FILE, sampledAt: 'yesterday' }, WRITTEN_AT)).toBeNull();
  });

  it('drops zero-VRAM and malformed rows the way the tool parsers do, and keeps an empty fresh file as a measurement', () => {
    const file: HostGpuProcessesFile = {
      ...BETA_RED_HOST_FILE,
      processes: [
        { pid: 6566, processName: 'vllm', vramMb: 0 },
        { pid: 0, processName: 'ghost', vramMb: 100 },
        { pid: 12, processName: '   ', vramMb: 100 },
      ],
    };
    expect(samplesFromHostGpuProcessesFile(file, WRITTEN_AT)).toEqual([]);
  });
});

describe('GpuProcessSamplerService', () => {
  let filesystem: MockProxy<FilesystemService>;
  let service: GpuProcessSamplerService;

  beforeEach(() => {
    execMock.mockReset();
    filesystem = mock<FilesystemService>();
    service = new GpuProcessSamplerService(mock<LoggerService>(), filesystem);
    vi.useFakeTimers();
    vi.setSystemTime(WRITTEN_AT + 5_000);
  });

  it('reads the host file first and never asks the vendor tool when it is fresh', async () => {
    filesystem.readJsonFile.mockResolvedValue(BETA_RED_HOST_FILE);

    const samples = await service.sampleVramByProcess('nvidia');

    expect(samples.map((row) => [row.processName, row.vramMb])).toEqual([
      ['VLLM::EngineCore', 6104],
      ['/usr/bin/baobab', 22],
      ['/usr/local/lib/ollama/llama-server', 2926],
    ]);
    expect(filesystem.readJsonFile).toHaveBeenCalledWith(HOST_GPU_PROCESSES_FILE_PATH, expect.anything());
    expect(execMock).not.toHaveBeenCalled();
  });

  it('falls through to the vendor tool when there is no host file — a Hub run on the host keeps measuring', async () => {
    filesystem.readJsonFile.mockResolvedValue(null);
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (err: null, out: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '6975, VLLM::EngineCore, 6104\n', stderr: '' });
    });

    const samples = await service.sampleVramByProcess('nvidia');

    expect(samples).toEqual([{ pid: 6975, processName: 'VLLM::EngineCore', vramMb: 6104 }]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(String(execMock.mock.calls[0]?.[0])).toContain('nvidia-smi');
  });

  it('treats a stale host file as no file at all, so the tool is still tried', async () => {
    filesystem.readJsonFile.mockResolvedValue({ ...BETA_RED_HOST_FILE, sampledAt: new Date(WRITTEN_AT - 120_000).toISOString() });
    execMock.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      cb(new Error('nvidia-smi: not found'));
    });

    const samples = await service.sampleVramByProcess('nvidia');

    // Inside the fleet's Hub container this is the whole story: stale file, no tool, nothing measured.
    expect(samples).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('answers from the host file regardless of what the profile says the vendor is', async () => {
    filesystem.readJsonFile.mockResolvedValue(BETA_RED_HOST_FILE);

    expect(await service.sampleVramByProcess(undefined)).toHaveLength(3);
    expect(await service.sampleVramByProcess('apple')).toHaveLength(3);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('a fresh file that lists no processes is a measurement of an idle card, not a missing file', async () => {
    filesystem.readJsonFile.mockResolvedValue({ ...BETA_RED_HOST_FILE, processes: [] });

    expect(await service.sampleVramByProcess('nvidia')).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });
});
