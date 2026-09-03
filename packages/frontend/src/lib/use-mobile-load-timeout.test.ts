import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileLoadTimeout } from './use-mobile-load-timeout';

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => true) }));

vi.mock('@/lib/mobile-connection', () => ({
  isMobileClient: () => mockIsMobile(),
  getHubBaseUrlSync: () => null,
}));

describe('useMobileLoadTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockIsMobile.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays false on desktop even when a spinner is up', () => {
    mockIsMobile.mockReturnValue(false);
    const { result } = renderHook(() => useMobileLoadTimeout(true, 1000));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(false);
  });

  it('becomes true after the budget on a phone', () => {
    const { result } = renderHook(() => useMobileLoadTimeout(true, 1000));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(true);
  });
});
