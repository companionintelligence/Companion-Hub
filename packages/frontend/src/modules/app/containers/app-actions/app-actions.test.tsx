import { render, screen } from '@/tests/test-utils';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { describe, expect, it, vi } from 'vitest';
import { AppActions } from './app-actions';

const hoisted = vi.hoisted(() => ({
  queryClient: {
    getQueryData: vi.fn(),
  },
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => hoisted.queryClient,
  useQuery: ({ initialData }: { initialData?: () => unknown }) => ({
    data: initialData ? initialData() : null,
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  ignoreAppVersionMutation: () => ({}),
  startAppMutation: () => ({}),
  unignoreAppVersionMutation: () => ({}),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/use-disclosure', () => ({
  useDisclosure: () => ({
    isOpen: false,
    open: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({
    setOptimisticStatus: vi.fn(),
  }),
}));

vi.mock('@/modules/app/helpers/use-installation-progress', () => ({
  useInstallationProgress: () => null,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-tooltip', () => ({
  Tooltip: () => null,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useLocation: () => ({ pathname: '/apps/test-app/community' }),
    useNavigate: () => hoisted.navigate,
  };
});

vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../../components/dialogs/install-dialog/install-dialog', () => ({
  InstallDialog: () => null,
}));
vi.mock('../../components/dialogs/stop-dialog/stop-dialog', () => ({
  StopDialog: () => null,
}));
vi.mock('../../components/dialogs/force-stop-dialog/force-stop-dialog', () => ({
  ForceStopDialog: () => null,
}));
vi.mock('../../components/dialogs/restart-dialog/restart-dialog', () => ({
  RestartDialog: () => null,
}));
vi.mock('../../components/dialogs/uninstall-dialog/uninstall-dialog', () => ({
  UninstallDialog: () => null,
}));
vi.mock('../../components/dialogs/reset-dialog/reset-dialog', () => ({
  ResetDialog: () => null,
}));
vi.mock('../../components/dialogs/update-settings-dialog/update-settings-dialog', () => ({
  UpdateSettingsDialog: () => null,
}));

function makeInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    urn: 'test-app:community',
    id: 'test-app',
    name: 'Test App',
    short_desc: 'Short description',
    description: 'Long description',
    author: 'Test Author',
    source: 'https://github.com/test/test-app',
    version: '1.0.0',
    cihub_app_version: 1,
    available: true,
    deprecated: false,
    port: 3000,
    force_expose: false,
    generate_vapid_keys: false,
    categories: ['utilities'],
    form_fields: [],
    https: false,
    exposable: true,
    no_gui: true,
    supported_architectures: ['amd64', 'arm64'],
    dynamic_config: true,
    created_at: 0,
    updated_at: 1700000000000,
    force_pull: false,
    ...overrides,
  };
}

function makeApp(overrides: Partial<AppDetails> = {}): AppDetails {
  return {
    id: 1,
    domain: null,
    exposed: false,
    exposedLocal: false,
    ignoredVersion: null,
    isVisibleOnGuestDashboard: false,
    openPort: false,
    pendingRestart: false,
    port: 3000,
    status: 'running',
    version: 1,
    config: {},
    localSubdomain: 'test-app',
    ...overrides,
  };
}

const info = makeInfo();

const metadata: AppMetadata = {
  latestVersion: 1,
  localSubdomain: 'test-app',
};

const runningApp = makeApp();

describe('AppActions', () => {
  it('keeps install errors inline in hero layout with constrained width', () => {
    hoisted.queryClient.getQueryData.mockReturnValue({
      message: 'Install completed with warnings and needs your attention before the app is fully usable.',
    });

    const { container } = render(<AppActions app={runningApp} metadata={metadata} info={info} layout="hero" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('hero-inline-install-error');
    expect(alert).toHaveTextContent('Install completed with warnings and needs your attention before the app is fully usable.');
    expect(container.querySelector('.hero-action-bar')).toBeInTheDocument();
  });

  it('uses the taller amber retry install button styling for failed installs', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    render(<AppActions app={makeApp({ status: 'install_failed' })} metadata={metadata} info={info} layout="hero" />);

    expect(screen.getByTestId('action-app_action_retry_install')).toHaveClass('retry-install-action-button');
  });
});
