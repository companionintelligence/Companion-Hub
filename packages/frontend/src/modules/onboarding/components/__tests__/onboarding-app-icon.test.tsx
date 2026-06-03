import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingAppIcon } from '../onboarding-app-icon';

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: ({ alt, urn }: { alt?: string; urn?: string }) => <div data-testid="app-logo">{alt ?? urn}</div>,
}));

describe('OnboardingAppIcon', () => {
  it('renders the OpenClaw agent mark for the openclaw slug', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'openclaw', name: 'OpenClaw', icon: '', urn: 'urn:store:openclaw' }} />);

    expect(screen.getByAltText('OpenClaw')).toHaveAttribute('src', '/agents/openclaw.png');
    expect(screen.queryByTestId('app-logo')).not.toBeInTheDocument();
  });

  it('uses AppLogo when a store urn is available for non-agent apps', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'immich', name: 'Immich', icon: '', urn: 'urn:store:immich' }} />);

    expect(screen.getByTestId('app-logo')).toHaveTextContent('Immich');
  });
});
