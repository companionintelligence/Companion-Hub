import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsContainer } from '../mcp-settings';

// ENH-MCP-4: exercises the MCP settings screen against a mocked /api/mcp-admin surface.

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
vi.mock('@/components/ui/Skeleton/Skeleton', () => ({ Skeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@/components/ui/Switch', () => ({
  Switch: ({ checked, onCheckedChange, name }: any) => (
    <input
      type="checkbox"
      role="switch"
      aria-label={name}
      aria-checked={checked}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock('@/components/ui/Card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
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

const STATUS = {
  enabled: true,
  server: { name: 'ci-hub', version: '1.0.0' },
  protocolVersion: '2025-11-25',
  toolCount: 2,
  activeSessions: 0,
  destructiveAllowed: false,
  activeKeyCount: 2,
  endpoint: '/api/mcp',
};
const TOOLS = {
  tools: [
    { name: 'hub_list_installed_apps', description: 'List apps', inputSchema: { type: 'object' }, destructive: false, category: 'App Discovery' },
    { name: 'hub_uninstall_app', description: 'Uninstall an app', inputSchema: { type: 'object' }, destructive: true, category: 'App Lifecycle' },
  ],
};
const KEYS = {
  keys: [
    {
      id: 1,
      name: 'Laptop CLI',
      prefix: 'a1b2c3d4',
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
      managed: true,
      ownerAppUrn: 'openclaw:ci-store',
      expiresAt: null,
      lastUsedAt: '2026-02-01T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z',
    },
  ],
};

function mockGet(url: string) {
  if (url === '/api/mcp-admin/status') return Promise.resolve({ ok: true, json: async () => STATUS });
  if (url === '/api/mcp-admin/tools') return Promise.resolve({ ok: true, json: async () => TOOLS });
  if (url === '/api/mcp-admin/keys') return Promise.resolve({ ok: true, json: async () => KEYS });
  return Promise.resolve({ ok: true, json: async () => ({}) });
}

describe('McpSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation((url: string) => mockGet(url));
  });

  it('loads and renders server status + tool catalog', async () => {
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());
    expect(screen.getByText('ci-hub 1.0.0')).toBeTruthy();
    expect(screen.getByText('2025-11-25')).toBeTruthy();
    expect(screen.getByText('hub_list_installed_apps')).toBeTruthy();
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('renders the endpoint as a clickable absolute URL (not the bare path)', async () => {
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());
    // The backend reports '/api/mcp'; the UI resolves it against the browsing origin so an operator
    // can copy the real URL an agent connects to.
    const expected = `${window.location.origin}/api/mcp`;
    const el = screen.getByText(expected);
    expect(el.tagName).toBe('BUTTON'); // clickable-to-copy
    expect(el.getAttribute('title')).toBe(expected); // full URL legible even when truncated
    expect(screen.queryByText('/api/mcp')).toBeNull(); // no longer shows the bare path
  });

  it('groups the tool catalog by category', async () => {
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());
    // Each tool's backend category becomes a section header.
    expect(screen.getByText('App Discovery')).toBeTruthy();
    expect(screen.getByText('App Lifecycle')).toBeTruthy();
    // Tools still render under their group.
    expect(screen.getByText('hub_list_installed_apps')).toBeTruthy();
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('lists API keys with a managed badge and never shows the raw key', async () => {
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-key-list')).toBeTruthy());
    expect(screen.getByText('Laptop CLI')).toBeTruthy();
    expect(screen.getByText('openclaw')).toBeTruthy();
    expect(screen.getByText('a1b2c3d4…')).toBeTruthy(); // prefix only, not the raw key
    // The managed companion-app key is badged; the operator key is not.
    expect(screen.getAllByText('MCP_SETTINGS_KEY_MANAGED_BADGE')).toHaveLength(1);
  });

  it('creates a key and reveals the raw value once', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp-admin/keys' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 3, name: 'n8n', prefix: 'deadbeef', key: 'deadbeefRAWKEY' }) });
      }
      return mockGet(url);
    });

    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    await user.click(screen.getByTestId('mcp-create-key'));
    await waitFor(() => expect(screen.getByTestId('mcp-new-key-name')).toBeTruthy());
    fireEvent.change(screen.getByTestId('mcp-new-key-name'), { target: { value: 'n8n' } });
    await user.click(screen.getByTestId('mcp-create-key-submit'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/mcp-admin/keys',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'n8n' }) }),
      ),
    );
    // The raw key is surfaced exactly once, in the "copy it now" panel.
    await waitFor(() => expect(screen.getByTestId('mcp-created-key').textContent).toContain('deadbeefRAWKEY'));
  });

  it('revokes a key via DELETE and refreshes the list so the row disappears', async () => {
    const user = userEvent.setup();
    let revoked = false;
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp-admin/keys/1' && init?.method === 'DELETE') {
        revoked = true;
        return Promise.resolve({ ok: true, json: async () => ({ revoked: true }) });
      }
      // After the revoke, the reloaded list no longer contains 'Laptop CLI' (id 1).
      if (url === '/api/mcp-admin/keys' && revoked) {
        return Promise.resolve({ ok: true, json: async () => ({ keys: KEYS.keys.filter((k) => k.id !== 1) }) });
      }
      return mockGet(url);
    });

    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-key-list')).toBeTruthy());

    const row = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'MCP_SETTINGS_KEY_REVOKE' }));

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/mcp-admin/keys/1', expect.objectContaining({ method: 'DELETE' })));
    // The refresh must actually re-render without the revoked key (not just fire the DELETE).
    await waitFor(() => expect(screen.queryByText('Laptop CLI')).toBeNull());
    expect(screen.getByText('openclaw')).toBeTruthy(); // the other key remains
  });

  it('shows the last-key explanation when the backend refuses the revoke with 409', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/mcp-admin/keys/1' && init?.method === 'DELETE') {
        // Backend blocks revoking the final key (an empty store would re-seed it at next boot).
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) });
      }
      return mockGet(url);
    });

    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-key-list')).toBeTruthy());

    const row = screen.getByText('Laptop CLI').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'MCP_SETTINGS_KEY_REVOKE' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('MCP_SETTINGS_KEY_REVOKE_LAST'));
    expect(screen.getByText('Laptop CLI')).toBeTruthy(); // row stays — nothing was revoked
  });

  it('filters the tool list by search', async () => {
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-tool-search')).toBeTruthy());
    fireEvent.change(screen.getByTestId('mcp-tool-search'), { target: { value: 'uninstall' } });
    await waitFor(() => expect(screen.queryByText('hub_list_installed_apps')).toBeNull());
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('toggles the destructive gate via POST /settings', async () => {
    const user = userEvent.setup();
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    await user.click(screen.getByRole('switch', { name: 'mcp-allow-destructive' }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/mcp-admin/settings',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ allowDestructive: true }) }),
      ),
    );
  });

  it('runs a tool and shows the result', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/tools/')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: { count: 5 } }) });
      }
      return mockGet(url);
    });

    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    // Open the runner for the first tool, then submit.
    const listRow = screen.getByText('hub_list_installed_apps').closest('li') as HTMLElement;
    await user.click(within(listRow).getByRole('button', { name: 'MCP_SETTINGS_RUN' }));
    await waitFor(() => expect(screen.getByTestId('mcp-run-submit')).toBeTruthy());
    await user.click(screen.getByTestId('mcp-run-submit'));

    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith('/api/mcp-admin/tools/hub_list_installed_apps/call', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(screen.getByTestId('mcp-run-result').textContent).toContain('5'));
  });

  it('rejects non-object JSON arguments before calling the backend', async () => {
    const user = userEvent.setup();
    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    const listRow = screen.getByText('hub_list_installed_apps').closest('li') as HTMLElement;
    await user.click(within(listRow).getByRole('button', { name: 'MCP_SETTINGS_RUN' }));
    await waitFor(() => expect(screen.getByTestId('mcp-run-submit')).toBeTruthy());

    // A JSON array is valid JSON but not an object record — must be blocked client-side.
    fireEvent.change(screen.getByTestId('mcp-run-args'), { target: { value: '[1,2,3]' } });
    await user.click(screen.getByTestId('mcp-run-submit'));

    expect(toast.error).toHaveBeenCalledWith('MCP_SETTINGS_RUN_ARGS_NOT_OBJECT');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/mcp-admin/tools/hub_list_installed_apps/call', expect.anything());
  });

  it('gates a destructive tool run behind an explicit confirmation checkbox', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/tools/')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) });
      }
      return mockGet(url);
    });

    render(<McpSettingsContainer />);
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    // Open the runner for the destructive tool.
    const row = screen.getByText('hub_uninstall_app').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'MCP_SETTINGS_RUN' }));
    await waitFor(() => expect(screen.getByTestId('mcp-run-submit')).toBeTruthy());

    // Run is disabled until the operator explicitly confirms.
    expect((screen.getByTestId('mcp-run-submit') as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox'));
    expect((screen.getByTestId('mcp-run-submit') as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByTestId('mcp-run-submit'));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/mcp-admin/tools/hub_uninstall_app/call',
        expect.objectContaining({ body: expect.stringContaining('"confirmDestructive":true') }),
      ),
    );
  });
});
