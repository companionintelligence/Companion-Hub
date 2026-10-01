import { render, screen, userEvent, waitFor } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Options = { __name: string; onSuccess?: () => void; onError?: (error: { message: string; intlParams?: Record<string, string> }) => void };
  const registered = new Map<string, Options>();
  const mutate = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    registered,
    mutate,
    invalidateQueries: vi.fn(),
    toastInfo: vi.fn(),
    toastError: vi.fn(),
    track: (name: string) => {
      const fn = vi.fn();
      mutate.set(name, fn);
      return fn;
    },
  };
});

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { __name: string; onSuccess?: () => void; onError?: (e: never) => void }) => {
    h.registered.set(options.__name, options as never);
    return { mutate: h.mutate.get(options.__name) ?? h.track(options.__name), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getInstalledAppsQueryKey: () => ['installed-apps'],
  startAllAppsMutation: () => ({ __name: 'start' }),
  stopAllAppsMutation: () => ({ __name: 'stop' }),
  restartAllAppsMutation: () => ({ __name: 'restart' }),
  updateAllAppsMutation: () => ({ __name: 'update' }),
}));

vi.mock('sonner', () => ({ toast: { info: (...args: unknown[]) => h.toastInfo(...args), error: (...args: unknown[]) => h.toastError(...args) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { BatchActionsMenu } = await import('./batch-actions-menu');

const open = async (props: Partial<React.ComponentProps<typeof BatchActionsMenu>> = {}) => {
  render(<BatchActionsMenu runningCount={2} stoppedCount={1} updatesAvailable={0} {...props} />);
  await userEvent.click(screen.getByTestId('batch-actions-trigger'));
};

const isDisabled = (item: HTMLElement) => item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled');

describe('BatchActionsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.registered.clear();
    h.mutate.clear();
  });

  it('offers start, stop and restart, and no update when none is available', async () => {
    await open();

    expect(screen.getByRole('menuitem', { name: 'MY_APPS_START_ALL_FORM_SUBMIT' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'MY_APPS_STOP_ALL_FORM_SUBMIT' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'MY_APPS_RESTART_ALL_FORM_SUBMIT' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'MY_APPS_UPDATE_ALL_FORM_SUBMIT' })).toBeNull();
  });

  it('offers update all once there are updates', async () => {
    await open({ updatesAvailable: 3 });

    expect(screen.getByRole('menuitem', { name: 'MY_APPS_UPDATE_ALL_FORM_SUBMIT' })).toBeInTheDocument();
  });

  it('disables start when nothing is stopped', async () => {
    await open({ stoppedCount: 0 });

    expect(isDisabled(screen.getByRole('menuitem', { name: 'MY_APPS_START_ALL_FORM_SUBMIT' }))).toBe(true);
    expect(isDisabled(screen.getByRole('menuitem', { name: 'MY_APPS_STOP_ALL_FORM_SUBMIT' }))).toBe(false);
  });

  it('disables stop and restart when nothing is running', async () => {
    await open({ runningCount: 0 });

    expect(isDisabled(screen.getByRole('menuitem', { name: 'MY_APPS_STOP_ALL_FORM_SUBMIT' }))).toBe(true);
    expect(isDisabled(screen.getByRole('menuitem', { name: 'MY_APPS_RESTART_ALL_FORM_SUBMIT' }))).toBe(true);
    expect(isDisabled(screen.getByRole('menuitem', { name: 'MY_APPS_START_ALL_FORM_SUBMIT' }))).toBe(false);
  });

  it.each([
    ['MY_APPS_START_ALL_FORM_SUBMIT', 'MY_APPS_START_ALL_FORM_TITLE', 'start'],
    ['MY_APPS_STOP_ALL_FORM_SUBMIT', 'MY_APPS_STOP_ALL_FORM_TITLE', 'stop'],
    ['MY_APPS_RESTART_ALL_FORM_SUBMIT', 'MY_APPS_RESTART_ALL_FORM_TITLE', 'restart'],
    ['MY_APPS_UPDATE_ALL_FORM_SUBMIT', 'MY_APPS_UPDATE_ALL_FORM_TITLE', 'update'],
  ])('asks before running %s, and runs only that action when confirmed', async (itemName, title, action) => {
    await open({ updatesAvailable: 1 });

    await userEvent.click(screen.getByRole('menuitem', { name: itemName }));

    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
    // Nothing has run yet: opening the dialog is not confirming it.
    for (const mutate of h.mutate.values()) {
      expect(mutate).not.toHaveBeenCalled();
    }

    await userEvent.click(screen.getByRole('button', { name: itemName }));

    expect(h.mutate.get(action)).toHaveBeenCalledWith({});
    for (const [name, mutate] of h.mutate) {
      if (name !== action) expect(mutate).not.toHaveBeenCalled();
    }
  });

  it('shows both paragraphs of the update warning', async () => {
    await open({ updatesAvailable: 1 });
    await userEvent.click(screen.getByRole('menuitem', { name: 'MY_APPS_UPDATE_ALL_FORM_SUBMIT' }));

    expect(await screen.findByText('MY_APPS_UPDATE_ALL_FORM_SUBTITLE_1')).toBeInTheDocument();
    expect(screen.getByText('MY_APPS_UPDATE_ALL_FORM_SUBTITLE_2')).toBeInTheDocument();
  });

  it('closes the dialog, says it is under way and refreshes the app list once the request is accepted', async () => {
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'MY_APPS_STOP_ALL_FORM_SUBMIT' }));
    await screen.findByRole('dialog');

    h.registered.get('stop')?.onSuccess?.();

    expect(h.toastInfo).toHaveBeenCalledWith('MY_APPS_STOP_ALL_IN_PROGRESS');
    expect(h.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['installed-apps'] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('reports a refused request and closes the dialog', async () => {
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'MY_APPS_RESTART_ALL_FORM_SUBMIT' }));
    await screen.findByRole('dialog');

    h.registered.get('restart')?.onError?.({ message: 'SERVER_ERROR_NOT_ALLOWED_IN_DEMO' });

    expect(h.toastError).toHaveBeenCalledWith('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
