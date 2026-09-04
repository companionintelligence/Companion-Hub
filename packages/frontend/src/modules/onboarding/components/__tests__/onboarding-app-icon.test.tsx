import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OnboardingAppIcon } from '../onboarding-app-icon';

describe('OnboardingAppIcon', () => {
  it('uses the Hub marketplace image proxy when a store urn is available', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'ci-openclaw', name: 'OpenClaw', icon: '', urn: 'urn:store:ci-openclaw' }} />);

    expect(screen.getByAltText('')).toHaveAttribute('src', '/api/marketplace/apps/urn%3Astore%3Aci-openclaw/image');
  });

  it('falls back to icon url when urn is missing', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'ci-openclaw', name: 'OpenClaw', icon: '/agents/openclaw.png', urn: undefined }} />);

    expect(screen.getByAltText('')).toHaveAttribute('src', '/agents/openclaw.png');
  });

  it('uses the same marketplace image proxy for non-agent apps', () => {
    render(<OnboardingAppIcon app={{ appSlug: 'immich', name: 'Immich', icon: '', urn: 'urn:store:immich' }} />);

    expect(screen.getByAltText('')).toHaveAttribute('src', '/api/marketplace/apps/urn%3Astore%3Aimmich/image');
  });

  it('falls back to the Portal icon when the marketplace image is unavailable', () => {
    const portalIcon = 'https://www.google.com/s2/favicons?sz=32&domain_url=https://mattermost.com';
    render(
      <OnboardingAppIcon
        app={{
          appSlug: 'mattermost',
          name: 'Mattermost',
          icon: portalIcon,
          urn: 'mattermost:ci-marketplace',
        }}
      />,
    );

    const image = screen.getByAltText('');
    expect(image).toHaveAttribute('src', '/api/marketplace/apps/mattermost%3Aci-marketplace/image');
    fireEvent.error(image);
    expect(screen.getByAltText('')).toHaveAttribute('src', portalIcon);
  });

  it('renders a supplied local glyph after all remote icon sources fail', () => {
    render(
      <OnboardingAppIcon
        app={{ appSlug: 'ghost', name: 'Ghost', icon: '', urn: 'ghost:ci-marketplace' }}
        fallback={<span data-testid="local-icon">G</span>}
      />,
    );

    fireEvent.error(screen.getByAltText(''));
    expect(screen.getByTestId('local-icon')).toBeInTheDocument();
  });
});
