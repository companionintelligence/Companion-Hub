/*
 * Hub speaks the Docker Engine API, but not every server behind that socket is Docker. socktainer
 * exposes Apple's `container` runtime through a Docker-compatible socket. It implements most of the
 * API and accepts `network connect` / `disconnect` without acting on them, because
 * Virtualization.framework cannot hot-plug a NIC and Apple container fixes a container's networks
 * when it is created.
 */

interface EngineVersionLike {
  Platform?: { Name?: unknown };
  Components?: Array<{ Name?: unknown }>;
}

const SOCKTAINER = 'socktainer';

function isSocktainerName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === SOCKTAINER;
}

/**
 * Whether a `GET /version` body is socktainer's.
 *
 * socktainer reports `Platform.Name: "socktainer"` and a `socktainer` component. Its `GET /info` has
 * no `OperatingSystem`, so `/version` is the signal that identifies it. Docker Engine and Docker
 * Desktop answer with their own platform names and `Engine` / `containerd` / `runc` components.
 */
export function isSocktainerVersion(version: unknown): boolean {
  if (typeof version !== 'object' || version === null) {
    return false;
  }
  const { Platform, Components } = version as EngineVersionLike;
  if (isSocktainerName(Platform?.Name)) {
    return true;
  }
  return Array.isArray(Components) && Components.some((component) => isSocktainerName(component?.Name));
}

/**
 * One-time warning that Hub is running on Apple container. It names what degrades so an operator
 * who sees an app fail has the cause in the log, not only in the docs.
 */
export const APPLE_CONTAINER_ENGINE_NOTICE =
  'Container engine is Apple container (socktainer): experimental. ' +
  'It cannot attach a running container to a network, so Hub does not hot-attach itself or Traefik to app networks; ' +
  'each container is its own VM with 1 GiB of memory unless the app sets a memory limit; ' +
  'and restart policies are enforced by the socktainer process, not across a reboot.';
