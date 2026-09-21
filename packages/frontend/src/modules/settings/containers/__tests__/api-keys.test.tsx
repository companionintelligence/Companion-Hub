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

  it('names who created each operator key — the person it acts as — and says when nobody is recorded', async () => {
    const [operator, managed] = KEYS.keys;
    mockApiFetch.mockImplementation((url: string) =>
      url === '/api/api-keys'
        ? Promise.resolve({
            ok: true,
            json: async () => ({
              keys: [
                { ...operator, createdByUserId: 4, createdByUsername: 'owner@acme.com' },
                { ...operator, id: 3, name: 'legacy', createdByUserId: null, createdByUsername: null },
                { ...managed, createdByUserId: null, createdByUsername: null },
              ],
            }),
          })
        : mockGet(url),
    );

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());

    expect(screen.getByTestId('api-key-creator-1').textContent).toBe('API_KEYS_CREATED_BY');
    expect(screen.getByTestId('api-key-creator-3').textContent).toBe('API_KEYS_CREATED_BY_UNKNOWN');
    // A managed key acts for its app, not a person: no creator line at all.
    expect(screen.queryByTestId('api-key-creator-2')).toBeNull();
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
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'n8n', capability: 'write', scope: 'mcp' }) }),
      ),
    );
    // The raw key is surfaced exactly once, in the "copy it now" panel.
    await waitFor(() => expect(screen.getByTestId('api-key-created').textContent).toContain('deadbeefRAWKEY'));
    expect(toast.success).toHaveBeenCalledWith('API_KEYS_CREATED');
  });

  it('offers the two mintable scopes, and never the two nobody mints by hand', async () => {
    const user = userEvent.setup();
    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());

    await user.click(screen.getByTestId('api-key-create'));
    const dialog = await screen.findByTestId('dialog');

    expect(within(dialog).getByTestId('api-key-create-scope-mcp')).toBeTruthy();
    expect(within(dialog).getByTestId('api-key-create-scope-inference')).toBeTruthy();
    expect(within(dialog).getByText('API_KEYS_CREATE_SCOPE_HINT')).toBeTruthy();

    // An operator-created 'app' key would have no owning app URN and could never authenticate
    // anything, and 'qa:read' is minted over ssh on the node under test. Neither is offered here.
    expect(within(dialog).queryByText('API_KEYS_SCOPE_APP')).toBeNull();
    expect(within(dialog).queryByText('API_KEYS_SCOPE_QA_READ')).toBeNull();

    // MCP is the default, and its capability picker is the other radio group in the dialog.
    expect((within(dialog).getByTestId('api-key-create-scope-mcp') as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByTestId('api-key-create-scope-inference') as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByTestId('api-key-new-capability-read')).toBeTruthy();
  });

  /*
   * Capability grades the MCP TOOL surface. An inference key reaches no tool, so every level would
   * mean the same thing — a control that changes nothing is worse than no control.
   */
  it('drops the capability picker for an inference key, and mints it without one', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 4, key: 'raw' }) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
    await user.click(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

    fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'Cursor' } });
    await user.click(screen.getByTestId('api-key-create-scope-inference'));

    const dialog = await screen.findByTestId('dialog');
    expect(within(dialog).queryByTestId('api-key-new-capability-read')).toBeNull();
    expect(within(dialog).getByText('API_KEYS_CREATE_SCOPE_INFERENCE_HINT')).toBeTruthy();

    await user.click(screen.getByTestId('api-key-create-submit'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/api-keys',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Cursor', capability: 'write', scope: 'inference' }) }),
      ),
    );
  });

  /*
   * The owner/admin gate exists because 'full' reaches the destructive TOOLS. An inference key
   * reaches none, so a member must not be blocked from minting one by a rule written for the other
   * surface — and the screen must not carry a stale 'full' from a previous choice into the body.
   */
  it('lets a member mint an inference key even while full capability is refused to them', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/api-keys/grantable') return Promise.resolve({ ok: true, json: async () => ({ canGrantFull: false }) });
      if (url === '/api/api-keys' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 5, key: 'raw' }) });
      }
      return mockGet(url);
    });

    render(<ApiKeysContainer />);
    await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
    await user.click(screen.getByTestId('api-key-create'));
    await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

    fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'Zed' } });
    await user.click(screen.getByTestId('api-key-create-scope-inference'));

    expect((screen.getByTestId('api-key-create-submit') as HTMLButtonElement).disabled).toBe(false);
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
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'recall', capability: 'read', scope: 'mcp' }) }),
      ),
    );
  });

  describe('full capability takes an organization owner or admin', () => {
    const listFor = (canGrantFull: boolean) => (url: string) =>
      url === '/api/api-keys/grantable' ? Promise.resolve({ ok: true, json: async () => ({ canGrantFull }) }) : mockGet(url);

    it('shows the keys without waiting for the Portal to say who may give full capability', async () => {
      mockApiFetch.mockImplementation((url: string) => (url === '/api/api-keys/grantable' ? new Promise(() => {}) : mockGet(url)));

      render(<ApiKeysContainer />);

      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
    });

    it('offers full capability only to someone who may give it, and says who can', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation(listFor(false));

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-create'));

      expect(((await screen.findByTestId('api-key-new-capability-full')) as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('api-key-new-capability-write') as HTMLInputElement).disabled).toBe(false);
      expect(screen.getByText('API_KEY_FULL_ROLE_REQUIRED')).toBeTruthy();
    });

    it('keeps full out of reach when raising an existing key, too', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation(listFor(false));

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-change-1')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-1'));

      expect(((await screen.findByTestId('api-key-change-capability-full')) as HTMLInputElement).disabled).toBe(true);
    });

    it('says why the Hub refused a key, not just that it failed', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys' && init?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 403, json: async () => ({ statusCode: 403, message: 'API_KEY_FULL_ROLE_REQUIRED' }) });
        }
        return listFor(true)(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-create'));
      await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

      fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'agent' } });
      await user.click(screen.getByTestId('api-key-new-capability-full'));
      await user.click(screen.getByTestId('api-key-create-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API_KEY_FULL_ROLE_REQUIRED'));
    });

    it('uses its own words when the Hub sent no reason it can translate', async () => {
      const user = userEvent.setup();
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys' && init?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 400, json: async () => ({ statusCode: 400, message: 'Bad Request Exception' }) });
        }
        return listFor(true)(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-create'));
      await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

      fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'agent' } });
      await user.click(screen.getByTestId('api-key-create-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API_KEYS_CREATE_ERROR'));
      expect(toast.error).not.toHaveBeenCalledWith('Bad Request Exception');
    });

    it('takes a refused promotion back to the picker, re-read, with full out of reach', async () => {
      const user = userEvent.setup();
      let refused = false;
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys/1' && init?.method === 'PATCH') {
          refused = true;
          return Promise.resolve({ ok: false, status: 403, json: async () => ({ statusCode: 403, message: 'API_KEY_FULL_ROLE_REQUIRED' }) });
        }
        // The role changed after the list loaded; the re-read after the refusal says so.
        return listFor(!refused)(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-change-1')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-1'));
      await user.click(await screen.findByTestId('api-key-change-capability-full'));
      await user.click(screen.getByTestId('api-key-change-submit'));
      await user.click(screen.getByTestId('api-key-change-confirm'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API_KEY_FULL_ROLE_REQUIRED'));
      await waitFor(() => expect((screen.getByTestId('api-key-change-capability-full') as HTMLInputElement).disabled).toBe(true));
      expect(screen.queryByTestId('api-key-change-confirm')).toBeNull();
      // `full` is still the selected choice, so saving it again must not be on offer.
      expect((screen.getByTestId('api-key-change-submit') as HTMLButtonElement).disabled).toBe(true);
    });

    it('will not send a refused full key again once the re-read takes full away', async () => {
      const user = userEvent.setup();
      let refused = false;
      mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/api-keys' && init?.method === 'POST') {
          refused = true;
          return Promise.resolve({ ok: false, status: 403, json: async () => ({ statusCode: 403, message: 'API_KEY_FULL_ROLE_REQUIRED' }) });
        }
        return listFor(!refused)(url);
      });

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-create')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-create'));
      await waitFor(() => expect(screen.getByTestId('api-key-new-name')).toBeTruthy());

      fireEvent.change(screen.getByTestId('api-key-new-name'), { target: { value: 'agent' } });
      await user.click(screen.getByTestId('api-key-new-capability-full'));
      await user.click(screen.getByTestId('api-key-create-submit'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('API_KEY_FULL_ROLE_REQUIRED'));
      await waitFor(() => expect((screen.getByTestId('api-key-create-submit') as HTMLButtonElement).disabled).toBe(true));
    });
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
      name: 'ci-planning',
      prefix: 'cafe0001',
      scopes: ['app'],
      capability: 'write',
      managed: true,
      ownerAppUrn: 'ci-planning:ci-marketplace',
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

      const row = screen.getByText('ci-planning').closest('li') as HTMLElement;
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

    it.each([
      ['a managed key, by how far each level reaches the apps beside its own', 2, 'API_KEYS_CAPABILITY_MANAGED_', 'API_KEYS_CAPABILITY_'],
      ['an operator key, in the words that say nothing about other apps', 1, 'API_KEYS_CAPABILITY_', 'API_KEYS_CAPABILITY_MANAGED_'],
    ])('describes the levels of %s', async (_label, id, shown, hidden) => {
      const user = userEvent.setup();
      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
      await user.click(screen.getByTestId(`api-key-change-${id}`));

      await screen.findByTestId('api-key-change-capability');
      // Each line next to the level it describes, so two levels' words can never be swapped unnoticed.
      for (const level of ['read', 'write', 'full']) {
        const option = screen.getByTestId(`api-key-change-capability-${level}`).closest('label') as HTMLElement;
        expect(within(option).getByText(`${shown}${level.toUpperCase()}_HINT`)).toBeTruthy();
        expect(within(option).queryByText(`${hidden}${level.toUpperCase()}_HINT`)).toBeNull();
      }
    });

    it.each([
      ['full', 'read', 'API_KEYS_CAPABILITY_CONFIRM_MANAGED_FULL_BODY', 'API_KEYS_CAPABILITY_CONFIRM_FULL_BODY'],
      ['write', 'read', 'API_KEYS_CAPABILITY_CONFIRM_MANAGED_WRITE_BODY', 'API_KEYS_CAPABILITY_CONFIRM_WRITE_BODY'],
    ])('confirms raising a managed key to %s in words about every app, not just this one', async (to, from, shown, hidden) => {
      const user = userEvent.setup();
      const managedKey = { ...KEYS.keys[1], capability: from };
      mockApiFetch.mockImplementation((url: string) =>
        url === '/api/api-keys' ? Promise.resolve({ ok: true, json: async () => ({ keys: [KEYS.keys[0], managedKey] }) }) : mockGet(url),
      );

      render(<ApiKeysContainer />);
      await waitFor(() => expect(screen.getByTestId('api-key-list')).toBeTruthy());
      await user.click(screen.getByTestId('api-key-change-2'));
      await user.click(await screen.findByTestId(`api-key-change-capability-${to}`));
      await user.click(screen.getByTestId('api-key-change-submit'));

      expect(screen.getByText(shown)).toBeTruthy();
      expect(screen.queryByText(hidden)).toBeNull();
      expect(mockApiFetch).not.toHaveBeenCalledWith('/api/api-keys/2', expect.objectContaining({ method: 'PATCH' }));
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
