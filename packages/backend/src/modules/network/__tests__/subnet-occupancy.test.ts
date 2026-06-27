import { describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import type { AppUrn } from '@ci-hub/common/types';
import { collectOccupiedSubnets, occupiedCidrStrings } from '../subnet-occupancy';

describe('subnet-occupancy', () => {
  it('collects normalized DB and Docker IPAM ranges', async () => {
    const docker = {
      listNetworks: vi.fn().mockResolvedValue([
        fromPartial({
          Id: 'net-1',
          Name: 'ghost_ci-marketplace_network',
          Labels: { 'com.docker.compose.project': 'ghost_ci-marketplace' },
          IPAM: { Config: [{ Subnet: '10.128.10.1/24', IPRange: '10.128.10.128/25' }] },
        }),
      ]),
    };

    const occupied = await collectOccupiedSubnets(
      [
        {
          appName: 'chatwoot',
          appStoreSlug: 'ci-marketplace',
          subnet: '10.128.11.0/24',
        },
      ],
      docker as never,
    );

    expect(occupiedCidrStrings(occupied).sort()).toEqual(['10.128.10.0/24', '10.128.10.128/25', '10.128.11.0/24']);
    expect(occupied.find((entry) => entry.source === 'database')?.appUrn).toBe('chatwoot:ci-marketplace');
    expect(occupied.find((entry) => entry.source === 'docker')?.composeProject).toBe('ghost_ci-marketplace');
  });

  it('excludes the requesting app DB subnet while keeping Docker ranges', async () => {
    const docker = {
      listNetworks: vi.fn().mockResolvedValue([]),
    };

    const occupied = await collectOccupiedSubnets(
      [
        {
          appName: 'ghost',
          appStoreSlug: 'ci-marketplace',
          subnet: '10.128.10.0/24',
        },
      ],
      docker as never,
      { excludeAppUrn: 'ghost:ci-marketplace' as AppUrn },
    );

    expect(occupied).toEqual([]);
  });
});
