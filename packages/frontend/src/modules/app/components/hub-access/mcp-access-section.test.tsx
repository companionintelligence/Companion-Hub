import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAccess } from './hub-access';

// The app's request for the Hub's MCP tools, inside the "Hub access" section: who may answer it, and
// what an answer sends. Against a mocked raw-URL client, as hub-access.test.tsx does.

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), manageHub: true, canGrantFull: true }));
vi.mock('@/api-client/client.gen', () => ({
  client: {
    get: (...args: unknown[]) => h.get(...args),
    put: (...args: unknown[]) => h.put(...args),
    post: (...args: unknown[]) => h.post(...args),
  },
}));
vi.mock('@/lib/hooks/use-hub-access', () => ({ useHubAccess: () => ({ manageHub: h.manageHub, isPending: false }) }));
vi.mock('@/lib/hooks/use-can-grant-full', () => ({ useCanGrantFull: () => h.canGrantFull }));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

const APP_URN = 'agent:someone-elses-store';
const MCP_URL = `/api/app-lifecycle/${encodeURIComponent(APP_URN)}/hub-access/mcp`;

const UNANSWERED = { appKey: null, identityVerification: false, provisioned: false, mcp: { access: null, keyCapability: null } };

function renderHubAccess() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return render(<HubAccess appUrn={APP_URN} />, { wrapper });
}

describe('HubAccess — the app’s request for the Hub MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.manageHub = true;
    h.canGrantFull = true;
    h.put.mockResolvedValue({ data: { restarting: true } });
  });

  it('shows an app nobody has answered, which holds nothing, with no access chosen and nothing to rotate', async () => {
    h.get.mockResolvedValue({ data: UNANSWERED });

    renderHubAccess();

    expect(await screen.findByTestId('hub-access-mcp')).toBeTruthy();
    expect(screen.getByTestId('hub-access-mcp-unanswered')).toBeTruthy();
    expect((screen.getByTestId('hub-access-mcp-access-none') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('hub-access-rotate')).toBeNull();
  });

  it('lets a Hub manager answer, sending the level, and says the app restarts', async () => {
    h.get.mockResolvedValue({ data: UNANSWERED });
    const user = userEvent.setup();
    renderHubAccess();

    await user.click(await screen.findByTestId('hub-access-mcp-access-write'));
    await user.click(screen.getByTestId('hub-access-mcp-save'));

    await waitFor(() => expect(h.put).toHaveBeenCalledWith(expect.objectContaining({ url: MCP_URL, body: { access: 'write' } })));
    expect(toast.success).toHaveBeenCalledWith('APP_MCP_ACCESS_SAVED_RESTARTING');
  });

  it('lets "no access" be saved as an answer to an app nobody has answered', async () => {
    h.get.mockResolvedValue({ data: UNANSWERED });
    const user = userEvent.setup();
    renderHubAccess();

    await user.click(await screen.findByTestId('hub-access-mcp-save'));

    await waitFor(() => expect(h.put).toHaveBeenCalledWith(expect.objectContaining({ body: { access: 'none' } })));
  });

  it('offers no save until the answer changes', async () => {
    h.get.mockResolvedValue({ data: { ...UNANSWERED, mcp: { access: 'read', keyCapability: 'read' } } });
    const user = userEvent.setup();
    renderHubAccess();

    const save = (await screen.findByTestId('hub-access-mcp-save')) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(screen.getByTestId('hub-access-mcp-access-write'));
    expect(save.disabled).toBe(false);
  });

  it('shows full as unavailable to a manager who is no owner or admin', async () => {
    h.canGrantFull = false;
    h.get.mockResolvedValue({ data: UNANSWERED });

    renderHubAccess();

    expect(((await screen.findByTestId('hub-access-mcp-access-full')) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('hub-access-mcp-access-write') as HTMLInputElement).disabled).toBe(false);
  });

  it('shows a member the answer but no way to change it', async () => {
    h.manageHub = false;
    h.get.mockResolvedValue({ data: { ...UNANSWERED, mcp: { access: 'write', keyCapability: 'write' } } });

    renderHubAccess();

    expect(((await screen.findByTestId('hub-access-mcp-access-write')) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('hub-access-mcp-access-none') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('hub-access-mcp-save')).toBeNull();
    expect(screen.getByText('APP_MCP_ACCESS_MANAGER_REQUIRED')).toBeTruthy();
  });

  it('says when the key works at another level than the one granted, as Settings → Security may set', async () => {
    h.get.mockResolvedValue({ data: { ...UNANSWERED, mcp: { access: 'write', keyCapability: 'read' } } });

    renderHubAccess();

    expect(await screen.findByTestId('hub-access-mcp-key-level')).toBeTruthy();
  });
});
