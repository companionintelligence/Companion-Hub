/**
 * Docker's wordings for a host port that is taken: by a program running on the host ("address
 * already in use") or by another container ("port is already allocated"). Docker Desktop words both
 * as "Ports are not available". The failure classifier in error reporting reads the same pattern.
 */
export const DOCKER_HOST_PORT_CONFLICT_PATTERN = /ports are not available|address already in use|port is already allocated/i;

/** True when Docker could not publish a container port because the host port is taken. */
export function isDockerHostPortConflictError(error: unknown): boolean {
  return DOCKER_HOST_PORT_CONFLICT_PATTERN.test(messageOf(error));
}

/**
 * Where each Docker wording names the host port, measured on Docker Engine 29.6 for the first two:
 * - `failed to bind host port 127.0.0.1:18789/tcp: address already in use` (a host program has it)
 * - `Bind for 0.0.0.0:18798 failed: port is already allocated` (another container has it)
 * - `Ports are not available: exposing port TCP 0.0.0.0:8080 -> 0.0.0.0:0: listen tcp ...` (Docker Desktop)
 * - `listen tcp4 0.0.0.0:8080: bind: address already in use` (older engines' userland proxy)
 *
 * The address before the port can be IPv4, `[::]` or a bare `::`, so it is matched lazily up to
 * the last colon before the digits.
 */
const HOST_PORT_PATTERNS = [
  /failed to bind host port (?:for )?\S*?:(\d{1,5})[/:]/i,
  /Bind for \S*?:(\d{1,5}) failed/i,
  /exposing port (?:TCP|UDP) \S*?:(\d{1,5})\s/i,
  /listen (?:tcp|udp)[46]? \S*?:(\d{1,5}):/i,
];

/** The protocol in `/tcp`, `exposing port UDP` or `listen tcp4`. "Bind for ... failed" names none. */
const PROTOCOL_PATTERN = /\/(tcp|udp)\b|exposing port (tcp|udp)\b|listen (tcp|udp)[46]?\s/i;

export interface ConflictingHostBinding {
  port: number;
  /** Left out when the wording names no protocol. */
  protocol?: 'tcp' | 'udp';
}

/** The host port, and its protocol when given, that a Docker port-conflict error names. */
export function extractConflictingHostBinding(error: unknown): ConflictingHostBinding | undefined {
  const message = messageOf(error);
  for (const pattern of HOST_PORT_PATTERNS) {
    const port = Number(message.match(pattern)?.[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      const named = message.match(PROTOCOL_PATTERN);
      const protocol = (named?.[1] ?? named?.[2] ?? named?.[3])?.toLowerCase();
      return protocol === 'tcp' || protocol === 'udp' ? { port, protocol } : { port };
    }
  }
  return undefined;
}

/** The host port a Docker port-conflict error names, or `undefined` when it names none. */
export function extractConflictingHostPort(error: unknown): number | undefined {
  return extractConflictingHostBinding(error)?.port;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
