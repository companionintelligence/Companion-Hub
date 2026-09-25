import type { AppInfo } from '@/types/app.types';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallDialog } from './install-dialog';

const { capturedOptions, invalidateAppQueries, addOptimisticInstalledApp, removeOptimisticInstalledApp } = vi.hoisted(() => ({
  capturedOptions: { current: null as { onError?: (e: unknown) => void; onMutate?: () => void } | null },
  invalidateAppQueries: vi.fn(),
  addOptimisticInstalledApp: vi.fn(),
  removeOptimisticInstalledApp: vi.fn(),
}));

vi.mock('@/modules/app/helpers/use-app-status', () => ({
  useAppStatus: () => ({ setOptimisticStatus: vi.fn() }),
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
  useMutation: (options: { onError?: (e: unknown) => void; onMutate?: () => void }) => {
    capturedOptions.current = options;
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({}),
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  installAppMutation: () => ({}),
}));

// The dialog is rendered closed, so none of this markup mounts — stub it out to keep the test on the
// mutation's cache handling rather than on Radix.
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
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

describe('InstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions.current = null;
  });

  it('seeds an optimistic row so the app appears immediately', () => {
    renderDialog();

    capturedOptions.current?.onMutate?.();

    expect(addOptimisticInstalledApp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ urn: 'ci-hermes:ci-marketplace' }));
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
