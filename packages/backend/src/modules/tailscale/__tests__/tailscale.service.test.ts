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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isServePermissionDenied, servePermissionCommand, servePermissionRemedy, TailscaleService } from '../tailscale.service';
import { CORE_6_SERVE_STATUS, CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR, HUB_SERVE_COMMAND, SERVE_CONFIG_DENIED_STDERR } from './serve-captures';

const runningStatusJson = JSON.stringify({
  Version: '1.82.0',
  BackendState: 'Running',
  Self: { HostName: 'hub', DNSName: 'hub-1.example.ts.net.', TailscaleIPs: ['100.1.1.1'] },
  MagicDNSSuffix: 'example.ts.net',
  CurrentTailnet: { Name: 'operator@example.com', MagicDNSSuffix: 'example.ts.net' },
});

describe('TailscaleService', () => {
  let service: TailscaleService;

  beforeEach(() => {
    execFileMock.mockReset();
    vi.mocked(access).mockReset();
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
    delete process.env.HUB_TAILSCALE_EXTRA_ARGS;
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
    expect(status.nodeFqdn).toBe('hub-1.example.ts.net');
    expect(status.tailnet).toBe('example.ts.net');
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
        if (cmd === 'docker' && args.includes('up')) {
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.tailscale.com/a/test-auth');
  });

  it('startAuth includes --reset on sidecar strategy', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.startAuth();

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === 'docker' && args.includes('up'));
    expect(upCall[1]).toContain('--reset');
    expect(upCall[1]).not.toContain('--json');
  });

  it('startAuth does not include --reset on host strategy', async () => {
    vi.mocked(access).mockResolvedValue(undefined); // binary + socket accessible

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === '/usr/bin/tailscale' && args.includes('version')) {
          process.nextTick(() => cb(null, '1.82.0\n', ''));
          return;
        }
        if (cmd === '/usr/bin/tailscale' && args.includes('up')) {
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.tailscale.com/a/test-auth');

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === '/usr/bin/tailscale' && args.includes('up'));
    expect(upCall).toBeDefined();
    expect(upCall[1]).not.toContain('--reset');
    expect(upCall[1]).not.toContain('--json');
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
        '--login-server=https://controlplane.tailscale.com',
        '--accept-routes',
        '--advertise-routes=172.18.0.0/16,172.19.0.0/16',
      ],
      expect.objectContaining({ timeout: 120_000 }),
      expect.any(Function),
    );
  });

  it('prepends the Tailscale control server when custom extra args omit one', async () => {
    process.env.HUB_TAILSCALE_EXTRA_ARGS = '--accept-routes --advertise-routes=10.0.0.0/24';

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

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === 'docker' && args.includes('up'));
    expect(upCall?.[1]).toContain('--login-server=https://controlplane.tailscale.com');
  });

  it('preserves an explicit login server override in custom extra args', async () => {
    process.env.HUB_TAILSCALE_EXTRA_ARGS = '--login-server=https://headscale.example --accept-routes';

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

    const upCall = execFileMock.mock.calls.find(([cmd, args]: [string, string[]]) => cmd === 'docker' && args.includes('up'));
    expect(upCall?.[1]).toContain('--login-server=https://headscale.example');
    expect(upCall?.[1]).not.toContain('--login-server=https://controlplane.tailscale.com');
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
        if (cmd === 'docker' && args.includes('up')) {
          callOrder.push('up');
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.tailscale.com/a/test-auth');
    expect(callOrder).toEqual(['status', 'status', 'up']);
  });

  it('startAuth reuses existing AuthURL from status without running tailscale up', async () => {
    const callOrder: string[] = [];
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          callOrder.push('status');
          process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/existing' }), ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          callOrder.push('up');
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.tailscale.com/a/existing');
    expect(callOrder).toEqual(['status', 'status']);
  });

  it('startAuth extracts auth URL when tailscale up exits non-zero with output', async () => {
    let statusCallCount = 0;
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          statusCallCount++;
          if (statusCallCount === 1) {
            process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'NoState' }), ''));
          } else {
            process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'NeedsLogin' }), ''));
          }
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          const err = Object.assign(new Error('Command failed'), {
            stderr: 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth',
            stdout: '',
          });
          process.nextTick(() => cb(err, '', 'To authenticate, visit:\nhttps://login.tailscale.com/a/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://login.tailscale.com/a/test-auth');
  });

  it('startAuth extracts auth URL for custom login-server host', async () => {
    process.env.HUB_TAILSCALE_EXTRA_ARGS = '--login-server=https://headscale.example --accept-routes';

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          process.nextTick(() => cb(null, '', 'To authenticate, visit:\nhttps://headscale.example/register/test-auth'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('https://headscale.example/register/test-auth');
  });

  it('startAuth checks status via the same strategy used for tailscale up', async () => {
    let accessCalls = 0;
    vi.mocked(access).mockImplementation(async () => {
      accessCalls++;
      if (accessCalls <= 2) {
        throw new Error('ENOENT');
      }
    });

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === '/usr/bin/tailscale' && args.includes('version')) {
          process.nextTick(() => cb(null, '1.82.0\n', ''));
          return;
        }
        if (cmd === '/usr/bin/tailscale' && args.includes('status') && args.includes('--json')) {
          process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'Running', Version: '1.82.0' }), ''));
          return;
        }
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          (service as any).strategyCache = { value: 'sidecar', expires: Date.now() - 1 };
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          process.nextTick(() => cb(null, JSON.stringify({ BackendState: 'Running', Version: '1.82.0' }), ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    const result = await service.startAuth();
    expect(result.authUrl).toBe('');

    const dockerStatusCalls = execFileMock.mock.calls.filter(
      ([cmd, args]: [string, string[]]) => cmd === 'docker' && args.includes('status') && args.includes('--json'),
    );
    const hostStatusCalls = execFileMock.mock.calls.filter(
      ([cmd, args]: [string, string[]]) => cmd === '/usr/bin/tailscale' && args.includes('status') && args.includes('--json'),
    );

    expect(dockerStatusCalls.length).toBeGreaterThan(0);
    expect(hostStatusCalls.length).toBe(0);
  });

  it('startAuth preserves tailscale up output when post-up status check fails', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.82.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('up')) {
          process.nextTick(() => cb(null, 'tailscale up completed with no auth URL', 'NeedsLogin state detected'));
          return;
        }
        if (cmd === 'docker' && args.includes('status') && args.includes('--json')) {
          const err = Object.assign(new Error('status command failed'), {
            stderr: 'transient tailscale status failure',
            stdout: '',
          });
          process.nextTick(() => cb(err, '', 'transient tailscale status failure'));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await expect(service.startAuth()).rejects.toThrow('Failed to start Tailscale auth. Check server logs for details.');
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
        if (cmd === 'docker' && args[2] === 'sh' && args[3] === '-c') {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.disconnect();

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      [
        'exec',
        'hub-tailscale',
        'sh',
        '-c',
        'kill -9 $(pidof tailscaled 2>/dev/null) >/dev/null 2>&1 || true; rm -f /var/lib/tailscale/tailscaled.state',
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('disconnect uses host strategy (tailscale down)', async () => {
    vi.mocked(access).mockResolvedValue(undefined); // binary + socket accessible

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === '/usr/bin/tailscale' && args.includes('version')) {
          process.nextTick(() => cb(null, '1.82.0\n', ''));
          return;
        }
        if (cmd === '/usr/bin/tailscale' && args.includes('down')) {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.disconnect();

    expect(execFileMock).toHaveBeenCalledWith('/usr/bin/tailscale', ['down'], expect.any(Object), expect.any(Function));
  });

  it('serveApp publishes a dedicated https port to the provided upstream', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.98.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('serve') && args.includes('--https=3001')) {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await service.serveApp({
      appName: 'anything-llm',
      httpsPort: 3001,
      upstreamUrl: 'http://172.18.0.10:3001',
    });

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      ['exec', 'hub-tailscale', 'tailscale', 'serve', '--bg', '--yes', '--https=3001', 'http://172.18.0.10:3001'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('unservePort removes a dedicated https port mapping', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.98.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('serve') && args.includes('--https=3001') && args.includes('off')) {
          process.nextTick(() => cb(null, '', ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await expect(service.unservePort(3001)).resolves.toBe(true);

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      ['exec', 'hub-tailscale', 'tailscale', 'serve', '--https=3001', 'off'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('unservePort reports a failed removal instead of throwing, so the sync keeps the port as its own', async () => {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.98.0', ''));
          return;
        }
        process.nextTick(() => cb(new Error('Command failed: tailscale serve --https=3001 off'), '', 'error: handler does not exist\n'));
      },
    );

    await expect(service.unservePort(3001)).resolves.toBe(false);
  });

  /** Answers `serve status --json` from the sidecar with `stdout`; anything else is unexpected. */
  function mockSidecarServeStatus(stdout: string) {
    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.98.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('serve') && args.includes('status') && args.includes('--json')) {
          process.nextTick(() => cb(null, stdout, ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );
  }

  it('getServeStatus reads the proxy target under Handlers, where tailscale actually prints it', async () => {
    // The fixture this replaced put `/` directly under the listener. Real output nests it under
    // `Handlers`, so the parser reported mount `Handlers` with no target and the sync re-ran
    // `tailscale serve` on every appliance every five minutes.
    mockSidecarServeStatus(CORE_6_SERVE_STATUS);

    await expect(service.getServeStatus()).resolves.toEqual({
      entries: [
        {
          service: '443',
          proto: 'https',
          mountPoint: '/',
          dest: 'http://localhost:5002',
          listenPort: 443,
          host: 'core-6.tailxyz.ts.net',
        },
      ],
    });
  });

  it('getServeStatus keeps a listener per node name so a stale pre-rename listener is not mistaken for the current one', async () => {
    mockSidecarServeStatus(CORE_17_SERVE_STATUS_AFTER_MANUAL_REPAIR);

    const { entries } = await service.getServeStatus();

    expect(entries.map((entry) => [entry.host, entry.listenPort, entry.mountPoint, entry.dest])).toEqual([
      ['bench-1.tailxyz.ts.net', 443, '/', 'http://localhost:5002'],
      ['core-17.tailxyz.ts.net', 443, '/', 'http://localhost:5002'],
    ]);
  });

  it('getServeStatus lists Tailscale Services apart from port listeners', async () => {
    mockSidecarServeStatus(JSON.stringify({ Services: { 'svc:bitboard': { Dest: 'http://172.18.0.11:3711' } } }));

    await expect(service.getServeStatus()).resolves.toEqual({
      entries: [
        {
          service: 'bitboard',
          proto: 'https',
          mountPoint: '/',
          dest: 'http://172.18.0.11:3711',
          rawServiceName: 'svc:bitboard',
        },
      ],
    });
  });

  describe('isServePermissionDenied', () => {
    it('recognises the operator refusal tailscale printed on beta-ms-a2, whether it arrives in the message or in stderr', () => {
      // Node puts stderr into `message` for execFile failures; the service also attaches it as
      // `stderr`, so either path must be enough.
      expect(isServePermissionDenied(new Error(`Command failed: ${HUB_SERVE_COMMAND}\n${SERVE_CONFIG_DENIED_STDERR}`))).toBe(true);
      expect(isServePermissionDenied(Object.assign(new Error(`Command failed: ${HUB_SERVE_COMMAND}`), { stderr: SERVE_CONFIG_DENIED_STDERR }))).toBe(
        true,
      );
    });

    it('does not claim a tailnet without HTTPS or a failed exec is a permission problem', () => {
      // Those failures have their own handling (the enable-Serve toast, the per-pass error log);
      // folding them into the once-only operator warning would hide them.
      expect(isServePermissionDenied(new Error('Serve is not enabled on your tailnet.'))).toBe(false);
      expect(isServePermissionDenied(new Error('Tailscale CLI unavailable (no host socket and no sidecar)'))).toBe(false);
      expect(isServePermissionDenied('serve config denied')).toBe(false);
    });
  });

  describe('servePermissionRemedy', () => {
    /** The command Settings → Network shows and copies, which the log line names too. */
    const commandFor = (uid: number) => servePermissionCommand(uid);

    /** Runs `command` in a real shell with a `sudo` that records its arguments instead of escalating. */
    async function runWithRecordingSudo(command: string): Promise<{ sudoCalls: string[]; exitedCleanly: boolean }> {
      // The backend test setup swaps `node:fs` for an in-memory volume, and this file mocks
      // `child_process`; the shell and its `sudo` stub need the real ones.
      const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
      const dir = mkdtempSync(join(tmpdir(), 'operator-remedy-'));
      try {
        const log = join(dir, 'sudo.log');
        writeFileSync(join(dir, 'sudo'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
        chmodSync(join(dir, 'sudo'), 0o755);
        let exitedCleanly = true;
        try {
          execFileSync('sh', ['-c', command], { env: { PATH: `${dir}:/usr/bin:/bin` }, stdio: 'pipe' });
        } catch {
          exitedCleanly = false;
        }
        const sudoCalls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
        return { sudoCalls, exitedCleanly };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("names the Hub's uid rather than $USER, which expands to whoever pastes it", () => {
      expect(servePermissionRemedy(1000)).toContain('id -nu 1000');
      expect(servePermissionRemedy(1000)).toContain('(the Hub runs as uid 1000)');
      expect(servePermissionRemedy(1000)).not.toContain('$USER');
    });

    it.skipIf(process.platform === 'win32')('sets the operator to the host account that owns the uid when pasted into a shell', async () => {
      await expect(runWithRecordingSudo(commandFor(0))).resolves.toEqual({ sudoCalls: ['tailscale set --operator=root'], exitedCleanly: true });
    });

    it.skipIf(process.platform === 'win32')(
      'runs nothing for a uid with no host account, where an empty --operator= would clear the operator the host already has',
      async () => {
        await expect(runWithRecordingSudo(commandFor(2_147_483_000))).resolves.toEqual({ sudoCalls: [], exitedCleanly: false });
      },
    );

    it('falls back to a placeholder where the platform has no uid', () => {
      expect(servePermissionRemedy(null)).toContain('sudo tailscale set --operator=<user>');
      expect(servePermissionCommand(null)).toBe('sudo tailscale set --operator=<user>');
    });

    it('logs the same command the Hub page copies, followed only by which uid it is for', () => {
      expect(servePermissionRemedy(1000)).toBe(`${servePermissionCommand(1000)} (the Hub runs as uid 1000)`);
    });
  });

  describe('servePermission', () => {
    it('reports no refusal until the sync records one', () => {
      expect(service.getServePermission()).toEqual({ denied: false, remedy: null, deniedSince: null });
    });

    it('keeps when a refusal began, with the command that ends it, until a write succeeds', () => {
      const began = new Date('2026-10-01T09:00:00.000Z');

      expect(service.recordServePermissionDenied(began)).toBe(true);
      // The same refusal on a later pass changes nothing, so open pages are not told again.
      expect(service.recordServePermissionDenied(new Date('2026-10-01T09:05:00.000Z'))).toBe(false);
      expect(service.getServePermission()).toEqual({ denied: true, remedy: servePermissionCommand(), deniedSince: '2026-10-01T09:00:00.000Z' });

      expect(service.recordServePermissionGranted()).toBe(true);
      expect(service.recordServePermissionGranted()).toBe(false);
      expect(service.getServePermission()).toEqual({ denied: false, remedy: null, deniedSince: null });
    });
  });
});
