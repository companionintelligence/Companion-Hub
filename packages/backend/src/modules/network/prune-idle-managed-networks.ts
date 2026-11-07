import type Dockerode from 'dockerode';
import { isNetworkRemovalRace } from './docker-network-errors';

export interface PruneIdleNetworksResult {
  /** Names of the networks removed. */
  removed: string[];
  /** Networks whose removal failed for a reason other than a race. The rest were still tried. */
  failed: { networkName: string; message: string }[];
}

/**
 * The names and ids of the networks these containers are on, in any state.
 *
 * A created container that never started has an empty `NetworkID`, so its network appears by name only.
 */
export function networksNamedByContainers(containers: Dockerode.ContainerInfo[]): Set<string> {
  const named = new Set<string>();
  for (const container of containers) {
    for (const [name, endpoint] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
      named.add(name);
      if (endpoint?.NetworkID) {
        named.add(endpoint.NetworkID);
      }
    }
  }
  return named;
}

/**
 * Remove the networks carrying `label` that no container names, running or stopped.
 *
 * Docker's `/networks/prune` counts only running containers as users. Stop Hub keeps every app
 * container stopped to start it again, so a prune at boot deleted their networks and Start Hub then
 * failed with "network <id> not found" (#2313).
 */
export async function pruneIdleManagedNetworks(docker: Dockerode, label: string): Promise<PruneIdleNetworksResult> {
  const result: PruneIdleNetworksResult = { removed: [], failed: [] };
  // Checked here as well as in the filter. The label is the only thing keeping this off every other
  // network on the host. An engine that ignores the filter would hand back all of them.
  const listed = (await docker.listNetworks({ filters: { label: [`${label}=true`] } })) ?? [];
  const networks = listed.filter((network) => network.Labels?.[label] === 'true');
  if (networks.length === 0) {
    return result;
  }

  const named = networksNamedByContainers((await docker.listContainers({ all: true })) ?? []);
  for (const network of networks) {
    if (named.has(network.Name) || named.has(network.Id)) {
      continue;
    }
    try {
      // Docker removes a network that only created or stopped containers name. Ask again just before
      // removing, so a compose up that created a container since the list above keeps its network.
      const users = await docker.listContainers({ all: true, filters: { network: [network.Name, network.Id] } });
      const usersNamed = networksNamedByContainers(users ?? []);
      if (usersNamed.has(network.Name) || usersNamed.has(network.Id)) {
        continue;
      }
      await docker.getNetwork(network.Id).remove();
      result.removed.push(network.Name);
    } catch (error) {
      if (isNetworkRemovalRace(error)) {
        continue;
      }
      result.failed.push({ networkName: network.Name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
