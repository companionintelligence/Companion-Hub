import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AuthLayout } from './layout';

vi.mock('@/components/language-selector/language-selector', () => ({
  LanguageSelector: () => <div data-testid="language" />,
}));

describe('AuthLayout', () => {
  it('pads for the phone safe area and the desktop title bar', () => {
    render(
      <AuthLayout>
        <p>Sign in</p>
      </AuthLayout>,
    );

    const shell = screen.getByText('Sign in').closest('.overflow-y-auto') as HTMLElement;
    expect(shell.style.paddingTop).toBe('calc(var(--titlebar-height, 0px) + max(2rem, var(--safe-area-top, 0px)))');
    expect(shell.style.paddingBottom).toBe('max(2rem, var(--safe-area-bottom, 0px))');
  });
});
