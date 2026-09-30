import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
 * Does a `/proc/net/tcp` or `/proc/net/tcp6` table list a socket listening on `port`?
 *
 * Each row's local address ends in the port as four hex digits (`0100007F:1F90` is 127.0.0.1:8080),
 * and the fourth column is the socket state. The header row matches no state, so it is skipped.
 */
export function procNetTcpHasListener(table: string, port: number): boolean {
  return table.split('\n').some((row) => {
    const [, localAddress, , state] = row.trim().split(/\s+/);
    if (!localAddress || state?.toUpperCase() !== PROC_NET_TCP_LISTEN) return false;
    const hexPort = localAddress.slice(localAddress.lastIndexOf(':') + 1);
    return /^[0-9A-Fa-f]{4}$/.test(hexPort) && Number.parseInt(hexPort, 16) === port;
  });
}

function isPortListeningViaProcNet(port: number): boolean {
  return ['/proc/net/tcp', '/proc/net/tcp6'].some((table) => {
    try {
      return procNetTcpHasListener(readFileSync(table, 'utf-8'), port);
    } catch {
      // A kernel without IPv6 has no tcp6 table, and so no listener to report there.
      return false;
    }
  });
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

/** Attempt a TCP bind on 127.0.0.1 — mirrors desktop port_manager.rs behavior.
 *  Not used when execPath cannot run `-e` (compiled Bun binaries). */
export function isPortAvailableViaTcpBind(port: number): boolean {
  const script = [
    "require('net').createServer()",
    ".once('error', () => process.exit(1))",
    `.listen(${port}, '127.0.0.1', () => process.exit(0))`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * The TCP bind probe first, where the runtime can run it: a port it cannot bind is taken. Then the
 * listener tools, which also see listeners the 127.0.0.1 probe misses: ss, then /proc (Linux), lsof
 * (other Unix), or netstat (Windows).
 */
export function isPortAvailable(port: number): boolean {
  if (!execPathSupportsEvalProbe()) {
    return !isPortListeningViaExternalTools(port);
  }

  if (!isPortAvailableViaTcpBind(port)) {
    return false;
  }

  try {
    return !isPortListeningViaExternalTools(port);
  } catch {
    return true;
  }
}
