import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSettingsContainer } from '../mcp-settings';

// ENH-MCP-4: exercises the MCP settings screen against a mocked /api/mcp-admin surface.

const mockApiFetch = vi.fn();
vi.mock('@/lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
  apiKeyConfigured: true,
  endpoint: '/api/mcp',
};
const TOOLS = {
  tools: [
    { name: 'hub_list_installed_apps', description: 'List apps', inputSchema: { type: 'object' }, destructive: false },
    { name: 'hub_uninstall_app', description: 'Uninstall an app', inputSchema: { type: 'object' }, destructive: true },
  ],
};

function mockGet(url: string) {
  if (url === '/api/mcp-admin/status') return Promise.resolve({ ok: true, json: async () => STATUS });
  if (url === '/api/mcp-admin/tools') return Promise.resolve({ ok: true, json: async () => TOOLS });
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
});
