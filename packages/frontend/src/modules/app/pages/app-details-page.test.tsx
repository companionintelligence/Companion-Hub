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

// MemoryStatusBadge is a self-contained child with its own data dependencies
// (useMemoryConnection → useQuery/useMutation/useQueryClient); this page test
// focuses on page layout, so stub it out rather than widening the narrow
// react-query mock above.
vi.mock('../hooks/use-app-media', () => ({
  useAppMedia: () => ({
    data: { screenshots: [], demoVideoUrl: null },
    isLoading: false,
  }),
}));

vi.mock('../components/app-media-gallery/app-media-gallery', () => ({
  AppMediaGallery: () => <div data-testid="app-media-gallery" />,
}));

vi.mock('../components/memory-status-badge/memory-status-badge', () => ({
  MemoryStatusBadge: () => null,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['app'] }),
  getServeStatusOptions: () => ({ queryKey: ['serve-status'], queryFn: vi.fn() }),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    get: vi.fn(async () => ({ data: { totalBytes: 1234, formatted: '1.2 KB' } })),
  },
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    userSettings: {
      localDomain: 'local.test',
      sslPort: 443,
      internalIp: '0.0.0.0',
      domain: 'companionintelligence.com',
      ciHubOrganizationSlug: 'companion',
      ciHubDeviceSlug: 'studio',
    },
    cloudflareAvailable: true,
    tailscaleAvailable: true,
  }),
}));

vi.mock('../components/app-status/app-status', () => ({
  AppStatus: () => <div data-testid="app-status" />,
}));

// The availability probe is a self-contained hook (useQuery + useMutation +
// useQueryClient); this page test only cares about layout, so stub it rather
// than widen the narrow react-query mock above.
vi.mock('../helpers/use-app-url-availability', () => ({
  useAppUrlAvailability: () => ({ state: 'idle', statusMessage: null }),
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
            short_desc: 'A clean desktop summary for installs.',
            categories: ['utilities'],
          },
          app: { status: 'running' },
          metadata: {},
        },
        isLoading: false,
      };
    });
  });

  it('shows a skeleton of the page, not a spinner, while the app loads', () => {
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) =>
      options.queryKey?.[0] === 'app-image-size' ? { data: undefined, isLoading: true } : { data: undefined, isLoading: true, isError: false },
    );

    render(<AppDetailsPage />);

    expect(screen.getByRole('status', { name: 'COMMON_LOADING' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-actions')).not.toBeInTheDocument();
  });

  it('uses the shared marketplace image URL for the details logo', () => {
    render(<AppDetailsPage />);

    const image = screen.getByRole('img', { name: 'Test App' });
    expect(getMarketplaceAppImageUrl).toHaveBeenCalledWith('test-app:community');
    expect(image).toHaveAttribute('src', 'http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
  });

  it('prefers the portal icon URL from metadata when available', () => {
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
            short_desc: 'A clean desktop summary for installs.',
            categories: ['utilities'],
          },
          app: { status: 'running' },
          metadata: { iconUrl: 'https://cdn.example.com/test-app.png' },
        },
        isLoading: false,
      };
    });

    render(<AppDetailsPage />);

    const image = screen.getByRole('img', { name: 'Test App' });
    expect(getMarketplaceAppImageUrl).not.toHaveBeenCalled();
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/test-app.png');
  });

  it('falls back to the placeholder image when the details logo fails to load', () => {
    render(<AppDetailsPage />);

    const image = screen.getByRole('img', { name: 'Test App' });
    fireEvent.error(image);

    expect(screen.getByRole('img', { name: 'Test App' })).toHaveAttribute('src', '/app-not-found.jpg');
  });

  it('keeps the summary card content and actions visible', () => {
    render(<AppDetailsPage />);

    expect(screen.getByText('A clean desktop summary for installs.')).toBeInTheDocument();
    expect(screen.getByTestId('app-actions')).toBeInTheDocument();
    expect(screen.getByTestId('app-status')).toBeInTheDocument();
    expect(screen.getByTestId('app-media-gallery')).toBeInTheDocument();
    expect(screen.getByTestId('app-details-tabs')).toBeInTheDocument();
  });

  it('shows a not-found message when app details fail to load', () => {
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
      if (options.queryKey?.[0] === 'app-image-size') {
        return { data: null, isLoading: false };
      }

      return {
        data: undefined,
        isLoading: false,
        isError: true,
      };
    });

    render(<AppDetailsPage />);

    expect(screen.getByText('APP_ERROR_APP_NOT_FOUND')).toBeInTheDocument();
    expect(screen.getByText('APP_DETAILS_LOAD_FAILED')).toBeInTheDocument();
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('keeps the status and action bar in the shared header row layout', () => {
    render(<AppDetailsPage />);

    expect(screen.getByTestId('app-header-actions-row')).toHaveClass('md:flex-row', 'md:justify-between');
  });

  it('disables runtime-health polling while an app is uninstalling', () => {
    useQuery.mockImplementation((options: { queryKey?: readonly unknown[]; enabled?: boolean }) => {
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
          app: { status: 'uninstalling' },
          metadata: {},
        },
        isLoading: false,
      };
    });

    render(<AppDetailsPage />);

    expect(useQuery).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        queryKey: ['app-runtime-health', 'test-app:community'],
        enabled: false,
      }),
    );
  });
});
