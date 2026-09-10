import { parseComposeJson } from '@ci-hub/common/schemas';

export interface PortRequestInput {
  containerPort: number;
  protocol?: 'tcp' | 'udp';
  label: string;
  preferredHostPort?: number;
}

/**
 * The 'main' port request derived from the app's declared config.json port, or `null` when the
 * app declares none. Split out from {@link buildComposePortRequests} — which can throw on a
 * malformed compose — so a caller can still request the main port when the compose half fails.
 * Shared by `InstallAppCommand` and the install plan preview so they cannot drift.
 */
export function buildMainPortRequest(appPort: number | undefined, formPort: number | undefined): PortRequestInput | null {
  if (!appPort) return null;
  return { containerPort: appPort, label: 'main', preferredHostPort: formPort ?? appPort };
}

/**
 * Port requests declared by a compose manifest's `addPorts` entries. Throws on a malformed
 * compose — callers that already log-and-continue on that (`InstallAppCommand`) keep doing so at
 * the call site; the plan preview treats it the same way `checks.config`/`images` already do.
 */
export function buildComposePortRequests(composeContent: unknown): PortRequestInput[] {
  if (!composeContent) return [];

  const { services } = parseComposeJson(composeContent);
  const requests: PortRequestInput[] = [];

  for (const service of services) {
    if (!service.addPorts) continue;
    for (const addPort of service.addPorts) {
      const containerPort = typeof addPort.containerPort === 'string' ? Number.parseInt(addPort.containerPort, 10) : addPort.containerPort;
      const hostPort = typeof addPort.hostPort === 'string' ? Number.parseInt(addPort.hostPort, 10) : addPort.hostPort;
      if (!Number.isNaN(containerPort) && !Number.isNaN(hostPort)) {
        requests.push({
          containerPort,
          label: `${service.name}-${containerPort}`,
          preferredHostPort: hostPort,
          protocol: addPort.udp ? 'udp' : 'tcp',
        });
      }
    }
  }

  return requests;
}
