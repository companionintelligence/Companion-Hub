import type { HostPlatform, RuntimeKind } from '@ci-hub/common/types';

/** Shown in Settings → System when Docker Desktop / WSL2 may cap container RAM. */
export const DOCKER_VM_RESOURCE_GUIDANCE =
  'CI OS Hub tries to raise Docker VM memory automatically at startup (up to ~75% of host RAM). A Docker Desktop restart may be required for changes to apply. If available memory still looks low, open Docker Desktop → Settings → Resources, increase Memory, then Apply & Restart.';

export function getVmResourceGuidance(runtimeKind: RuntimeKind, platform?: HostPlatform | string, options?: { hasVmWedge?: boolean }): string {
  const hasVmWedge = options?.hasVmWedge ?? false;

  if (runtimeKind === 'linux-native' || runtimeKind === 'host-native') {
    if (hasVmWedge) {
      return DOCKER_VM_RESOURCE_GUIDANCE;
    }
    return 'Resources reflect this machine directly. No Docker Desktop VM limits apply.';
  }
  if (runtimeKind === 'wsl2-vm' || platform === 'win32') {
    return `${DOCKER_VM_RESOURCE_GUIDANCE} On Windows you can also edit %UserProfile%\\.wslconfig (memory=, processors=), then run wsl --shutdown.`;
  }
  if (runtimeKind === 'docker-desktop-vm' || platform === 'darwin') {
    return DOCKER_VM_RESOURCE_GUIDANCE;
  }
  return 'If stats look low, check Docker Desktop or WSL2 resource limits on your host. See Settings → System for host vs container details.';
}
