import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAccess } from './hub-access';

// "Hub access" section of the app settings dialog: Hub-provisioned trust material (app key +
// identity secret) and the rotate flow, against a mocked raw-URL client (the generated api-client
// doesn't know these routes).

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/api-client/client.gen', () => ({
  client: { get: (...args: unknown[]) => h.get(...args), post: (...args: unknown[]) => h.post(...args) },
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// Minimal Button stub so the test focuses on data flow, not Radix internals. `type` is forwarded
// deliberately — this renders inside the settings <form>, where a defaulted submit type would save
// the form on every click.
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

const APP_URN = 'openclaw:ci-store';
const HUB_ACCESS_URL = `/api/app-lifecycle/${encodeURIComponent(APP_URN)}/hub-access`;

const WITH_KEY = {
  appKey: { prefix: 'ff00aa11', scopes: ['mcp', 'app'], lastUsedAt: '2026-02-01T00:00:00Z', createdAt: '2026-01-02T00:00:00Z' },
  identityVerification: true,
  provisioned: true,
};

function renderHubAccess(props: { hasUnsavedChanges?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<HubAccess appUrn={APP_URN} {...props} />, { wrapper });
}

describe('HubAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for apps without any Hub trust material', async () => {
    h.get.mockResolvedValue({ data: { appKey: null, identityVerification: false, provisioned: false } });

    renderHubAccess();

    await waitFor(() => expect(h.get).toHaveBeenCalledWith(expect.objectContaining({ url: HUB_ACCESS_URL })));
    expect(screen.queryByTestId('hub-access')).toBeNull();
  });

  it('renders nothing when the fetch fails', async () => {
    h.get.mockRejectedValue(new Error('boom'));

    renderHubAccess();

    await waitFor(() => expect(h.get).toHaveBeenCalled());
    expect(screen.queryByTestId('hub-access')).toBeNull();
  });

  it('shows the key prefix, scope badges, last-used, and identity state when provisioned', async () => {
    h.get.mockResolvedValue({ data: WITH_KEY });

    renderHubAccess();

    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());
    const keyRow = screen.getByTestId('hub-access-key');
    expect(within(keyRow).getByText('ff00aa11…')).toBeTruthy(); // prefix only, never the raw key
    expect(within(keyRow).getByText('API_KEYS_SCOPE_MCP')).toBeTruthy();
    expect(within(keyRow).getByText('API_KEYS_SCOPE_APP')).toBeTruthy();
    expect(within(keyRow).getByText('API_KEYS_LAST_USED')).toBeTruthy();
    expect(screen.getByText('APP_SETTINGS_HUB_ACCESS_IDENTITY_ON')).toBeTruthy();
  });

  it('reports identity verification off when no forward-auth secret is provisioned', async () => {
    h.get.mockResolvedValue({ data: { ...WITH_KEY, identityVerification: false } });

    renderHubAccess();

    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());
    expect(screen.getByText('APP_SETTINGS_HUB_ACCESS_IDENTITY_OFF')).toBeTruthy();
  });

  it('never renders a submit button — it lives inside the settings form', async () => {
    const user = userEvent.setup();
    h.get.mockResolvedValue({ data: WITH_KEY });

    renderHubAccess();
    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());

    // Both states, because they render disjoint sets of buttons: revealing the confirm unmounts
    // the Rotate trigger, so checking only after the click would never inspect it.
    const assertNoSubmitters = (state: string) => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.length, `${state}: nothing to assert on`).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute('type'), `${state}: "${button.textContent}" would submit the settings form`).toBe('button');
      }
    };

    assertNoSubmitters('resting');
    await user.click(screen.getByTestId('hub-access-rotate'));
    assertNoSubmitters('confirming');
  });

  it('rotates only after explicit confirmation, then toasts and refetches', async () => {
    const user = userEvent.setup();
    h.get.mockResolvedValue({ data: WITH_KEY });
    h.post.mockResolvedValue({ data: { requestId: 'req-1' } });

    renderHubAccess();
    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());

    // Opening the confirm must not fire the rotate on its own.
    await user.click(screen.getByTestId('hub-access-rotate'));
    expect(screen.getByTestId('hub-access-confirm')).toBeTruthy();
    expect(screen.getByText('APP_SETTINGS_HUB_ACCESS_ROTATE_CONFIRM')).toBeTruthy();
    expect(h.post).not.toHaveBeenCalled();

    const getCalls = h.get.mock.calls.length;
    await user.click(screen.getByTestId('hub-access-rotate-confirm'));

    await waitFor(() => expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ url: `${HUB_ACCESS_URL}/rotate` })));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('APP_SETTINGS_HUB_ACCESS_ROTATED'));
    // Invalidation refetches the status so the section reflects the fresh material.
    await waitFor(() => expect(h.get.mock.calls.length).toBeGreaterThan(getCalls));
    // Confirm dismissed after rotating.
    expect(screen.queryByTestId('hub-access-confirm')).toBeNull();
  });

  it('abandons the rotate when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    h.get.mockResolvedValue({ data: WITH_KEY });

    renderHubAccess();
    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());

    await user.click(screen.getByTestId('hub-access-rotate'));
    await user.click(screen.getByText('COMMON_CANCEL'));

    expect(screen.queryByTestId('hub-access-confirm')).toBeNull();
    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-access-rotate')).toBeTruthy(); // back to the resting state
  });

  it('blocks rotating while the settings form has unsaved edits', async () => {
    h.get.mockResolvedValue({ data: WITH_KEY });

    renderHubAccess({ hasUnsavedChanges: true });

    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());
    // Rotating restarts the app, which would discard the pending edits without saying so.
    expect(screen.getByTestId('hub-access-rotate')).toBeDisabled();
    expect(screen.getByTestId('hub-access-unsaved-hint')).toBeTruthy();
  });

  it('toasts an error when the rotate fails', async () => {
    const user = userEvent.setup();
    h.get.mockResolvedValue({ data: WITH_KEY });
    h.post.mockRejectedValue(new Error('boom'));

    renderHubAccess();
    await waitFor(() => expect(screen.getByTestId('hub-access')).toBeTruthy());

    await user.click(screen.getByTestId('hub-access-rotate'));
    await user.click(screen.getByTestId('hub-access-rotate-confirm'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('APP_SETTINGS_HUB_ACCESS_ROTATE_ERROR'));
  });
});
