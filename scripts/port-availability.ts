import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { hubDockerEngineIsRootless } from './lib/docker-engine';

/** Bun-compiled `cihub` cannot run `execPath -e` probes — spawning itself deadlocks on macOS. */
export function isCompiledCihubBinary(): boolean {
  if (process.execPath.includes('bunfs')) {
    return true;
  }
  const base = process.execPath.split(/[/\\]/).pop() ?? '';
  return /^cihub(\.exe)?$/i.test(base);
}

function execPathSupportsEvalProbe(): boolean {
  if (process.platform === 'win32') {
    return false;
  }
  return !isCompiledCihubBinary();
}

/** Socket state `0A` in `/proc/net/tcp` and `/proc/net/tcp6`: the kernel's TCP_LISTEN. */
const PROC_NET_TCP_LISTEN = '0A';

/**
 * Is this `/proc/net/tcp` or `/proc/net/tcp6` row, split into columns, a socket listening on `port`?
 *
 * Each row's local address ends in the port as four hex digits (`0100007F:1F90` is 127.0.0.1:8080),
 * and the fourth column is the socket state. The header row matches no state, so it is skipped.
 */
function isListenerRow(columns: string[], port: number): boolean {
  const [, localAddress, , state] = columns;
  if (!localAddress || state?.toUpperCase() !== PROC_NET_TCP_LISTEN) return false;
  const hexPort = localAddress.slice(localAddress.lastIndexOf(':') + 1);
  return /^[0-9A-Fa-f]{4}$/.test(hexPort) && Number.parseInt(hexPort, 16) === port;
}

function procNetTcpRows(table: string): string[][] {
  return table.split('\n').map((row) => row.trim().split(/\s+/));
}

/** Does a `/proc/net/tcp` or `/proc/net/tcp6` table list a socket listening on `port`? */
export function procNetTcpHasListener(table: string, port: number): boolean {
  return procNetTcpRows(table).some((columns) => isListenerRow(columns, port));
}

/** The inodes of the sockets listening on `port` in a `/proc/net/tcp` or `/proc/net/tcp6` table: the tenth column. */
export function procNetTcpListenerInodes(table: string, port: number): string[] {
  return procNetTcpRows(table)
    .filter((columns) => isListenerRow(columns, port))
    .map((columns) => columns[9] ?? '')
    .filter((inode) => /^[1-9]\d*$/.test(inode));
}

/** The kernel's TCP socket tables, `net/tcp` and `net/tcp6` under `procRoot`. */
export function readProcNetTcpTables(procRoot = '/proc'): string[] {
  return ['tcp', 'tcp6'].flatMap((name) => {
    try {
      return [readFileSync(path.join(procRoot, 'net', name), 'utf-8')];
    } catch {
      // A kernel without IPv6 has no tcp6 table, and so no listener to report there.
      return [];
    }
  });
}

function isPortListeningViaProcNet(port: number): boolean {
  return readProcNetTcpTables().some((table) => procNetTcpHasListener(table, port));
}

function isPortListeningViaExternalTools(port: number): boolean {
  // Windows: netstat -ano (ss/lsof are not available)
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' });
    if (result.status === 0) {
      const needle = `:${port} `;
      return (result.stdout || '').split('\n').some((line) => line.includes('LISTENING') && line.includes(needle));
    }
    return false;
  }

  const ss = spawnSync('ss', ['-ltn', `sport = :${port}`], { encoding: 'utf-8' });
  if (ss.status === 0) {
    const listenNeedle = `:${port}`;
    if ((ss.stdout || '').split('\n').some((line) => line.includes('LISTEN') && line.includes(listenNeedle))) {
      return true;
    }
  }

  // Linux: read the kernel's own tables rather than trust lsof. BusyBox's lsof (Alpine) ignores
  // these flags, lists every open file and exits 0, so every port read as taken (CI-Hub#1699).
  if (process.platform === 'linux') {
    return isPortListeningViaProcNet(port);
  }

  // macOS: `-i :443` matches outbound HTTPS (remote port 443). Use local TCP listen filter.
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf-8' });
  return lsof.status === 0 && Boolean((lsof.stdout || '').trim());
}

/** The bind probe's exit status when the kernel refuses the bind (EACCES, EPERM) rather than the port being in use. */
const TCP_BIND_REFUSED = 2;

/**
 * Attempt a TCP bind on 127.0.0.1 — mirrors desktop port_manager.rs behavior. `refused` means the
 * kernel would not let this user bind the port at all: on Linux a normal user may not bind below
 * `net.ipv4.ip_unprivileged_port_start` (1024), whether or not anything listens there.
 * Not used when execPath cannot run `-e` (compiled Bun binaries).
 */
export function probeTcpBind(port: number): 'free' | 'in-use' | 'refused' {
  const script = [
    "require('net').createServer()",
    `.once('error', (error) => process.exit(['EACCES', 'EPERM'].includes(error.code) ? ${TCP_BIND_REFUSED} : 1))`,
    `.listen(${port}, '127.0.0.1', () => process.exit(0))`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore' });
  if (result.status === 0) return 'free';
  return result.status === TCP_BIND_REFUSED ? 'refused' : 'in-use';
}

let rootlessEngine: boolean | undefined;

/** Asked at most once a run, and only after a refused bind, so the usual path never waits on `docker info`. */
function engineIsRootless(): boolean {
  rootlessEngine ??= hubDockerEngineIsRootless();
  return rootlessEngine;
}

/**
 * What the Hub's Docker engine would find on a host port. `rootless-privileged` is a port below
 * `net.ipv4.ip_unprivileged_port_start`: a rootless engine publishes as this user, who may not bind it.
 */
export type HostPortState = 'free' | 'in-use' | 'rootless-privileged';

/**
 * The TCP bind probe first, where the runtime can run it: a port something else has bound is in use.
 * Then the listener tools, which also see listeners the 127.0.0.1 probe misses: ss, then /proc (Linux),
 * lsof (other Unix), or netstat (Windows).
 *
 * A bind Linux refuses says nothing about the port. A rootful Docker engine publishes as root and can
 * still use it, so the listeners decide; a rootless engine is refused just like the probe.
 */
export function hostPortState(port: number): HostPortState {
  if (!execPathSupportsEvalProbe()) {
    return isPortListeningViaExternalTools(port) ? 'in-use' : 'free';
  }

  const bind = probeTcpBind(port);
  if (bind === 'in-use') return 'in-use';
  if (bind === 'refused') {
    if (process.platform !== 'linux') return 'in-use';
    if (engineIsRootless()) return 'rootless-privileged';
  }

  try {
    return isPortListeningViaExternalTools(port) ? 'in-use' : 'free';
  } catch {
    return 'free';
  }
}

export function isPortAvailable(port: number): boolean {
  return hostPortState(port) === 'free';
}
