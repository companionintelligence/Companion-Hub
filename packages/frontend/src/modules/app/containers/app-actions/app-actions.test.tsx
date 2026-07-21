import { render, screen, userEvent } from '@/tests/test-utils';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppActions } from './app-actions';

const hoisted = vi.hoisted(() => ({
  queryClient: {
    getQueryData: vi.fn(),
  },
  // Options of the START mutation specifically (tagged via startAppMutation below),
  // so its onError can be driven without depending on useMutation call order.
  startOpts: undefined as undefined | Record<string, (arg?: unknown) => void>,
  invalidateAppQueries: vi.fn(),
  navigate: vi.fn(),
  // null => web client (no Tauri); a function => running inside the desktop app.
  tauriInvoke: null as null | (() => unknown),
  openPath: vi.fn(),
}));

vi.mock('@/lib/helpers/open-folder', () => ({
  openPathInFileExplorer: (...args: unknown[]) => hoisted.openPath(...args),
  openLogsFolder: vi.fn(),
}));

vi.mock('@/lib/helpers/tauri-invoke', () => ({
  getTauriInvoke: () => hoisted.tauriInvoke,
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts?: Record<string, unknown>) => {
    if (opts?.__kind === 'start') {
      hoisted.startOpts = opts as Record<string, (arg?: unknown) => void>;
    }
    return {
      mutate: vi.fn(),
      isPending: false,
    };
  },
  useQueryClient: () => hoisted.queryClient,
  useQuery: ({ initialData }: { initialData?: () => unknown }) => ({
    data: initialData ? initialData() : null,
  }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  ignoreAppVersionMutation: () => ({}),
  // Tagged so the useMutation mock above can pick this one out of several.
  startAppMutation: () => ({ __kind: 'start' }),
  unignoreAppVersionMutation: () => ({}),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', async () => {
  const actual = await vi.importActual<typeof import('@/modules/app/helpers/app-sse-cache')>('@/modules/app/helpers/app-sse-cache');
  return { ...actual, invalidateAppQueries: (...args: unknown[]) => hoisted.invalidateAppQueries(...args) };
});

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
    useLocation: () => ({ pathname: '/apps/test-app/community', search: '' }),
    useNavigate: () => hoisted.navigate,
    useSearchParams: () => [new URLSearchParams(), vi.fn()] as const,
  };
});

vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../../components/dialogs/install-dialog/install-dialog', () => ({
  InstallDialog: () => null,
}));
vi.mock('../../components/dialogs/cancel-install-dialog/cancel-install-dialog', () => ({
  CancelInstallDialog: () => null,
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

const OPEN_DATA_FOLDER_TESTID = 'icon-action-app_action_open_data_folder';

describe('AppActions', () => {
  afterEach(() => {
    hoisted.tauriInvoke = null;
    hoisted.openPath.mockReset();
    hoisted.startOpts = undefined;
    hoisted.invalidateAppQueries.mockReset();
  });

  it('re-syncs the app when a start fails synchronously so the status never sticks on "starting" (#909)', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    render(<AppActions app={runningApp} metadata={metadata} info={info} appDataHostPath="/srv/hub/app-data/community/test-app" layout="hero" />);

    // Start is the highest-traffic lifecycle action. A pre-flight rejection (starting
    // an app that was already removed) throws before any status update, so no SSE
    // event ever arrives to clear the optimistic 'starting' status.
    expect(hoisted.startOpts?.onError).toBeTypeOf('function');
    hoisted.startOpts?.onError?.({ message: 'APP_ERROR_APP_NOT_FOUND', intlParams: { id: 'test-app:community' } } as never);

    expect(hoisted.invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'test-app:community');
  });

  it('hides the "Open data folder" button in the web client (no Tauri)', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = null;

    render(<AppActions app={runningApp} metadata={metadata} info={info} appDataHostPath="/srv/hub/app-data/community/test-app" layout="hero" />);

    expect(screen.queryByTestId(OPEN_DATA_FOLDER_TESTID)).not.toBeInTheDocument();
  });

  it('shows the "Open data folder" button in the desktop app and opens the host path on click', async () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = vi.fn();

    render(<AppActions app={runningApp} metadata={metadata} info={info} appDataHostPath="/srv/hub/app-data/community/test-app" layout="hero" />);

    const button = screen.getByTestId(OPEN_DATA_FOLDER_TESTID);
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(hoisted.openPath).toHaveBeenCalledWith('/srv/hub/app-data/community/test-app');
  });

  it('hides the "Open data folder" button when no host path is available', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = vi.fn();

    render(<AppActions app={runningApp} metadata={metadata} info={info} layout="hero" />);

    expect(screen.queryByTestId(OPEN_DATA_FOLDER_TESTID)).not.toBeInTheDocument();
  });

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

  it('shows a short ROCm message and AI Settings link for rocm_kfd_missing errors', () => {
    hoisted.queryClient.getQueryData.mockReturnValue({
      message: 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.',
      errorCode: 'rocm_kfd_missing',
      settingsPath: '/settings?tab=ai&section=rocm',
    });

    render(
      <MemoryRouter>
        <AppActions app={runningApp} metadata={metadata} info={info} layout="hero" />
      </MemoryRouter>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('APP_ERROR_ROCM_KFD_MISSING');
    expect(screen.getByRole('link', { name: 'APP_ERROR_OPEN_AI_SETTINGS' })).toHaveAttribute('href', '/settings?tab=ai&section=rocm');
  });

  it('shows the Cancel button only while installing (not for other transient states)', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    const { rerender } = render(
      <MemoryRouter>
        <AppActions app={makeApp({ status: 'installing' })} metadata={metadata} info={info} />
      </MemoryRouter>,
    );
    // IconActionButton testid derives from the (mocked) label COMMON_CANCEL.
    expect(screen.getByTestId('icon-action-common_cancel')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <AppActions app={makeApp({ status: 'uninstalling' })} metadata={metadata} info={info} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('icon-action-common_cancel')).not.toBeInTheDocument();
  });
});
