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
  Self: { HostName: 'hub', DNSName: 'hub-1.capybara-ulmer.ts.net.', TailscaleIPs: ['100.1.1.1'] },
  MagicDNSSuffix: 'capybara-ulmer.ts.net',
  CurrentTailnet: { Name: 'liam.broza@gmail.com', MagicDNSSuffix: 'capybara-ulmer.ts.net' },
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
    expect(status.nodeFqdn).toBe('hub-1.capybara-ulmer.ts.net');
    expect(status.tailnet).toBe('capybara-ulmer.ts.net');
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
        '--advertise-routes=172.18.0.0/16',
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

    await service.unservePort(3001);

    expect(execFileMock).toHaveBeenCalledWith(
      'docker',
      ['exec', 'hub-tailscale', 'tailscale', 'serve', '--https=3001', 'off'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('getServeStatus parses direct-port and service entries', async () => {
    const serveStatusJson = JSON.stringify({
      Web: {
        'hub-tailscale-1.capybara-ulmer.ts.net:3001': {
          '/': { Proxy: 'http://172.18.0.10:3001' },
        },
      },
      Services: {
        'svc:bitboard': {
          Dest: 'http://172.18.0.11:3711',
        },
      },
    });

    execFileMock.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string, stderr?: string) => void) => {
        if (cmd === 'docker' && args[1] === 'hub-tailscale' && args[3] === 'version') {
          process.nextTick(() => cb(null, '1.98.0', ''));
          return;
        }
        if (cmd === 'docker' && args.includes('serve') && args.includes('status') && args.includes('--json')) {
          process.nextTick(() => cb(null, serveStatusJson, ''));
          return;
        }
        process.nextTick(() => cb(new Error('unexpected'), '', ''));
      },
    );

    await expect(service.getServeStatus()).resolves.toEqual({
      entries: [
        {
          service: 'bitboard',
          proto: 'https',
          mountPoint: '/',
          dest: 'http://172.18.0.11:3711',
          rawServiceName: 'svc:bitboard',
        },
        {
          service: '3001',
          proto: 'https',
          mountPoint: '/',
          dest: 'http://172.18.0.10:3001',
          listenPort: 3001,
        },
      ],
    });
  });
});
