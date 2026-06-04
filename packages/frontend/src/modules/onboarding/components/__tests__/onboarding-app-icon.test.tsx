import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingAppIcon } from '../onboarding-app-icon';

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ alt, urn }: { alt?: string; urn?: string }) => <div data-testid="app-logo">{alt ?? urn}</div>,
}));

describe('OnboardingAppIcon', () => {
  it('uses AppLogo for ci-openclaw when a store urn is available', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'ci-openclaw', name: 'OpenClaw', icon: '', urn: 'urn:store:ci-openclaw' }} />);

    expect(screen.getByTestId('app-logo')).toHaveTextContent('OpenClaw');
  });

  it('falls back to icon url when urn is missing', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'ci-openclaw', name: 'OpenClaw', icon: '/agents/openclaw.png', urn: undefined }} />);

    expect(screen.getByAltText('')).toHaveAttribute('src', '/agents/openclaw.png');
  });

  it('uses AppLogo when a store urn is available for non-agent apps', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'immich', name: 'Immich', icon: '', urn: 'urn:store:immich' }} />);

    expect(screen.getByTestId('app-logo')).toHaveTextContent('Immich');
  });
});
