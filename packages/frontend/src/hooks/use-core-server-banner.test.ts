import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCoreServerBanner } from './use-core-server-banner';

describe('useCoreServerBanner', () => {
  it('starts visible for a probe', () => {
    const { result } = renderHook(() => useCoreServerBanner(1000));
    expect(result.current.isDismissed).toBe(false);
  });

  it('hides after dismiss for the current probe', () => {
    const { result } = renderHook(() => useCoreServerBanner(1000));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
  });

  it('re-shows after a new probe completes', () => {
    const { result, rerender } = renderHook(({ probeUpdatedAt }) => useCoreServerBanner(probeUpdatedAt), {
      initialProps: { probeUpdatedAt: 1000 as number | undefined },
    });

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.isDismissed).toBe(true);

    rerender({ probeUpdatedAt: 2000 });
    expect(result.current.isDismissed).toBe(false);
  });

  it('does not dismiss when probe timestamp is undefined', () => {
    const { result } = renderHook(() => useCoreServerBanner(undefined));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(false);
  });
});
