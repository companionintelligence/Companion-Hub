import { render, screen, userEvent, waitFor, within } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: { guestDashboard: true } as { guestDashboard?: boolean },
  refreshAppContext: vi.fn(async () => {}),
  updateSettings: vi.fn(async (_options: unknown) => ({})),
  setVisibility: vi.fn(async (_options: unknown) => ({})),
  createLink: vi.fn(async (_options: unknown) => ({})),
  editLink: vi.fn(async (_options: unknown) => ({})),
  deleteLink: vi.fn(async (_options: unknown) => ({})),
  installed: [] as unknown[],
  links: [] as unknown[],
  linksFail: false,
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({ userSettings: h.settings, refreshAppContext: h.refreshAppContext }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsOptions: () => ({ queryKey: ['installed'], queryFn: async () => ({ installed: h.installed }) }),
  getInstalledAppsQueryKey: () => ['installed'],
  getAppQueryKey: (options: { path: { urn: string } }) => ['app', options.path.urn],
  getLinksOptions: () => ({
    queryKey: ['links'],
    queryFn: async () => {
      if (h.linksFail) throw new Error('INTERNAL_SERVER_ERROR');
      return { links: h.links };
    },
  }),
  getLinksQueryKey: () => ['links'],
  updateUserSettingsMutation: () => ({ mutationFn: h.updateSettings }),
  setGuestVisibilityMutation: () => ({ mutationFn: h.setVisibility }),
  createLinkMutation: () => ({ mutationFn: h.createLink }),
  editLinkMutation: () => ({ mutationFn: h.editLink }),
  deleteLinkMutation: () => ({ mutationFn: h.deleteLink }),
}));

vi.mock('@/lib/marketplace-image-url', () => ({
  getMarketplaceAppImageUrl: (urn?: string) => (urn ? `/api/marketplace/apps/${urn}/image` : '/app-not-found.jpg'),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// The link dialog's switch is a Radix control, which measures itself. jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { GuestDashboardSettings } from './guest-dashboard-settings';

const app = (urn: string, name: string, visible: boolean, shortDesc = '') => ({
  app: { id: urn.length, status: 'running', isVisibleOnGuestDashboard: visible },
  info: { id: urn.split(':')[0], urn, name, short_desc: shortDesc },
});

const wiki = {
  id: 7,
  title: 'Family wiki',
  url: 'https://wiki.example.com',
  description: 'House notes',
  iconUrl: null,
  isVisibleOnGuestDashboard: true,
  userId: 1,
};
const calendar = {
  id: 8,
  title: 'Calendar',
  url: 'https://cal.example.com',
  description: null,
  iconUrl: '',
  isVisibleOnGuestDashboard: false,
  userId: 1,
};

const renderCard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <GuestDashboardSettings />
    </QueryClientProvider>,
  );

describe('GuestDashboardSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.settings = { guestDashboard: true };
    h.installed = [
      app('immich:ci-marketplace', 'Immich', true, 'Photos'),
      app('family-photos:_user', 'Family Photos', false, 'User-created custom app'),
    ];
    h.links = [wiki, calendar];
    h.linksFail = false;
  });

  it('turns the guest dashboard on by itself, without the rest of General settings', async () => {
    h.settings = { guestDashboard: false };
    renderCard();

    expect(screen.queryByRole('heading', { name: 'Apps' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Enable guest dashboard' }));

    await waitFor(() => expect(h.updateSettings).toHaveBeenCalledWith({ body: { guestDashboard: true } }, expect.anything()));
    expect(h.refreshAppContext).toHaveBeenCalled();
  });

  it('keeps its hint reachable from the keyboard', () => {
    renderCard();

    const hint = screen.getByRole('button', {
      name: 'This will allow non-authenticated users to see a limited dashboard and easily access the running apps on your instance.',
    });
    hint.focus();
    expect(hint).toHaveFocus();
  });

  // The per-app choice used to be only in each app's Settings dialog, and only with Advanced mode on.
  it('lists every installed app with a switch that shows or hides it', async () => {
    renderCard();

    const list = await screen.findByTestId('guest-dashboard-apps-list');
    expect(within(list).getByRole('switch', { name: 'Show Immich to guests' })).toBeChecked();
    expect(within(list).getByRole('switch', { name: 'Show Family Photos to guests' })).not.toBeChecked();
    // The description the Hub writes for a custom app says nothing, so it isn't shown.
    expect(within(list).getByText('Photos')).toBeInTheDocument();
    expect(within(list).queryByText('User-created custom app')).not.toBeInTheDocument();

    await userEvent.click(within(list).getByRole('switch', { name: 'Show Family Photos to guests' }));

    await waitFor(() =>
      expect(h.setVisibility).toHaveBeenCalledWith({ path: { urn: 'family-photos:_user' }, body: { visible: true } }, expect.anything()),
    );
  });

  // The switch used to read the one mutation's last variables: it flicked back between the answer and
  // the refetch, and a second app flipped meanwhile dropped the first back to its old state.
  it('keeps each app switch on its new state while its save and refetch are under way', async () => {
    const saves: Array<() => void> = [];
    const heldSave = (options: unknown) =>
      new Promise<object>((resolve) => {
        saves.push(() => {
          const { path, body } = options as { path: { urn: string }; body: { visible: boolean } };
          h.installed = h.installed.map((entry) => {
            const row = entry as ReturnType<typeof app>;
            return row.info.urn === path.urn ? { ...row, app: { ...row.app, isVisibleOnGuestDashboard: body.visible } } : row;
          });
          resolve({});
        });
      });
    h.setVisibility.mockImplementationOnce(heldSave).mockImplementationOnce(heldSave);
    renderCard();

    const list = await screen.findByTestId('guest-dashboard-apps-list');
    const immich = within(list).getByRole('switch', { name: 'Show Immich to guests' });
    const photos = within(list).getByRole('switch', { name: 'Show Family Photos to guests' });
    await userEvent.click(immich);
    await userEvent.click(photos);

    expect(immich).not.toBeChecked();
    expect(immich).toBeDisabled();
    expect(photos).toBeChecked();
    expect(photos).toBeDisabled();

    for (const save of saves) save();

    await waitFor(() => expect(photos).toBeEnabled());
    expect(immich).not.toBeChecked();
    expect(photos).toBeChecked();
  });

  it('lists the links and marks the ones guests do not see', async () => {
    renderCard();

    const list = await screen.findByTestId('guest-dashboard-links-list');
    expect(within(list).getByText('Family wiki')).toBeInTheDocument();
    expect(within(list).getByText('https://wiki.example.com')).toBeInTheDocument();
    expect(within(list).getAllByText('Hidden from guests')).toHaveLength(1);
  });

  it('says the links failed to load, rather than that there are none, and loads them on Retry', async () => {
    h.linksFail = true;
    renderCard();

    expect(await screen.findByText('Something went wrong. Retry, or refresh the page if it keeps happening.')).toBeInTheDocument();
    expect(screen.queryByText('No links yet.')).not.toBeInTheDocument();

    h.linksFail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('guest-dashboard-links-list')).toBeInTheDocument();
  });

  it('adds a link, naming what is wrong before it is sent', async () => {
    h.links = [];
    renderCard();

    expect(await screen.findByText('No links yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add link' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a link' });

    await userEvent.type(within(dialog).getByLabelText('Address'), 'wiki.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));

    expect(await within(dialog).findByText('Give the link a title.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter a full address, starting with https://')).toBeInTheDocument();
    expect(h.createLink).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText('Title'), 'Family wiki');
    await userEvent.clear(within(dialog).getByLabelText('Address'));
    await userEvent.type(within(dialog).getByLabelText('Address'), 'https://wiki.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));

    await waitFor(() =>
      expect(h.createLink).toHaveBeenCalledWith(
        {
          body: { title: 'Family wiki', url: 'https://wiki.example.com', description: '', iconUrl: '', isVisibleOnGuestDashboard: true },
        },
        expect.anything(),
      ),
    );
  });

  it('edits a link with its saved values filled in', async () => {
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit Family wiki' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Family wiki' });
    expect(within(dialog).getByLabelText('Description')).toHaveValue('House notes');

    await userEvent.click(within(dialog).getByRole('switch', { name: 'Show to guests' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(h.editLink).toHaveBeenCalledWith(
        {
          path: { id: 7 },
          body: { title: 'Family wiki', url: 'https://wiki.example.com', description: 'House notes', iconUrl: '', isVisibleOnGuestDashboard: false },
        },
        expect.anything(),
      ),
    );
  });

  it('deletes a link after asking', async () => {
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Delete Calendar' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Calendar?' });
    expect(h.deleteLink).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(h.deleteLink).toHaveBeenCalledWith({ path: { id: 8 } }, expect.anything()));
  });
});
