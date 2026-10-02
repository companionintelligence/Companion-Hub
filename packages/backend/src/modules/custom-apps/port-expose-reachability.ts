import { TranslatableError } from '@/common/error/translatable-error';
import { detectHubContainer } from '@/modules/inference/backends/host-url.util';
import { HttpStatus } from '@nestjs/common';
import net from 'node:net';

const PROBE_TIMEOUT_MS = 2000;

/**
 * Where the Hub opens the operator's port.
 *
 * Inside the container, `127.0.0.1` is the container itself. Traefik uses
 * `host.docker.internal`, the Docker bridge, so a probe has to use that same
 * address. On a process that is not containerized, loopback is the machine.
 */
export function hubPortProbeHost(inContainer: boolean = detectHubContainer()): string {
  return inContainer ? 'host.docker.internal' : '127.0.0.1';
}

export type PortConnect = (host: string, port: number) => Promise<void>;

export function connectTcp(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('timeout')));
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', fail);
  });
}

/**
 * Refuse to publish a port the Hub cannot open.
 *
 * The host is never taken from the request. Only the numeric port is, and it
 * stays inside the range the form already allows. A service bound only to
 * loopback fails this check from inside the container, which is the 502 the
 * route would otherwise serve after we had already marked the app running.
 */
export async function assertHubCanReachPort(port: number, connect: PortConnect = connectTcp): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TranslatableError('PORT_EXPOSE_PORT_INVALID', undefined, HttpStatus.BAD_REQUEST);
  }

  const host = hubPortProbeHost();
  try {
    await connect(host, port);
  } catch {
    throw new TranslatableError('PORT_EXPOSE_PORT_UNREACHABLE', { port: String(port), host }, HttpStatus.BAD_REQUEST);
  }
}
