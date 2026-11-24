import { describe, expect, it } from 'vitest';
import { nextAppLinkSubnet, traefikAddressOnAppSubnet } from '../app-network-addresses';

describe('traefikAddressOnAppSubnet', () => {
  it("is the subnet's last host address", () => {
    expect(traefikAddressOnAppSubnet('10.128.12.0/24')).toBe('10.128.12.254');
    expect(traefikAddressOnAppSubnet('172.20.0.0/16')).toBe('172.20.255.254');
    expect(traefikAddressOnAppSubnet('10.128.1.0/27')).toBe('10.128.1.30');
  });

  it('is nothing for a subnet with no spare host, or none at all', () => {
    expect(traefikAddressOnAppSubnet('10.128.12.0/31')).toBeNull();
    expect(traefikAddressOnAppSubnet('fd00::/64')).toBeNull();
    expect(traefikAddressOnAppSubnet(null)).toBeNull();
    expect(traefikAddressOnAppSubnet('')).toBeNull();
  });
});

describe('nextAppLinkSubnet', () => {
  it('carves /27s from 10.128.1.0, outside the edge, the infra network and the app range', () => {
    expect(nextAppLinkSubnet(['10.128.0.0/29', '10.128.0.8/29', '10.128.10.0/24'])).toBe('10.128.1.0/27');
    expect(nextAppLinkSubnet(['10.128.1.0/27', '10.128.1.32/27'])).toBe('10.128.1.64/27');
  });

  it('skips anything Docker already has that overlaps', () => {
    expect(nextAppLinkSubnet(['10.128.1.0/24'])).toBe('10.128.2.0/27');
    expect(nextAppLinkSubnet(['10.128.0.0/16'])).toBeNull();
  });

  it('has room for 72 links and no more', () => {
    const taken: string[] = [];
    for (let index = 0; index < 72; index += 1) {
      const next = nextAppLinkSubnet(taken);
      expect(next).not.toBeNull();
      taken.push(next as string);
    }
    expect(taken.at(-1)).toBe('10.128.9.224/27');
    expect(nextAppLinkSubnet(taken)).toBeNull();
  });
});
