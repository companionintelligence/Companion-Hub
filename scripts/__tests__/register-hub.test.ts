import { describe, expect, it, vi } from 'vitest';
import {
  fetchDeviceId,
  formatHubAccessUrl,
  isValidPairingCode,
  normalizePairingCode,
  prepareFreshSetup,
  registrationComplete,
  submitPairingCode,
} from '../lib/register-hub';

describe('register-hub helpers', () => {
  it('normalizes pairing codes', () => {
    expect(normalizePairingCode(' ab-12c ')).toBe('AB12C');
    expect(isValidPairingCode('ABC123')).toBe(true);
    expect(isValidPairingCode('ABC12')).toBe(false);
  });

  it('detects completed registration', () => {
    expect(registrationComplete({ phase: 'publicly_ready', registered: true })).toBe(true);
    expect(registrationComplete({ phase: 'locally_ready', registered: true })).toBe(true);
    expect(registrationComplete({ phase: 'provisioning', registered: false })).toBe(false);
  });

  it('formats hub access URLs', () => {
    // Bare subdomain label + root domain (what /api/registration/pair returns)
    expect(formatHubAccessUrl('companionintelligence.com', 'hub-core7-team')).toBe('https://hub-core7-team.companionintelligence.com');
    // Subdomain already a full hostname under the root domain
    expect(formatHubAccessUrl('example.com', 'hub.example.com')).toBe('https://hub.example.com');
    // Subdomain already a URL
    expect(formatHubAccessUrl(undefined, 'https://hub.example.com')).toBe('https://hub.example.com');
    expect(formatHubAccessUrl('example.com', 'https://hub.example.com')).toBe('https://hub.example.com');
    // Domain only / subdomain only / neither
    expect(formatHubAccessUrl('example.com', undefined)).toBe('https://example.com');
    expect(formatHubAccessUrl(undefined, 'hub-core7-team')).toBe('https://hub-core7-team');
    expect(formatHubAccessUrl(undefined, undefined)).toBeUndefined();
    expect(formatHubAccessUrl('example.com', 'example.com')).toBe('https://example.com');
  });
});

describe('register-hub requests carry the host-local key', () => {
  // An unpaired Hub withholds the Portal link and refuses a fresh start without the key or the setup
  // code, so `cihub register` must send it on every call, not only on the pairing itself.
  const sent = async (call: (apiBase: string, key?: string) => Promise<unknown>, key?: string) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await call('http://127.0.0.1:5002', key);
    } finally {
      vi.unstubAllGlobals();
    }
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers).get('authorization');
  };

  it.each([
    ['fetchDeviceId', fetchDeviceId],
    ['prepareFreshSetup', prepareFreshSetup],
    ['submitPairingCode', (apiBase: string, key?: string) => submitPairingCode(apiBase, 'ABC123', key)],
  ] as const)('%s sends it as a bearer token, and nothing without one', async (_name, call) => {
    await expect(sent(call, 'local-key')).resolves.toBe('Bearer local-key');
    await expect(sent(call)).resolves.toBeNull();
  });
});
