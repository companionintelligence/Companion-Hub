import { spawnSync } from 'node:child_process';

/** Bun-compiled `cihub` cannot run `execPath -e` probes — spawning itself deadlocks on macOS. */
function isCompiledCihubBinary(): boolean {
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

/** Prefer TCP bind probe when the runtime supports it; otherwise use ss/lsof/netstat. */
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
