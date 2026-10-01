import { fireEvent, render, screen, userEvent, waitFor, within } from '@/tests/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const URN = 'immich:ci-marketplace';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  saveFile: vi.fn(),
  setOptimisticStatus: vi.fn(),
  invalidateAppQueries: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getAppBackupsQueryKey: () => ['backups'],
  getAppBackupsOptions: (options: { query: { page: number } }) => ({
    queryKey: ['backups', options.query.page],
    queryFn: () => h.list(options.query.page),
  }),
  backupAppMutation: () => ({ mutationFn: (variables: unknown) => h.backup(variables) }),
  restoreAppBackupMutation: () => ({ mutationFn: (variables: unknown) => h.restore(variables) }),
  deleteAppBackupMutation: () => ({ mutationFn: (variables: unknown) => h.remove(variables) }),
  uploadBackupMutation: () => ({ mutationFn: (variables: unknown) => h.upload(variables) }),
}));

vi.mock('@/api-client/sdk.gen', () => ({ downloadBackup: (...args: unknown[]) => h.download(...args) }));
vi.mock('@/modules/settings/containers/log-download', () => ({ downloadResponseAsFile: (...args: unknown[]) => h.saveFile(...args) }));
vi.mock('../../helpers/app-sse-cache', () => ({ invalidateAppQueries: (...args: unknown[]) => h.invalidateAppQueries(...args) }));
vi.mock('../../helpers/use-app-status', () => ({ useAppStatus: () => ({ setOptimisticStatus: h.setOptimisticStatus }) }));
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => h.toastSuccess(...args), error: (...args: unknown[]) => h.toastError(...args) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}));

const { AppBackupsCard } = await import('./app-backups-card');

const BACKUPS = [
  { id: 'immich-ci-marketplace-1700000000000.tar.gz', size: 2_621_440, date: Date.UTC(2026, 8, 30, 10, 0, 0) },
  { id: 'immich-ci-marketplace-1690000000000.tar.gz', size: 512, date: Date.UTC(2026, 7, 1, 10, 0, 0) },
];

const listOf = (data = BACKUPS, extra: Partial<{ total: number; lastPage: number; currentPage: number }> = {}) => ({
  data,
  total: data.length,
  currentPage: 1,
  lastPage: 1,
  ...extra,
});

const mount = (ui: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...view,
    rerenderCard: (next: ReactElement) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
};

const card = (status: React.ComponentProps<typeof AppBackupsCard>['status'] = 'running') => (
  <AppBackupsCard appUrn={URN} appName="Immich" status={status} />
);

describe('AppBackupsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.list.mockResolvedValue(listOf());
    h.backup.mockResolvedValue({ requestId: 'r' });
    h.restore.mockResolvedValue({ requestId: 'r' });
    h.remove.mockResolvedValue(undefined);
    h.upload.mockResolvedValue({ success: true });
    h.download.mockResolvedValue({ response: { ok: true, status: 200 } });
  });

  describe('the list', () => {
    it('shows each backup with its size and date, and how many there are', async () => {
      mount(card());

      expect(await screen.findByText(BACKUPS[0]?.id as string)).toBeInTheDocument();
      expect(screen.getByText('2.5 MB')).toBeInTheDocument();
      expect(screen.getByText('512 B')).toBeInTheDocument();
      expect(screen.getByText(new Date(BACKUPS[0]?.date as number).toLocaleString())).toBeInTheDocument();
      expect(screen.getByText('(2)')).toBeInTheDocument();
    });

    it('says so when there are none', async () => {
      h.list.mockResolvedValue(listOf([]));
      mount(card());

      expect(await screen.findByText('BACKUPS_LIST_EMPTY')).toBeInTheDocument();
    });

    it('says so when the list cannot be loaded', async () => {
      h.list.mockRejectedValue(new Error('boom'));
      mount(card());

      expect(await screen.findByRole('alert')).toHaveTextContent('BACKUPS_LIST_LOAD_ERROR');
    });

    it('pages through a long list', async () => {
      h.list.mockImplementation(async (page: number) => listOf(BACKUPS, { total: 25, lastPage: 3, currentPage: page }));
      mount(card());
      await screen.findByText('BACKUPS_LIST_PAGE {"page":1,"total":3}');

      expect(screen.getByRole('button', { name: 'BACKUPS_LIST_PREVIOUS' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'BACKUPS_LIST_NEXT' }));

      expect(await screen.findByText('BACKUPS_LIST_PAGE {"page":2,"total":3}')).toBeInTheDocument();
      expect(h.list).toHaveBeenLastCalledWith(2);
    });

    it('steps back to the last page that exists when the page it is on has emptied', async () => {
      // Eleven backups, ten a page. The second page holds one; deleting it leaves a list of ten on one page.
      let deleted = false;
      h.list.mockImplementation(async (page: number) => {
        if (deleted) return listOf(page === 1 ? BACKUPS : [], { total: 10, lastPage: 1, currentPage: page });
        return listOf(page === 1 ? BACKUPS : [BACKUPS[1] as (typeof BACKUPS)[number]], { total: 11, lastPage: 2, currentPage: page });
      });
      h.remove.mockImplementation(async () => {
        deleted = true;
      });
      mount(card());
      await screen.findByText('BACKUPS_LIST_PAGE {"page":1,"total":2}');
      await userEvent.click(screen.getByRole('button', { name: 'BACKUPS_LIST_NEXT' }));
      await userEvent.click(await screen.findByRole('button', { name: `COMMON_DELETE ${BACKUPS[1]?.id}` }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'COMMON_DELETE' }));

      // Back on page 1, with its rows, rather than an empty page with a pager or a claim that there are no backups.
      expect(await screen.findByText(BACKUPS[0]?.id as string)).toBeInTheDocument();
      expect(screen.queryByText('BACKUPS_LIST_EMPTY')).toBeNull();
      expect(screen.queryByText('BACKUPS_LIST_NEXT')).toBeNull();
      expect(h.list).toHaveBeenLastCalledWith(1);
    });

    it('does not claim there are no backups while a page past the end is being replaced', async () => {
      h.list.mockImplementation(async (page: number) => listOf([], { total: 10, lastPage: 1, currentPage: page }));
      mount(card());

      await waitFor(() => expect(h.list).toHaveBeenCalled());
      expect(screen.queryByText('BACKUPS_LIST_EMPTY')).toBeNull();
    });

    it('shows no pager when everything fits on one page', async () => {
      mount(card());
      await screen.findByText(BACKUPS[0]?.id as string);

      expect(screen.queryByText('BACKUPS_LIST_NEXT')).toBeNull();
    });
  });

  describe('backing up', () => {
    it('asks first, then backs up and shows the app as backing up', async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('APP_BACKUP_SUBTITLE')).toBeInTheDocument();
      expect(h.backup).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_BACKUP' }));

      await waitFor(() => expect(h.backup).toHaveBeenCalledWith({ path: { urn: URN } }));
      expect(h.setOptimisticStatus).toHaveBeenCalledWith('backing_up', URN);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('reports a refusal and closes the dialog', async () => {
      h.backup.mockRejectedValue({ message: 'APP_ACTION_GRANT_DENIED', intlParams: { action: 'backup' } });
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'COMMON_BACKUP' }));

      await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('APP_ACTION_GRANT_DENIED {"action":"backup"}'));
    });

    it('asks the server for the real status when the request is refused, so the app is not left showing as backing up', async () => {
      h.backup.mockRejectedValue({ message: 'APP_ACTION_GRANT_DENIED', intlParams: { action: 'backup' } });
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'COMMON_BACKUP' }));

      expect(h.setOptimisticStatus).toHaveBeenCalledWith('backing_up', URN);
      await waitFor(() => expect(h.invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), URN));
    });

    it('does not ask when the request was accepted', async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'COMMON_BACKUP' }));

      await waitFor(() => expect(h.backup).toHaveBeenCalled());
      expect(h.invalidateAppQueries).not.toHaveBeenCalled();
    });
  });

  describe('restoring', () => {
    it('names the backup and warns that the data will be replaced before restoring it', async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: `COMMON_RESTORE ${BACKUPS[0]?.id}` }));

      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(BACKUPS[0]?.id as string);
      expect(within(dialog).getByText('APP_RESTORE_SUBTITLE')).toBeInTheDocument();
      expect(h.restore).not.toHaveBeenCalled();

      await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_RESTORE' }));

      await waitFor(() => expect(h.restore).toHaveBeenCalledWith({ path: { urn: URN }, body: { filename: BACKUPS[0]?.id } }));
      expect(h.setOptimisticStatus).toHaveBeenCalledWith('restoring', URN);
    });
  });

  describe('restoring, when refused', () => {
    it('asks the server for the real status, so the app is not left showing as restoring', async () => {
      h.restore.mockRejectedValue({ message: 'APP_RESTORE_ERROR_TOAST' });
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: `COMMON_RESTORE ${BACKUPS[0]?.id}` }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'COMMON_RESTORE' }));

      expect(h.setOptimisticStatus).toHaveBeenCalledWith('restoring', URN);
      await waitFor(() => expect(h.invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), URN));
    });
  });

  describe('deleting', () => {
    it('asks first, deletes only the chosen backup, says so and reloads the list', async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: `COMMON_DELETE ${BACKUPS[1]?.id}` }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('DELETE_BACKUP_MODAL_SUBTITLE')).toBeInTheDocument();
      expect(h.remove).not.toHaveBeenCalled();
      const loads = h.list.mock.calls.length;

      await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_DELETE' }));

      await waitFor(() => expect(h.remove).toHaveBeenCalledWith({ path: { urn: URN }, body: { filename: BACKUPS[1]?.id } }));
      await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('BACKUPS_LIST_DELETE_SUCCESS'));
      await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(loads));
    });
  });

  describe('uploading', () => {
    const open = async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: 'COMMON_UPLOAD_BACKUP' }));
      return screen.findByRole('dialog');
    };
    const file = (name: string) => new File(['x'], name, { type: 'application/gzip' });

    it('will not submit until a .tar.gz is chosen', async () => {
      const dialog = await open();

      expect(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' })).toBeDisabled();

      // The picker's `accept` filter keeps this out of a real browser's dialog, but a file can still be dropped or chosen with "all files".
      fireEvent.change(within(dialog).getByLabelText('APP_BACKUP_UPLOAD_FILE_LABEL'), { target: { files: [file('notes.txt')] } });

      expect(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' })).toBeDisabled();
      expect(within(dialog).getByRole('alert')).toHaveTextContent('APP_BACKUP_UPLOAD_FILE_PLACEHOLDER');
    });

    it('uploads the chosen file, says so, and reloads the list', async () => {
      const dialog = await open();
      const chosen = file('immich-1700000000000.tar.gz');
      await userEvent.upload(within(dialog).getByLabelText('APP_BACKUP_UPLOAD_FILE_LABEL'), chosen);
      const loads = h.list.mock.calls.length;

      await userEvent.click(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' }));

      await waitFor(() => expect(h.upload).toHaveBeenCalledWith({ path: { urn: URN }, body: { file: chosen } }));
      await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith('APP_BACKUP_UPLOAD_SUCCESS'));
      await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(loads));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('says when a backup of that name is already there, and keeps the dialog open to pick another', async () => {
      h.upload.mockRejectedValue(new Error('A backup with this filename already exists'));
      const dialog = await open();
      await userEvent.upload(within(dialog).getByLabelText('APP_BACKUP_UPLOAD_FILE_LABEL'), file('dup.tar.gz'));

      await userEvent.click(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' }));

      await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('APP_BACKUP_UPLOAD_ALREADY_EXISTS'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('says so when the Hub reports the name clash as a translation key', async () => {
      h.upload.mockRejectedValue({ message: 'APP_BACKUP_UPLOAD_ALREADY_EXISTS', status: 409 });
      const dialog = await open();
      await userEvent.upload(within(dialog).getByLabelText('APP_BACKUP_UPLOAD_FILE_LABEL'), file('dup.tar.gz'));

      await userEvent.click(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' }));

      await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('APP_BACKUP_UPLOAD_ALREADY_EXISTS'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('gives a general message for any other failure', async () => {
      h.upload.mockRejectedValue(new Error('Request failed with status code 500'));
      const dialog = await open();
      await userEvent.upload(within(dialog).getByLabelText('APP_BACKUP_UPLOAD_FILE_LABEL'), file('x.tar.gz'));

      await userEvent.click(within(dialog).getByRole('button', { name: 'APP_BACKUP_UPLOAD_SUBMIT' }));

      await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('APP_BACKUP_UPLOAD_ERROR'));
    });
  });

  describe('downloading', () => {
    it('streams the file and hands it to the browser under its own name', async () => {
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: `APP_BACKUP_DOWNLOAD ${BACKUPS[0]?.id}` }));

      await waitFor(() => expect(h.saveFile).toHaveBeenCalledWith({ ok: true, status: 200 }, BACKUPS[0]?.id));
      expect(h.download).toHaveBeenCalledWith({ path: { urn: URN, filename: BACKUPS[0]?.id }, parseAs: 'stream' });
    });

    it('says so when the download fails', async () => {
      h.download.mockResolvedValue({ response: { ok: false, status: 404 } });
      mount(card());
      await userEvent.click(await screen.findByRole('button', { name: `APP_BACKUP_DOWNLOAD ${BACKUPS[0]?.id}` }));

      await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('BACKUPS_LIST_DOWNLOAD_ERROR'));
      expect(h.saveFile).not.toHaveBeenCalled();
    });
  });

  describe('while something else is working on the app', () => {
    it.each(['backing_up', 'restoring', 'updating', 'installing', 'starting', 'stopping', 'restarting', 'resetting', 'uninstalling'] as const)(
      'is read-only when the app is %s, apart from downloading',
      async (status) => {
        mount(card(status));
        await screen.findByText(BACKUPS[0]?.id as string);

        expect(screen.getByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'COMMON_UPLOAD_BACKUP' })).toBeDisabled();
        expect(screen.getByRole('button', { name: `COMMON_RESTORE ${BACKUPS[0]?.id}` })).toBeDisabled();
        expect(screen.getByRole('button', { name: `COMMON_DELETE ${BACKUPS[0]?.id}` })).toBeDisabled();
        expect(screen.getByRole('button', { name: `APP_BACKUP_DOWNLOAD ${BACKUPS[0]?.id}` })).toBeEnabled();
      },
    );

    it.each(['running', 'stopped'] as const)('is fully available when the app is %s', async (status) => {
      mount(card(status));
      await screen.findByText(BACKUPS[0]?.id as string);

      expect(screen.getByRole('button', { name: 'BACKUPS_LIST_BACKUP_NOW' })).toBeEnabled();
      expect(screen.getByRole('button', { name: `COMMON_RESTORE ${BACKUPS[0]?.id}` })).toBeEnabled();
    });
  });

  describe('when a backup or restore finishes', () => {
    it.each([['backing_up'], ['restoring']] as const)('reloads the list as the app leaves %s', async (working) => {
      const view = mount(card(working));
      await screen.findByText(BACKUPS[0]?.id as string);
      const loads = h.list.mock.calls.length;

      view.rerenderCard(card('running'));

      await waitFor(() => expect(h.list.mock.calls.length).toBeGreaterThan(loads));
    });

    it('does not reload for an unrelated status change', async () => {
      const view = mount(card('running'));
      await screen.findByText(BACKUPS[0]?.id as string);
      const loads = h.list.mock.calls.length;

      view.rerenderCard(card('stopped'));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(h.list.mock.calls.length).toBe(loads);
    });
  });
});
