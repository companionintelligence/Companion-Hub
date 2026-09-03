import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import toast from 'react-hot-toast';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsContainer } from '../mcp-settings';

// ENH-MCP-4: exercises the MCP settings screen against a mocked /api/mcp-admin surface.
// Key management moved to the hub-wide Settings → Security card (see api-keys.test.tsx);
// this tab only links there. The appliance-wide destructive switch that used to live here is gone
// too — destructive access is now each key's capability, granted one key at a time on that card.

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
  activeKeyCount: 2,
  endpoint: '/api/mcp',
};
const TOOLS = {
  tools: [
    {
      name: 'hub_list_installed_apps',
      description: 'List apps',
      inputSchema: { type: 'object' },
      destructive: false,
      access: 'read',
      category: 'App Discovery',
    },
    {
      name: 'hub_start_app',
      description: 'Start an app',
      inputSchema: { type: 'object' },
      destructive: false,
      access: 'write',
      category: 'App Lifecycle',
    },
    {
      name: 'hub_uninstall_app',
      description: 'Uninstall an app',
      inputSchema: { type: 'object' },
      destructive: true,
      access: 'write',
      category: 'App Lifecycle',
    },
  ],
};
function mockGet(url: string) {
  if (url === '/api/mcp-admin/status') return Promise.resolve({ ok: true, json: async () => STATUS });
  if (url === '/api/mcp-admin/tools') return Promise.resolve({ ok: true, json: async () => TOOLS });
  return Promise.resolve({ ok: true, json: async () => ({}) });
}

// The container renders a react-router Link (Manage API keys), so every render needs a router.
function renderContainer() {
  return render(
    <MemoryRouter>
      <McpSettingsContainer />
    </MemoryRouter>,
  );
}

describe('McpSettingsContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockImplementation((url: string) => mockGet(url));
  });

  it('loads and renders server status + tool catalog', async () => {
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());
    expect(screen.getByText('ci-hub 1.0.0')).toBeTruthy();
    expect(screen.getByText('2025-11-25')).toBeTruthy();
    expect(screen.getByText('hub_list_installed_apps')).toBeTruthy();
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('renders the endpoint as a clickable absolute URL (not the bare path)', async () => {
    renderContainer();
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
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());
    // Each tool's backend category becomes a section header.
    expect(screen.getByText('App Discovery')).toBeTruthy();
    expect(screen.getByText('App Lifecycle')).toBeTruthy();
    // Tools still render under their group.
    expect(screen.getByText('hub_list_installed_apps')).toBeTruthy();
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('links to hub-wide key management on the Security tab instead of listing keys', async () => {
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    // No key list or create affordance here anymore — just the pointer card.
    expect(screen.queryByTestId('mcp-key-list')).toBeNull();
    expect(screen.queryByTestId('mcp-create-key')).toBeNull();

    // The status's activeKeyCount stays visible, next to the manage link.
    expect(screen.getByTestId('mcp-active-key-count').textContent).toBe('MCP_SETTINGS_ACTIVE_KEYS');
    const link = screen.getByRole('link', { name: 'MCP_SETTINGS_MANAGE_KEYS_LINK' });
    expect(link.getAttribute('href')).toBe('/settings?tab=security');
  });

  it('filters the tool list by search', async () => {
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-tool-search')).toBeTruthy());
    fireEvent.change(screen.getByTestId('mcp-tool-search'), { target: { value: 'uninstall' } });
    await waitFor(() => expect(screen.queryByText('hub_list_installed_apps')).toBeNull());
    expect(screen.getByText('hub_uninstall_app')).toBeTruthy();
  });

  it('offers no appliance-wide destructive switch, and points at where the decision moved to', async () => {
    // One switch could only be on or off for every key at once, so enabling it for one agent enabled
    // it for all of them. An operator who remembers it here must be told where it went, not just find
    // it missing.
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-settings')).toBeTruthy());

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('MCP_SETTINGS_CAPABILITY_HINT')).toBeTruthy();
    expect(screen.getByTestId('mcp-manage-keys')).toBeTruthy();
  });

  it('badges each tool by the least capability that reaches it', async () => {
    renderContainer();
    await waitFor(() => expect(screen.getByTestId('mcp-tool-groups')).toBeTruthy());

    const readRow = screen.getByText('hub_list_installed_apps').closest('li') as HTMLElement;
    expect(within(readRow).queryByText('MCP_SETTINGS_TOOL_WRITE_BADGE')).toBeNull();
    expect(within(readRow).queryByText('MCP_SETTINGS_TOOL_DESTRUCTIVE_BADGE')).toBeNull();

    const writeRow = screen.getByText('hub_start_app').closest('li') as HTMLElement;
    expect(within(writeRow).getByText('MCP_SETTINGS_TOOL_WRITE_BADGE')).toBeTruthy();

    // Destructive implies write, so the badges are alternatives rather than a stack.
    const destructiveRow = screen.getByText('hub_uninstall_app').closest('li') as HTMLElement;
    expect(within(destructiveRow).getByText('MCP_SETTINGS_TOOL_DESTRUCTIVE_BADGE')).toBeTruthy();
    expect(within(destructiveRow).queryByText('MCP_SETTINGS_TOOL_WRITE_BADGE')).toBeNull();
  });

  it('runs a tool and shows the result', async () => {
    const user = userEvent.setup();
    mockApiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/tools/')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: { count: 5 } }) });
      }
      return mockGet(url);
    });

    renderContainer();
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
    renderContainer();
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

    renderContainer();
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
