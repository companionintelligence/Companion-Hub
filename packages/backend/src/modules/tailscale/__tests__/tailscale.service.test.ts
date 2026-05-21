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

  it('startAuth includes --reset on sidecar strategy', async () => {
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

    await service.startAuth();

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === 'docker' && args.includes('up'));
    expect(upCall[1]).toContain('--reset');
  });

  it('startAuth does not include --reset on host strategy', async () => {
    vi.mocked(access).mockResolvedValue(undefined); // binary + socket accessible

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === '/usr/bin/tailscale' && args.includes('version')) {
          process.nextTick(() => cb(null, '1.82.0\n', ''));
          return;
        }
        if (cmd === '/usr/bin/tailscale' && args.includes('up') && args.includes('--json')) {
          process.nextTick(() => cb(null, JSON.stringify({ AuthURL: 'https://login.test/auth' }), ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.test/auth');

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === '/usr/bin/tailscale' && args.includes('up'));
    expect(upCall).toBeDefined();
    expect(upCall[1]).not.toContain('--reset');
  });

  it('connectWithAuthKey invokes tailscale up via sidecar (includes --reset)', async () => {
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

  it('connectWithAuthKey does not include --reset on host strategy', async () => {
    vi.mocked(access).mockResolvedValue(undefined); // binary + socket accessible

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === '/usr/bin/tailscale' && args.includes('version')) {
          process.nextTick(() => cb(null, '1.82.0\n', ''));
          return;
        }
        if (cmd === '/usr/bin/tailscale' && args.includes('up') && args.includes('--auth-key')) {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.connectWithAuthKey('tskey-auth-testkey');

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === '/usr/bin/tailscale' && args.includes('up'));
    expect(upCall).toBeDefined();
    expect(upCall[1]).toContain('--auth-key');
    expect(upCall[1]).not.toContain('--reset');
  });

  it('connectWithAuthKey waits for sidecar daemon before running tailscale up', async () => {
    const callOrder: string[] = [];
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          callOrder.push('status');
          process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'NeedsLogin' }), ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up') && args.includes('--auth-key')) {
          callOrder.push('up');
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.connectWithAuthKey('tskey-auth-testkey');

    expect(callOrder).toEqual(['status', 'up']);
  });

  it('connectWithAuthKey rejects invalid key prefix', async () => {
    await expect(service.connectWithAuthKey('not-a-key')).rejects.toThrow(/tskey-auth/);
  });

  it('startAuth waits for sidecar daemon before running tailscale up', async () => {
    const callOrder: string[] = [];
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          callOrder.push('status');
          process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'NeedsLogin' }), ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up') && args.includes('--json')) {
          callOrder.push('up');
          process.nextTick(() => cb(null, JSON.stringify({ AuthURL: 'https://login.test/auth' }), ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.test/auth');
    expect(callOrder).toEqual(['status', 'up']);
  });

  describe('waitForSidecarDaemon', () => {
    it('returns immediately when daemon responds (including non-zero exits like NeedsLogin)', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
          // NeedsLogin: daemon responds but exits non-zero — "ready enough"
          process.nextTick(() => cb(new Error('exit code 1'), '', '{"BackendState":"NeedsLogin"}'));
        },
      );

      await (service as any).waitForSidecarDaemon(3, 0);
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('retries on socket-not-ready errors (EOF) until daemon responds', async () => {
      let callCount = 0;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
          callCount++;
          if (callCount < 3) {
            process.nextTick(() => cb(new Error('read unix /var/run/tailscale/tailscaled.sock: EOF'), '', ''));
          } else {
            process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'Running' }), ''));
          }
        },
      );

      await (service as any).waitForSidecarDaemon(5, 0);
      expect(callCount).toBe(3);
    });

    it('throws after exhausting all retry attempts on persistent EOF', async () => {
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
          process.nextTick(() => cb(new Error('EOF'), '', ''));
        },
      );

      await expect((service as any).waitForSidecarDaemon(3, 0)).rejects.toThrow(/not ready/);
      expect(execFileMock).toHaveBeenCalledTimes(3);
    });
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
