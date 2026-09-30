import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { procNetTcpHasListener } from '../port-availability';

/** `/proc/net/tcp`: 127.0.0.1:8080 listening, and an established connection from local port 80. */
const PROC_NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41275 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:0050 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 41276 1 0000000000000000 20 4 30 10 -1',
  '   2: 0100007F:0035 0100007F:C3D4 06 00000000:00000000 03:00001524 00000000     0        0 0 3 0000000000000000',
].join('\n');

/** `/proc/net/tcp6`: [::]:443 listening. */
const PROC_NET_TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22817 1 0000000000000000 100 0 0 10 0',
].join('\n');

/** Run `body` as if on `platform`, from a compiled `cihub` whose only port check is the external one. */
async function asCompiledCihub<T>(platform: NodeJS.Platform, execPath: string, body: () => Promise<T>): Promise<T> {
  const original = { platform: process.platform, execPath: process.execPath };
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'execPath', { configurable: true, value: execPath });
  try {
    return await body();
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original.platform });
    Object.defineProperty(process, 'execPath', { configurable: true, value: original.execPath });
  }
}

describe('procNetTcpHasListener', () => {
  it('finds a listener in the IPv4 table', () => {
    expect(procNetTcpHasListener(PROC_NET_TCP, 8080)).toBe(true);
  });

  it('finds a listener in the IPv6 table', () => {
    expect(procNetTcpHasListener(PROC_NET_TCP6, 443)).toBe(true);
  });

  it('ignores sockets on the port that are not listening', () => {
    // 80 is ESTABLISHED (01) and 53 is TIME_WAIT (06).
    expect(procNetTcpHasListener(PROC_NET_TCP, 80)).toBe(false);
    expect(procNetTcpHasListener(PROC_NET_TCP, 53)).toBe(false);
  });

  it('ignores listeners on other ports', () => {
    expect(procNetTcpHasListener(PROC_NET_TCP, 8081)).toBe(false);
    // 0x90 is the tail of 0x1F90, and must not match it.
    expect(procNetTcpHasListener(PROC_NET_TCP, 0x90)).toBe(false);
    expect(procNetTcpHasListener(PROC_NET_TCP6, 80)).toBe(false);
  });

  it('finds nothing in an empty or header-only table', () => {
    expect(procNetTcpHasListener('', 8080)).toBe(false);
    expect(procNetTcpHasListener(PROC_NET_TCP.split('\n')[0] ?? '', 8080)).toBe(false);
  });
});

describe('port-availability', () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    vi.resetModules();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
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

  it('uses lsof listen probe for compiled cihub without self-spawning execPath', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn((command: string, args?: readonly string[]) => {
        if (command.includes('cihub')) {
          throw new Error('compiled cihub must not spawn itself');
        }
        if (command === 'lsof') {
          expect(args).toEqual(['-nP', '-iTCP:8880', '-sTCP:LISTEN', '-t']);
          return { status: 1, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }),
    }));

    await asCompiledCihub('darwin', '/usr/local/bin/cihub', async () => {
      const { isPortAvailable } = await import('../port-availability');
      expect(isPortAvailable(8880)).toBe(true);
    });
  });

  it('does not treat outbound HTTPS as local port 443 listen', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn((command: string, args?: readonly string[]) => {
        if (command === 'lsof') {
          expect(args).toEqual(['-nP', '-iTCP:443', '-sTCP:LISTEN', '-t']);
          return { status: 1, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      }),
    }));

    await asCompiledCihub('darwin', '/Users/me/.local/bin/cihub', async () => {
      const { isPortAvailable } = await import('../port-availability');
      expect(isPortAvailable(443)).toBe(true);
    });
  });

  describe('on Linux without ss', () => {
    const spawned: string[] = [];

    /** No `ss`, and BusyBox's `lsof`, which ignores its flags and lists every open file with exit 0. */
    function mockAlpineTools(tables: Record<string, string>) {
      spawned.length = 0;
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string) => {
          spawned.push(command);
          if (command === 'lsof') return { status: 0, stdout: '1\t/bin/busybox\t0\t/dev/null\n1\t/bin/busybox\t1\t/dev/null\n', stderr: '' };
          return { status: null, stdout: '', stderr: '', error: new Error(`spawnSync ${command} ENOENT`) };
        }),
      }));
      vi.doMock('node:fs', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs')>();
        const readFileSync = (file: string) => {
          const table = tables[file];
          if (table === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
          return table;
        };
        return { ...actual, readFileSync: readFileSync as typeof actual.readFileSync };
      });
    }

    // Regression (CI-Hub#1699): `cihub up` on Alpine stopped at "Cannot find available host port
    // near 8880 for HTTP_PORT (80 is occupied)" with nothing listening on port 80.
    it('reads the kernel tables, and never asks lsof', async () => {
      mockAlpineTools({ '/proc/net/tcp': PROC_NET_TCP, '/proc/net/tcp6': PROC_NET_TCP6 });

      await asCompiledCihub('linux', '/usr/local/bin/cihub', async () => {
        const { isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(80)).toBe(true);
        expect(isPortAvailable(8080)).toBe(false);
        expect(isPortAvailable(443)).toBe(false);
      });
      expect(spawned).not.toContain('lsof');
    });

    it('still answers from the IPv4 table on a kernel without IPv6', async () => {
      mockAlpineTools({ '/proc/net/tcp': PROC_NET_TCP });

      await asCompiledCihub('linux', '/usr/local/bin/cihub', async () => {
        const { isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(8080)).toBe(false);
        expect(isPortAvailable(443)).toBe(true);
      });
    });
  });
});
