import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (params) {
        const parts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
        return `${key}(${parts.join(',')})`;
      }
      return key;
    },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useParams: () => ({ storeId: 'store1', appId: 'test-app' }),
    useNavigate: () => vi.fn(),
    useLocation: () => ({ state: null, pathname: '/apps/store1/test-app/update' }),
    redirect: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppOptions: () => ({ queryKey: ['app'] }),
  getAppComposeDiffOptions: () => ({ queryKey: ['composeDiff'] }),
  getAppConfigDiffOptions: () => ({ queryKey: ['configDiff'] }),
  updateAppMutation: () => ({ mutationFn: vi.fn() }),
}));

vi.mock('@/api-client', () => ({
  getApp: vi.fn(),
}));

vi.mock('./+types/app-update-page', () => ({
  Route: {},
}));

vi.mock('@/components/app-logo/app-logo', () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: () => <div data-testid="codemirror" />,
}));
vi.mock('@codemirror/merge', () => ({
  unifiedMergeView: () => [],
}));
vi.mock('@uiw/codemirror-theme-copilot', () => ({
  copilot: {},
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('@/components/ui/Stepper/Stepper', () => ({
  Stepper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StepTriggerList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  StepTrigger: ({ title }: { title: string }) => <div>{title}</div>,
  StepContent: ({ children, step }: { children: React.ReactNode; step: number }) => <div data-testid={`step-${step}`}>{children}</div>,
}));

vi.mock('@/components/ui/ScrollArea', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/Alert/Alert', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertIcon: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AlertHeading: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import { useQuery } from '@tanstack/react-query';
import AppUpdatePage from './app-update-page';

const mockUseQuery = vi.mocked(useQuery);

const APP_DATA = {
  info: {
    urn: 'test-app:store1',
    name: 'Test App',
    version: '1.0.0',
    supported_architectures: ['amd64', 'arm64'],
  },
  metadata: {
    latestVersion: 2,
    latestDockerVersion: '2.0.0',
    minHubVersion: '0.3.0',
  },
  app: { status: 'running', version: 1 },
};

function setupQueries(configChanged = true, composeChanged = false) {
  mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
    if (opts.queryKey[0] === 'app') {
      return { data: APP_DATA, isLoading: false } as ReturnType<typeof useQuery>;
    }
    if (opts.queryKey[0] === 'configDiff') {
      return {
        data: { current: 'old-config', new: configChanged ? 'new-config' : 'old-config' },
        isLoading: false,
      } as ReturnType<typeof useQuery>;
    }
    if (opts.queryKey[0] === 'composeDiff') {
      return {
        data: { current: 'old-compose', new: composeChanged ? 'new-compose' : 'old-compose' },
        isLoading: false,
      } as ReturnType<typeof useQuery>;
    }
    return { data: undefined, isLoading: false } as ReturnType<typeof useQuery>;
  });
}

describe('AppUpdatePage — update summary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the summary step with version change', () => {
    setupQueries();

    render(
      <MemoryRouter>
        <AppUpdatePage {...({ loaderData: APP_DATA } as any)} />
      </MemoryRouter>,
    );

    const summary = screen.getByTestId('update-summary');
    expect(summary).toBeInTheDocument();

    const version = screen.getByTestId('update-summary-version');
    expect(version).toHaveTextContent('1.0.0');
    expect(version).toHaveTextContent('2.0.0');
  });

  it('shows architectures in summary', () => {
    setupQueries();

    render(
      <MemoryRouter>
        <AppUpdatePage {...({ loaderData: APP_DATA } as any)} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('update-summary')).toHaveTextContent('amd64, arm64');
  });

  it('shows config changed indicator', () => {
    setupQueries(true, false);

    render(
      <MemoryRouter>
        <AppUpdatePage {...({ loaderData: APP_DATA } as any)} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_CONFIG_CHANGED');
    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_COMPOSE_UNCHANGED');
  });

  it('shows compose changed indicator', () => {
    setupQueries(false, true);

    render(
      <MemoryRouter>
        <AppUpdatePage {...({ loaderData: APP_DATA } as any)} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_CONFIG_UNCHANGED');
    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_COMPOSE_CHANGED');
  });

  it('shows checking state while diff queries are loading', () => {
    mockUseQuery.mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      if (opts.queryKey[0] === 'app') {
        return { data: APP_DATA, isLoading: false } as ReturnType<typeof useQuery>;
      }
      return { data: undefined, isLoading: true } as ReturnType<typeof useQuery>;
    });

    render(
      <MemoryRouter>
        <AppUpdatePage {...({ loaderData: APP_DATA } as any)} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_CONFIG_CHECKING');
    expect(screen.getByTestId('update-summary')).toHaveTextContent('APP_UPDATE_SUMMARY_COMPOSE_CHECKING');
  });
});
