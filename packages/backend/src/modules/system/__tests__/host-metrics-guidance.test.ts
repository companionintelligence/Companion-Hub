import { describe, expect, it } from 'vitest';
import { DOCKER_VM_RESOURCE_GUIDANCE, getVmResourceGuidance } from '../host-metrics-guidance';

describe('getVmResourceGuidance', () => {
  it('mentions automatic tuning for Docker Desktop on macOS', () => {
    const text = getVmResourceGuidance('docker-desktop-vm', 'darwin');
    expect(text).toBe(DOCKER_VM_RESOURCE_GUIDANCE);
    expect(text).toContain('automatically');
  });

  it('shows Docker guidance on Linux when a VM wedge is detected', () => {
    const text = getVmResourceGuidance('linux-native', 'linux', { hasVmWedge: true });
    expect(text).toBe(DOCKER_VM_RESOURCE_GUIDANCE);
  });

  it('shows native guidance on Linux without a VM wedge', () => {
    const text = getVmResourceGuidance('linux-native', 'linux', { hasVmWedge: false });
    expect(text).toContain('No Docker Desktop VM limits');
  });
});
