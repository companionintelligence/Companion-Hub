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

const info: AppInfo = {
  id: 'test-app',
  urn: 'test-app:community',
  name: 'Test App',
  short_desc: 'Short description',
  description: 'Long description',
  categories: [],
  form_fields: [],
  no_gui: true,
  deprecated: false,
  replacesNames: [],
  version: '1.0.0',
} as AppInfo;

const metadata: AppMetadata = {
  latestVersion: 1,
} as AppMetadata;

const runningApp: AppDetails = {
  status: 'running',
  version: 1,
  config: {},
  ignoredVersion: null,
  exposureMode: 'local',
} as AppDetails;

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

    render(<AppActions app={{ ...runningApp, status: 'install_failed' }} metadata={metadata} info={info} layout="hero" />);

    expect(screen.getByTestId('action-app_action_retry_install')).toHaveClass('retry-install-action-button');
  });
});
