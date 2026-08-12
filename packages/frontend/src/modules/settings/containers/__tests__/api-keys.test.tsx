import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysContainer } from '../api-keys';

// Hub-wide API-key card (Settings → Security), exercised against a mocked /api/api-keys surface.
// This card is also where destructive access is granted now, one key at a time — the MCP tab's
// appliance-wide switch is gone — so the capability controls are exercised here too.

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
      capability: 'write',
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
      capability: 'full',
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
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/api-keys',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'n8n', capability: 'write' }) }),
      ),
    );
    // The raw key is surfaced exactly once, in the "copy it now" panel.
    await waitFor(() => expect(screen.getByTestId('api-key-created').textContent).toContain('deadbeefRAWKEY'));
    expect(toast.success).toHaveBeenCalledWith('API_KEYS_CREATED');
  });

  it('states the fixed MCP scope when creating, without offering a scope selector', async () => {
    const user = userEvent.setup();
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());

    await user.click(screen.getByTestId('api-key-create'));
    const dialog = await screen.findByTestId('dialog');

    // The scope is disclosed, so the operator knows what the key will open...
    expect(within(dialog).getByTestId('api-key-create-scope').textContent).toContain('API_KEYS_SCOPE_MCP');
    expect(within(dialog).getByText('API_KEYS_CREATE_SCOPE_HINT')).toBeTruthy();

    // ...but WHICH scope is not a choice: an operator-created 'app' key would have no owning app URN
    // and could never authenticate anything, so it must never be offered here.
    expect(within(dialog).getByTestId('api-key-new-name')).toBeTruthy();
    expect(within(dialog).queryByText('API_KEYS_SCOPE_APP')).toBeNull();

    // What the key may DO on that scope IS a choice — the only radio group in the dialog.
    expect(within(dialog).getAllByRole('radio')).toHaveLength(3);
    expect(within(dialog).getByTestId('api-key-new-capability-read')).toBeTruthy();
  });

  it('mints at the chosen capability, so a read-only key is never wide open in between', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 3, key: 'raw' }) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
    await user.click(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

    fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'recall' } });
    await user.click(screen.getByTestId('api-key-new-capability-read'));
    await user.click(screen.getByTestId('api-key-create-submit'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/api-keys',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'recall', capability: 'read' }) }),
      ),
    );
  });

  it('renders no create affordance inside managed rows (one global create button only)', async () => {
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    const managedRow = screen.getByText('openclaw').closest('li') as HTMLElement;
    expect(within(managedRow).queryByText('API_KEYS_CREATE')).toBeNull();
    // A managed row offers exactly the two actions that apply to a key the Hub owns: change what it
    // can do, and revoke it. Creating is never one of them.
    expect(within(managedRow).getAllByRole('button')).toHaveLength(2);
    expect(within(managedRow).getByRole('button', { name: 'API_KEYS_REVOKE' })).toBeTruthy();
    expect(within(managedRow).getByRole('button', { name: 'API_KEYS_CAPABILITY_CHANGE' })).toBeTruthy();
    // Exactly one create button, outside the list.
    expect(screen.getAllByText('API_KEYS_CREATE')).toHaveLength(1);
  });

  describe('capability', () => {
    const APP_ONLY_KEY = {
      id: 3,
      name: 'ci-import-tools',
      prefix: 'cafe0001',
      scopes: ['app'],
      capability: 'write',
      managed: true,
      ownerAppUrn: 'import-tools:ci-marketplace',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-01-03T00:00:00Z',
    };

    it('badges each key with what it can do', async () => {
      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

      const operatorRow = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
      expect(within(operatorRow).getByTestId('api-key-capability-write')).toBeTruthy();
      const managedRow = screen.getByText('openclaw').closest('li') as HTMLElement;
      expect(within(managedRow).getByTestId('api-key-capability-full')).toBeTruthy();
    });

    it('shows neither badge nor control for a key that cannot reach the tool surface', async () => {
      // Capability gates MCP tools only. An 'app'-scoped callback key is identity-checked against its
      // owning app instead, so a level shown here would read as a guarantee nothing enforces.
      mockApiFetch.mockImplementation((url: string) =>
        url === '/api/api-keys' ? Promise.resolve({ ok: true, json: async () => ({ keys: [APP_ONLY_KEY] }) }) : mockGet(url),
      );

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

      const row = screen.getByText('ci-import-tools').closest('li') as HTMLElement;
      expect(within(row).queryByTestId('api-key-capability-write')).toBeNull();
      expect(within(row).queryByRole('button', { name: 'API_KEYS_CAPABILITY_CHANGE' })).toBeNull();
    });

    it('demotes without a confirmation, since narrowing a key only ever removes authority', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys/1' && init?.method === 'PATCH') {
          return Promise.resolve({ ok: true, json: async () => ({ changed: true, capability: 'read', previousCapability: 'write' }) });
        }
        return mockGet(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-1'));

      await user.click(await screen.findByTestId('api-key-change-capability-read'));
      await user.click(screen.getByTestId('api-key-change-submit'));

      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/api-keys/1',
          expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ capability: 'read' }) }),
        ),
      );
      expect(toast.success).toHaveBeenCalledWith('API_KEYS_CAPABILITY_SAVED');
    });

    it('requires a confirmation naming the key before granting destructive access', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys/1' && init?.method === 'PATCH') {
          return Promise.resolve({ ok: true, json: async () => ({ changed: true, capability: 'full', previousCapability: 'write' }) });
        }
        return mockGet(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-1'));

      await user.click(await screen.findByTestId('api-key-change-capability-full'));
      await user.click(screen.getByTestId('api-key-change-submit'));

      // Nothing is written yet — Save on a promotion opens the confirmation instead.
      expect(mockApiFetch).not.toHaveBeenCalledWith('/api/api-keys/1', expect.objectContaining({ method: 'PATCH' }));
      // The destructive wording, not the generic one, because 'full' is what is being granted.
      expect(screen.getByText('API_KEYS_CAPABILITY_CONFIRM_FULL_TITLE')).toBeTruthy();

      await user.click(screen.getByTestId('api-key-change-confirm'));
      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith(
          '/api/api-keys/1',
          expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ capability: 'full' }) }),
        ),
      );
    });

    it('backing out of the confirmation writes nothing', async () => {
      const user = userEvent.setup();
      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-1'));

      await user.click(await screen.findByTestId('api-key-change-capability-full'));
      await user.click(screen.getByTestId('api-key-change-submit'));
      await user.click(screen.getByText('COMMON_BACK'));

      expect(screen.getByTestId('api-key-change-submit')).toBeTruthy(); // back on the picker
      expect(mockApiFetch).not.toHaveBeenCalledWith('/api/api-keys/1', expect.objectContaining({ method: 'PATCH' }));
    });

    it('warns which app a managed key belongs to before narrowing it', async () => {
      const user = userEvent.setup();
      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

      await user.click(screen.getByTestId('api-key-change-2'));
      expect(await screen.findByTestId('api-key-change-managed-warning')).toBeTruthy();
    });
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

  it('revokes the last remaining key, since nothing reseeds one at boot', async () => {
    const user = userEvent.setup();
    let revoked = false;
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys/1' && init?.method === 'DELETE') {
        revoked = true;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ revoked: true }) });
      }
      // After the revoke the store is empty — a legitimate end state now.
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ keys: revoked ? [] : [KEYS.keys[0]] }) });
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    const row = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'API_KEYS_REVOKE' }));

    await waitFor(() => expect(screen.getByText('API_KEYS_EMPTY')).toBeTruthy());
    expect(toast.error).not.toHaveBeenCalled();
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
