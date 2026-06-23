import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('port-availability', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    vi.resetModules();
    vi.doUnmock('node:child_process');
  });

  it('reports occupied ports via TCP bind probe', async () => {
    const { isPortAvailable, isPortAvailableViaTcpBind } = await import('../port-availability');
    server = createServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected numeric port');
    }

    expect(isPortAvailableViaTcpBind(address.port)).toBe(false);
    expect(isPortAvailable(address.port)).toBe(false);
  });

  it('reports free ports via TCP bind probe', async () => {
    const { isPortAvailable, isPortAvailableViaTcpBind } = await import('../port-availability');
    expect(isPortAvailableViaTcpBind(59999)).toBe(true);
    expect(isPortAvailable(59999)).toBe(true);
  });

  it('uses lsof listen probe when execPath cannot run -e (compiled cihub)', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn((command: string, args?: readonly string[]) => {
        if (command === process.execPath && args?.[0] === '-e') {
          return { status: 2, stdout: '', stderr: 'Unknown command: -e' };
        }
        if (command === 'lsof') {
          expect(args).toEqual(['-nP', '-iTCP:8880', '-sTCP:LISTEN', '-t']);
          return { status: 1, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }),
    }));

    const { isPortAvailable } = await import('../port-availability');
    expect(isPortAvailable(8880)).toBe(true);
  });

  it('does not treat outbound HTTPS as local port 443 listen', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn((command: string, args?: readonly string[]) => {
        if (command === process.execPath && args?.[0] === '-e') {
          return { status: 2, stdout: '', stderr: '' };
        }
        if (command === 'lsof') {
          expect(args).toEqual(['-nP', '-iTCP:443', '-sTCP:LISTEN', '-t']);
          return { status: 1, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }),
    }));

    const { isPortAvailable } = await import('../port-availability');
    expect(isPortAvailable(443)).toBe(true);
  });
});
