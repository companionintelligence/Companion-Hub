import { describe, expect, it } from 'vitest';
import { extractOverlapCidrsFromError, isDockerNetworkOverlapError } from '../docker-network-errors';

describe('docker-network-errors', () => {
  it('detects overlap errors from Docker daemon messages', () => {
    expect(
      isDockerNetworkOverlapError(
        new Error(
          'failed to create network ghost_ci-marketplace_network: Error response from daemon: cannot create network (br-abc): conflicts with network (br-def): networks have overlapping IPv4',
        ),
      ),
    ).toBe(true);
    expect(isDockerNetworkOverlapError(new Error('networks have overlapping IPv4'))).toBe(true);
    expect(isDockerNetworkOverlapError(new Error('Pool overlaps with other one on this address space'))).toBe(true);
    expect(isDockerNetworkOverlapError(new Error('address space 10.128.0.0/16 overlaps with 10.128.10.0/24'))).toBe(true);
  });

  it('does not classify non-overlap network creation failures as overlap errors', () => {
    expect(
      isDockerNetworkOverlapError(
        new Error(
          'failed to create network ghost_ci-marketplace_network: Error response from daemon: network with name ghost_ci-marketplace_network already exists',
        ),
      ),
    ).toBe(false);
    expect(isDockerNetworkOverlapError(new Error('failed to create network app_network: Error response from daemon: permission denied'))).toBe(false);
    expect(
      isDockerNetworkOverlapError(new Error('failed to create network app_network: Error response from daemon: invalid network configuration')),
    ).toBe(false);
    expect(isDockerNetworkOverlapError(new Error('failed to create network app_network: connection refused'))).toBe(false);
    expect(isDockerNetworkOverlapError(new Error('port already allocated'))).toBe(false);
  });

  it('extracts CIDR hints from overlap errors', () => {
    const error = new Error('failed to create network: 10.128.10.0/24 overlaps 10.128.10.1/24');
    expect(extractOverlapCidrsFromError(error)).toEqual(['10.128.10.0/24', '10.128.10.1/24']);
  });
});
