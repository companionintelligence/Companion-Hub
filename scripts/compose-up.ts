import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const COMPOSE_OUTPUT_BUFFER_LIMIT = 8192;

export type DockerComposeUpResult = SpawnSyncReturns<string>;

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

function runDockerComposeDetached(args: string[], envOverrides: Record<string, string | undefined>): DockerComposeUpResult {
  return spawnSync('docker', args, {
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
}

function runDockerComposeAttached(args: string[], envOverrides: Record<string, string | undefined>): Promise<DockerComposeUpResult> {
  return new Promise((resolve) => {
    let buffer = '';
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

    const finish = (exitCode: number) => {
      resolve({
        status: exitCode,
        stdout: buffer,
        stderr: '',
        output: [buffer, ''],
        pid: child.pid ?? 0,
        signal: null,
        error: undefined,
      });
    };

    const onSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    child.on('close', (code) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      finish(code ?? 1);
    });
    child.on('error', () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      finish(1);
    });
  });
}

export async function runDockerComposeUpOnce(
  args: string[],
  options: { detached: boolean; envOverrides: Record<string, string | undefined> },
): Promise<DockerComposeUpResult> {
  return options.detached ? runDockerComposeDetached(args, options.envOverrides) : runDockerComposeAttached(args, options.envOverrides);
}
