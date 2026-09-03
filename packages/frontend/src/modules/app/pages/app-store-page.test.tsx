import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const { mockStoreState, mockSearchAppsInfiniteOptions } = vi.hoisted(() => ({
  mockStoreState: {
    setCategory: vi.fn(),
    category: undefined as string | undefined,
    storeId: 'ci-apps',
    setStoreId: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    setSearchImmediate: vi.fn(),
    resetBrowseToFeatured: vi.fn(),
  },
  mockSearchAppsInfiniteOptions: vi.fn(() => ({ queryKey: ['searchApps'] })),
}));

const mockSetSearchParams = vi.fn();
let capturedSearchParams = new URLSearchParams();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: vi.fn(() => ({})),
    useSearchParams: vi.fn(() => [capturedSearchParams, mockSetSearchParams]),
    Navigate: vi.fn(({ to }: { to: string }) => <div data-testid="navigate-to">{to}</div>),
    Link: vi.fn(({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    )),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (params) return `${key}:${JSON.stringify(params)}`;
      return key;
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useInfiniteQuery: vi.fn(() => ({
    data: { pages: [{ data: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetching: false,
    fetchNextPage: vi.fn(),
  })),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    prefetchInfiniteQuery: vi.fn(),
  })),
  keepPreviousData: {},
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getEnabledAppStoresOptions: () => ({ queryKey: ['enabledStores'] }),
  searchAppsOptions: () => ({ queryKey: ['searchAppsAll'] }),
}));

vi.mock('@/lib/installed-app-urns-query', () => ({
  getInstalledAppUrnsOptions: () => ({ queryKey: ['installed-urns'], queryFn: async () => ({ urns: [] }) }),
}));

vi.mock('@/lib/marketplace-search-query', () => ({
  searchAppsInfiniteOptions: mockSearchAppsInfiniteOptions,
}));

vi.mock('@/api-client/sdk.gen', () => ({
  pullAppStores: vi.fn(),
}));

vi.mock('@/lib/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: () => ({ lastElementRef: vi.fn() }),
}));

const mockUsePortalCatalog = vi.hoisted(() =>
  vi.fn(() => ({
    alternatives: {},
    isLoading: false,
    isError: false,
    alternativesError: undefined,
    refetchAlternatives: vi.fn(),
  })),
);

vi.mock('@/lib/hooks/use-portal-catalog', () => ({
  usePortalCatalog: mockUsePortalCatalog,
}));

vi.mock('@/lib/portal-alternatives', () => ({
  portalAlternativesQueryOptions: () => ({ queryKey: ['alternatives'], enabled: false }),
}));

vi.mock('@/modules/app/components/featured-store-view/featured-store-view', () => ({
  FeaturedStoreView: () => <div data-testid="featured-store-view" />,
}));

vi.mock('@/lib/hooks/use-registration-status', () => ({
  useRegistrationStatus: () => ({ data: { registered: true }, isLoading: false }),
}));

vi.mock('@/components/empty-page/empty-page', () => ({
  EmptyPage: () => <div data-testid="empty-page" />,
}));

vi.mock('@/modules/app/components/app-card/app-card', () => ({
  AppCard: ({ app }: { app: { name: string } }) => <div data-testid={`app-card-${app.name}`} />,
}));

vi.mock('@/stores/app-store', () => ({
  useAppStoreState: () => mockStoreState,
}));

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import AppStorePage from './app-store-page';

const mockUseQuery = vi.mocked(useQuery);
const mockUseParams = vi.mocked(useParams);

const STORE_A = { slug: 'ci-apps', name: 'CI Apps', enabled: true, url: '', hash: '', branch: 'main' };
const STORE_B = { slug: 'community', name: 'Community', enabled: true, url: '', hash: '', branch: 'main' };

function setupQueries(stores = [STORE_A, STORE_B]) {
  mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
    if (opts.queryKey[0] === 'enabledStores') {
      return { data: { appStores: stores }, isLoading: false } as ReturnType<typeof useQuery>;
    }
    if (opts.queryKey[0] === 'installed') {
      return { data: { installed: [] }, isLoading: false } as ReturnType<typeof useQuery>;
    }
    if (opts.queryKey[0] === 'searchAppsAll') {
      return { data: { data: [] }, isLoading: false } as ReturnType<typeof useQuery>;
    }
    return { data: undefined, isLoading: false } as ReturnType<typeof useQuery>;
  });
}

describe('AppStorePage — multi-store UX', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseParams.mockReturnValue({});
    capturedSearchParams = new URLSearchParams();
    mockStoreState.category = undefined;
    mockStoreState.storeId = 'ci-apps';
    mockStoreState.search = '';
    mockUsePortalCatalog.mockReturnValue({
      alternatives: {},
      isLoading: false,
      isError: false,
      alternativesError: undefined,
      refetchAlternatives: vi.fn(),
    });
  });

  it('renders store switcher buttons when multiple stores are enabled', () => {
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    const switcher = screen.getByTestId('store-switcher');
    expect(switcher).toBeInTheDocument();
    expect(screen.getByText('CI Apps')).toBeInTheDocument();
    expect(screen.getByText('Community')).toBeInTheDocument();
  });

  it('does not render store switcher with a single store', () => {
    setupQueries([STORE_A]);

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('store-switcher')).not.toBeInTheDocument();
    expect(screen.getByTestId('store-label')).toBeInTheDocument();
  });

  it('redirects /store/:storeId to /store?store=<storeId>', () => {
    setupQueries();
    mockUseParams.mockReturnValue({ storeId: 'community' });

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('navigate-to')).toHaveTextContent('/store?store=community');
  });

  it('links curated alternatives (including OnlyOffice) to /store/<slug>/<appSlug>', () => {
    mockUsePortalCatalog.mockReturnValue({
      alternatives: {
        utilities: [
          {
            proprietary: [{ name: 'Microsoft Office', icon: null, url: null }],
            alternatives: [{ name: 'OnlyOffice', icon: null, url: 'https://www.onlyoffice.com/', appSlug: 'onlyoffice' }],
          },
        ],
      },
      isLoading: false,
      isError: false,
      alternativesError: undefined,
      refetchAlternatives: vi.fn(),
    });

    setupQueries([{ slug: 'ci-marketplace', name: 'CI Marketplace', enabled: true, url: '', hash: '', branch: 'main' }]);
    mockStoreState.category = '__alternatives__';
    mockStoreState.storeId = 'ci-marketplace';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /OnlyOffice/i });
    expect(link).toHaveAttribute('href', '/store/ci-marketplace/onlyoffice');
    expect(screen.queryByText('ONBOARDING_SOON')).not.toBeInTheDocument();
  });

  it('syncs URL ?store= param to Zustand on mount', () => {
    capturedSearchParams = new URLSearchParams('store=community');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setStoreId).toHaveBeenCalledWith('community');
  });

  it('calls setSearchParams when switching stores', () => {
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Community'));
    expect(mockStoreState.setStoreId).toHaveBeenCalledWith('community');
    expect(mockSetSearchParams).toHaveBeenCalled();
  });

  it('clears invalid ?store= param from URL', () => {
    capturedSearchParams = new URLSearchParams('store=nonexistent');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockSetSearchParams).toHaveBeenCalled();
  });

  it('uses the shared store search value for the app query and syncs the mobile input from it', () => {
    setupQueries();
    mockStoreState.search = 'sidebar term';

    const { rerender } = render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockSearchAppsInfiniteOptions).toHaveBeenCalledWith({
      query: { search: 'sidebar term', category: undefined, pageSize: 24, storeId: 'ci-apps' },
    });
    expect(screen.getByPlaceholderText('APP_STORE_SEARCH_APPS')).toHaveValue('sidebar term');

    mockStoreState.search = 'updated elsewhere';

    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByPlaceholderText('APP_STORE_SEARCH_APPS')).toHaveValue('updated elsewhere');
  });

  it('renders featured view instead of category search when featured is selected', () => {
    setupQueries();
    mockStoreState.category = 'featured';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('featured-store-view')).toBeInTheDocument();
    expect(mockSearchAppsInfiniteOptions).toHaveBeenCalledWith({
      query: { search: '', category: undefined, pageSize: 24, storeId: 'ci-apps' },
    });
  });

  it('switches to all when searching from featured view', () => {
    setupQueries();
    mockStoreState.category = 'featured';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('APP_STORE_SEARCH_APPS'), { target: { value: 'companion' } });

    expect(mockStoreState.setCategory).toHaveBeenCalledWith(undefined);
    expect(mockStoreState.setSearch).toHaveBeenCalledWith('companion');
  });

  it('hydrates search and category from URL query params', () => {
    capturedSearchParams = new URLSearchParams('q=ollama&category=ai&store=ci-apps');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setSearchImmediate).toHaveBeenCalledWith('ollama');
    expect(mockStoreState.setCategory).toHaveBeenCalledWith('ai');
  });

  it('writes browse params to the URL when search and category are set', () => {
    setupQueries();
    mockStoreState.search = 'docs';
    mockStoreState.category = 'development';
    mockStoreState.storeId = 'ci-apps';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    const updater = mockSetSearchParams.mock.calls.find((call) => typeof call[0] === 'function')?.[0] as
      | ((prev: URLSearchParams) => URLSearchParams)
      | undefined;

    expect(updater).toBeTypeOf('function');
    if (typeof updater !== 'function') {
      throw new Error('expected setSearchParams updater');
    }
    const next = updater(new URLSearchParams('store=ci-apps'));
    expect(next.get('q')).toBe('docs');
    expect(next.get('category')).toBe('development');
    expect(next.get('store')).toBe('ci-apps');
  });
});
