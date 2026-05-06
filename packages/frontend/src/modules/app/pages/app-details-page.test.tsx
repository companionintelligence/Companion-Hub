import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useQuery, getMarketplaceAppImageUrl } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  getMarketplaceAppImageUrl: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: () => ({ appId: 'test-app', storeId: 'community' }),
    redirect: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['app'] }),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    get: vi.fn(async () => ({ data: { totalBytes: 1234, formatted: '1.2 KB' } })),
  },
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    userSettings: { localDomain: 'local.test', sslPort: 443 },
  }),
}));

vi.mock('@/components/ui/LoadingSpinner/loading-spinner', () => ({
  PageLoadingSpinner: () => <div data-testid="loading" />,
}));

vi.mock('../components/app-status/app-status', () => ({
  AppStatus: () => <div data-testid="app-status" />,
}));

vi.mock('../containers/app-actions/app-actions', () => ({
  AppActions: () => <div data-testid="app-actions" />,
}));

vi.mock('../containers/app-details-tabs/app-details-tabs', () => ({
  AppDetailsTabs: () => <div data-testid="app-details-tabs" />,
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl,
}));

import AppDetailsPage from './app-details-page';

describe('AppDetailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMarketplaceAppImageUrl.mockReturnValue('http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      if (options.queryKey?.[0] === 'app-image-size') {
        return { data: { totalBytes: 1234, formatted: '1.2 KB' }, isLoading: false };
      }

      return {
        data: {
          info: {
            urn: 'test-app:community',
            name: 'Test App',
            author: 'CI',
            categories: ['utilities'],
          },
          app: { status: 'running' },
          metadata: {},
        },
        isLoading: false,
      };
    });
  });

  it('uses the shared marketplace image URL for the details logo', () => {
    render(<AppDetailsPage />);

    const image = screen.getByRole('img', { name: 'Test App' });
    expect(getMarketplaceAppImageUrl).toHaveBeenCalledWith('test-app:community');
    expect(image).toHaveAttribute('src', 'http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
  });

  it('falls back to the placeholder image when the details logo fails to load', () => {
    render(<AppDetailsPage />);

    const image = screen.getByRole('img', { name: 'Test App' });
    fireEvent.error(image);

    expect(screen.getByRole('img', { name: 'Test App' })).toHaveAttribute('src', '/app-not-found.jpg');
  });
});
