import { spawnSync } from 'node:child_process';

function isPortListeningViaExternalTools(port: number): boolean {
  const ss = spawnSync('ss', ['-ltn', `sport = :${port}`], { encoding: 'utf-8' });
  if (ss.status === 0) {
    const listenNeedle = `:${port}`;
    if ((ss.stdout || '').split('\n').some((line) => line.includes('LISTEN') && line.includes(listenNeedle))) {
      return true;
    }
  }

  const lsof = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf-8' });
  return lsof.status === 0 && Boolean((lsof.stdout || '').trim());
}

/** Attempt a TCP bind on 127.0.0.1 — mirrors desktop port_manager.rs behavior. */
export function isPortAvailableViaTcpBind(port: number): boolean {
  const script = [
    "require('net').createServer()",
    ".once('error', () => process.exit(1))",
    `.listen(${port}, '127.0.0.1', () => process.exit(0))`,
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore' });
  return result.status === 0;
}

/** Prefer TCP bind probe; optionally confirm with ss/lsof when available. */
export function isPortAvailable(port: number): boolean {
  if (!isPortAvailableViaTcpBind(port)) {
    return false;
  }

  try {
    return !isPortListeningViaExternalTools(port);
  } catch {
    return true;
  }
}
