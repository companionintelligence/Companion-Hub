import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException };

const spawn = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
  answer: (_command: string, _args: string[]): SpawnResult => ({ status: 1, stdout: '', stderr: '' }),
}));

vi.mock('node:child_process', () => ({
  spawnSync: (command: string, args: string[]) => {
    spawn.calls.push({ command, args });
    return spawn.answer(command, args);
  },
}));

// A Linux host with the NVIDIA driver loaded. Nothing is written to disk.
const fsWrites = vi.hoisted(() => ({ paths: [] as string[], contents: new Map<string, string>() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (target: string) => target === '/proc/driver/nvidia/gpus',
  mkdirSync: () => undefined,
  rmSync: () => undefined,
  writeFileSync: (target: string, data: string) => {
    fsWrites.paths.push(String(target));
    fsWrites.contents.set(String(target), String(data));
  },
}));

const { collectHostNvidiaProbe, initGpuRuntime } = await import('../init-gpu-runtime');

const ROW = 'NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 595.99.02\n';
const notFound = (): SpawnResult => ({
  status: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawnSync nvidia-smi ENOENT'), { code: 'ENOENT' }),
});

describe('collectHostNvidiaProbe', () => {
  beforeEach(() => {
    spawn.calls = [];
  });

  it('runs nvidia-smi itself, so a broken ~/.profile cannot stop the probe', () => {
    spawn.answer = (command) => {
      if (command === 'nvidia-smi') return { status: 0, stdout: ROW, stderr: '' };
      // What dash prints for a login shell whose profile sources a file that has gone.
      return { status: 2, stdout: '', stderr: 'sh: 34: .: cannot open /home/user/snap/code/249/.local/share/../bin/env: No such file' };
    };

    const probe = collectHostNvidiaProbe();

    expect(probe).toMatchObject({ model: 'NVIDIA GeForce RTX 3080 Laptop GPU', vramMb: 8192, driverVersion: '595.99.02', source: 'host-nvidia-smi' });
    expect(spawn.calls.map((call) => call.command)).toEqual(['nvidia-smi']);
  });

  it('falls back to a login shell only when nvidia-smi is not on PATH', () => {
    spawn.answer = (command, args) => {
      if (command === 'nvidia-smi') return notFound();
      if (command === 'sh' && args[1]?.startsWith('nvidia-smi --query-gpu=')) return { status: 0, stdout: ROW, stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };

    expect(collectHostNvidiaProbe()?.vramMb).toBe(8192);
    expect(spawn.calls.map((call) => call.command)).toEqual(['nvidia-smi', 'sh']);
  });

  it('writes no probe when the driver does not answer', () => {
    spawn.answer = (command) =>
      command === 'nvidia-smi'
        ? { status: 9, stdout: '', stderr: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' }
        : { status: 1, stdout: '', stderr: '' };

    expect(collectHostNvidiaProbe()).toBeNull();
    expect(spawn.calls.map((call) => call.command)).toEqual(['nvidia-smi']);
  });
});

// The output decides, not the exit code: nvidia-smi exits non-zero when one card of several cannot be
// read and still lists the rest. Through `sh -lc '… | head -n 1'` the exit code was head's.
describe('collectHostNvidiaProbe and nvidia-smi exit codes', () => {
  beforeEach(() => {
    spawn.calls = [];
  });

  it('writes the probe from a listed GPU even when nvidia-smi exits non-zero, logging the exit code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawn.answer = (command) =>
      command === 'nvidia-smi'
        ? { status: 15, stdout: ROW, stderr: 'Unable to determine the device handle for GPU0002:00:00.0: Unknown Error' }
        : { status: 1, stdout: '', stderr: '' };

    const probe = collectHostNvidiaProbe();

    expect(probe).toMatchObject({ model: 'NVIDIA GeForce RTX 3080 Laptop GPU', vramMb: 8192 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exit code 15'));
    warn.mockRestore();
  });

  // nvidia-smi prints these on stdout, with stderr empty.
  it.each([
    [6, 'No devices were found\n'],
    [18, 'Failed to initialize NVML: Driver/library version mismatch\nNVML library version: 595.99\n'],
  ])('writes no probe from an error line after exit code %i', (status, stdout) => {
    spawn.answer = (command) => (command === 'nvidia-smi' ? { status, stdout, stderr: '' } : { status: 1, stdout: '', stderr: '' });

    expect(collectHostNvidiaProbe()).toBeNull();
  });

  it('still takes a real row that follows an error line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawn.answer = (command) =>
      command === 'nvidia-smi'
        ? { status: 15, stdout: `Unable to determine the device handle for GPU0002:00:00.0: Unknown Error\n${ROW}`, stderr: '' }
        : { status: 1, stdout: '', stderr: '' };

    expect(collectHostNvidiaProbe()).toMatchObject({ model: 'NVIDIA GeForce RTX 3080 Laptop GPU', vramMb: 8192 });
    warn.mockRestore();
  });
});

describe('initGpuRuntime on a Linux host whose ~/.profile stops a login shell', () => {
  const originalPlatform = process.platform;
  const savedStatePath = process.env.CI_HUB_STATE_PATH;
  const savedSkip = process.env.CI_HUB_SKIP_GPU_TOOLKIT;

  beforeEach(() => {
    spawn.calls = [];
    fsWrites.paths = [];
    fsWrites.contents.clear();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.CI_HUB_STATE_PATH = '/srv/hub-data';
    delete process.env.CI_HUB_SKIP_GPU_TOOLKIT;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (savedStatePath === undefined) delete process.env.CI_HUB_STATE_PATH;
    else process.env.CI_HUB_STATE_PATH = savedStatePath;
    if (savedSkip !== undefined) process.env.CI_HUB_SKIP_GPU_TOOLKIT = savedSkip;
    vi.restoreAllMocks();
  });

  it('still finds docker and writes nvidia.json: only a login shell reads the profile', () => {
    spawn.answer = (command, args) => {
      // Every login shell dies on the profile, as dash does on a `.` of a file that has gone.
      if (command === 'sh' && args[0] === '-lc') return { status: 2, stdout: '', stderr: 'sh: 34: .: cannot open /home/user/bin/env: No such file' };
      if (command === 'sh' && args[0] === '-c') return { status: 0, stdout: '', stderr: '' };
      if (command === 'nvidia-smi') return { status: 0, stdout: ROW, stderr: '' };
      if (command === 'docker') return { status: 0, stdout: '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };

    initGpuRuntime();

    expect(fsWrites.paths).toContain('/srv/hub-data/state/hardware/nvidia.json');
    expect(spawn.calls).toContainEqual({ command: 'sh', args: ['-c', 'command -v docker >/dev/null 2>&1'] });
  });

  it('still finds rocm-smi on an AMD host without /dev/kfd: the ROCm probe runs it directly too', () => {
    spawn.answer = (command, args) => {
      if (command === 'sh' && args[0] === '-lc') return { status: 2, stdout: '', stderr: 'sh: 34: .: cannot open /home/user/bin/env: No such file' };
      if (command === 'rocm-smi') return { status: 0, stdout: 'ROCM-SMI version: 3.0.0\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };

    initGpuRuntime();

    const rocm = fsWrites.contents.get('/srv/hub-data/state/hardware/rocm.json');
    expect(rocm && JSON.parse(rocm)).toMatchObject({ available: false, source: 'host-rocm-smi' });
  });
});
