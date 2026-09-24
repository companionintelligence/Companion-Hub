import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchPublicWebDiagnostics, repairPublicWebRouting, invalidateAppQueries, toastError, toastSuccess } = vi.hoisted(() => ({
  fetchPublicWebDiagnostics: vi.fn(),
  repairPublicWebRouting: vi.fn(),
  invalidateAppQueries: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/cloudflare-api', async (importOriginal) => ({
  // Keep the real `customDomainAwaitingRestart` / `restartCanApply` — the status
  // rule is exactly what these tests are about, so stubbing it would prove nothing.
  ...(await importOriginal<typeof import('@/lib/cloudflare-api')>()),
  fetchPublicWebDiagnostics,
  repairPublicWebRouting,
}));

vi.mock('@/modules/app/helpers/app-sse-cache', () => ({ invalidateAppQueries }));

vi.mock('react-hot-toast', () => ({ default: { error: toastError, success: toastSuccess } }));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { CustomDomainRestartBanner } = await import('./custom-domain-restart-banner');

const waitingEntry = {
  appUrn: 'wordpress:store',
  envMismatch: true,
  computedPublicUrl: 'https://wp.example.com',
  status: 'running',
  action: 'ok' as const,
  pendingRestart: true,
  customDomain: 'wp.example.com',
  awaitingCustomDomainRestart: true,
};

const renderBanner = (apps: (typeof waitingEntry)[]) =>
  render(<CustomDomainRestartBanner apps={apps} namesByUrn={{ 'wordpress:store': 'WordPress' }} />);

describe('CustomDomainRestartBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the dark domain and the app', () => {
    renderBanner([waitingEntry]);

    expect(screen.getByTestId('custom-domain-restart-banner')).toHaveTextContent('wp.example.com');
    expect(screen.getByTestId('custom-domain-restart-banner')).toHaveTextContent('WordPress');
  });

  it('says nothing when no domain is waiting', () => {
    renderBanner([{ ...waitingEntry, awaitingCustomDomainRestart: false }]);

    expect(screen.queryByTestId('custom-domain-restart-banner')).not.toBeInTheDocument();
  });

  it('does not offer to restart an app that is stopped', () => {
    // `repair()` rewrites the env and returns success WITHOUT starting a container
    // when the app is not running, so this button would clear the warning and leave
    // the customer's domain exactly as dark as it was.
    renderBanner([{ ...waitingEntry, status: 'stopped' }]);

    expect(screen.queryByTestId('custom-domain-restart-banner')).not.toBeInTheDocument();
  });

  it('reports a failed re-read as an error, not as "already in sync"', async () => {
    fetchPublicWebDiagnostics.mockResolvedValue(null);
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(i18next.t('APP_PUBLIC_WEB_REPAIR_ERROR')));
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(repairPublicWebRouting).not.toHaveBeenCalled();
  });

  it('surfaces a repair the Hub reports as failed inside a 200', async () => {
    fetchPublicWebDiagnostics.mockResolvedValue({ apps: [waitingEntry] });
    repairPublicWebRouting.mockResolvedValue([
      { appUrn: 'wordpress:store', success: false, message: 'Routing was rewritten but the app failed to restart' },
    ]);
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(i18next.t('APP_PUBLIC_WEB_REPAIR_ERROR')));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('confirms a restart that worked', async () => {
    fetchPublicWebDiagnostics.mockResolvedValue({ apps: [waitingEntry] });
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'wordpress:store', success: true }]);
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(i18next.t('APP_PUBLIC_WEB_REPAIR_SUCCESS')));
    expect(invalidateAppQueries).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('offers a restart for every waiting app, not just when there is one', async () => {
    // The count sentence on its own reads "Restart them to finish" and gives the
    // operator nothing to click and no way to tell which apps it means.
    const second = { ...waitingEntry, appUrn: 'n8n:store', customDomain: 'n8n.example.com', appName: 'n8n' };
    render(<CustomDomainRestartBanner apps={[waitingEntry, second]} namesByUrn={{ 'wordpress:store': 'WordPress' }} />);

    const banner = screen.getByTestId('custom-domain-restart-banner');
    expect(banner).toHaveTextContent('wp.example.com');
    expect(banner).toHaveTextContent('n8n.example.com');
    // Named from the report when the installed-apps list has not landed, never a URN.
    expect(banner).not.toHaveTextContent('n8n:store');
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('restarts the app whose row was clicked', async () => {
    const second = { ...waitingEntry, appUrn: 'n8n:store', customDomain: 'n8n.example.com', appName: 'n8n' };
    fetchPublicWebDiagnostics.mockResolvedValue({ apps: [waitingEntry, second] });
    repairPublicWebRouting.mockResolvedValue([{ appUrn: 'n8n:store', success: true }]);
    render(<CustomDomainRestartBanner apps={[waitingEntry, second]} namesByUrn={{}} />);

    const [, n8nButton] = screen.getAllByRole('button');
    await userEvent.click(n8nButton as HTMLElement);

    await waitFor(() => expect(repairPublicWebRouting).toHaveBeenCalledWith('n8n:store'));
  });

  it('does not restart an app the report no longer lists as waiting', async () => {
    fetchPublicWebDiagnostics.mockResolvedValue({ apps: [{ ...waitingEntry, awaitingCustomDomainRestart: false }] });
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(i18next.t('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED')));
    expect(repairPublicWebRouting).not.toHaveBeenCalled();
  });
});
