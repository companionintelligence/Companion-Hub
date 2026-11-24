import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDetails, AppInfo, AppMetadata } from '@/types/app.types';

const { access, seen } = vi.hoisted(() => ({
  access: { actions: [] as string[] },
  seen: {
    actions: undefined as readonly string[] | undefined,
    canEditNotes: undefined as boolean | undefined,
    onImageUpload: undefined as unknown,
  },
}));

vi.mock('../helpers/use-custom-app-access', () => ({
  useCustomAppAccess: () => ({ actions: access.actions, may: (action: string) => access.actions.includes(action) }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  uploadAppImageMutation: () => ({}),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ userSettings: { localDomain: 'local.test', sslPort: 443 } }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl: () => 'http://localhost:5002/api/marketplace/apps/whoami-check%3A_user/image',
}));

vi.mock('@/components/custom-app-logo/custom-app-logo', () => ({
  CustomAppLogo: (props: { onImageUpload?: unknown }) => {
    seen.onImageUpload = props.onImageUpload;
    return <div data-testid="custom-app-logo" />;
  },
}));

vi.mock('../components/app-status/app-status', () => ({
  AppStatus: () => <div data-testid="app-status" />,
}));

vi.mock('../helpers/use-app-url-availability', () => ({
  useAppUrlAvailability: () => ({ state: 'idle', statusMessage: null }),
}));

vi.mock('../containers/app-actions/app-actions', () => ({
  AppActions: (props: { allowedActions?: readonly string[] }) => {
    seen.actions = props.allowedActions;
    return <div data-testid="app-actions" />;
  },
}));

vi.mock('../containers/app-details-tabs/app-details-tabs', () => ({
  AppDetailsTabs: (props: { canEditNotes?: boolean }) => {
    seen.canEditNotes = props.canEditNotes;
    return <div data-testid="app-details-tabs" />;
  },
}));

vi.mock('../components/app-backups-card/app-backups-card', () => ({
  AppBackupsCard: () => <div data-testid="app-backups-card" />,
}));

vi.mock('../components/custom-app-restart-notice/custom-app-restart-notice', () => ({
  CustomAppRestartNotice: () => null,
}));

vi.mock('../components/app-access-points/app-access-points', () => ({
  AppAccessPoints: () => <div data-testid="app-access-points" />,
}));

import { CustomAppDetailsPageContent } from './custom-app-details-page-content';

const info = {
  id: 'whoami-check',
  urn: 'whoami-check:_user',
  name: 'Whoami Check',
  version: '1.0.0',
  short_desc: 'User-created custom app',
} as unknown as AppInfo;

const EVERY_ACTION = ['view', 'start', 'stop', 'restart', 'install', 'update', 'uninstall', 'reset', 'backup', 'restore', 'configure'];
const installed = { id: 1, status: 'stopped', config: {} } as unknown as AppDetails;

describe('CustomAppDetailsPageContent', () => {
  beforeEach(() => {
    access.actions = EVERY_ACTION;
    seen.actions = undefined;
    seen.canEditNotes = undefined;
    seen.onImageUpload = undefined;
  });

  // Laid out like a store app's page: the app's name heads the card, and "Version: 1.0.0" no longer stands in for it.
  it("heads the page with the app's own name and says it is a custom app", () => {
    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Whoami Check' })).toBeInTheDocument();
    expect(screen.getByText('CUSTOM_APP_KIND')).toBeInTheDocument();
    expect(screen.getByTestId('app-version')).toHaveTextContent('v1.0.0');
  });

  it('leaves out the description the Hub wrote itself and shows one the owner wrote', () => {
    const { rerender } = render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);
    expect(screen.queryByText('User-created custom app')).not.toBeInTheDocument();

    rerender(
      <CustomAppDetailsPageContent
        appId="whoami-check"
        info={{ ...info, short_desc: 'Checks who is calling' } as AppInfo}
        app={installed}
        metadata={{} as AppMetadata}
      />,
    );
    expect(screen.getByText('Checks who is calling')).toBeInTheDocument();
  });

  // As on a store app page: the addresses, backups and notes follow the header card instead of sitting inside it.
  it('puts the addresses, backups and notes after the header card', () => {
    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);

    const card = screen.getByTestId('app-details');
    for (const id of ['app-access-points', 'app-backups-card', 'app-details-tabs']) {
      const section = screen.getByTestId(id);
      expect(card).not.toContainElement(section);
      expect(card.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('gives an organization owner or admin every control: actions, notes, logo and backups', () => {
    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);

    expect(seen.actions).toEqual(EVERY_ACTION);
    expect(seen.canEditNotes).toBe(true);
    expect(seen.onImageUpload).toBeTypeOf('function');
    expect(screen.getByTestId('app-backups-card')).toBeInTheDocument();
  });

  // A member sees the app, its status and Open. Its settings, backups and lifecycle are not offered at all.
  it('shows a member the app without its backups, its logo upload, its notes editor or any change', () => {
    access.actions = ['view'];

    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);

    expect(seen.actions).toEqual(['view']);
    expect(seen.canEditNotes).toBe(false);
    expect(seen.onImageUpload).toBeUndefined();
    expect(screen.queryByTestId('app-backups-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-status')).toBeInTheDocument();
  });

  it('offers an account with no linked Portal identity start, stop and restart, and no settings or backups', () => {
    access.actions = ['view', 'start', 'stop', 'restart'];

    render(<CustomAppDetailsPageContent appId="whoami-check" info={info} app={installed} metadata={{} as AppMetadata} />);

    expect(seen.actions).toEqual(['view', 'start', 'stop', 'restart']);
    expect(seen.canEditNotes).toBe(false);
    expect(screen.queryByTestId('app-backups-card')).not.toBeInTheDocument();
  });
});
