import { describe, expect, it } from 'vitest';
import { formatHubAccessUrl, isValidPairingCode, normalizePairingCode, registrationComplete } from '../lib/register-hub';

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
