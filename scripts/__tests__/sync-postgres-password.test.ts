import { describe, expect, it } from 'vitest';
import { tcpProbeNetworks } from '../sync-postgres-password';

describe('tcpProbeNetworks', () => {
  it('probes from the network the database is actually on first (post-#1597: ci-hub_internal only)', () => {
    expect(tcpProbeNetworks(['ci-hub_internal'])[0]).toBe('ci-hub_internal');
  });

  it('still reaches an older stack whose database sits on the shared Hub networks', () => {
    const networks = tcpProbeNetworks(['ci-hub_network', 'ci-os-hub_network']);
    expect(networks.slice(0, 2)).toEqual(['ci-hub_network', 'ci-os-hub_network']);
    expect(networks).toContain('ci-hub_internal');
  });

  it('falls back to every known network, internal first, when the attachments cannot be read', () => {
    expect(tcpProbeNetworks([])).toEqual(['ci-hub_internal', 'ci-hub_network', 'ci-os-hub_network']);
  });

  it('lists each network once', () => {
    const networks = tcpProbeNetworks(['ci-hub_internal', 'ci-hub_network']);
    expect(new Set(networks).size).toBe(networks.length);
  });
});
