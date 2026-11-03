import type { AppInfo } from '@/types/app.types';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallDialog } from './install-dialog';

type CapturedOptions = {
  mutationKey?: unknown;
  onError?: (e: unknown) => void;
  onMutate?: () => Promise<void> | void;
  onSuccess?: () => void;
};

const { capturedFormProps } = vi.hoisted(() => ({ capturedFormProps: { current: null as { initialValues?: Record<string, unknown> } | null } }));

const { capturedOptions, invalidateAppQueries, addOptimisticInstalledApp, removeOptimisticInstalledApp, setOptimisticStatus, queryClient, calls } =
  vi.hoisted(() => {
    const calls: string[] = [];
    return {
      calls,
      capturedOptions: { current: null as CapturedOptions | null },
      invalidateAppQueries: vi.fn(),
      addOptimisticInstalledApp: vi.fn(),
      removeOptimisticInstalledApp: vi.fn(),
      setOptimisticStatus: vi.fn((status: string) => calls.push(`optimistic ${status}`)),
      queryClient: {
        cancelQueries: vi.fn(async () => {
          calls.push('cancel app read');
        }),
        setQueryData: vi.fn(),
      },
    };
  });

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus }),
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({
  invalidateAppQueries,
}));

vi.mock('@/modules/app/helpers/optimistic-installed-apps', () => ({
  addOptimisticInstalledApp,
  removeOptimisticInstalledApp,
}));

vi.mock('@tanstack/react-query', () => ({
  // Capture the options so the mutation's own onMutate/onError can be exercised directly.
  useMutation: (options: CapturedOptions) => {
    capturedOptions.current = options;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => queryClient,
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  installAppMutation: () => ({}),
  getAppQueryKey: (options: { path: { urn: string } }) => ['getApp', options.path.urn],
}));

// Most tests render the dialog closed, so none of this markup mounts. Stubbing it out keeps them on the
// mutation's cache handling rather than on Radix. An open one only has to reach the form.
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogContent: ({ children }: { children: ReactNode }) => children,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

vi.mock('../../install-form/install-form', () => ({
  InstallForm: (props: { initialValues?: Record<string, unknown> }) => {
    capturedFormProps.current = props;
    return null;
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: () => null,
}));

const INFO = { urn: 'ci-hermes:ci-marketplace', name: 'Hermes' } as unknown as AppInfo;

const renderDialog = () => render(<InstallDialog info={INFO} isOpen={false} onClose={vi.fn()} />);

/** What the dialog's last write to the app's cached record makes of `current`. */
const cachedAfterWrite = (current: unknown) => {
  const call = queryClient.setQueryData.mock.calls.at(-1) as unknown as [unknown, (value: unknown) => { app?: unknown } | undefined] | undefined;
  expect(call?.[0]).toEqual(['getApp', 'ci-hermes:ci-marketplace']);
  return call?.[1](current);
};

describe('InstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    capturedOptions.current = null;
    capturedFormProps.current = null;
  });

  // The app left the listing's port because another program held it, so that address is not where it is.
  it('opens a retry on the port the failed install left the app on', () => {
    render(<InstallDialog info={INFO} isOpen onClose={vi.fn()} retryPort={10003} />);

    expect(capturedFormProps.current?.initialValues).toMatchObject({ port: '10003' });
  });

  it('leaves the port to the listing on a first install', () => {
    render(<InstallDialog info={INFO} isOpen onClose={vi.fn()} />);

    expect(capturedFormProps.current?.initialValues).toEqual({ customDomainExpected: '' });
  });

  it('seeds an optimistic row so the app appears immediately', async () => {
    renderDialog();

    await capturedOptions.current?.onMutate?.();

    expect(addOptimisticInstalledApp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ urn: 'ci-hermes:ci-marketplace' }));
  });

  // A read of the app that was already out when Install was clicked came back after the optimistic
  // write, found no row and put the page back on Install for the seconds the Hub took to answer.
  it('cancels a read of the app still out before marking it installing', async () => {
    renderDialog();

    await capturedOptions.current?.onMutate?.();

    expect(queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: ['getApp', 'ci-hermes:ci-marketplace'] });
    expect(calls).toEqual(['cancel app read', 'optimistic installing']);
  });

  // Cancelling a first read takes the record back to no data at all, which setOptimisticStatus skips.
  it('marks the app installing even when its record has not been read yet', async () => {
    renderDialog();

    await capturedOptions.current?.onMutate?.();

    expect(cachedAfterWrite(undefined)?.app).toMatchObject({ urn: 'ci-hermes:ci-marketplace', status: 'installing' });
  });

  it('runs under the key the app page watches while the request is out', () => {
    renderDialog();

    expect(capturedOptions.current?.mutationKey).toEqual(['install-request', 'ci-hermes:ci-marketplace']);
  });

  describe('when the Hub takes the install', () => {
    it('keeps the app installing when a read in the meantime found no row, and reads it again', () => {
      renderDialog();

      capturedOptions.current?.onSuccess?.();

      expect(cachedAfterWrite({ app: null })?.app).toMatchObject({ status: 'installing' });
      expect(invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'ci-hermes:ci-marketplace');
    });

    it('leaves a row the Hub already reported alone', () => {
      renderDialog();

      capturedOptions.current?.onSuccess?.();

      const reported = { app: { id: 3, status: 'running' } };
      expect(cachedAfterWrite(reported)).toBe(reported);
    });
  });

  describe('when the Hub refuses it because the app is already installing', () => {
    it('keeps the app installing and its row, and reads it again', () => {
      renderDialog();

      capturedOptions.current?.onError?.({ message: 'APP_ERROR_INSTALL_IN_PROGRESS', intlParams: { id: 'ci-hermes' } });

      expect(removeOptimisticInstalledApp).not.toHaveBeenCalled();
      expect(cachedAfterWrite({ app: null })?.app).toMatchObject({ status: 'installing' });
      expect(invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'ci-hermes:ci-marketplace');
    });
  });

  describe('when the install fails', () => {
    // The install never happened, so the row we invented has to go. Left behind, it sits on the
    // dashboard as a permanent "installing" spinner for an app that will never exist — and the store
    // page keeps counting the app as installed.
    it('MUST retract the optimistic row', () => {
      renderDialog();

      capturedOptions.current?.onError?.({ message: 'BOOM' });

      expect(removeOptimisticInstalledApp).toHaveBeenCalledWith(expect.anything(), 'ci-hermes:ci-marketplace');
    });

    it('MUST refetch the app so no cache is left on a status that will never arrive', () => {
      renderDialog();

      capturedOptions.current?.onError?.({ message: 'BOOM' });

      expect(invalidateAppQueries).toHaveBeenCalledWith(expect.anything(), 'ci-hermes:ci-marketplace');
    });
  });
});
