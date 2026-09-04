import { HUB_APPURN_LABEL, HUB_MANAGED_LABEL, LEGACY_HUB_APPURN_LABEL, LEGACY_HUB_MANAGED_LABEL } from '@/common/constants';
import type Dockerode from 'dockerode';

export function managedAppLabelSets(appUrn?: string): string[][] {
  if (appUrn) {
    return [
      [`${HUB_MANAGED_LABEL}=true`, `${HUB_APPURN_LABEL}=${appUrn}`],
      [`${LEGACY_HUB_MANAGED_LABEL}=true`, `${LEGACY_HUB_APPURN_LABEL}=${appUrn}`],
    ];
  }
  return [[`${HUB_MANAGED_LABEL}=true`], [`${LEGACY_HUB_MANAGED_LABEL}=true`]];
}

export function appUrnLabelSets(appUrn: string, extra: string[] = []): string[][] {
  return [
    [`${HUB_APPURN_LABEL}=${appUrn}`, ...extra],
    [`${LEGACY_HUB_APPURN_LABEL}=${appUrn}`, ...extra],
  ];
}

export async function listContainersMatchingAnyLabelSets(docker: Dockerode, labelSets: string[][], all = true): Promise<Dockerode.ContainerInfo[]> {
  const seen = new Set<string>();
  const out: Dockerode.ContainerInfo[] = [];
  for (const label of labelSets) {
    const list = await docker.listContainers({ all, filters: { label } });
    for (const container of list) {
      const key = container.Id || JSON.stringify(container);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(container);
      }
    }
  }
  return out;
}
