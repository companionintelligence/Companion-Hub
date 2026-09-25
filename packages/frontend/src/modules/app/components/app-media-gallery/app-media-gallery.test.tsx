import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppMediaGallery } from './app-media-gallery';

describe('AppMediaGallery', () => {
  it('renders a loading skeleton while media is pending', () => {
    const { container } = render(<AppMediaGallery appName="Companion Memory" screenshots={[]} demoVideoUrl={null} isLoading />);

    expect(container.querySelector('.animate-pulse, [class*="Skeleton"]')).toBeTruthy();
  });

  it('renders screenshots and opens the lightbox', () => {
    render(
      <AppMediaGallery
        appName="Companion Memory"
        screenshots={['https://example.com/one.png', 'https://example.com/two.png']}
        demoVideoUrl={null}
        isLoading={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open screenshot fullscreen' }));
    expect(screen.getByRole('dialog', { name: 'Companion Memory screenshots' })).toBeInTheDocument();
  });

  it('starts the lightbox at the header bottom edge so the close button is not covered', () => {
    render(<AppMediaGallery appName="Companion Memory" screenshots={['https://example.com/one.png']} demoVideoUrl={null} isLoading={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open screenshot fullscreen' }));
    // The header is fixed at `top: --titlebar-height` with `height: --header-offset` (see header.tsx).
    expect(screen.getByRole('dialog').style.top).toBe('calc(var(--titlebar-height, 0px) + var(--header-offset))');
  });

  it('returns null when there is no media', () => {
    const { container } = render(<AppMediaGallery appName="Companion Memory" screenshots={[]} demoVideoUrl={null} isLoading={false} />);

    expect(container.firstChild).toBeNull();
  });
});
