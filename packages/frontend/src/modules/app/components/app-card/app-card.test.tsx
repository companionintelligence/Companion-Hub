import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { AppInfoSimple } from '@/types/app.types';
import { AppCard } from './app-card';

const { getMarketplaceAppImageUrl } = vi.hoisted(() => ({
  getMarketplaceAppImageUrl: vi.fn(),
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl,
}));

describe('AppCard', () => {
  const appFixture: AppInfoSimple = {
    available: true,
    categories: ['utilities'],
    created_at: 0,
    deprecated: false,
    id: 'test-app',
    name: 'Test App',
    short_desc: 'Description',
    supported_architectures: ['amd64'],
    urn: 'test-app:community',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMarketplaceAppImageUrl.mockReturnValue('http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
  });

  it('uses the shared marketplace image URL for the app logo', () => {
    render(
      <MemoryRouter>
        <AppCard app={appFixture} />
      </MemoryRouter>,
    );

    const image = screen.getByRole('img', { name: 'Test App' });

    expect(getMarketplaceAppImageUrl).toHaveBeenCalledWith('test-app:community');
    expect(image).toHaveAttribute('src', 'http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('prefers portal icon URLs from search results', () => {
    render(
      <MemoryRouter>
        <AppCard app={{ ...appFixture, urn: 'ghost:ci-marketplace', name: 'Ghost', icon: 'https://cdn.example.com/ghost.png' }} />
      </MemoryRouter>,
    );

    expect(getMarketplaceAppImageUrl).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Ghost' })).toHaveAttribute('src', 'https://cdn.example.com/ghost.png');
  });

  it('falls back to the placeholder image and then the avatar tile when image loading fails twice', () => {
    render(
      <MemoryRouter>
        <AppCard app={appFixture} />
      </MemoryRouter>,
    );

    fireEvent.error(screen.getByRole('img', { name: 'Test App' }));
    expect(screen.getByRole('img', { name: 'Test App' })).toHaveAttribute('src', '/app-not-found.jpg');

    fireEvent.error(screen.getByRole('img', { name: 'Test App' }));
    expect(screen.getByText('T')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Test App' })).not.toBeInTheDocument();
  });

  it('clamps a long description on the card instead of cutting it mid-sentence', () => {
    const shortDesc = 'Browser UI for the pi coding agent, pre-wired to your Hub’s local model so you can edit files from another machine.';

    render(
      <MemoryRouter>
        <AppCard app={{ ...appFixture, short_desc: shortDesc }} />
      </MemoryRouter>,
    );

    const description = screen.getByText(shortDesc);
    expect(description.tagName).toBe('P');
    expect(description).toHaveClass('line-clamp-2');
    expect(description).toHaveAttribute('title', shortDesc);
  });

  it('is one link, and an installed app says so', () => {
    render(
      <MemoryRouter>
        <AppCard app={appFixture} isInstalled />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Test App/ })).toBeInTheDocument();
    expect(screen.getByText('Installed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies light-mode elevation styles to the card surface', () => {
    const { container } = render(
      <MemoryRouter>
        <AppCard app={appFixture} />
      </MemoryRouter>,
    );

    expect(container.querySelector('a > div')).toHaveClass('shadow-sm', 'hover:shadow-xl', 'shadow-slate-300/70');
  });
});
