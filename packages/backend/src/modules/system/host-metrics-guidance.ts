import type { HostPlatform, RuntimeKind } from '@ci-hub/common/types';

export function getVmResourceGuidance(runtimeKind: RuntimeKind, platform?: HostPlatform | string): string {
  if (runtimeKind === 'linux-native' || runtimeKind === 'host-native') {
    return 'Resources reflect this machine directly. No Docker Desktop VM limits apply.';
  }
  if (runtimeKind === 'wsl2-vm' || platform === 'win32') {
    return 'Increase WSL2 memory in %UserProfile%\\.wslconfig (memory=, processors=), then run wsl --shutdown and restart Docker Desktop.';
  }
  if (runtimeKind === 'docker-desktop-vm' || platform === 'darwin') {
    return 'Docker Desktop caps how much RAM Hub can use (often 8 GB). Open Docker Desktop → Settings → Resources → Advanced, raise Memory, then Apply & Restart. See Settings → System for host vs container details.';
  }
  return 'If stats look low, check Docker Desktop or WSL2 resource limits on your host.';
}
