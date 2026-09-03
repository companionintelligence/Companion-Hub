import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePairingCode, resolvePendingPairingCode, stashPendingPairingCode, takeStashedPairingCode } from './deep-link-pair';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => core.invoke(...a) }));

const win = window as unknown as Record<string, unknown>;

describe('deep-link-pair', () => {
  beforeEach(() => {
    sessionStorage.clear();
    core.invoke.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    delete win.__TAURI_INTERNALS__;
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

  it('rejects codes that are the right shape but not alphanumeric', () => {
    expect(normalizePairingCode('abc 12')).toBeNull();
    expect(normalizePairingCode('abc-12')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
    expect(normalizePairingCode('   ')).toBeNull();
  });

  it('accepts a padded code, since links get hand-copied', () => {
    expect(normalizePairingCode('  abc123  ')).toBe('ABC123');
    expect(normalizePairingCode('123456')).toBe('123456');
  });

  it('refuses to stash a malformed code', () => {
    // A junk stash outlives the link that carried it: registration would read a
    // code that can never pair, and fail with no visible cause.
    stashPendingPairingCode('nope');
    expect(takeStashedPairingCode()).toBeNull();
  });

  it('consumes the stash even when it was corrupted after the fact', () => {
    // Anything can write sessionStorage; a bad value must not wedge the slot
    // and shadow the next real code.
    sessionStorage.setItem('ci-hub.pending-pairing-code', 'not-a-code');
    expect(takeStashedPairingCode()).toBeNull();

    stashPendingPairingCode('abc123');
    expect(takeStashedPairingCode()).toBe('ABC123');
  });

  it('prefers a freshly delivered desktop code over a stale stash', async () => {
    // Ordering is the point of resolvePendingPairingCode: a code left over from
    // an earlier link must never shadow the one the user just clicked.
    win.__TAURI_INTERNALS__ = {};
    core.invoke.mockResolvedValue('new456');
    stashPendingPairingCode('old123');

    expect(await resolvePendingPairingCode()).toBe('NEW456');
  });

  it('falls back to the stash when the native side has nothing pending', async () => {
    win.__TAURI_INTERNALS__ = {};
    core.invoke.mockResolvedValue(null);
    stashPendingPairingCode('old123');

    expect(await resolvePendingPairingCode()).toBe('OLD123');
    expect(await resolvePendingPairingCode()).toBeNull();
  });

  it('falls back to the stash when the native call blows up', async () => {
    win.__TAURI_INTERNALS__ = {};
    core.invoke.mockRejectedValue(new Error('no such command'));
    stashPendingPairingCode('old123');

    expect(await resolvePendingPairingCode()).toBe('OLD123');
  });

  it('reads nothing from the native side in a plain browser', async () => {
    // No Tauri shell: the invoke must not even be attempted.
    stashPendingPairingCode('old123');

    expect(await resolvePendingPairingCode()).toBe('OLD123');
    expect(core.invoke).not.toHaveBeenCalled();
  });
});
