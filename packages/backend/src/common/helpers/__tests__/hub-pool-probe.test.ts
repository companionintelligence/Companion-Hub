import { describe, expect, it } from 'vitest';
import {
  MAX_MANUAL_POOL_CANDIDATES,
  POOL_PROBE_MISS_THRESHOLD,
  formatProbeAuthority,
  parseProbeTarget,
  poolProbePortCandidates,
} from '../hub-pool-probe';

describe('parseProbeTarget', () => {
  it('accepts the shapes an operator actually types', () => {
    expect(parseProbeTarget('192.168.1.42')).toEqual({ host: '192.168.1.42', port: null, isIpv6: false });
    expect(parseProbeTarget('192.168.1.42:5002')).toEqual({ host: '192.168.1.42', port: 5002, isIpv6: false });
    expect(parseProbeTarget('mini-pc')).toEqual({ host: 'mini-pc', port: null, isIpv6: false });
    expect(parseProbeTarget('mini-pc.lan:3000')).toEqual({ host: 'mini-pc.lan', port: 3000, isIpv6: false });
  });

  it('tolerates a pasted browser URL, scheme and trailing slash included', () => {
    expect(parseProbeTarget('http://192.168.1.42:5010/')).toEqual({ host: '192.168.1.42', port: 5010, isIpv6: false });
    expect(parseProbeTarget('https://mini-pc.lan')).toEqual({ host: 'mini-pc.lan', port: null, isIpv6: false });
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(parseProbeTarget('  Mini-PC.LAN:5002 ')).toEqual({ host: 'mini-pc.lan', port: 5002, isIpv6: false });
  });

  it('handles IPv6 with and without brackets, and never splits a bare literal on its last colon', () => {
    expect(parseProbeTarget('[fd00::1]:5002')).toEqual({ host: 'fd00::1', port: 5002, isIpv6: true });
    expect(parseProbeTarget('fd00::1')).toEqual({ host: 'fd00::1', port: null, isIpv6: true });
  });

  it('refuses anything carrying a path, query, fragment or credentials', () => {
    // This value goes on to build a URL, so a shape that is ambiguous with one has to be refused
    // here rather than resolved by whatever `new URL()` happens to do with it.
    expect(parseProbeTarget('192.168.1.42/admin')).toBeNull();
    expect(parseProbeTarget('192.168.1.42?x=1')).toBeNull();
    expect(parseProbeTarget('192.168.1.42#frag')).toBeNull();
    expect(parseProbeTarget('user:pass@192.168.1.42')).toBeNull();
    expect(parseProbeTarget('192.168.1.42\\admin')).toBeNull();
  });

  it('refuses a malformed or out-of-range port rather than silently dropping it', () => {
    expect(parseProbeTarget('192.168.1.42:0')).toBeNull();
    expect(parseProbeTarget('192.168.1.42:70000')).toBeNull();
    expect(parseProbeTarget('192.168.1.42:abc')).toBeNull();
    expect(parseProbeTarget('192.168.1.42:')).toBeNull();
  });

  it('refuses empty, oversized and structurally invalid names', () => {
    expect(parseProbeTarget('')).toBeNull();
    expect(parseProbeTarget('   ')).toBeNull();
    expect(parseProbeTarget(`${'a'.repeat(400)}.lan`)).toBeNull();
    expect(parseProbeTarget('bad_label.lan')).toBeNull();
    expect(parseProbeTarget('-leading.lan')).toBeNull();
    expect(parseProbeTarget('..')).toBeNull();
  });
});

describe('poolProbePortCandidates', () => {
  it('tries only what the operator typed, when they typed one', () => {
    expect(poolProbePortCandidates(5010, { API_PORT: '5002' })).toEqual([5010]);
  });

  it('falls back to an ordered list, because the container API_PORT is not the published one', () => {
    // Every compose file sets `API_PORT: 5002` inside the container while publishing
    // `${API_PORT:-5002}` on the host, so the env var is a hint and never an answer.
    expect(poolProbePortCandidates(null, { API_PORT: '3000' })).toEqual([3000, 5002]);
    expect(poolProbePortCandidates(null, { API_PORT: '5002' })).toEqual([5002, 3000]);
    expect(poolProbePortCandidates(null, {})).toEqual([5002, 3000]);
  });

  it('ignores an unusable API_PORT instead of probing port NaN', () => {
    expect(poolProbePortCandidates(null, { API_PORT: 'not-a-port' })).toEqual([5002, 3000]);
    expect(poolProbePortCandidates(null, { API_PORT: '99999' })).toEqual([5002, 3000]);
  });
});

describe('formatProbeAuthority', () => {
  it('brackets IPv6 and leaves everything else alone', () => {
    expect(formatProbeAuthority({ host: 'fd00::1', port: null, isIpv6: true }, 5002)).toBe('[fd00::1]:5002');
    expect(formatProbeAuthority({ host: '192.168.1.42', port: null, isIpv6: false }, 5002)).toBe('192.168.1.42:5002');
  });
});

describe('pool discovery constants', () => {
  it('keeps the 3-strike convention the rest of the module uses', () => {
    // Same number as `UNREACHABLE_THRESHOLD` in hub-pool-peer.service.ts and the registration
    // service's retry convention: one lost answer must never evict.
    expect(POOL_PROBE_MISS_THRESHOLD).toBe(3);
    expect(MAX_MANUAL_POOL_CANDIDATES).toBe(20);
  });
});
