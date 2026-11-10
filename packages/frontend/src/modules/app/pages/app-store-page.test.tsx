import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import en from '@ci-hub/common/i18n/translations/en.json';
import enUS from '@ci-hub/common/i18n/translations/en-US.json';
import es from '@ci-hub/common/i18n/translations/es-ES.json';

const { mockStoreState, mockSearchAppsInfiniteOptions } = vi.hoisted(() => ({
  mockStoreState: {
    setCategory: vi.fn(),
    category: undefined as string | undefined,
    storeId: 'ci-apps' as string | undefined,
    setStoreId: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    setSearchImmediate: vi.fn(),
    resetBrowseToFeatured: vi.fn(),
  },
  mockSearchAppsInfiniteOptions: vi.fn(() => ({ queryKey: ['searchApps'] })),
}));

const mockNavigate = vi.fn();
const mockSetSearchParams = vi.fn();
let capturedSearchParams = new URLSearchParams();
let capturedPathname = '/store';

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: vi.fn(() => ({})),
    useLocation: () => ({ pathname: capturedPathname, search: '', hash: '', state: null, key: 'default' }),
    useNavigate: () => mockNavigate,
    useSearchParams: vi.fn(() => [capturedSearchParams, mockSetSearchParams]),
    Navigate: vi.fn(({ to, replace }: { to: string; replace?: boolean }) => (
      <div data-testid="navigate-to" data-replace={String(Boolean(replace))}>
        {to}
      </div>
    )),
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
    isError: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
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
  AppCard: ({ app, isLoading }: { app: { name: string }; isLoading?: boolean }) => (
    <div data-testid={isLoading ? 'app-card-skeleton' : `app-card-${app.name}`} />
  ),
}));

vi.mock('@/stores/app-store', () => ({
  useAppStoreState: () => mockStoreState,
}));

import { pullAppStores } from '@/api-client/sdk.gen';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import AppStorePage from './app-store-page';

const mockUseQuery = vi.mocked(useQuery);
const mockUseInfiniteQuery = vi.mocked(useInfiniteQuery);
const mockUseParams = vi.mocked(useParams);

const STORE_A = { slug: 'ci-apps', name: 'CI Apps', enabled: true, url: '', hash: '', branch: 'main' };
const STORE_B = { slug: 'community', name: 'Community', enabled: true, url: '', hash: '', branch: 'main' };
const STORE_MARKETPLACE = { slug: 'ci-marketplace', name: 'CI Marketplace', enabled: true, url: '', hash: '', branch: 'main' };

const OWNER_ACTIONS = ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure'];
/** What `GET /api/custom-apps/access` answers: an organization owner or admin unless a test says otherwise. */
let customAppActions: string[] = OWNER_ACTIONS;
/** What `GET /api/hub-access` answers: an owner or admin unless a test says otherwise. */
let manageHub = true;

function setupQueries(stores = [STORE_A, STORE_B]) {
  mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
    if (opts.queryKey[0] === 'custom-app-access') {
      return { data: customAppActions, isLoading: false } as ReturnType<typeof useQuery>;
    }
    if (opts.queryKey[0] === 'hub-access') {
      return { data: manageHub, isLoading: false, isPending: false } as ReturnType<typeof useQuery>;
    }
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
    mockSetSearchParams.mockReset();
    customAppActions = OWNER_ACTIONS;
    manageHub = true;
    mockUseParams.mockReturnValue({});
    capturedSearchParams = new URLSearchParams();
    capturedPathname = '/store';
    mockStoreState.category = undefined;
    mockStoreState.storeId = 'ci-apps';
    mockStoreState.search = '';
    mockUsePortalCatalog.mockReturnValue({
      alternatives: {},
      isLoading: false,
      isError: false,
      refetchAlternatives: vi.fn(),
    });
  });

  it('offers expose and custom app from the store header', () => {
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'PORT_EXPOSE_SIDEBAR_LINK' }));
    fireEvent.click(screen.getByRole('button', { name: 'APP_STORE_CREATE_CUSTOM_APP' }));

    expect(mockNavigate).toHaveBeenCalledWith('/apps/expose');
    expect(mockNavigate).toHaveBeenCalledWith('/apps/create');
  });

  // Pulling the app stores refreshes them for the whole Hub, an owner's or admin's to do.
  it.each([
    ['offers an owner or admin', true],
    ['does not offer a member', false],
  ])('%s Check for Updates', (_label, canManage) => {
    manageHub = canManage;
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.queryAllByRole('button', { name: 'APP_STORE_CHECK_FOR_UPDATES' })).toHaveLength(canManage ? 1 : 0);
  });

  // The generated client resolves with `{ error }` on a non-2xx unless the call passes throwOnError,
  // and the mutation would then succeed: a failed pull showed "updated" and never the error toast.
  it('pulls the app stores with throwOnError so a failed pull reaches onError', async () => {
    setupQueries();
    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    const options = vi.mocked(useMutation).mock.calls[0]?.[0] as { mutationFn: () => Promise<unknown> };
    await options.mutationFn();

    expect(vi.mocked(pullAppStores)).toHaveBeenCalledWith({ throwOnError: true });
  });

  // Only an organization owner or admin may create a custom app, so a member is not offered the button.
  it.each([
    ['a member', ['view']],
    ['an account with no linked Portal identity', ['view', 'start', 'stop', 'restart']],
  ])('does not offer %s Create a custom app', (_label, actions) => {
    customAppActions = actions;
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'PORT_EXPOSE_SIDEBAR_LINK' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'APP_STORE_CREATE_CUSTOM_APP' })).not.toBeInTheDocument();
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
    capturedPathname = '/store/community';
    mockUseParams.mockReturnValue({ storeId: 'community' });

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('navigate-to')).toHaveTextContent('/store?store=community');
    // A redirect that stayed in the history would send Back straight here again.
    expect(screen.getByTestId('navigate-to')).toHaveAttribute('data-replace', 'true');
    expect(mockSetSearchParams).not.toHaveBeenCalled();
  });

  it('keeps a store name with reserved characters as one query value in the redirect', () => {
    setupQueries();
    capturedPathname = '/store/a%26category%3Dai';
    mockUseParams.mockReturnValue({ storeId: 'a&category=ai' });

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('navigate-to')).toHaveTextContent('/store?store=a%26category%3Dai');
  });

  it('shows matching alternatives in catalog search for a proprietary name', () => {
    mockUsePortalCatalog.mockReturnValue({
      alternatives: {
        data: [
          {
            proprietary: [{ name: 'Google Drive', icon: '', url: null }],
            alternatives: [{ name: 'Nextcloud', icon: '', url: 'https://nextcloud.com/', appSlug: 'nextcloud' }],
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetchAlternatives: vi.fn(),
    });

    setupQueries([{ slug: 'ci-marketplace', name: 'CI Marketplace', enabled: true, url: '', hash: '', branch: 'main' }]);
    mockStoreState.category = undefined;
    mockStoreState.search = 'google drive';
    mockStoreState.storeId = 'ci-marketplace';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Google Drive')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Nextcloud/i });
    expect(link).toHaveAttribute('href', '/store/ci-marketplace/nextcloud');
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

    const clearing = mockSetSearchParams.mock.calls.find(([updater]) => !updater(new URLSearchParams('store=nonexistent')).has('store'));

    expect(clearing).toBeDefined();
    // A pushed entry would keep the bad address in the history. Back would land on it and be sent forward again.
    expect(clearing?.[1]).toEqual({ replace: true });
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
      query: { search: 'sidebar term', category: undefined, pageSize: 16, storeId: 'ci-apps' },
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

  it('prefetches the next catalog page after the first 16 land', () => {
    const fetchNextPage = vi.fn();
    setupQueries();
    mockUseInfiniteQuery.mockReturnValueOnce({
      data: {
        pages: [{ data: [{ urn: 'a:ci-apps', name: 'A', short_desc: '', categories: [] }], nextCursor: 'b:ci-apps' }],
      },
      hasNextPage: true,
      isFetchingNextPage: false,
      isFetching: false,
      fetchNextPage,
    } as unknown as ReturnType<typeof useInfiniteQuery>);

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('app-card-A')).toBeInTheDocument();
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('shows a retry when the catalog request fails, and an empty catalog stays empty', () => {
    const refetch = vi.fn();
    setupQueries();
    mockUseInfiniteQuery.mockReturnValueOnce({
      data: undefined,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: false,
      isError: true,
      fetchNextPage: vi.fn(),
      refetch,
    } as unknown as ReturnType<typeof useInfiniteQuery>);

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('empty-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-card-skeleton')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'COMMON_RETRY' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('paints store chrome and in-grid skeletons while the first catalog page is loading', () => {
    setupQueries();
    mockUseInfiniteQuery.mockReturnValueOnce({
      data: undefined,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: true,
      fetchNextPage: vi.fn(),
    } as unknown as ReturnType<typeof useInfiniteQuery>);

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('store-switcher')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-page')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('app-card-skeleton')).toHaveLength(16);
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
      query: { search: '', category: undefined, pageSize: 16, storeId: 'ci-apps' },
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

  it('shows only the sentence and Retry when the alternatives fail to load', () => {
    setupQueries();
    mockStoreState.category = '__alternatives__';
    mockUsePortalCatalog.mockReturnValue({
      alternatives: {},
      isLoading: false,
      isError: true,
      refetchAlternatives: vi.fn(),
    });

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    const banner = screen.getByText(/APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS/);
    expect(banner).toHaveTextContent(/^APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS COMMON_RETRY$/);
  });

  it.each([
    ['en', en.APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS],
    ['en-US', enUS.APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS],
    ['es-ES', es.APP_STORE_COULD_NOT_LOAD_RECOMMENDATIONS],
  ])('ends the alternatives error with a full stop in %s, since Retry follows it directly', (_language, message) => {
    expect(message).toMatch(/\.$/);
  });

  // The dashboard layout keeps the old page mounted through its exit animation, so it sees the next page's address.
  it("leaves the next page's address alone while it animates out", () => {
    capturedPathname = '/home';
    // With no ?store= on the address and the marketplace listed, the store sync would fall back to the marketplace.
    setupQueries([STORE_MARKETPLACE, STORE_B]);
    mockStoreState.category = 'featured';
    mockStoreState.storeId = 'community';

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockSetSearchParams).not.toHaveBeenCalled();
    expect(mockStoreState.setSearchImmediate).not.toHaveBeenCalled();
    expect(mockStoreState.setCategory).not.toHaveBeenCalled();
    expect(mockStoreState.setStoreId).not.toHaveBeenCalled();
  });

  it('ignores a store switch clicked while it animates out', () => {
    capturedPathname = '/home';
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Community'));

    expect(mockStoreState.setStoreId).not.toHaveBeenCalled();
    expect(mockSetSearchParams).not.toHaveBeenCalled();
  });

  it('opens the full catalog for a link with a search term and no category', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps&q=uptime');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setSearchImmediate).toHaveBeenCalledWith('uptime');
    expect(mockStoreState.setCategory).toHaveBeenCalledWith(undefined);
    expect(mockStoreState.setCategory).not.toHaveBeenCalledWith('featured');
  });

  it('leaves Featured for a link that names it alongside a search term', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps&q=uptime&category=featured');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setSearchImmediate).toHaveBeenCalledWith('uptime');
    expect(mockStoreState.setCategory).toHaveBeenCalledWith(undefined);
    expect(mockStoreState.setCategory).not.toHaveBeenCalledWith('featured');
  });

  it('still opens Featured for a link with no search term', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps');
    setupQueries();

    render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setCategory).toHaveBeenCalledWith('featured');
  });

  it('leaves Featured when the address gains a search term while the page is open', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps');
    setupQueries();

    const { rerender } = render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );
    expect(mockStoreState.setCategory).toHaveBeenCalledWith('featured');
    mockStoreState.setCategory.mockClear();

    capturedSearchParams = new URLSearchParams('store=ci-apps&q=uptime');
    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setSearchImmediate).toHaveBeenCalledWith('uptime');
    expect(mockStoreState.setCategory).toHaveBeenCalledWith(undefined);
  });

  it('keeps the open view when the address has neither a category nor a search term', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps');
    setupQueries();

    const { rerender } = render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );
    mockStoreState.setCategory.mockClear();

    capturedSearchParams = new URLSearchParams('store=community');
    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setCategory).not.toHaveBeenCalled();
  });

  it('still follows the next address after its own write turns out to change nothing', () => {
    capturedSearchParams = new URLSearchParams('store=ci-apps&q=uptime');
    setupQueries();
    mockSetSearchParams.mockImplementation((updater: (prev: URLSearchParams) => URLSearchParams) => updater(capturedSearchParams));

    // First pass: the store hasn't taken the search term yet, so the page writes an address without it.
    const { rerender } = render(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    // Second pass: the term has landed, the write matches the address and the URL never moves.
    mockStoreState.search = 'uptime';
    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );
    mockStoreState.setCategory.mockClear();

    capturedSearchParams = new URLSearchParams('store=ci-apps&category=development');
    rerender(
      <MemoryRouter>
        <AppStorePage />
      </MemoryRouter>,
    );

    expect(mockStoreState.setCategory).toHaveBeenCalledWith('development');
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

  it('does not replace a linked store with the store id still in memory', () => {
    capturedSearchParams = new URLSearchParams('store=community');
    setupQueries();
    mockStoreState.storeId = undefined;

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
    expect(updater(new URLSearchParams('store=community')).get('store')).toBe('community');
  });
});
