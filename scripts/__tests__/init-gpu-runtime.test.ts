import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeFileSync = vi.fn();
const envFileVars = vi.hoisted(() => ({ value: {} as Record<string, string> }));

const GPU_NAME = 'NVIDIA GeForce RTX 4090';
/** nvidia-smi.exe's CSV row when a test puts it on PATH; null leaves it failing, as on a host without it. */
const nvidiaSmi = vi.hoisted(() => ({ row: null as string | null }));

/** A Windows host with an NVIDIA GPU as WMI reports it, and no `sh` on PATH to find docker with. */
vi.mock('node:child_process', () => ({
  spawnSync: (command: string, args: string[]) => {
    if (command === 'nvidia-smi' && nvidiaSmi.row) return { status: 0, stdout: nvidiaSmi.row, stderr: '' };
    const script = String(args.at(-1));
    if (command === 'powershell.exe' && script.includes('ConvertTo-Json')) {
      return { status: 0, stdout: JSON.stringify({ Name: GPU_NAME, AdapterRAM: 4293918720, DriverVersion: '32.0.15.6094' }), stderr: '' };
    }
    if (command === 'powershell.exe') return { status: 0, stdout: `${GPU_NAME}\r\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  },
}));

vi.mock('node:fs', () => ({
  existsSync: () => false,
  mkdirSync: vi.fn(),
  readFileSync: () => '',
  rmSync: vi.fn(),
  writeFileSync: (...args: unknown[]) => writeFileSync(...args),
}));

vi.mock('../env-file', () => ({ parseEnvFile: () => envFileVars.value }));

const { initGpuRuntime } = await import('../init-gpu-runtime');

/**
 * The same env file value as init-host-probe reads: Docker's form of the data dir. Read as a Windows
 * path, `cihub up` left an nvidia.json the Hub never reads under `C:\mnt\c\Users\...`.
 */
describe('initGpuRuntime on a Windows install', () => {
  const ENV_KEYS = ['ENV_FILE', 'ROOT_FOLDER_HOST', 'CI_HUB_STATE_PATH', 'STATE_PATH', 'CI_HUB_SKIP_GPU_TOOLKIT'] as const;
  const saved = new Map<string, string | undefined>();
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    writeFileSync.mockReset();
    process.env.ENV_FILE = 'C:\\Users\\hub\\AppData\\Roaming\\companion-hub\\.env';
    envFileVars.value = { ROOT_FOLDER_HOST: '/mnt/c/Users/hub/AppData/Roaming/companion-hub' };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    nvidiaSmi.row = null;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  // WMI's AdapterRAM is 32 bits, so the 24 GB card below reads 4095 MB there. The desktop app asks
  // nvidia-smi.exe first; `cihub up` now does the same, so both write the card's real size.
  it("writes nvidia-smi's figure when nvidia-smi.exe answers, not WMI's 4 GB cap, with updatedAt", () => {
    nvidiaSmi.row = `${GPU_NAME}, 24564, 581.80\n`;

    initGpuRuntime();

    const probe = JSON.parse(String(writeFileSync.mock.calls[0]?.[1]));
    expect(probe).toMatchObject({ model: GPU_NAME, vramMb: 24564, driverVersion: '581.80', source: 'host-nvidia-smi' });
    expect(Number.isFinite(Date.parse(probe.updatedAt))).toBe(true);
  });

  it('falls back to WMI without nvidia-smi.exe, still stamped', () => {
    initGpuRuntime();

    const probe = JSON.parse(String(writeFileSync.mock.calls[0]?.[1]));
    expect(probe).toMatchObject({ model: GPU_NAME, vramMb: 4095, source: 'host-windows-wmi' });
    expect(Number.isFinite(Date.parse(probe.updatedAt))).toBe(true);
  });

  it('writes the NVIDIA probe under the data dir the env file names, not under C:\\mnt', () => {
    initGpuRuntime();

    const written = String(writeFileSync.mock.calls[0]?.[0]);
    expect(written.startsWith('C:\\Users\\hub\\AppData\\Roaming\\companion-hub')).toBe(true);
    expect(written).toContain('nvidia.json');
  });
});
