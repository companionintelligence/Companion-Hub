import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl: (urn?: string) => (urn ? `/api/marketplace/apps/${encodeURIComponent(urn)}/image` : '/app-not-found.jpg'),
}));

import { AppLogo, appMonogramLetter } from './app-logo';

const image = (container: HTMLElement) => container.querySelector('image');

describe('AppLogo', () => {
  it('shows the image it was given', () => {
    const { container } = render(<AppLogo urn="immich:ci-marketplace" alt="Immich" />);

    expect(image(container)).toHaveAttribute('href', '/api/marketplace/apps/immich%3Aci-marketplace/image');
    expect(screen.queryByTestId('app-logo-monogram')).not.toBeInTheDocument();
  });

  // A custom app with no uploaded image answered 404, and the browser drew its own broken-image glyph.
  it("falls back to the name's first letter when the image fails to load", () => {
    const { container } = render(<AppLogo urn="family-photos:_user" alt="Family Photos" />);

    fireEvent.error(image(container) as Element);

    expect(screen.getByTestId('app-logo-monogram')).toHaveTextContent('F');
    expect(image(container)).toBeNull();
  });

  it('draws the letter straight away for a link with no icon', () => {
    render(<AppLogo url="" name="school calendar" />);

    expect(screen.getByTestId('app-logo-monogram')).toHaveTextContent('S');
  });

  it('keeps the old placeholder image when there is no name to take a letter from', () => {
    const { container } = render(<AppLogo url="" />);

    expect(screen.queryByTestId('app-logo-monogram')).not.toBeInTheDocument();
    expect(image(container)).toHaveAttribute('href', '/app-not-found.jpg');
  });

  it('takes a whole character, not half of one, and capitalises it', () => {
    expect(appMonogramLetter('  émile')).toBe('É');
    expect(appMonogramLetter('🎵 Music')).toBe('🎵');
    expect(appMonogramLetter('')).toBe('');
  });
});
