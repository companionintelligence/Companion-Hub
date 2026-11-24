import { getAllAppStoresQueryKey } from '@/api-client/@tanstack/react-query.gen';
import { render, screen, userEvent, waitFor, within } from '@/tests/test-utils';
import type { AppStore } from '@/types/app.types';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DeleteAppStoreDialog } from './delete-app-store-dialog';

const { mutationFn, toastSuccess } = vi.hoisted(() => ({
  mutationFn: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api-client/@tanstack/react-query.gen')>()),
  deleteAppStoreMutation: () => ({ mutationFn }),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const APP_STORE: AppStore = { slug: 'community-apps', name: 'Community Apps', enabled: true, url: 'https://community.example.com/repo.git' };
const ALL_STORES_KEY = getAllAppStoresQueryKey();

describe('DeleteAppStoreDialog', () => {
  it('refreshes the store list before reporting the removal', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ALL_STORES_KEY, { appStores: [APP_STORE] });
    let finishRefetch = () => {};
    const refetch = vi.fn(
      () =>
        new Promise<{ appStores: AppStore[] }>((resolve) => {
          finishRefetch = () => resolve({ appStores: [] });
        }),
    );
    // The observer makes the query active, so invalidating it refetches.
    const unsubscribe = new QueryObserver(queryClient, { queryKey: ALL_STORES_KEY, queryFn: refetch, staleTime: Number.POSITIVE_INFINITY }).subscribe(
      () => {},
    );

    render(
      <QueryClientProvider client={queryClient}>
        <DeleteAppStoreDialog appStore={APP_STORE} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'COMMON_DELETE' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'COMMON_DELETE' }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(mutationFn).toHaveBeenCalledWith({ path: { id: APP_STORE.slug } }, expect.anything());
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    finishRefetch();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('APP_STORE_DELETE_SUCCESS'));
    unsubscribe();
  });
});
