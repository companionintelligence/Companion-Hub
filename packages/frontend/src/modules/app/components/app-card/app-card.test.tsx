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
});
