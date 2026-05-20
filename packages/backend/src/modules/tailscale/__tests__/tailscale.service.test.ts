import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  constants: { X_OK: 1, R_OK: 4, W_OK: 2 },
}));

import { access } from 'node:fs/promises';
import { TailscaleService } from '../tailscale.service';

const runningStatusJson = JSON.stringify({
  Version: '1.82.0',
  BackendState: 'Running',
  Self: { HostName: 'hub', TailscaleIPs: ['100.1.1.1'] },
  CurrentTailnet: { Name: 'test.ts.net' },
});

describe('TailscaleService', () => {
  let service: TailscaleService;

  beforeEach(() => {
    execFileMock.mockReset();
    vi.mocked(access).mockReset();
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
    service = new TailscaleService();
  });

  it('uses docker sidecar when host binary/socket are missing', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args[args.length - 1] === '--json') {
          process.nextTick(() => cb(null, runningStatusJson, ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const status = await service.getStatus();
    expect(status.installed).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.ip).toBe('100.1.1.1');
    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      ['exec', 'hub-tailscale', 'tailscale', 'status', '--json'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('startAuth uses docker sidecar when host unavailable', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up') && args.includes('--json')) {
          process.nextTick(() => cb(null, JSON.stringify({ AuthURL: 'https://login.test/auth' }), ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.test/auth');
  });

  it('connectWithAuthKey invokes tailscale up via sidecar', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up') && args.includes('--auth-key')) {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.connectWithAuthKey('tskey-auth-testkey');

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        'hub-tailscale',
        'tailscale',
        'up',
        '--reset',
        '--auth-key',
        'tskey-auth-testkey',
        '--accept-routes',
        '--advertise-routes=172.18.0.0/16',
      ],
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it('connectWithAuthKey rejects invalid key prefix', async () => {
    await expect(service.connectWithAuthKey('not-a-key')).rejects.toThrow(/tskey-auth/);
  });

  it('disconnect uses docker sidecar when host unavailable', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args[args.length - 1] === 'down') {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.disconnect();

    expect(execFileMock).toHaveBeenCalledWith('docker', ['exec', 'hub-tailscale', 'tailscale', 'down'], expect.any(Object), expect.any(Function));
  });
});
