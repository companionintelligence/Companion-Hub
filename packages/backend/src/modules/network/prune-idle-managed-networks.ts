import type Dockerode from 'dockerode';

/**
 * Remove the Hub-managed networks that no container uses, running or stopped.
 *
 * Docker's own `/networks/prune` counts only RUNNING containers as users. **Stop Hub** in the desktop
 * app stops every app container and keeps it, to start the same containers again on **Start Hub**, so
 * when the Hub booted in between, a prune filtered on the managed label still deleted the network of
 * every app the Hub container itself isn't attached to. The desktop app then failed to start those
 * containers with "failed to set up container networking: network <id> not found", and apps on
 * **This machine only** stayed stopped (#2313).
 *
 * So a network counts as used when any container, in any state, names it in its network settings,
 * by name or by id. A network left behind by an app whose containers are gone is still removed.
 * Removal errors that mean "someone uses it now" or "already gone" are expected races, not failures.
 *
 * @returns the names of the networks removed.
 */
export async function pruneIdleManagedNetworks(docker: Dockerode, label: string): Promise<string[]> {
  const networks = (await docker.listNetworks({ filters: { label: [`${label}=true`] } })) ?? [];
  if (networks.length === 0) {
    return [];
  }

  const containers = (await docker.listContainers({ all: true })) ?? [];
  const inUse = new Set<string>();
  for (const container of containers) {
    for (const [name, endpoint] of Object.entries(container.NetworkSettings?.Networks ?? {})) {
      inUse.add(name);
      if (endpoint?.NetworkID) {
        inUse.add(endpoint.NetworkID);
      }
    }
  }

  const removed: string[] = [];
  for (const network of networks) {
    if (inUse.has(network.Name) || inUse.has(network.Id)) {
      continue;
    }
    try {
      await docker.getNetwork(network.Id).remove();
      removed.push(network.Name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already in use|has active endpoints|not found/i.test(message)) {
        continue;
      }
      throw error;
    }
  }
  return removed;
}
