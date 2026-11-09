import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import type { AppStore } from '@/types/app.types';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { EditAppStoreDialog } from './edit-app-store-dialog';

const { mutationFn, toastSuccess } = vi.hoisted(() => ({
  mutationFn: vi.fn(async () => ({})),
  toastSuccess: vi.fn(),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateAppStoreMutation: () => ({ mutationFn }),
}));

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const APP_STORE: AppStore = { slug: 'ci-marketplace', name: 'CI Marketplace', enabled: true, url: 'https://portal.example.com/api' };
const ALL_STORES_KEY = [{ _id: 'getAllAppStores' }];

// The Switch measures itself with ResizeObserver, which jsdom doesn't have.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

describe('EditAppStoreDialog', () => {
  it('refreshes the store list before reporting the save', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ALL_STORES_KEY, { appStores: [APP_STORE] });
    let finishRefetch = () => {};
    const refetch = vi.fn(
      () =>
        new Promise<{ appStores: AppStore[] }>((resolve) => {
          finishRefetch = () => resolve({ appStores: [{ ...APP_STORE, name: 'Home Shelf' }] });
        }),
    );
    // The observer makes the query active, so invalidating it refetches.
    const unsubscribe = new QueryObserver(queryClient, { queryKey: ALL_STORES_KEY, queryFn: refetch, staleTime: Number.POSITIVE_INFINITY }).subscribe(
      () => {},
    );

    render(
      <QueryClientProvider client={queryClient}>
        <EditAppStoreDialog appStore={APP_STORE} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'COMMON_EDIT' }));
    const name = await screen.findByLabelText('COMMON_NAME');
    await userEvent.clear(name);
    await userEvent.type(name, 'Home Shelf');
    await userEvent.click(screen.getByRole('button', { name: 'COMMON_SAVE' }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(mutationFn).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    finishRefetch();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('APP_STORE_EDIT_DIALOG_SUCCESS'));
    unsubscribe();
  });
});
