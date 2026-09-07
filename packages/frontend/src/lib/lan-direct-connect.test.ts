import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAN_PROBE_PATH, normalizeLanUrl, normalizeUrl, probeLanHub, resolveHubBaseUrl, resolveHubConnection } from './lan-direct-connect';
import { resetActiveFetch, setActiveFetch } from './runtime-fetch';

describe('lan-direct-connect url normalization', () => {
  it('normalizes bare IPv4 addresses with default port', () => {
    expect(normalizeLanUrl('192.168.1.50')).toBe('http://192.168.1.50:5002');
    expect(normalizeLanUrl('10.0.0.5', 5004)).toBe('http://10.0.0.5:5004');
  });

  it('preserves existing port if already specified', () => {
    expect(normalizeLanUrl('192.168.1.50:5004')).toBe('http://192.168.1.50:5004');
    expect(normalizeLanUrl('http://192.168.1.50:8080')).toBe('http://192.168.1.50:8080');
  });

  it('preserves existing https scheme', () => {
    expect(normalizeLanUrl('https://192.168.1.50:5002')).toBe('https://192.168.1.50:5002');
    expect(normalizeLanUrl('https://hub.local')).toBe('https://hub.local:5002');
  });

  it('handles hostnames', () => {
    expect(normalizeLanUrl('hub.local')).toBe('http://hub.local:5002');
    expect(normalizeLanUrl('ci-hub.home.arpa:5004')).toBe('http://ci-hub.home.arpa:5004');
  });

  it('strips trailing slashes and paths', () => {
    expect(normalizeLanUrl('http://192.168.1.50:5002/')).toBe('http://192.168.1.50:5002');
    expect(normalizeLanUrl('192.168.1.50:5002///')).toBe('http://192.168.1.50:5002');
  });

  it('handles IPv6 loopback and bracketed addresses', () => {
    expect(normalizeLanUrl('[::1]')).toBe('http://[::1]:5002');
    expect(normalizeLanUrl('http://[fe80::1]:5004')).toBe('http://[fe80::1]:5004');
  });

  it('returns null for null, undefined, empty, or whitespace-only values', () => {
    expect(normalizeLanUrl(null)).toBeNull();
    expect(normalizeLanUrl(undefined)).toBeNull();
    expect(normalizeLanUrl('')).toBeNull();
    expect(normalizeLanUrl('   ')).toBeNull();
  });

  it('normalizeUrl removes trailing slashes and trims whitespace', () => {
    expect(normalizeUrl('https://hub.ci.computer/')).toBe('https://hub.ci.computer');
    expect(normalizeUrl('  https://hub.ci.computer///  ')).toBe('https://hub.ci.computer');
  });
});

describe('probeLanHub', () => {
  it('returns true when probe health endpoint responds with 200 ok', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`http://192.168.1.50:5002${DEFAULT_LAN_PROBE_PATH}`);
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    const isLive = await probeLanHub('http://192.168.1.50:5002', { fetchFn: mockFetch });
    expect(isLive).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('supports custom probe path', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://192.168.1.50:5002/custom/health');
      return new Response('ok', { status: 200 });
    });

    const isLive = await probeLanHub('http://192.168.1.50:5002', {
      probePath: '/custom/health',
      fetchFn: mockFetch,
    });
    expect(isLive).toBe(true);
  });

  it('returns false when health endpoint responds with non-ok status', async () => {
    const mockFetch = vi.fn(async () => new Response('Internal error', { status: 500 }));

    const isLive = await probeLanHub('http://192.168.1.50:5002', { fetchFn: mockFetch });
    expect(isLive).toBe(false);
  });

  it('returns false when fetch rejects (connection refused or timeout)', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('Connection refused');
    });

    const isLive = await probeLanHub('http://192.168.1.50:5002', { fetchFn: mockFetch });
    expect(isLive).toBe(false);
  });

  it('falls back to runtimeFetch if no custom fetchFn is provided', async () => {
    const active = vi.fn(async () => new Response('ok', { status: 200 }));
    setActiveFetch(active as unknown as typeof fetch);

    try {
      const isLive = await probeLanHub('http://192.168.1.50:5002');
      expect(isLive).toBe(true);
      expect(active).toHaveBeenCalledTimes(1);
    } finally {
      resetActiveFetch();
    }
  });
});

describe('resolveHubConnection and resolveHubBaseUrl', () => {
  const remoteTunnelUrl = 'https://hub-device123.ci.computer/';

  it('selects LAN when LAN probe succeeds', async () => {
    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));

    const resolved = await resolveHubConnection({
      lanAddress: '192.168.1.100',
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });

    expect(resolved).toEqual({
      baseUrl: 'http://192.168.1.100:5002',
      transport: 'lan',
      lanCandidateUrl: 'http://192.168.1.100:5002',
      remoteTunnelUrl: 'https://hub-device123.ci.computer',
      probed: true,
    });

    const url = await resolveHubBaseUrl({
      lanAddress: '192.168.1.100',
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });
    expect(url).toBe('http://192.168.1.100:5002');
  });

  it('falls back to remote tunnel when LAN probe fails or times out', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('The operation timed out');
    });

    const resolved = await resolveHubConnection({
      lanAddress: '192.168.1.100',
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });

    expect(resolved).toEqual({
      baseUrl: 'https://hub-device123.ci.computer',
      transport: 'tunnel',
      lanCandidateUrl: 'http://192.168.1.100:5002',
      remoteTunnelUrl: 'https://hub-device123.ci.computer',
      probed: true,
    });

    const url = await resolveHubBaseUrl({
      lanAddress: '192.168.1.100',
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });
    expect(url).toBe('https://hub-device123.ci.computer');
  });

  it('falls back to remote tunnel immediately without probing when lanAddress is null or empty', async () => {
    const mockFetch = vi.fn();

    const resolved = await resolveHubConnection({
      lanAddress: null,
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });

    expect(resolved).toEqual({
      baseUrl: 'https://hub-device123.ci.computer',
      transport: 'tunnel',
      lanCandidateUrl: null,
      remoteTunnelUrl: 'https://hub-device123.ci.computer',
      probed: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();

    const url = await resolveHubBaseUrl({
      lanAddress: '   ',
      remoteTunnelUrl,
      fetchFn: mockFetch,
    });
    expect(url).toBe('https://hub-device123.ci.computer');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
