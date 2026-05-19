import { render } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Match the translation mock used elsewhere in the suite.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}));

// Capture mutation factories so each test can inspect / drive them.
const updateConfigMutateFn = vi.fn();
const restartAppMutateFn = vi.fn();
let lastUpdateConfigOnSuccess: (() => void) | undefined;
let lastRestartAppOptions: unknown;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onSuccess?: () => void; mutationKey?: unknown[] }) => {
    // The dialog wires two mutations. We tell them apart by the mutationKey baked
    // into the generated `*Mutation()` factories.
    const key = JSON.stringify(options.mutationKey ?? []);
    if (key.includes('updateAppConfig')) {
      lastUpdateConfigOnSuccess = options.onSuccess;
      return { mutate: updateConfigMutateFn, isPending: false };
    }
    lastRestartAppOptions = options;
    return { mutate: restartAppMutateFn, isPending: false };
  },
}));

vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  updateAppConfigMutation: () => ({ mutationKey: ['updateAppConfig'] }),
  restartAppMutation: () => ({ mutationKey: ['restartApp'] }),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

// Stub the InstallForm so we don't pull in the full form module's dependencies.
vi.mock('../../install-form/install-form', () => ({
  InstallForm: ({ formId }: { formId: string }) => <form id={formId} data-testid="install-form" />,
}));

vi.mock('../../install-form-buttons/install-form-buttons', () => ({
  InstallFormButtons: () => <div data-testid="install-form-buttons" />,
}));

vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

import { UpdateSettingsDialog } from './update-settings-dialog';

const baseProps = {
  info: { id: 'nextcloud', urn: 'nextcloud:store1' as never, form_fields: [] } as never,
  config: {},
  isOpen: true,
  onClose: vi.fn(),
};

describe('UpdateSettingsDialog — restart-on-save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastUpdateConfigOnSuccess = undefined;
    lastRestartAppOptions = undefined;
  });

  it('restarts the app after a successful config save when status is running', () => {
    render(<UpdateSettingsDialog {...baseProps} status="running" />);

    expect(lastUpdateConfigOnSuccess).toBeTypeOf('function');
    lastUpdateConfigOnSuccess?.();

    expect(restartAppMutateFn).toHaveBeenCalledTimes(1);
    expect(restartAppMutateFn).toHaveBeenCalledWith({ path: { urn: 'nextcloud:store1' } });
  });

  it('does not restart the app when status is stopped', () => {
    render(<UpdateSettingsDialog {...baseProps} status="stopped" />);

    lastUpdateConfigOnSuccess?.();

    expect(restartAppMutateFn).not.toHaveBeenCalled();
  });

  it('wires a restart mutation even when status is unknown (no auto-restart)', () => {
    render(<UpdateSettingsDialog {...baseProps} status={undefined} />);

    lastUpdateConfigOnSuccess?.();

    expect(restartAppMutateFn).not.toHaveBeenCalled();
    expect(lastRestartAppOptions).toBeDefined();
  });
});
