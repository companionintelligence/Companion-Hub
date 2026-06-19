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
    expect(formatHubAccessUrl('example.com', 'hub.example.com')).toBe('https://hub.example.com');
    expect(formatHubAccessUrl(undefined, 'https://hub.example.com')).toBe('https://hub.example.com');
  });
});
