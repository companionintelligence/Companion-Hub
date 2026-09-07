import { readdirSync, statSync } from 'node:fs';

/**
 * Shared AMD GPU device-permission plumbing for every backend that mounts `/dev/kfd` and
 * `/dev/dri` into a container — Lucebox, Lemonade and Ollama.
 *
 * All three hit the same defect: `group_add: ['video', 'render']` looks right and does nothing.
 * Docker resolves those *names* against the **container's** `/etc/group`, where `render` is
 * typically GID 109, while the host group that actually owns the device nodes is site-specific
 * (990 across the Strix Halo fleet — core-7, core-14, core-17, beta-max, fzzy — with video at
 * 44). The container joins a group granting nothing and every GPU device open fails with EACCES.
 *
 * Kept in one place deliberately, following the `host-url.util.ts` precedent: this derivation was
 * written once for Lucebox and imported by Lemonade, and a third importer is the point at which
 * "it lives in whichever backend happened to need it first" starts costing more than it saves.
 * What each backend still decides for itself is what to do with an empty result — Lucebox is
 * GPU-only and throws, Lemonade and Ollama also serve on CPU and degrade with a warning.
 */

/** Injection seam so the GID derivation is testable off an AMD host. */
export interface DeviceGroupProbe {
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { gid: number };
}

const DEFAULT_DEVICE_PROBE: DeviceGroupProbe = {
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
};

/**
 * Derive the numeric host GIDs that own the GPU device nodes.
 *
 * Statting the very device nodes the service mounts gives the correct numbers on any host,
 * which no hard-coded name or number can. Returns an empty array when nothing can be statted —
 * generating a config away from the GPU host — and leaves the response to the caller.
 */
export function resolveAmdDeviceGroupIds(probe: DeviceGroupProbe = DEFAULT_DEVICE_PROBE): number[] {
  const gids = new Set<number>();

  const add = (path: string): void => {
    try {
      const { gid } = probe.statSync(path);
      if (Number.isInteger(gid)) gids.add(gid);
    } catch {
      // Device absent on this host — the remaining nodes still describe the groups we need.
    }
  };

  add('/dev/kfd');

  let entries: string[] = [];
  try {
    entries = probe.readdirSync('/dev/dri');
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    // Nodes are `card0`/`card1` (video) and `renderD128` (render); which index exists varies
    // per host, so enumerate rather than assuming `card1`/`renderD129`.
    if (/^(?:card|renderD)\d+$/.test(entry)) add(`/dev/dri/${entry}`);
  }

  return [...gids].sort((a, b) => a - b);
}
