import { act } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@/tests/test-utils';
import { Toaster } from './Toaster';
import { toasterPlacement } from './toaster-placement';

/** The list sonner renders the open toasts into. */
const toastList = () => document.querySelector<HTMLOListElement>('[data-sonner-toaster]');

describe('toasterPlacement', () => {
  beforeEach(() => {
    // Sonner follows the system theme through matchMedia, which jsdom lacks.
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => {
    act(() => toast.dismiss());
    vi.unstubAllGlobals();
  });

  it.each(['/login', '/register', '/reset-password', '/device-registration', '/login/', '/Login'])(
    'puts toasts at the top of %s, below the title bar, where they cannot cover the sign-in form',
    async (pathname) => {
      render(<Toaster {...toasterPlacement(pathname)} />);
      act(() => {
        toast.info('Companion Hub 0.3.6 is installed', { duration: Number.POSITIVE_INFINITY });
      });

      await waitFor(() => expect(toastList()).not.toBeNull());
      expect(toastList()).toHaveAttribute('data-y-position', 'top');
      expect(toastList()).toHaveAttribute('data-x-position', 'center');
      expect(toastList()?.style.getPropertyValue('--offset-top')).toBe('calc(var(--titlebar-height, 0px) + var(--safe-area-top, 0px) + 16px)');
    },
  );

  it.each(['/home', '/settings', '/apps/whoami:ci-marketplace', '/'])('keeps toasts at the bottom on %s', async (pathname) => {
    render(<Toaster {...toasterPlacement(pathname)} />);
    act(() => {
      toast.info('Companion Hub 0.3.6 is installed', { duration: Number.POSITIVE_INFINITY });
    });

    await waitFor(() => expect(toastList()).not.toBeNull());
    expect(toastList()).toHaveAttribute('data-y-position', 'bottom');
    expect(toastList()).toHaveAttribute('data-x-position', 'center');
  });

  it('moves a toast that is still open back to the bottom once the sign-in page is left', async () => {
    const { rerender } = render(<Toaster {...toasterPlacement('/login')} />);
    act(() => {
      toast.info('Companion Hub 0.3.6 is installed', { duration: Number.POSITIVE_INFINITY });
    });
    await waitFor(() => expect(toastList()).toHaveAttribute('data-y-position', 'top'));

    rerender(<Toaster {...toasterPlacement('/home')} />);

    expect(toastList()).toHaveAttribute('data-y-position', 'bottom');
    expect(toastList()?.textContent).toContain('Companion Hub 0.3.6 is installed');
  });
});
