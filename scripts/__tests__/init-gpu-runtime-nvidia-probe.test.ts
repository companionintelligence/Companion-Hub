import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { collectHostNvidiaProbe } = await import('../init-gpu-runtime');

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
