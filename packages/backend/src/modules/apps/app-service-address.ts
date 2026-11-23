import { parseInstalledComposeJson } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppFilesManager } from './app-files-manager';
import { securityGrantsFor } from './security-grants';

/** The slice of `DockerReadFacade` (or `DockerService`, which forwards to it) this file needs. */
export interface AppServiceAddressLookup {
  getServiceAddressOnAppNetwork(appUrn: AppUrn, service: string): Promise<string | null>;
}

/**
 * The compose service an app is reached at: its `isMain` service, else its only or first one. Null
 * when the installed compose cannot be read.
 */
export async function mainServiceNameOf(appFilesManager: Pick<AppFilesManager, 'getDockerComposeJson'>, appUrn: AppUrn): Promise<string | null> {
  try {
    const composeJson = await appFilesManager.getDockerComposeJson(appUrn);
    if (!composeJson.content) {
      return null;
    }
    const parsed = parseInstalledComposeJson(composeJson.content, securityGrantsFor(appUrn));
    return (parsed.services.find((service) => service.isMain) ?? parsed.services[0])?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * The address the Hub dials to reach an app's main service: the container's address on the app's own
 * network, never the service's name.
 *
 * ⚠ NEVER DIAL AN APP BY NAME FROM THE HUB. The Hub is on every app's network, and on a container with
 * several networks Docker answers a name from whichever network claims it first. An app names its own
 * services, so a service called `gateway` in one app answered the Hub's calls to Companion Memory's
 * `gateway`, with the credential the Hub sent along. An address read from this app's own container on
 * this app's own network cannot be claimed by another app.
 *
 * Null when the compose cannot be read or the main service has no running container on that network.
 */
export async function mainServiceAddressOf(
  appFilesManager: Pick<AppFilesManager, 'getDockerComposeJson'>,
  docker: AppServiceAddressLookup,
  appUrn: AppUrn,
): Promise<string | null> {
  const service = await mainServiceNameOf(appFilesManager, appUrn);
  return service ? docker.getServiceAddressOnAppNetwork(appUrn, service) : null;
}
