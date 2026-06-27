import { describe, expect, it } from 'vitest';
import { extractOverlapCidrsFromError, isDockerNetworkOverlapError } from '../docker-network-errors';

describe('docker-network-errors', () => {
  it('detects overlap errors from Docker daemon messages', () => {
    expect(isDockerNetworkOverlapError(new Error('networks have overlapping IPv4'))).toBe(true);
    expect(isDockerNetworkOverlapError(new Error('Pool overlaps with other one'))).toBe(true);
    expect(isDockerNetworkOverlapError(new Error('port already allocated'))).toBe(false);
  });

  it('extracts CIDR hints from overlap errors', () => {
    const error = new Error('failed to create network: 10.128.10.0/24 overlaps 10.128.10.1/24');
    expect(extractOverlapCidrsFromError(error)).toEqual(['10.128.10.0/24', '10.128.10.1/24']);
  });
});
