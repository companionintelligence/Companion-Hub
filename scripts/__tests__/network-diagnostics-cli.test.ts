import { describe, expect, it } from 'vitest';
import { formatNetworkDiagnosticsLines } from '../network-diagnostics-cli';

describe('network-diagnostics-cli', () => {
  it('formats a clean diagnostics report', () => {
    const lines = formatNetworkDiagnosticsLines({
      duplicateDbSubnets: [],
      hubPoolOverlaps: [],
      orphanNetworks: [],
      issueCount: 0,
    });

    expect(lines).toEqual(['Duplicate DB subnets     ok', 'Hub pool overlaps        ok', 'Orphan compose networks  ok']);
  });

  it('formats overlap and orphan issues', () => {
    const lines = formatNetworkDiagnosticsLines({
      duplicateDbSubnets: [{ subnet: '10.128.10.0/24', appUrns: ['ghost:ci-marketplace', 'chatwoot:ci-marketplace'] }],
      hubPoolOverlaps: [
        {
          cidr: '10.128.10.0/24',
          conflictsWith: '10.128.10.1/24',
          dockerNetworkName: 'ghost_ci-marketplace_network',
        },
      ],
      orphanNetworks: [{ dockerNetworkId: '1', dockerNetworkName: 'ghost_ci-marketplace_network', composeProject: 'ghost_ci-marketplace' }],
      issueCount: 3,
    });

    expect(lines.some((line) => line.includes('Duplicate DB subnets'))).toBe(true);
    expect(lines.some((line) => line.includes('overlaps 10.128.10.1/24'))).toBe(true);
    expect(lines.some((line) => line.includes('ghost_ci-marketplace_network'))).toBe(true);
  });
});
