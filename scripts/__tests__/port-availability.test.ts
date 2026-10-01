import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { procNetTcpHasListener, procNetTcpListenerInodes } from '../port-availability';

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

/** `docker info --format '{{json .SecurityOptions}}'` from a rootful and a rootless engine. */
const ROOTFUL_SECURITY_OPTIONS = '["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]';
const ROOTLESS_SECURITY_OPTIONS = '["name=apparmor","name=seccomp,profile=builtin","name=rootless","name=cgroupns"]';

/** A normal user on Linux, where the kernel refuses a bind on port 1 (`net.ipv4.ip_unprivileged_port_start` above it). */
const KERNEL_REFUSES_PORT_1 = (() => {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return false;
  try {
    return Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf-8')) > 1;
  } catch {
    return false;
  }
})();

/**
 * The exit status the bind probe's own `-e` script chooses, run against a stand-in `net` whose
 * `listen` the kernel refuses with EACCES below 1024, as it does a normal user on Linux.
 */
function runBindProbe(script: string): number {
  let status: number | undefined;
  let onError: (error: NodeJS.ErrnoException) => void = () => {};
  const server = {
    once(_event: string, handler: (error: NodeJS.ErrnoException) => void) {
      onError = handler;
      return server;
    },
    listen(port: number, _host: string, onListening: () => void) {
      if (port < 1024) onError(Object.assign(new Error(`listen EACCES: permission denied 127.0.0.1:${port}`), { code: 'EACCES' }));
      else onListening();
      return server;
    },
  };
  const exit = (code: number) => {
    status ??= code;
  };
  runInNewContext(script, { require: () => ({ createServer: () => server }), process: { exit } });
  return status ?? -1;
}

/** Serve `/proc/net/tcp{,6}` from `tables`; a table left out does not exist. */
function mockProcNetTcp(tables: Record<string, string>) {
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

/** Run `body` as if on `platform` from `execPath`. A compiled `cihub` skips the bind probe, so its only port check is the external one. */
async function asProcess<T>(platform: NodeJS.Platform, execPath: string, body: () => Promise<T>): Promise<T> {
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

describe('procNetTcpListenerInodes', () => {
  it("names the listening socket's inode, and not a connection's on the same port", () => {
    expect(procNetTcpListenerInodes(PROC_NET_TCP, 8080)).toEqual(['41275']);
    expect(procNetTcpListenerInodes(PROC_NET_TCP6, 443)).toEqual(['22817']);
    expect(procNetTcpListenerInodes(PROC_NET_TCP, 80)).toEqual([]);
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
    const { isPortAvailable, probeTcpBind } = await import('../port-availability');
    server = createServer();
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected numeric port');
    }

    expect(probeTcpBind(address.port)).toBe('in-use');
    expect(isPortAvailable(address.port)).toBe(false);
  });

  it('reports free ports via TCP bind probe', async () => {
    const { isPortAvailable, probeTcpBind } = await import('../port-availability');
    expect(probeTcpBind(59999)).toBe('free');
    expect(isPortAvailable(59999)).toBe(true);
  });

  it.runIf(KERNEL_REFUSES_PORT_1)('tells a bind the kernel refuses from a port in use', async () => {
    const { probeTcpBind } = await import('../port-availability');
    expect(probeTcpBind(1)).toBe('refused');
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

    await asProcess('darwin', '/usr/local/bin/cihub', async () => {
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

    await asProcess('darwin', '/Users/me/.local/bin/cihub', async () => {
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
      mockProcNetTcp(tables);
    }

    // Regression (CI-Hub#1699): `cihub up` on Alpine stopped at "Cannot find available host port
    // near 8880 for HTTP_PORT (80 is occupied)" with nothing listening on port 80.
    it('reads the kernel tables, and never asks lsof', async () => {
      mockAlpineTools({ '/proc/net/tcp': PROC_NET_TCP, '/proc/net/tcp6': PROC_NET_TCP6 });

      await asProcess('linux', '/usr/local/bin/cihub', async () => {
        const { isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(80)).toBe(true);
        expect(isPortAvailable(8080)).toBe(false);
        expect(isPortAvailable(443)).toBe(false);
      });
      expect(spawned).not.toContain('lsof');
    });

    it('still answers from the IPv4 table on a kernel without IPv6', async () => {
      mockAlpineTools({ '/proc/net/tcp': PROC_NET_TCP });

      await asProcess('linux', '/usr/local/bin/cihub', async () => {
        const { isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(8080)).toBe(false);
        expect(isPortAvailable(443)).toBe(true);
      });
    });
  });

  // Regression (CI-Hub#1726): on Linux a normal user's bind below 1024 fails with EACCES whether or
  // not anything listens, so ports 80 and 443 always read as taken and every Hub moved to 8880/8443.
  describe('on Linux, where a normal user may not bind below 1024', () => {
    const NODE = '/usr/local/bin/node';
    const spawned: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const dockerCalls = () => spawned.filter(({ command }) => command === 'docker');

    /**
     * The bind probe runs its own script against a stand-in `net` whose `listen` the kernel refuses
     * (EACCES) below 1024, `ss` is missing so the kernel's tables answer, and `docker info` reports
     * `securityOptions`.
     */
    function mockLinuxUser(securityOptions: string) {
      spawned.length = 0;
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        spawnSync: vi.fn((command: string, args: readonly string[] = [], options: { env?: NodeJS.ProcessEnv } = {}) => {
          spawned.push({ command, args, env: options.env });
          if (command === NODE && args[0] === '-e') return { status: runBindProbe(String(args[1])), stdout: '', stderr: '' };
          if (command === 'docker') return { status: 0, stdout: `${securityOptions}\n`, stderr: '' };
          return { status: null, stdout: '', stderr: '', error: new Error(`spawnSync ${command} ENOENT`) };
        }),
      }));
      mockProcNetTcp({ '/proc/net/tcp': PROC_NET_TCP, '/proc/net/tcp6': PROC_NET_TCP6 });
    }

    it('lets the listeners decide: nothing on port 80 is free, a listener on 443 is in use', async () => {
      mockLinuxUser(ROOTFUL_SECURITY_OPTIONS);

      await asProcess('linux', NODE, async () => {
        const { hostPortState, isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(80)).toBe(true);
        expect(isPortAvailable(443)).toBe(false);
        expect(hostPortState(443)).toBe('in-use');
      });
    });

    it('keeps them unavailable on a rootless engine, which binds as this user too', async () => {
      mockLinuxUser(ROOTLESS_SECURITY_OPTIONS);

      await asProcess('linux', NODE, async () => {
        const { hostPortState, isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(80)).toBe(false);
        expect(hostPortState(80)).toBe('rootless-privileged');
        expect(isPortAvailable(8880)).toBe(true);
      });
    });

    it('asks docker only after a refused bind, and once a run', async () => {
      mockLinuxUser(ROOTFUL_SECURITY_OPTIONS);

      await asProcess('linux', NODE, async () => {
        const { isPortAvailable } = await import('../port-availability');
        isPortAvailable(8880);
        expect(dockerCalls()).toEqual([]);
        isPortAvailable(80);
        isPortAvailable(443);
        isPortAvailable(80);
      });
      expect(dockerCalls()).toHaveLength(1);
    });

    it('asks the pinned engine, which a `rootless` docker context leaves pinned as `other`', async () => {
      mockLinuxUser(ROOTLESS_SECURITY_OPTIONS);

      await asProcess('linux', NODE, async () => {
        const { pinDockerEngine } = await import('../lib/docker-engine');
        pinDockerEngine({ dockerHost: 'unix:///run/user/1000/docker.sock', kind: 'other', contextName: 'rootless', reason: 'test', selectedAt: 0 });
        const { hostPortState } = await import('../port-availability');
        expect(hostPortState(80)).toBe('rootless-privileged');
      });
      expect(dockerCalls().map(({ env }) => env?.DOCKER_HOST)).toEqual(['unix:///run/user/1000/docker.sock']);
    });

    it('needs no docker call when the engine was pinned by its rootless socket', async () => {
      mockLinuxUser(ROOTFUL_SECURITY_OPTIONS);

      await asProcess('linux', NODE, async () => {
        const { pinDockerEngine } = await import('../lib/docker-engine');
        pinDockerEngine({ dockerHost: 'unix:///run/user/1000/docker.sock', kind: 'rootless', reason: 'test', selectedAt: 0 });
        const { hostPortState } = await import('../port-availability');
        expect(hostPortState(443)).toBe('rootless-privileged');
      });
      expect(dockerCalls()).toEqual([]);
    });

    it('still counts a refused bind as taken off Linux', async () => {
      mockLinuxUser(ROOTFUL_SECURITY_OPTIONS);

      await asProcess('darwin', NODE, async () => {
        const { isPortAvailable } = await import('../port-availability');
        expect(isPortAvailable(80)).toBe(false);
      });
      expect(dockerCalls()).toEqual([]);
    });
  });
});
