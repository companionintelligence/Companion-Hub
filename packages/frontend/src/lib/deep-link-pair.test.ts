import { beforeEach, describe, expect, it } from 'vitest';
import { normalizePairingCode, stashPendingPairingCode, takeStashedPairingCode } from './deep-link-pair';

describe('deep-link-pair', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('normalizes valid pairing codes', () => {
    expect(normalizePairingCode('abc123')).toBe('ABC123');
  });

  it('rejects invalid pairing codes', () => {
    expect(normalizePairingCode('abc12')).toBeNull();
    expect(normalizePairingCode('abc1234')).toBeNull();
    expect(normalizePairingCode('abc12!')).toBeNull();
  });

  it('stashes and takes a pending pairing code once', () => {
    stashPendingPairingCode('abc123');
    expect(takeStashedPairingCode()).toBe('ABC123');
    expect(takeStashedPairingCode()).toBeNull();
  });
});
