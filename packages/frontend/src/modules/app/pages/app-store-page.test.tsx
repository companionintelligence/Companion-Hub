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
  })),
  keepPreviousData: {},
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getEnabledAppStoresOptions: () => ({ queryKey: ['enabledStores'] }),
  searchAppsInfiniteOptions: mockSearchAppsInfiniteOptions,
  searchAppsOptions: () => ({ queryKey: ['searchAppsAll'] }),
  getInstalledAppsOptions: () => ({ queryKey: ['installed'] }),
}));

vi.mock('@/api-client/sdk.gen', () => ({
  pullAppStores: vi.fn(),
}));

vi.mock('@/lib/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: () => ({ lastElementRef: vi.fn() }),
}));

vi.mock('@/lib/portal-alternatives', () => ({
  portalAlternativesQueryOptions: () => ({ queryKey: ['alternatives'], enabled: false }),
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

  it('redirects /app-store/:storeId to /app-store?store=<storeId>', () => {
    setupQueries();
    mockUseParams.mockReturnValue({ storeId: 'community' });

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('navigate-to')).toHaveTextContent('/app-store?store=community');
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
    expect(screen.getByPlaceholderText('Search apps...')).toHaveValue('sidebar term');

    mockStoreState.search = 'updated elsewhere';

    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByPlaceholderText('Search apps...')).toHaveValue('updated elsewhere');
  });
});
