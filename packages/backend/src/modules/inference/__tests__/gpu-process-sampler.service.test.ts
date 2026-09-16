import { describe, expect, it } from 'vitest';
import { parseNvidiaSmiComputeApps, parseRocmSmiShowPids } from '../gpu-process-sampler.service';

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
