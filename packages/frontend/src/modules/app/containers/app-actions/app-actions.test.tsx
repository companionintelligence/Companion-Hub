import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { stashPendingInstallIntent } from '@/lib/deep-link-install';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppActions } from './app-actions';
import { IDLE_APP_URL_AVAILABILITY, type AppUrlAvailability } from '../../helpers/use-app-url-availability';

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
  openExternal: vi.fn(),
  // Companion Memory connection state. Defaults to "not a memory consumer", which
  // is what every non-memory test expects (no button rendered at all).
  memory: {
    applicable: false,
    connected: false,
    memoryInstalled: false,
    memoryReady: false,
    connectable: false,
    blockedReasonKey: null as string | null,
    providerStatus: 'absent',
    connectUrl: null as string | null,
    connectUrlLocal: null as string | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    isDisconnecting: false,
    isLoading: false,
  },
  architecture: 'amd64' as 'amd64' | 'arm64',
  toastError: vi.fn(),
  forgetInstallIntent: vi.fn(),
  /*
   * Props the two dialogs that carry the custom-domain state were mounted with.
   * The seeding is the whole behaviour here — what the operator is SHOWN is what
   * a release is allowed to act on (R2-HUBDOMAINS-3) — and it happens on the way
   * in, so it is only observable from the props.
   */
  updateSettingsProps: undefined as undefined | Record<string, unknown>,
  installDialogProps: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@/modules/app/helpers/use-memory-connection', () => ({
  useMemoryConnection: () => hoisted.memory,
  useMemoryProviderForceGate: () => ({
    requiresForce: false,
    consumers: [],
    unableToVerify: false,
    forceConfirmed: false,
    setForceConfirmed: vi.fn(),
    submitDisabled: false,
  }),
}));

vi.mock('@/lib/helpers/open-folder', () => ({
  openPathInFileExplorer: (...args: unknown[]) => hoisted.openPath(...args),
  openLogsFolder: vi.fn(),
  canOpenFolderInFileExplorer: () => hoisted.tauriInvoke !== null,
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

// AppActions consumes exactly one VALUE from this module; everything else it imports is
// `import type` and erased. Spreading importActual would link the real module against the
// partial api-client mock above (no getAppQueryKey etc.), so any future test that reaches
// another export fails with an opaque "No export is defined on the mock" instead of a
// normal assertion. Mock just what is used, matching the sibling dialog tests.
vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: (...args: unknown[]) => hoisted.invalidateAppQueries(...args),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const disclosureOpen = vi.hoisted(() => vi.fn());

vi.mock('@/lib/hooks/use-disclosure', () => ({
  useDisclosure: () => ({
    isOpen: false,
    open: disclosureOpen,
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

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    architecture: hoisted.architecture,
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: (...args: unknown[]) => hoisted.toastError(...args),
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
  openExternal: (...args: unknown[]) => hoisted.openExternal(...args),
}));

vi.mock('@/lib/deep-link-install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deep-link-install')>()),
  forgetInstallIntentForApp: (...args: unknown[]) => hoisted.forgetInstallIntent(...args),
}));

vi.mock('../../components/dialogs/install-dialog/install-dialog', () => ({
  InstallDialog: (props: Record<string, unknown>) => {
    hoisted.installDialogProps = props;
    return null;
  },
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
vi.mock('../../components/dialogs/app-data-folder-dialog/app-data-folder-dialog', () => ({
  AppDataFolderDialog: () => null,
}));
vi.mock('../../components/dialogs/update-settings-dialog/update-settings-dialog', () => ({
  UpdateSettingsDialog: (props: Record<string, unknown>) => {
    hoisted.updateSettingsProps = props;
    return null;
  },
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
    // Required on the generated `AppInfo`: the schema defaults it to `[]`, and `.default()` makes a
    // field required in the OpenAPI output even though a manifest may omit it.
    replaces: [],
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
    domain: '',
    exposed: false,
    exposedLocal: false,
    ignoredVersion: 0,
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

/** Public-route readiness is a prop now (the page owns the probe), so tests inject it directly. */
function makeAvailability(overrides: Partial<AppUrlAvailability> = {}): AppUrlAvailability {
  return { ...IDLE_APP_URL_AVAILABILITY, ...overrides };
}

const idleAvailability = makeAvailability();

const info = makeInfo();
/** A GUI app is what renders the Open button area; the default fixture is headless. */
const guiInfo = makeInfo({ no_gui: false });

const metadata: AppMetadata = {
  latestVersion: 1,
};

const runningApp = makeApp();
/** Public-web exposure: the only mode that waits on the availability probe. */
const exposedApp = makeApp({ exposureMode: 'cloudflare' });

const OPEN_DATA_FOLDER_TESTID = 'icon-action-app_action_open_data_folder';
const COPY_DATA_FOLDER_TESTID = 'icon-action-app_action_copy_data_folder_path';

describe('AppActions', () => {
  afterEach(() => {
    hoisted.tauriInvoke = null;
    hoisted.openPath.mockReset();
    hoisted.openExternal.mockReset();
    hoisted.startOpts = undefined;
    hoisted.invalidateAppQueries.mockReset();
    // Reset EVERY hoisted spy: mockReturnValue is sticky for the whole file, and vitest
    // is not configured with clearMocks/mockReset, so a leftover value silently leaks
    // into whichever test runs next and makes assertions depend on declaration order.
    hoisted.queryClient.getQueryData.mockReset();
    hoisted.navigate.mockReset();
    Object.assign(hoisted.memory, {
      applicable: false,
      connected: false,
      memoryInstalled: false,
      memoryReady: false,
      connectable: false,
      blockedReasonKey: null,
      providerStatus: 'absent',
    });
    hoisted.architecture = 'amd64';
    hoisted.toastError.mockReset();
    hoisted.forgetInstallIntent.mockReset();
    hoisted.updateSettingsProps = undefined;
    hoisted.installDialogProps = undefined;
    disclosureOpen.mockReset();
  });

  describe('the custom-domain state a save is allowed to act on', () => {
    /*
     * R2-HUBDOMAINS-3. Both dialogs submit `customDomain` on every save, and `''`
     * is the instruction to give a domain up — so each has to carry what the row
     * held when it was drawn, or the Hub cannot tell an operator's decision from
     * a snapshot that went stale while the dialog sat open.
     */
    const servingApp = makeApp({ customDomain: 'shop.acme.com', customDomainIntent: 'comfy.acme.com' });

    it('seeds the settings dialog with the BINDING, alongside the intent it shows in the picker', () => {
      render(<AppActions app={servingApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      const config = hoisted.updateSettingsProps?.config as Record<string, unknown>;

      // The release acts on what CI-Cloud is actually serving, so that — not the
      // intent the picker displays — is what the save has to be conditioned on.
      expect(config.customDomainExpected).toBe('shop.acme.com');
      expect(config.customDomain).toBe('comfy.acme.com');
    });

    it('tells the install dialog what a reinstall would be giving up', () => {
      render(<AppActions app={servingApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect(hoisted.installDialogProps?.boundCustomDomain).toBe('shop.acme.com');
    });

    it('claims nothing for an app that holds no domain', () => {
      render(<AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown>).customDomainExpected).toBe('');
      expect(hoisted.installDialogProps?.boundCustomDomain).toBeNull();
    });
  });

  describe('the restart setting for a newly connected domain', () => {
    /*
     * The stored config snapshot leaves this setting out, so that flipping it never
     * restarts the app — which makes the row the only place the dialog can read it
     * from. Seeded from anywhere else, every save of an unrelated setting would
     * quietly turn it back off.
     */
    it('seeds the settings dialog with what the app was saved with', () => {
      render(
        <AppActions
          app={makeApp({ autoRestartOnDomainChange: true })}
          metadata={metadata}
          info={info}
          urlAvailability={idleAvailability}
          layout="hero"
        />,
      );

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown>).autoRestartOnDomainChange).toBe(true);
    });

    it('seeds it off for an app that never set it', () => {
      render(<AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown>).autoRestartOnDomainChange).toBe(false);
    });
  });

  it('re-syncs the app when a start fails synchronously so the status never sticks on "starting" (#909)', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    render(
      <AppActions
        app={runningApp}
        metadata={metadata}
        info={info}
        appDataHostPath="/srv/hub/app-data/community/test-app"
        urlAvailability={idleAvailability}
        layout="hero"
      />,
    );

    // Start is the highest-traffic lifecycle action. A pre-flight rejection (starting
    // an app that was already removed) throws before any status update, so no SSE
    // event ever arrives to clear the optimistic 'starting' status.
    expect(hoisted.startOpts?.onError).toBeTypeOf('function');
    hoisted.startOpts?.onError?.({ message: 'APP_ERROR_APP_NOT_FOUND', intlParams: { id: 'test-app:community' } } as never);

    // Assert the client itself, not expect.anything(): the latter accepts any non-null
    // value, so dropping the useQueryClient() argument entirely would still pass.
    expect(hoisted.invalidateAppQueries).toHaveBeenCalledWith(hoisted.queryClient, 'test-app:community');
  });

  it('opens a read-only data-folder dialog in the web client', async () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = null;

    render(
      <AppActions
        app={runningApp}
        metadata={metadata}
        info={info}
        appDataHostPath="/srv/hub/app-data/community/test-app"
        urlAvailability={idleAvailability}
        layout="hero"
      />,
    );

    const button = screen.getByTestId(OPEN_DATA_FOLDER_TESTID);
    expect(button).toBeInTheDocument();
    expect(screen.queryByTestId(COPY_DATA_FOLDER_TESTID)).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(disclosureOpen).toHaveBeenCalled();
    expect(hoisted.openPath).not.toHaveBeenCalled();
  });

  it('shows the "Open data folder" button in the desktop app and opens the host path on click', async () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = vi.fn();

    render(
      <AppActions
        app={runningApp}
        metadata={metadata}
        info={info}
        appDataHostPath="/srv/hub/app-data/community/test-app"
        urlAvailability={idleAvailability}
        layout="hero"
      />,
    );

    const button = screen.getByTestId(OPEN_DATA_FOLDER_TESTID);
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(hoisted.openPath).toHaveBeenCalledWith('/srv/hub/app-data/community/test-app');
    expect(disclosureOpen).not.toHaveBeenCalled();
  });

  it('opens the listing dialog on desktop when the host path is missing', async () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = vi.fn();

    render(<AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

    const button = screen.getByTestId(OPEN_DATA_FOLDER_TESTID);
    await userEvent.click(button);
    expect(disclosureOpen).toHaveBeenCalled();
    expect(hoisted.openPath).not.toHaveBeenCalled();
  });

  it('hides the "Open data folder" button when the app is not installed', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.tauriInvoke = vi.fn();

    render(<AppActions app={null} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

    expect(screen.queryByTestId(OPEN_DATA_FOLDER_TESTID)).not.toBeInTheDocument();
    expect(screen.queryByTestId(COPY_DATA_FOLDER_TESTID)).not.toBeInTheDocument();
  });

  it('disables Install and toasts wrong architecture when the Hub arch is unsupported', async () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);
    hoisted.architecture = 'arm64';

    render(
      <AppActions
        app={null}
        metadata={metadata}
        info={makeInfo({ supported_architectures: ['amd64'] })}
        urlAvailability={idleAvailability}
        layout="hero"
      />,
    );

    const install = screen.getByTestId('action-common_install');
    expect(install).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(install);
    expect(hoisted.toastError).toHaveBeenCalledWith('APP_ACTION_WRONG_ARCHITECTURE');
  });

  describe('a saved link to install this app', () => {
    // A link held during setup opens the dialog from the stash while the desktop shell still has the
    // same link parked. Left there, it brought the user back here with the dialog open on the next
    // page load.
    afterEach(() => {
      sessionStorage.clear();
    });

    it('opens the install dialog and forgets every copy of the link', async () => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);
      stashPendingInstallIntent({ appSlug: 'test-app', storeId: 'community' });

      render(<AppActions app={null} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      await waitFor(() => expect(disclosureOpen).toHaveBeenCalled());
      expect(hoisted.forgetInstallIntent).toHaveBeenCalledWith('test-app', 'community');
    });

    it('forgets the link when the app cannot run on this Hub', async () => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);
      hoisted.architecture = 'arm64';
      stashPendingInstallIntent({ appSlug: 'test-app', storeId: 'community' });

      render(
        <AppActions
          app={null}
          metadata={metadata}
          info={makeInfo({ supported_architectures: ['amd64'] })}
          urlAvailability={idleAvailability}
          layout="hero"
        />,
      );

      await waitFor(() => expect(hoisted.toastError).toHaveBeenCalledWith('APP_ACTION_WRONG_ARCHITECTURE'));
      expect(disclosureOpen).not.toHaveBeenCalled();
      expect(hoisted.forgetInstallIntent).toHaveBeenCalledWith('test-app', 'community');
    });

    it('leaves a saved link for another app alone', () => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);
      stashPendingInstallIntent({ appSlug: 'other-app', storeId: 'community' });

      render(<AppActions app={null} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect(disclosureOpen).not.toHaveBeenCalled();
      expect(hoisted.forgetInstallIntent).not.toHaveBeenCalled();
    });
  });

  it('shows Start (not Install) when an installed app has no containers (stopped or legacy missing)', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    const { rerender } = render(
      <AppActions app={makeApp({ status: 'stopped' })} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />,
    );

    expect(screen.getByTestId('action-app_action_start')).toBeInTheDocument();
    expect(screen.queryByTestId('action-common_install')).not.toBeInTheDocument();

    rerender(<AppActions app={makeApp({ status: 'missing' })} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

    expect(screen.getByTestId('action-app_action_start')).toBeInTheDocument();
    expect(screen.queryByTestId('action-common_install')).not.toBeInTheDocument();
  });

  it('shows Install when the app is not installed', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    render(<AppActions app={null} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

    expect(screen.getByTestId('action-common_install')).toBeInTheDocument();
    expect(screen.queryByTestId('action-app_action_start')).not.toBeInTheDocument();
  });

  it('keeps install errors inline in hero layout with constrained width', () => {
    hoisted.queryClient.getQueryData.mockReturnValue({
      message: 'Install completed with warnings and needs your attention before the app is fully usable.',
    });

    const { container } = render(<AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('hero-inline-install-error');
    expect(alert).toHaveTextContent('Install completed with warnings and needs your attention before the app is fully usable.');
    expect(container.querySelector('.hero-action-bar')).toBeInTheDocument();
  });

  it('uses the taller amber retry install button styling for failed installs', () => {
    hoisted.queryClient.getQueryData.mockReturnValue(null);

    render(
      <AppActions app={makeApp({ status: 'install_failed' })} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />,
    );

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
        <AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />
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
        <AppActions app={makeApp({ status: 'installing' })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
      </MemoryRouter>,
    );
    // IconActionButton testid derives from the (mocked) label COMMON_CANCEL.
    expect(screen.getByTestId('icon-action-common_cancel')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <AppActions app={makeApp({ status: 'uninstalling' })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('icon-action-common_cancel')).not.toBeInTheDocument();
  });

  describe('launch action while the public route is not ready', () => {
    const renderExposed = (urlAvailability: AppUrlAvailability) => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);
      return render(<AppActions app={exposedApp} metadata={metadata} info={guiInfo} urlAvailability={urlAvailability} layout="hero" />);
    };

    it('never says "Starting" while propagating — the app has already started', () => {
      renderExposed(makeAvailability({ state: 'propagating', statusMessage: 'APP_ACTION_ERROR_DNS_NOT_FOUND', withinGracePeriod: true }));

      // The contradiction this fixes: a green "Running" pill beside a "Starting…" button.
      expect(screen.queryByText('COMMON_STARTING')).not.toBeInTheDocument();
      expect(screen.getByTestId('action-button-loading')).toBeDisabled();
    });

    it('keeps the "Open anyway" escape hatch while propagating, without repeating the reason', () => {
      renderExposed(
        makeAvailability({
          state: 'propagating',
          statusMessage: 'APP_ACTION_ERROR_DNS_NOT_FOUND',
          withinGracePeriod: true,
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.getByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).toBeInTheDocument();
      // The status pill carries the explanation now; duplicating it here is noise.
      expect(screen.queryByText('APP_ACTION_ERROR_DNS_NOT_FOUND')).not.toBeInTheDocument();
    });

    it('offers Resolve with the reason once the grace window has passed', () => {
      renderExposed(
        makeAvailability({
          state: 'propagating',
          statusMessage: 'APP_ACTION_ERROR_DNS_NOT_FOUND',
          withinGracePeriod: false,
          resolvable: true,
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.getByTestId('action-app_action_resolve')).toBeInTheDocument();
      expect(screen.getByText('APP_ACTION_ERROR_DNS_NOT_FOUND')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).toBeInTheDocument();
    });

    it('offers the local network route as an enabled action when the public one is unreachable', () => {
      renderExposed(
        makeAvailability({
          state: 'unreachable',
          statusMessage: 'APP_ACTION_ERROR_CF_UNKNOWN',
          appUrl: 'https://app.example.com',
          localUrl: 'http://192.168.1.9:8080',
        }),
      );

      // The point of CI-Engineering#75: a broken tunnel says nothing about the
      // local network, so this must be a real enabled action rather than the
      // disabled red button that used to sit next to a perfectly healthy app.
      const openLocally = screen.getByTestId('action-app_action_open_locally');
      expect(openLocally).toBeInTheDocument();
      expect(openLocally).toBeEnabled();
      // The failure is still reported, so the user knows why the route changed.
      expect(screen.getByText('APP_ACTION_ERROR_CF_UNKNOWN')).toBeInTheDocument();
    });

    it('falls back to the disabled error button when there is no local route to offer', () => {
      renderExposed(
        makeAvailability({ state: 'unreachable', statusMessage: 'APP_ACTION_ERROR_CF_UNKNOWN', appUrl: 'https://app.example.com', localUrl: null }),
      );

      expect(screen.queryByTestId('action-app_action_open_locally')).not.toBeInTheDocument();
      expect(screen.getByTestId('action-app_action_open')).toBeDisabled();
    });

    it('hides the local-network route for a remote browser that cannot reach a LAN address', () => {
      // A dashboard loaded over the public tunnel origin is a remote browser; the
      // app's http://192.168.x address is unroutable from there, so offering it
      // would just reinstate the dead button #75 removes. `localUrl` is present
      // (it is caller-independent), so only the page-origin gate suppresses it.
      const original = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...original, hostname: 'hub-core2-acme.companionintelligence.com', protocol: 'https:' },
      });
      try {
        renderExposed(
          makeAvailability({
            state: 'unreachable',
            statusMessage: 'APP_ACTION_ERROR_CF_UNKNOWN',
            appUrl: 'https://app.example.com',
            localUrl: 'http://192.168.1.9:8080',
          }),
        );

        expect(screen.queryByTestId('action-app_action_open_locally')).not.toBeInTheDocument();
        expect(screen.getByTestId('action-app_action_open')).toBeDisabled();
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: original });
      }
    });

    // A public FQDN whose leading labels only LOOK like a private range must not
    // be treated as LAN-reachable, or the dead button returns. The literal ranges
    // apply only to actual IP literals.
    it.each([
      ['192.168.cdn.example.com', false],
      ['10.foo.com', false],
      ['fcbank.com', false],
      ['fd-cdn.example.com', false],
      ['192.168.1.9', true],
      ['10.0.0.5', true],
    ])('classifies page host %s as LAN-reachable=%s for the local button', (hostname, reachable) => {
      const original = window.location;
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...original, hostname, protocol: hostname.includes('.example.com') || hostname.endsWith('.com') ? 'https:' : 'http:' },
      });
      try {
        renderExposed(
          makeAvailability({
            state: 'unreachable',
            statusMessage: 'APP_ACTION_ERROR_CF_UNKNOWN',
            appUrl: 'https://app.example.com',
            localUrl: 'http://192.168.1.9:8080',
          }),
        );

        if (reachable) {
          expect(screen.getByTestId('action-app_action_open_locally')).toBeEnabled();
        } else {
          expect(screen.queryByTestId('action-app_action_open_locally')).not.toBeInTheDocument();
        }
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: original });
      }
    });

    it('leads with the local route alongside Resolve, since it is the action most likely to work', () => {
      renderExposed(
        makeAvailability({
          state: 'propagating',
          statusMessage: 'APP_ACTION_ERROR_DNS_NOT_FOUND',
          withinGracePeriod: false,
          resolvable: true,
          appUrl: 'https://app.example.com',
          localUrl: 'http://192.168.1.9:8080',
        }),
      );

      expect(screen.getByTestId('action-app_action_open_locally')).toBeEnabled();
      expect(screen.getByTestId('action-app_action_resolve')).toBeInTheDocument();
    });

    it('offers a plain retry once probing has been given up on', () => {
      renderExposed(makeAvailability({ state: 'unreachable', statusMessage: 'APP_ACTION_ERROR_CF_UNKNOWN', resolvable: true, pollingStopped: true }));

      expect(screen.getByTestId('action-common_retry')).toBeInTheDocument();
      expect(screen.queryByTestId('action-app_action_resolve')).not.toBeInTheDocument();
    });

    it('still offers a retry after giving up on a verdict the Hub cannot repair', () => {
      // Nothing is polling any more, so a spinner here would be a dead end.
      renderExposed(
        makeAvailability({ state: 'unreachable', statusMessage: 'APP_ACTION_APPLICATION_ERROR', resolvable: false, pollingStopped: true }),
      );

      expect(screen.getByTestId('action-common_retry')).toBeInTheDocument();
    });

    it('shows the reason and the escape hatch for a propagating verdict that is not resolvable', () => {
      // Past the grace window with resolvable falsy used to fall through every
      // branch to a bare spinner, losing both the reason and "Open anyway".
      renderExposed(
        makeAvailability({
          state: 'propagating',
          statusMessage: 'APP_ACTION_ERROR_DNS_NOT_FOUND',
          withinGracePeriod: false,
          resolvable: false,
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.getByText('APP_ACTION_ERROR_DNS_NOT_FOUND')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).toBeInTheDocument();
    });

    it('enables Open as soon as the route is serving', async () => {
      renderExposed(makeAvailability({ state: 'ready', appUrl: 'https://app.example.com' }));

      const open = screen.getByTestId('action-app_action_open');
      expect(open).toBeEnabled();

      await userEvent.click(open);
      expect(hoisted.openExternal).toHaveBeenCalledWith('https://app.example.com');
    });
  });

  describe('Companion Memory action', () => {
    const renderRunning = () =>
      render(
        <MemoryRouter>
          <AppActions app={runningApp} metadata={metadata} info={guiInfo} urlAvailability={idleAvailability} layout="hero" />
        </MemoryRouter>,
      );

    it('renders nothing for an app that is not a memory consumer', () => {
      renderRunning();

      expect(screen.queryByTestId('action-memory_connect_action_connect_memory')).not.toBeInTheDocument();
    });

    it('offers an enabled Connect when a connect can actually be started', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: true, connectable: true });

      renderRunning();

      expect(screen.getByTestId('action-memory_connect_action_connect_memory')).toBeEnabled();
    });

    it('keeps Connect visible but disabled — with the REASON — when this browser cannot start one', () => {
      // The hole CI-Engineering#75 closes: ci-memory is up, so the old code fell
      // into the enabled branch and rendered a dead button under the generic
      // "what connecting does" tooltip, explaining the feature but not the block.
      Object.assign(hoisted.memory, {
        applicable: true,
        memoryInstalled: true,
        memoryReady: true,
        connectable: false,
        blockedReasonKey: 'MEMORY_CONNECT_BLOCKED_HUB_UNREACHABLE',
      });

      renderRunning();

      const button = screen.getByTestId('action-memory_connect_action_connect_memory');
      expect(button).toBeDisabled();
      // The tooltip is anchored on the wrapper span: a disabled button has
      // `pointer-events: none`, so hover would never reach it.
      expect(button.closest('[data-tooltip-id="app-actions-tooltip"]')).toHaveAttribute(
        'data-tooltip-content',
        'MEMORY_CONNECT_BLOCKED_HUB_UNREACHABLE',
      );
    });

    it('falls back to the generic description when the backend sends no reason', () => {
      Object.assign(hoisted.memory, {
        applicable: true,
        memoryInstalled: true,
        memoryReady: true,
        connectable: false,
        blockedReasonKey: null,
      });

      renderRunning();

      expect(screen.getByTestId('action-memory_connect_action_connect_memory').closest('[data-tooltip-id="app-actions-tooltip"]')).toHaveAttribute(
        'data-tooltip-content',
        'MEMORY_CONNECT_DESC',
      );
    });

    it('shows Disconnect once connected', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: true, connectable: true, connected: true });

      renderRunning();

      expect(screen.getByTestId('action-memory_connect_action_disconnect_memory')).toBeInTheDocument();
      expect(screen.queryByTestId('action-memory_connect_action_connect_memory')).not.toBeInTheDocument();
    });

    it('disables the action while CI Memory is still starting', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: false, providerStatus: 'starting' });

      renderRunning();

      expect(screen.getByTestId('action-memory_connect_action_connect_memory')).toBeDisabled();
    });
  });
});
