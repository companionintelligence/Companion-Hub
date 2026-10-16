/**
 * True when Docker could not publish a container port because the host port is taken: by a program
 * running on the host ("address already in use") or by another container ("port is already
 * allocated"). Docker Desktop words both as "Ports are not available".
 */
export function isDockerHostPortConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ports are not available|address already in use|port is already allocated/i.test(message);
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

/** The host port a Docker port-conflict error names, or `undefined` when it names none. */
export function extractConflictingHostPort(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  for (const pattern of HOST_PORT_PATTERNS) {
    const port = Number(message.match(pattern)?.[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return port;
    }
  }
  return undefined;
}
