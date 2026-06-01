import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Ollama on the host machine — reachable from a `--network host` container. */
export const HOST_LOOPBACK_OLLAMA_URL = 'http://127.0.0.1:11434';

const CURL_IMAGE = 'curlimages/curl:8.12.1';

export type OllamaTransport = 'direct' | 'host-network';

export function isRunningInDocker(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

export function isConnectionRefused(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ECONNREFUSED') || msg.includes('connect ECONNREFUSED');
}

export function isBridgeConnectionRefused(error?: string): boolean {
  if (!error) return false;
  return (
    (error.includes('ECONNREFUSED') || error.includes('connect ECONNREFUSED')) &&
    (error.includes('172.17.') || error.includes('172.18.') || error.includes('host.docker.internal'))
  );
}

export function shouldTryHostNetworkBridge(configuredUrl: string, err: unknown): boolean {
  if (!isRunningInDocker()) return false;
  if (!isConnectionRefused(err)) return false;
  // Bridge / host-gateway URLs cannot reach Ollama when it binds loopback only.
  return configuredUrl.includes('host.docker.internal') || configuredUrl.includes('172.17.') || configuredUrl.includes('172.18.');
}

/** Longer default — first probe may pull the curl sidecar image. */
export async function probeHostNetworkOllama(timeoutMs = 15_000): Promise<boolean> {
  try {
    await dockerHostCurl('GET', '/api/tags', undefined, { timeoutMs });
    return true;
  } catch {
    return false;
  }
}

interface DockerHostCurlOptions {
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

/** Run curl against host-loopback Ollama from a one-off container on the host network. */
export function dockerHostCurl(method: 'GET' | 'POST', path: string, body?: unknown, opts?: DockerHostCurlOptions): Promise<string> {
  const url = `${HOST_LOOPBACK_OLLAMA_URL}${path}`;
  const args = ['run', '--rm', '-i', '--network', 'host', CURL_IMAGE, 'curl', '-sS', '-N', '-X', method, url];
  if (body !== undefined) {
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (opts?.onLine) {
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) opts.onLine(trimmed);
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutMs = opts?.timeoutMs ?? 0;
    const timer = timeoutMs > 0 ? setTimeout(() => proc.kill('SIGTERM'), timeoutMs) : null;

    proc.on('error', (err) => finish(() => reject(err)));
    proc.on('close', (code) => {
      if (code === 0) {
        finish(() => resolve(stdout));
        return;
      }
      // Streaming pull may exit non-zero after sending body; keep stdout when we got data.
      if (opts?.onLine && stdout.trim()) {
        finish(() => resolve(stdout));
        return;
      }
      finish(() => reject(new Error(stderr.trim() || stdout.trim() || `docker curl exited with code ${code}`)));
    });
  });
}
