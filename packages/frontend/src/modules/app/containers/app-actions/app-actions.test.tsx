import { act, render, screen, userEvent, waitFor } from '@/tests/test-utils';
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
  ignoreOpts: undefined as undefined | Record<string, (...args: unknown[]) => void>,
  unignoreOpts: undefined as undefined | Record<string, (...args: unknown[]) => void>,
  invalidateAppQueries: vi.fn(),
  invalidateUpdatesAvailable: vi.fn(),
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
    connectedByOther: false,
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
  /** Props the uninstall dialog was last rendered with. */
  uninstallDialogProps: undefined as undefined | { canReset?: boolean },
  /** What the install progress bar reads, as the SSE progress ticks leave it. */
  installationProgress: null as null | { percent: number; downloadedBytes?: number; totalBytes?: number },
  /** Props the cancel-install confirmation was last rendered with. */
  cancelInstallProps: undefined as undefined | { onCancelStart?: () => void },
  /** Props the cancel-update confirmation (the same dialog, `operation="update"`) was last rendered with. */
  cancelUpdateProps: undefined as undefined | { onCancelStart?: () => void },
  /** The step of a running update, as the SSE stream left it. */
  updatePhase: null as null | string,
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
    if (opts?.__kind === 'ignore') {
      hoisted.ignoreOpts = opts as Record<string, (...args: unknown[]) => void>;
    }
    if (opts?.__kind === 'unignore') {
      hoisted.unignoreOpts = opts as Record<string, (...args: unknown[]) => void>;
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
  // Tagged so the useMutation mock above can pick each one out of several.
  ignoreAppVersionMutation: () => ({ __kind: 'ignore' }),
  startAppMutation: () => ({ __kind: 'start' }),
  unignoreAppVersionMutation: () => ({ __kind: 'unignore' }),
}));

// AppActions consumes exactly one VALUE from this module; everything else it imports is
// `import type` and erased. Spreading importActual would link the real module against the
// partial api-client mock above (no getAppQueryKey etc.), so any future test that reaches
// another export fails with an opaque "No export is defined on the mock" instead of a
// normal assertion. Mock just what is used, matching the sibling dialog tests.
vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries: (...args: unknown[]) => hoisted.invalidateAppQueries(...args),
  invalidateUpdatesAvailable: (...args: unknown[]) => hoisted.invalidateUpdatesAvailable(...args),
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
  useInstallationProgress: () => hoisted.installationProgress,
}));

vi.mock('@/modules/app/helpers/use-update-phase', () => ({
  useUpdatePhase: (urn?: string) => (urn ? hoisted.updatePhase : null),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    architecture: hoisted.architecture,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => hoisted.toastError(...args),
    success: vi.fn(),
  },
}));

vi.mock('react-i18next', () => {
  // Every key reads as itself but those the install error banner is handed, so a key left untranslated shows.
  const copy: Record<string, string> = {
    APP_INSTALL_PORTAL_ORGANIZATION_REQUIRED: 'Translated refusal',
    PORTAL_REQUEST_FAILED: 'CI Account request failed ({{status}}) for {{path}}.',
    APP_ACTION_GRANT_DENIED: 'Translated grant denial',
    APP_ERROR_APP_NOT_FOUND: 'Translated app not found',
  };

  return {
    useTranslation: () => ({
      t: (key: string) => copy[key] ?? key,
      i18n: { exists: (key: string) => key in copy },
    }),
  };
});

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
  CancelInstallDialog: (props: { onCancelStart?: () => void; operation?: 'install' | 'update' }) => {
    if (props.operation === 'update') {
      hoisted.cancelUpdateProps = props;
    } else {
      hoisted.cancelInstallProps = props;
    }
    return null;
  },
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
  UninstallDialog: (props: { canReset?: boolean }) => {
    hoisted.uninstallDialogProps = props;
    return null;
  },
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
    hoisted.ignoreOpts = undefined;
    hoisted.unignoreOpts = undefined;
    hoisted.invalidateAppQueries.mockReset();
    hoisted.invalidateUpdatesAvailable.mockReset();
    // Reset EVERY hoisted spy: mockReturnValue is sticky for the whole file, and vitest
    // is not configured with clearMocks/mockReset, so a leftover value silently leaks
    // into whichever test runs next and makes assertions depend on declaration order.
    hoisted.queryClient.getQueryData.mockReset();
    hoisted.navigate.mockReset();
    Object.assign(hoisted.memory, {
      applicable: false,
      connected: false,
      connectedByOther: false,
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
    hoisted.uninstallDialogProps = undefined;
    hoisted.installationProgress = null;
    hoisted.cancelInstallProps = undefined;
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

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown> | undefined)?.customDomainExpected).toBe('');
      expect(hoisted.installDialogProps?.boundCustomDomain).toBeNull();
    });
  });

  describe('the exposure mode the settings dialog opens on', () => {
    const openedMode = (app: AppDetails) => {
      render(<AppActions app={app} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);
      return (hoisted.updateSettingsProps?.config as Record<string, unknown> | undefined)?.exposureMode;
    };

    it('is the mode a custom app runs in when its form holds only a port', () => {
      expect(openedMode(makeApp({ exposureMode: 'local', config: { port: 9898 } }))).toBe('local');
    });

    it('is the mode the stored form names', () => {
      expect(openedMode(makeApp({ exposureMode: 'tailscale', config: { port: 9898, exposureMode: 'tailscale' } }))).toBe('tailscale');
    });

    it('stays Public Web for an app saved that way', () => {
      expect(
        openedMode(makeApp({ exposureMode: 'cloudflare', exposedLocal: true, config: { exposureMode: 'cloudflare', exposedLocal: true } })),
      ).toBe('cloudflare');
    });

    it('is what compose runs when the row and the form disagree', () => {
      // An install that sent no exposure settings stored `exposed_local = true` beside a local form.
      expect(openedMode(makeApp({ exposureMode: 'cloudflare', exposedLocal: true, config: { openPort: true } }))).toBe('local');
    });
  });

  describe('the exposure mode the install dialog opens on', () => {
    const installMode = (app: AppDetails | null) => {
      render(<AppActions app={app} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);
      return hoisted.installDialogProps?.retryExposureMode;
    };

    it('is what a failed install asked for when it is retried', () => {
      expect(installMode(makeApp({ status: 'install_failed', exposureMode: 'local', config: { exposureMode: 'local', openPort: true } }))).toBe(
        'local',
      );
    });

    it('is left to the new-install default for an app that is not installed', () => {
      expect(installMode(null)).toBeUndefined();
    });
  });

  describe('the port the install dialog opens on', () => {
    const installPort = (app: AppDetails | null) => {
      render(<AppActions app={app} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);
      return hoisted.installDialogProps?.retryPort;
    };

    // Another program held the listing's port, so the failed install moved the app off it.
    it('is the one a failed install left the app on when it is retried', () => {
      expect(installPort(makeApp({ status: 'install_failed', port: 10003 }))).toBe(10003);
    });

    it('is left to the listing for an app that is not installed', () => {
      expect(installPort(null)).toBeUndefined();
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

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown> | undefined)?.autoRestartOnDomainChange).toBe(true);
    });

    it('seeds it off for an app that never set it', () => {
      render(<AppActions app={runningApp} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect((hoisted.updateSettingsProps?.config as Record<string, unknown> | undefined)?.autoRestartOnDomainChange).toBe(false);
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

  describe('the install error under the actions', () => {
    const renderWithInstallError = (message: string) => {
      hoisted.queryClient.getQueryData.mockImplementation((key: unknown[]) => (key[0] === 'app-install-error' ? { message, ts: 1 } : null));

      render(<AppActions app={null} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);
    };

    it('translates a refused bundle download, which arrives as a key', () => {
      renderWithInstallError('APP_INSTALL_PORTAL_ORGANIZATION_REQUIRED');

      expect(screen.getByRole('alert')).toHaveTextContent('Translated refusal');
    });

    it('shows the general message for a key whose copy asks for values the event does not carry', () => {
      renderWithInstallError('PORTAL_REQUEST_FAILED');

      expect(screen.getByRole('alert')).toHaveTextContent('COMMON_AN_ERROR_OCCURRED');
    });

    it('shows an install that failed later as the text it sent', () => {
      renderWithInstallError('One or more containers exited after install.');

      expect(screen.getByRole('alert')).toHaveTextContent('One or more containers exited after install.');
    });
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

  describe('why the app is down', () => {
    const serviceFailure = { kind: 'restarting' as const, service: 'summary-service', exitCode: 126, logLine: 'permission denied' };
    // This file's `t` answers with the key. `app-service-failure.test.ts` covers the words.
    const text = 'APP_ERROR_SERVICE_WITH_LOG_LINE';

    it('names the service and the reason where it said one or more containers exited', () => {
      hoisted.queryClient.getQueryData.mockReturnValue({ message: 'keeps restarting in English', errorDetail: 'the logs', serviceFailure });

      render(
        <AppActions app={makeApp({ status: 'install_failed' })} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(text);
      expect(screen.getByRole('alert')).toHaveAttribute('title', 'the logs');
    });

    it.each(['install_failed', 'stopped'] as const)('reads it off the app in a tab that heard no event, when the app is %s', (status) => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);

      render(
        <AppActions
          app={makeApp({ status })}
          metadata={metadata}
          info={info}
          failure={{ message: 'keeps restarting in English', serviceFailure }}
          urlAvailability={idleAvailability}
          layout="hero"
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(text);
    });

    it('takes the reason on the app over the event, which leaves out the log line', () => {
      hoisted.queryClient.getQueryData.mockReturnValue({
        message: 'from the event',
        serviceFailure: { kind: 'restarting', service: 'summary-service' },
      });

      render(
        <AppActions
          app={makeApp({ status: 'install_failed' })}
          metadata={metadata}
          info={info}
          failure={{ message: 'keeps restarting in English', errorDetail: 'the logs', serviceFailure }}
          urlAvailability={idleAvailability}
          layout="hero"
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(text);
      expect(screen.getByRole('alert')).toHaveAttribute('title', 'the logs');
    });

    it('falls back on the event for someone the app does not give the reason to', () => {
      hoisted.queryClient.getQueryData.mockReturnValue({
        message: 'from the event',
        serviceFailure: { kind: 'restarting', service: 'summary-service' },
      });

      render(<AppActions app={makeApp({ status: 'stopped' })} metadata={metadata} info={info} urlAvailability={idleAvailability} layout="hero" />);

      expect(screen.getByRole('alert')).toHaveTextContent('APP_ERROR_SERVICE_KEEPS_RESTARTING');
    });

    it('drops it while the app is being worked on again, before the read catches up', () => {
      hoisted.queryClient.getQueryData.mockReturnValue(null);

      render(
        <AppActions
          app={makeApp({ status: 'starting' })}
          metadata={metadata}
          info={info}
          failure={{ message: 'keeps restarting in English', serviceFailure }}
          urlAvailability={idleAvailability}
          layout="hero"
        />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
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

  describe('the install progress bar', () => {
    const MB = 1024 * 1024;
    const renderInstalling = () =>
      render(
        <MemoryRouter>
          <AppActions app={makeApp({ status: 'installing' })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
        </MemoryRouter>,
      );

    it('says how much of the download has arrived', () => {
      hoisted.installationProgress = { percent: 75, downloadedBytes: 412 * MB, totalBytes: 1536 * MB };

      renderInstalling();

      expect(screen.getByText('APP_ACTION_DOWNLOADING 412 MB / 1.5 GB')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
    });

    it('says only Downloading while Docker has reported no sizes yet', () => {
      hoisted.installationProgress = { percent: 60 };

      renderInstalling();

      expect(screen.getByText('APP_ACTION_DOWNLOADING')).toBeInTheDocument();
    });

    // Docker often reports a small layer first; on a live Hub the readout opened as "0 MB / 0 MB".
    it('waits for a megabyte before it shows sizes', () => {
      hoisted.installationProgress = { percent: 98, downloadedBytes: 300 * 1024, totalBytes: 400 * 1024 };

      renderInstalling();

      expect(screen.getByText('APP_ACTION_DOWNLOADING')).toBeInTheDocument();
    });

    it('gives sizes under 10 MB to a tenth of a megabyte', () => {
      hoisted.installationProgress = { percent: 63, downloadedBytes: 7.2 * MB, totalBytes: 91 * MB };

      renderInstalling();

      expect(screen.getByText('APP_ACTION_DOWNLOADING 7.2 MB / 91 MB')).toBeInTheDocument();
    });
  });

  /*
   * A custom app's page passes the verbs this person holds. A member gets the app and Open only; an
   * account with no linked Portal identity also gets start, stop and restart. Nothing is shown that the
   * Hub would refuse.
   */
  describe.each(['running', 'stopped'] as const)('offering an update on a %s app', (status) => {
    const UPDATE = 'icon-action-common_update';
    const IGNORE = 'icon-action-app_action_ignore_version';
    const UNIGNORE = 'icon-action-app_action_unignore_version';
    const shown = () => [UPDATE, IGNORE, UNIGNORE].filter((id) => screen.queryByTestId(id));

    const renderOffer = (latest: AppMetadata, ignoredVersion?: number) =>
      render(
        <MemoryRouter>
          <AppActions
            app={makeApp({ status, version: 8, ignoredVersion })}
            metadata={latest}
            info={makeInfo({ version: '2026.10.28', cihub_app_version: 8 })}
            urlAvailability={idleAvailability}
          />
        </MemoryRouter>,
      );

    it('offers nothing when the app is up to date', () => {
      renderOffer({ latestVersion: 8, latestDockerVersion: '2026.10.28' });
      expect(shown()).toEqual([]);
    });

    it('offers a newer version whose counter did not change, without an ignore that could not hide it', () => {
      renderOffer({ latestVersion: 8, latestDockerVersion: '2026.11.2' });
      expect(shown()).toEqual([UPDATE]);
    });

    it('offers a raised counter and lets it be ignored', () => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.10.28' });
      expect(shown()).toEqual([UPDATE, IGNORE]);
    });

    it('hides an ignored counter and offers to stop ignoring it', () => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.10.28' }, 9);
      expect(shown()).toEqual([UNIGNORE]);
    });

    it('still offers a newer version beside an ignored counter', () => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.11.2' }, 9);
      expect(shown()).toEqual([UPDATE, UNIGNORE]);
    });

    // The icons above come from the app query and nothing else would make it fetch again. The URN is
    // the one the request went out for, since the page may have moved to another app by the time it lands.
    it.each([
      ['ignore', () => hoisted.ignoreOpts],
      ['unignore', () => hoisted.unignoreOpts],
    ])('asks for the app again once the %s has gone through', (_name, opts) => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.10.28' });

      opts()?.onSuccess?.(undefined, { path: { urn: 'other-app:community' } });

      expect(hoisted.invalidateAppQueries).toHaveBeenCalledWith(hoisted.queryClient, 'other-app:community');
    });

    // CI-Hub#2376: an ignored update stayed in Home's "Update all" until a reload.
    it.each([
      ['ignore', () => hoisted.ignoreOpts],
      ['unignore', () => hoisted.unignoreOpts],
    ])('asks for the update count again once the %s has gone through', (_name, opts) => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.10.28' });

      opts()?.onSuccess?.(undefined, { path: { urn: 'other-app:community' } });

      expect(hoisted.invalidateUpdatesAvailable).toHaveBeenCalledWith(hoisted.queryClient);
    });

    // CI-Hub#2376: a refused ignore showed APP_ACTION_GRANT_DENIED, a missing app APP_ERROR_APP_NOT_FOUND.
    it.each([
      ['ignore', () => hoisted.ignoreOpts, 'APP_ACTION_GRANT_DENIED', 'Translated grant denial'],
      ['unignore', () => hoisted.unignoreOpts, 'APP_ERROR_APP_NOT_FOUND', 'Translated app not found'],
    ])('says why a refused %s failed in words, not as its key', (_name, opts, key, words) => {
      renderOffer({ latestVersion: 9, latestDockerVersion: '2026.10.28' });

      opts()?.onError?.({ message: key, intlParams: {} });

      expect(hoisted.toastError).toHaveBeenCalledWith(words);
    });

    // CI-Hub#2376: an app at the counter it once ignored has no update, so there is nothing to un-ignore.
    it('offers nothing once the app has reached the counter it ignored', () => {
      renderOffer({ latestVersion: 8, latestDockerVersion: '2026.10.28' }, 8);
      expect(shown()).toEqual([]);
    });

    it('still offers a newer version, and no un-ignore, once the app has reached the counter it ignored', () => {
      renderOffer({ latestVersion: 8, latestDockerVersion: '2026.11.2' }, 8);
      expect(shown()).toEqual([UPDATE]);
    });
  });

  describe('the actions a person may use', () => {
    const customInfo = makeInfo({ urn: 'whoami-check:_user', id: 'whoami-check', no_gui: false });
    const renderCustom = (status: AppDetails['status'], allowedActions?: readonly string[]) =>
      render(
        <MemoryRouter>
          <AppActions
            app={makeApp({ status })}
            metadata={metadata}
            info={customInfo}
            urlAvailability={idleAvailability}
            allowedActions={allowedActions}
          />
        </MemoryRouter>,
      );
    const CHANGES = [
      'icon-action-common_settings',
      'icon-action-app_install_form_reset',
      'icon-action-app_action_uninstall',
      'icon-action-custom_app_edit_config',
    ];

    it('shows a member a stopped custom app with no Start and no change', () => {
      renderCustom('stopped', ['view']);

      expect(screen.queryByTestId('action-app_action_start')).not.toBeInTheDocument();
      for (const testId of CHANGES) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    it('shows a member a running custom app with Open, and no Stop, Restart or change', () => {
      renderCustom('running', ['view']);

      expect(screen.getByTestId('action-app_action_open')).toBeInTheDocument();
      expect(screen.queryByTestId('icon-action-common_stop')).not.toBeInTheDocument();
      expect(screen.queryByTestId('icon-action-common_restart')).not.toBeInTheDocument();
      for (const testId of CHANGES) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    // Connecting or disconnecting Companion Memory restarts the app, so it takes the restart grant.
    it('shows no Memory button to a person who may not restart the app', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: true, connectable: true });
      renderCustom('running', ['view']);

      expect(screen.queryByTestId('action-memory_connect_action_connect_memory')).not.toBeInTheDocument();
    });

    it('shows the Memory buttons to a person who may restart the app', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: true, connectable: true });
      renderCustom('running', ['view', 'restart']);

      expect(screen.getByTestId('action-memory_connect_action_connect_memory')).toBeInTheDocument();
    });

    it('offers an account with no linked Portal identity start, stop and restart, and no change', () => {
      renderCustom('running', ['view', 'start', 'stop', 'restart']);

      expect(screen.getByTestId('icon-action-common_stop')).toBeInTheDocument();
      expect(screen.getByTestId('icon-action-common_restart')).toBeInTheDocument();
      for (const testId of CHANGES) {
        expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      }
    });

    // The uninstall dialog points at Reset app, so it may only do that where the page shows Reset.
    it('lets the uninstall dialog point at Reset app only where Reset is offered', () => {
      const { unmount } = renderCustom('stopped');
      expect(hoisted.uninstallDialogProps?.canReset).toBe(true);
      unmount();

      const failed = renderCustom('install_failed');
      expect(hoisted.uninstallDialogProps?.canReset).toBe(false);
      failed.unmount();

      renderCustom('running', ['view', 'uninstall']);
      expect(hoisted.uninstallDialogProps?.canReset).toBe(false);
    });

    it('shows an organization owner or admin everything, as when the page passes nothing', () => {
      renderCustom('stopped', ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure']);

      expect(screen.getByTestId('action-app_action_start')).toBeInTheDocument();
      for (const testId of CHANGES) {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      }
    });

    // #2421: the API and MCP tools could always edit a running custom app; the page hid the button.
    it('offers Edit configuration on a running custom app, after Reset app as when it is stopped', () => {
      renderCustom('running', ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure']);

      const icons = screen.getAllByTestId(/^icon-action-/).map((icon) => icon.getAttribute('data-testid'));
      expect(icons).toContain('icon-action-custom_app_edit_config');
      expect(icons.indexOf('icon-action-custom_app_edit_config')).toBe(icons.indexOf('icon-action-app_install_form_reset') + 1);
    });

    it('keeps Edit configuration from a member, who may not change the app', () => {
      renderCustom('running', ['view']);

      expect(screen.queryByTestId('icon-action-custom_app_edit_config')).not.toBeInTheDocument();
    });

    // A stopped app had Uninstall in the middle of the bar, before Edit Configuration. It is last, as when the app runs.
    it('puts Uninstall last in the bar of a stopped app', () => {
      renderCustom('stopped', ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure']);

      const icons = screen.getAllByTestId(/^icon-action-/).map((icon) => icon.getAttribute('data-testid'));
      expect(icons.at(-1)).toBe('icon-action-app_action_uninstall');
    });
  });

  describe('cancelling an install', () => {
    const renderWithStatus = (status: AppDetails['status']) => (
      <MemoryRouter>
        <AppActions app={makeApp({ status })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
      </MemoryRouter>
    );

    it('starts the next install without "Cancelling" when the cancel reply came after the install was gone', () => {
      const { rerender } = render(renderWithStatus('installing'));

      // A queued install is settled at once: install_cancelled can reach the page before the
      // reply to the cancel request does.
      rerender(renderWithStatus('missing'));
      act(() => hoisted.cancelInstallProps?.onCancelStart?.());

      // The operator installs the app again.
      rerender(renderWithStatus('installing'));

      expect(screen.queryByText('APP_STATUS_CANCELLING')).not.toBeInTheDocument();
      expect(screen.getByTestId('icon-action-common_cancel')).toBeEnabled();
    });

    it('shows Cancelling while the install it cancelled winds down', () => {
      render(renderWithStatus('installing'));

      act(() => hoisted.cancelInstallProps?.onCancelStart?.());

      expect(screen.getAllByText('APP_STATUS_CANCELLING').length).toBeGreaterThan(0);
      expect(screen.getByTestId('icon-action-common_cancel')).toBeDisabled();
    });
  });

  // An update can wait minutes for the new version's health checks. The page said "Preparing..." the
  // whole time and offered no way out (#2107).
  describe('an update in progress', () => {
    const renderUpdating = () =>
      render(
        <MemoryRouter>
          <AppActions app={makeApp({ status: 'updating' })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
        </MemoryRouter>,
      );

    afterEach(() => {
      hoisted.updatePhase = null;
    });

    it.each([
      ['pulling', 'APP_UPDATE_PHASE_PULLING'],
      ['backing_up', 'APP_UPDATE_PHASE_BACKING_UP'],
      ['replacing', 'APP_UPDATE_PHASE_REPLACING'],
      ['starting', 'APP_UPDATE_PHASE_STARTING'],
      ['verifying', 'APP_UPDATE_PHASE_VERIFYING'],
      ['finalizing', 'APP_UPDATE_PHASE_FINALIZING'],
      ['rolling_back', 'APP_UPDATE_PHASE_ROLLING_BACK'],
    ])('says what the update is doing while it is %s', (phase, key) => {
      hoisted.updatePhase = phase;

      renderUpdating();

      expect(screen.getByText(key)).toBeInTheDocument();
      expect(screen.queryByText('APP_ACTION_PREPARING')).not.toBeInTheDocument();
    });

    it('offers Cancel while the update waits for the new version and opens the confirmation', async () => {
      hoisted.updatePhase = 'verifying';

      renderUpdating();

      const cancel = screen.getByTestId('icon-action-common_cancel');
      expect(cancel).toBeEnabled();
      await userEvent.click(cancel);
      expect(disclosureOpen).toHaveBeenCalled();
    });

    it.each(['finalizing', 'rolling_back'])('does not offer Cancel once the update is %s', (phase) => {
      hoisted.updatePhase = phase;

      renderUpdating();

      expect(screen.getByTestId('icon-action-common_cancel')).toBeDisabled();
    });

    it('shows Cancelling once the cancel was accepted, then the rollback', () => {
      hoisted.updatePhase = 'verifying';
      const { rerender } = renderUpdating();

      act(() => hoisted.cancelUpdateProps?.onCancelStart?.());
      expect(screen.getAllByText('APP_STATUS_CANCELLING').length).toBeGreaterThan(0);
      expect(screen.getByTestId('icon-action-common_cancel')).toBeDisabled();

      hoisted.updatePhase = 'rolling_back';
      rerender(
        <MemoryRouter>
          <AppActions app={makeApp({ status: 'updating' })} metadata={metadata} info={info} urlAvailability={idleAvailability} />
        </MemoryRouter>,
      );
      expect(screen.getByText('APP_UPDATE_PHASE_ROLLING_BACK')).toBeInTheDocument();
    });
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

    // No DNS record exists for an address the Portal refused, so the link could only end on a browser error (#2271).
    it('offers no "Open anyway" for an address the Portal refused, and still says why', () => {
      renderExposed(
        makeAvailability({
          state: 'unreachable',
          statusMessage: 'APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED',
          publicAddressRefusal: 'APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED',
          withinGracePeriod: false,
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.queryByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).not.toBeInTheDocument();
      expect(screen.getByText('APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED')).toBeInTheDocument();
    });

    it('offers no "Open anyway" for a refused address once probing has stopped either', () => {
      renderExposed(
        makeAvailability({
          state: 'unreachable',
          statusMessage: 'APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED',
          publicAddressRefusal: 'APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED',
          withinGracePeriod: false,
          pollingStopped: true,
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.getByTestId('action-common_retry')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).not.toBeInTheDocument();
    });

    // Retry clears the verdict while the next probe runs, and the refusal has to outlast that.
    it('offers no "Open anyway" for a refused address while Retry waits for the next verdict', () => {
      renderExposed(
        makeAvailability({
          state: 'checking',
          publicAddressRefusal: 'APP_ACTION_ERROR_PUBLIC_ADDRESS_QUOTA_EXCEEDED',
          appUrl: 'https://app.example.com',
        }),
      );

      expect(screen.queryByRole('button', { name: 'APP_ACTION_OPEN_ANYWAY' })).not.toBeInTheDocument();
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

    it('warns that Connect replaces the connection another person made and offers no Disconnect of it', () => {
      Object.assign(hoisted.memory, { applicable: true, memoryInstalled: true, memoryReady: true, connectable: true, connectedByOther: true });

      renderRunning();

      const button = screen.getByTestId('action-memory_connect_action_connect_memory');
      expect(button).toBeEnabled();
      expect(button.closest('[data-tooltip-id="app-actions-tooltip"]')).toHaveAttribute('data-tooltip-content', 'MEMORY_CONNECT_REPLACE_OTHER_DESC');
      expect(screen.queryByTestId('action-memory_connect_action_disconnect_memory')).not.toBeInTheDocument();
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
