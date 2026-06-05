import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const COMPOSE_OUTPUT_BUFFER_LIMIT = 8192;

export function appendToRollingBuffer(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  return combined.length > COMPOSE_OUTPUT_BUFFER_LIMIT ? combined.slice(-COMPOSE_OUTPUT_BUFFER_LIMIT) : combined;
}

export function isHostPortBindConflict(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes('ports are not available') ||
    lower.includes('address already in use') ||
    lower.includes('bind: address already in use') ||
    lower.includes('port is already allocated')
  );
}

function runDockerComposeDetached(args: string[], envOverrides: Record<string, string | undefined>): SpawnSyncReturns<string> {
  return spawnSync('docker', args, {
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
}

function runDockerComposeAttached(args: string[], envOverrides: Record<string, string | undefined>): SpawnSyncReturns<string> {
  let buffer = '';
  let exitCode = 1;
  const signal = new Int32Array(new SharedArrayBuffer(4));

  const child = spawn('docker', args, {
    env: { ...process.env, ...envOverrides },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const capture = (chunk: Buffer, stream: NodeJS.WriteStream) => {
    const text = chunk.toString();
    stream.write(text);
    buffer = appendToRollingBuffer(buffer, text);
  };

  child.stdout?.on('data', (chunk) => capture(chunk, process.stdout));
  child.stderr?.on('data', (chunk) => capture(chunk, process.stderr));

  child.on('close', (code) => {
    exitCode = code ?? 1;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });

  child.on('error', () => {
    exitCode = 1;
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  });

  Atomics.wait(signal, 0, 0);

  return {
    status: exitCode,
    stdout: buffer,
    stderr: '',
    output: [buffer, ''],
    pid: child.pid ?? 0,
    signal: null,
    error: undefined,
  };
}

export function runDockerComposeUpOnce(
  args: string[],
  options: { detached: boolean; envOverrides: Record<string, string | undefined> },
): SpawnSyncReturns<string> {
  return options.detached ? runDockerComposeDetached(args, options.envOverrides) : runDockerComposeAttached(args, options.envOverrides);
}
