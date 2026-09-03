import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatNetworkDiagnosticsLines, runNetworkDoctorSection } from '../network-diagnostics-cli';

const hubApiFetch = vi.fn();

vi.mock('../public-web-cli', () => ({
  hubApiFetch: (...args: unknown[]) => hubApiFetch(...args),
}));

describe('network-diagnostics-cli', () => {
  beforeEach(() => {
    hubApiFetch.mockReset();
  });

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

  it('refreshes diagnostics after orphan repair so doctor reports current state', async () => {
    hubApiFetch
      .mockResolvedValueOnce({
        duplicateDbSubnets: [],
        hubPoolOverlaps: [],
        orphanNetworks: [{ dockerNetworkId: '1', dockerNetworkName: 'ghost_ci-marketplace_network' }],
        issueCount: 1,
      })
      .mockResolvedValueOnce({ removed: ['ghost_ci-marketplace_network'], skipped: [], failed: [] })
      .mockResolvedValueOnce({
        duplicateDbSubnets: [],
        hubPoolOverlaps: [],
        orphanNetworks: [],
        issueCount: 0,
      });

    const result = await runNetworkDoctorSection('.env.local', { repairNetworks: true });

    expect(hubApiFetch).toHaveBeenCalledTimes(3);
    expect(hubApiFetch.mock.calls[0]?.[1]).toBe('/network/diagnostics');
    expect(hubApiFetch.mock.calls[1]?.[1]).toBe('/network/repair-orphans');
    expect(hubApiFetch.mock.calls[2]?.[1]).toBe('/network/diagnostics');
    expect(result.issueCount).toBe(0);
    expect(result.lines).toContain('Orphan compose networks  ok');
    expect(result.lines.some((line) => line.startsWith('Repair orphans'))).toBe(true);
  });
});
