import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysContainer } from '../api-keys';

// Hub-wide API-key card (Settings → Security), exercised against a mocked /api/api-keys surface.

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
// Return a referentially STABLE t (like the real hook) so useCallback/useEffect deps on `t`
// don't thrash and re-fire the data load on every render.
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// Minimal UI-primitive stubs so the test focuses on data flow, not Radix internals.
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));
vi.mock('@/components/ui/Input', () => ({
  Input: (props: any) => <input {...props} />,
}));
vi.mock('@/components/ui/Skeleton/Skeleton', () => ({ Skeleton: (props: any) => <div data-testid={props['data-testid'] ?? 'skeleton'} /> }));
vi.mock('@/components/ui/Card', () => ({
  Card: ({ children, ...props }: any) => <div data-testid={props['data-testid']}>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardFooter: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div data-testid="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
}));

const KEYS = {
  keys: [
    {
      id: 1,
      name: 'Laptop CLI',
      prefix: 'a1b2c3d4',
      scopes: ['mcp'],
      managed: false,
      ownerAppUrn: null,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 2,
      name: 'openclaw',
      prefix: 'ff00aa11',
      scopes: ['mcp', 'app'],
      managed: true,
      ownerAppUrn: 'openclaw:ci-store',
      expiresAt: null,
      lastUsedAt: '2026-02-01T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ],
};

function mockGet(url: string) {
  if (url === '/api/api-keys') return Promise.resolve({ ok: true, json: async () => KEYS });
  return Promise.resolve({ ok: true, json: async () => ({}) });
}

describe('ApiKeysContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation((url: string) => mockGet(url));
  });

  it('lists every key with per-scope badges, the managed badge, and never the raw key', async () => {
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    expect(screen.getByText('Laptop CLI')).toBeTruthy();
    expect(screen.getByText('openclaw')).toBeTruthy();
    expect(screen.getByText('a1b2c3d4…')).toBeTruthy(); // prefix only, not the raw key

    // Scope badges: the operator key is MCP-only; the app key carries both scopes.
    const operatorRow = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    expect(within(operatorRow).getByText('API_KEYS_SCOPE_MCP')).toBeTruthy();
    expect(within(operatorRow).queryByText('API_KEYS_SCOPE_APP')).toBeNull();
    const managedRow = screen.getByText('openclaw').closest('li') as HTMLElement;
    expect(within(managedRow).getByText('API_KEYS_SCOPE_MCP')).toBeTruthy();
    expect(within(managedRow).getByText('API_KEYS_SCOPE_APP')).toBeTruthy();

    // The managed companion-app key is badged; the operator key is not.
    expect(screen.getAllByText('API_KEYS_MANAGED_BADGE')).toHaveLength(1);
    expect(within(managedRow).getByText('API_KEYS_MANAGED_BADGE')).toBeTruthy();

    // Last-used line per row.
    expect(within(operatorRow).getByText('API_KEYS_NEVER_USED')).toBeTruthy();
    expect(within(managedRow).getByText('API_KEYS_LAST_USED')).toBeTruthy();
  });

  it('creates a key via POST and reveals the raw value once', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 3, name: 'n8n', prefix: 'deadbeef', scopes: ['mcp'], key: 'deadbeefRAWKEY' }) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());

    await user.click(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());
    fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'n8n' } });
    await user.click(screen.getByTestId('api-key-create-submit'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/api-keys', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'n8n' }) })),
    );
    // The raw key is surfaced exactly once, in the "copy it now" panel.
    await waitFor(() => expect(screen.getByTestId('api-key-created').textContent).toContain('deadbeefRAWKEY'));
    expect(toast.success).toHaveBeenCalledWith('API_KEYS_CREATED');
  });

  it('offers no scope selector when creating — new keys are MCP-scoped operator keys', async () => {
    const user = userEvent.setup();
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());

    await user.click(screen.getByTestId('api-key-create'));
    const dialog = await screen.findByTestId('dialog');
    // Only a name field — no scope controls of any kind.
    expect(within(dialog).getByTestId('api-key-new-name')).toBeTruthy();
    expect(within(dialog).queryByText('API_KEYS_SCOPE_MCP')).toBeNull();
    expect(within(dialog).queryByText('API_KEYS_SCOPE_APP')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('renders no create affordance inside managed rows (one global create button only)', async () => {
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    const managedRow = screen.getByText('openclaw').closest('li') as HTMLElement;
    expect(within(managedRow).queryByText('API_KEYS_CREATE')).toBeNull();
    // The only button on a managed row is Revoke.
    expect(within(managedRow).getAllByRole('button')).toHaveLength(1);
    expect(within(managedRow).getByRole('button', { name: 'API_KEYS_REVOKE' })).toBeTruthy();
    // Exactly one create button, outside the list.
    expect(screen.getAllByText('API_KEYS_CREATE')).toHaveLength(1);
  });

  it('revokes a key via DELETE and refreshes the list so the row disappears', async () => {
    const user = userEvent.setup();
    let revoked = false;
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys/1' && init?.method === 'DELETE') {
        revoked = true;
        return Promise.resolve({ ok: true, json: async () => ({ revoked: true }) });
      }
      // After the revoke, the reloaded list no longer contains 'Laptop CLI' (id 1).
      if (url === '/api/api-keys' && revoked) {
        return Promise.resolve({ ok: true, json: async () => ({ keys: KEYS.keys.filter((k) => k.id !== 1) }) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    const row = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'API_KEYS_REVOKE' }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/api-keys/1', expect.objectContaining({ method: 'DELETE' })));
    // The refresh must actually re-render without the revoked key (not just fire the DELETE).
    await waitFor(() => expect(screen.queryByText('Laptop CLI')).toBeNull());
    expect(screen.getByText('openclaw')).toBeTruthy(); // the other key remains
  });

  it('shows the last-key explanation when the backend refuses the revoke with 409', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys/1' && init?.method === 'DELETE') {
        // Backend blocks revoking the last usable operator key.
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    const row = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'API_KEYS_REVOKE' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API_KEYS_REVOKE_LAST'));
    expect(screen.getByText('Laptop CLI')).toBeTruthy(); // row stays — nothing was revoked
  });

  it('surfaces a load error with a retry that reloads the list', async () => {
    mockApiFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByText('API_KEYS_LOAD_ERROR')).toBeTruthy());

    mockApiFetch.mockImplementation((url: string) => mockGet(url));
    fireEvent.click(screen.getByText('COMMON_RETRY'));
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
  });
});
