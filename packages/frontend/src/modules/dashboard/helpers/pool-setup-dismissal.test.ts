import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POOL_SETUP_DISMISSED_KEY, usePoolSetupDismissal } from './pool-setup-dismissal';

/** Fresh module state per call: the in-memory fallback is module-level, so a shared import would carry it between tests. */
const freshModule = async () => {
  vi.resetModules();
  return import('./pool-setup-dismissal');
};

const breakStorage = () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
};

describe('pool setup dismissal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads false by default and true after it is written, under the expected key', async () => {
    const { readPoolSetupDismissed, writePoolSetupDismissed } = await freshModule();

    expect(readPoolSetupDismissed()).toBe(false);
    writePoolSetupDismissed();

    expect(readPoolSetupDismissed()).toBe(true);
    expect(localStorage.getItem(POOL_SETUP_DISMISSED_KEY)).toBe('1');
    expect(POOL_SETUP_DISMISSED_KEY).toBe('ci-hub.pool-setup-dismissed');
  });

  it('reads a dismissal stored by an earlier page load', async () => {
    localStorage.setItem(POOL_SETUP_DISMISSED_KEY, '1');
    const { readPoolSetupDismissed } = await freshModule();

    expect(readPoolSetupDismissed()).toBe(true);
  });

  it('does not let the in-memory flag override a working store', async () => {
    const { readPoolSetupDismissed, writePoolSetupDismissed } = await freshModule();
    writePoolSetupDismissed();
    localStorage.removeItem(POOL_SETUP_DISMISSED_KEY);

    expect(readPoolSetupDismissed()).toBe(false);
  });

  it('falls back to the in-memory flag, and throws nothing, when storage throws', async () => {
    breakStorage();
    const { readPoolSetupDismissed, writePoolSetupDismissed } = await freshModule();

    expect(readPoolSetupDismissed()).toBe(false);
    expect(() => writePoolSetupDismissed()).not.toThrow();
    expect(readPoolSetupDismissed()).toBe(true);
  });

  describe('usePoolSetupDismissal', () => {
    it('starts from storage and flips on dismiss', () => {
      const { result } = renderHook(() => usePoolSetupDismissal());
      expect(result.current.dismissed).toBe(false);

      act(() => result.current.dismiss());

      expect(result.current.dismissed).toBe(true);
      expect(localStorage.getItem(POOL_SETUP_DISMISSED_KEY)).toBe('1');
    });

    it('stays dismissed after a remount', () => {
      localStorage.setItem(POOL_SETUP_DISMISSED_KEY, '1');

      expect(renderHook(() => usePoolSetupDismissal()).result.current.dismissed).toBe(true);
    });

    it('still dismisses for this session when storage throws', () => {
      breakStorage();
      const { result } = renderHook(() => usePoolSetupDismissal());

      expect(() => act(() => result.current.dismiss())).not.toThrow();
      expect(result.current.dismissed).toBe(true);
    });
  });
});
