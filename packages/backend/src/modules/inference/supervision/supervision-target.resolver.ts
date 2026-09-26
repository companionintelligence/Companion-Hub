import type { InferenceBackendType } from '@ci-hub/common/types';
import type { SupervisionContainerState, SupervisionTarget } from './supervision.types';

/**
 * Container names each backend could plausibly be running under.
 *
 * oMLX has none. It runs on the Apple Silicon host. vLLM's container name is listed for an
 * operator who still runs one; the product path is the host `vllm serve` command.
 */
export const SUPERVISION_CONTAINER_CANDIDATES: Record<InferenceBackendType, readonly string[]> = {
  ollama: ['ci-hub-ollama'],
  vllm: ['ci-hub-vllm'],
  lemonade: ['ci-hub-lemonade'],
  omlx: [],
};

/** Hostnames that mean "this machine" from inside or outside the Hub container. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal', 'gateway.docker.internal']);

/** `172.16.0.0/12` — the Docker bridge range, which is also "this machine" from a container. */
function isDockerBridgeLiteral(hostname: string): boolean {
  const match = /^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}

function defaultPortForProtocol(protocol: string): number | null {
  if (protocol === 'https:') return 443;
  if (protocol === 'http:') return 80;
  return null;
}

export interface ResolveSupervisionTargetInput {
  backend: InferenceBackendType;
  /** `backend.getBaseUrl()`. */
  baseUrl: string;
  /** One `docker ps -a` snapshot per tick, shared across all six backends. */
  containers: readonly SupervisionContainerState[];
  /** Whether the last health check reached the backend at all. */
  reachable: boolean;
}

/**
 * Decide what the Hub can actually observe for one backend.
 *
 * The order of the rules is load-bearing:
 *
 * 1. **Remote wins over everything.** A base URL pointing at another host is a remote endpoint even
 *    if a container of the matching name exists locally — that container is, by construction, not
 *    what the health check just probed.
 * 2. **A name match is not enough.** The container's published host port must match the port in the
 *    base URL. The desktop publishes Lucebox on a *dynamic* host port (`available_host_port`), so
 *    `ci-hub-inference-lucebox` routinely has nothing to do with whatever answers
 *    `SPECULATIVE_INFERENCE_URL`; and a stale `ci-hub-vllm` from an old experiment must not be
 *    reported as the engine while vLLM actually runs on the host. When the URL addresses the
 *    container by name on a Docker network there is no host binding to compare, so the container's
 *    own internal port is matched instead.
 * 3. **No port match downgrades to `host-process`, never to `container`.** Misidentifying the
 *    target costs an unobserved engine; the opposite would cost a report about a stranger.
 */
export function resolveSupervisionTarget(input: ResolveSupervisionTargetInput): SupervisionTarget {
  const { backend, baseUrl, containers, reachable } = input;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return {
      kind: 'absent',
      ref: null,
      reason: `The configured base URL (${baseUrl || 'empty'}) is not a URL, so there is nothing to look for.`,
    };
  }

  const hostname = url.hostname.toLowerCase();
  const candidates = SUPERVISION_CONTAINER_CANDIDATES[backend];
  const addressesContainerByName = candidates.includes(hostname);
  const isLocal = LOCAL_HOSTNAMES.has(hostname) || isDockerBridgeLiteral(hostname) || addressesContainerByName;

  if (!isLocal) {
    return {
      kind: 'remote',
      ref: url.host,
      reason: `${backend} answers at ${url.host}, which is another machine. A remote endpoint cannot be observed from here beyond its HTTP health — its process, its restarts and its logs belong to that host.`,
    };
  }

  const urlPort = url.port ? Number(url.port) : defaultPortForProtocol(url.protocol);
  const named = containers.filter((container) => candidates.includes(container.name));

  if (named.length > 0) {
    const matched = named.find((container) => containerServesPort(container, urlPort, addressesContainerByName));
    if (matched) {
      return {
        kind: 'container',
        ref: matched.name,
        reason: `Observed through the local Docker daemon as ${matched.name}. The Hub reports on this container and never starts, stops or restarts it.`,
      };
    }
    const names = named.map((container) => container.name).join(', ');
    return {
      kind: 'host-process',
      ref: hostname,
      reason:
        `A container named ${names} exists, but it does not publish port ${urlPort ?? 'unknown'}, which is the port ` +
        `${backend} answers on. Treating it as this backend would mean reporting on the wrong process, so it is not matched.`,
    };
  }

  if (candidates.length === 0) {
    return {
      kind: reachable ? 'host-process' : 'absent',
      ref: reachable ? hostname : null,
      reason: reachable
        ? `${backend} has no Docker deployment path at all — it runs as a host process (a launchd LaunchAgent on macOS), outside this container's PID namespace. Its own supervisor restarts it; the Hub can only observe its HTTP health.`
        : `${backend} has no Docker deployment path and nothing is answering at ${url.host}, so there is no process to observe.`,
    };
  }

  if (reachable) {
    return {
      kind: 'host-process',
      ref: hostname,
      reason: `${backend} answers at ${url.host} but no matching container exists, so it is a host daemon (systemd, launchd, or a bare process). The Hub cannot see its restarts or its logs from inside a container.`,
    };
  }

  return {
    kind: 'absent',
    ref: null,
    reason: `Nothing answers at ${url.host} and no matching container exists, so ${backend} is not deployed on this node.`,
  };
}

/**
 * Whether this container is plausibly the thing answering `urlPort`.
 *
 * When the URL addresses the container by its Docker-network name there is no host publication to
 * compare against — traffic goes straight to the container port — so that is what is matched.
 */
function containerServesPort(container: SupervisionContainerState, urlPort: number | null, byContainerName: boolean): boolean {
  if (urlPort === null) return false;
  if (byContainerName) {
    return container.ports.some((binding) => binding.containerPort === urlPort);
  }
  return container.ports.some((binding) => binding.hostPort === urlPort);
}
