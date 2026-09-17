import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import { resetRegistration } from '@/api-client/sdk.gen';
import { clearClientHubState } from '@/lib/clear-client-hub-state';
import { openExternal } from '@/lib/helpers/open-external';
import { type HubRemovalWatchEnd, watchForHubRemoval } from '@/lib/hub-removal-watch';
import { HubAccountSection } from '../hub-account-settings';

const fixtures = vi.hoisted(() => ({
  portalConfig: { portalUrl: 'https://portal.example.com', deviceId: 'hw-123', registrationUrl: null, demoMode: false } as Record<string, unknown>,
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/hooks/use-demo-mode', () => ({ useDemoMode: () => false }));
vi.mock('@/lib/clear-client-hub-state', () => ({ clearClientHubState: vi.fn() }));
vi.mock('@/lib/helpers/open-external', () => ({ openExternal: vi.fn().mockResolvedValue(true) }));
vi.mock('@/api-client/sdk.gen', () => ({ resetRegistration: vi.fn(), checkForRemoval: vi.fn() }));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({
  getPortalConfigOptions: () => ({ queryKey: ['portal-config'], queryFn: async () => fixtures.portalConfig }),
}));
vi.mock('@/lib/hub-removal-watch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hub-removal-watch')>()),
  watchForHubRemoval: vi.fn(),
}));

const renderSection = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HubAccountSection />
    </QueryClientProvider>,
  );
};

/** Starts the removal flow and hands back the watch's `onEnd` and stop function. */
const startRemoval = async () => {
  const stop = vi.fn();
  vi.mocked(watchForHubRemoval).mockReturnValue(stop);

  renderSection();
  const button = await screen.findByTestId('remove-hub-from-account-btn');
  await waitFor(() => expect(button).not.toBeDisabled());
  await userEvent.click(button);

  const { onEnd } = vi.mocked(watchForHubRemoval).mock.calls.at(-1)?.[0] as { onEnd: (end: HubRemovalWatchEnd) => void };
  return { onEnd, stop };
};

describe('HubAccountSection', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.portalConfig = { portalUrl: 'https://portal.example.com', deviceId: 'hw-123', registrationUrl: null, demoMode: false };
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, href: 'http://hub.local/settings' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('explains both actions separately: removal happens in the Portal, a reset keeps the Portal device', async () => {
    renderSection();

    expect(await screen.findByText('SETTINGS_HUB_ACCOUNT_REMOVE_TITLE')).toBeTruthy();
    expect(screen.getByText('SETTINGS_HUB_ACCOUNT_REMOVE_DESC')).toBeTruthy();
    expect(screen.getByText('SETTINGS_HUB_ACCOUNT_RESET_TITLE')).toBeTruthy();
    expect(screen.getByText('SETTINGS_HUB_ACCOUNT_RESET_DESC')).toBeTruthy();
  });

  it("opens the Portal's delete screen for this device and starts watching for the removal", async () => {
    await startRemoval();

    expect(openExternal).toHaveBeenCalledWith('https://portal.example.com/home?remove_device=hw-123');
    expect(watchForHubRemoval).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('remove-hub-waiting')).toBeTruthy();
  });

  it('goes to the pairing screen once the Hub reports it was removed', async () => {
    const { onEnd } = await startRemoval();
    vi.useFakeTimers();

    act(() => onEnd('removed'));

    expect(toast.success).toHaveBeenCalledWith('SETTINGS_HUB_ACCOUNT_REMOVED');
    expect(clearClientHubState).toHaveBeenCalledWith({ keepPortalEmail: true });
    act(() => {
      vi.runAllTimers();
    });
    expect(window.location.href).toBe('/device-registration');
  });

  it('stops quietly on timeout so the person can try again', async () => {
    const { onEnd } = await startRemoval();

    act(() => onEnd('timed_out'));

    expect(screen.queryByTestId('remove-hub-waiting')).toBeNull();
    expect(screen.queryByTestId('remove-hub-stopped')).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByTestId('remove-hub-from-account-btn')).not.toBeDisabled();
  });

  it('says what to do when the Portal refuses the device key', async () => {
    const { onEnd } = await startRemoval();

    act(() => onEnd('key_refused'));

    expect(screen.getByTestId('remove-hub-stopped').textContent).toBe('SETTINGS_HUB_ACCOUNT_REMOVE_KEY_REFUSED');
    expect(window.location.href).toBe('http://hub.local/settings');
  });

  it('stops the watch when the person stops waiting', async () => {
    const { stop } = await startRemoval();

    await userEvent.click(screen.getByText('SETTINGS_HUB_ACCOUNT_REMOVE_STOP'));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('remove-hub-waiting')).toBeNull();
  });

  it('replaces a running watch instead of starting a second one when clicked again', async () => {
    const { stop } = await startRemoval();

    await userEvent.click(screen.getByTestId('remove-hub-from-account-btn'));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(watchForHubRemoval).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('stops the watch on unmount', async () => {
    const stop = vi.fn();
    vi.mocked(watchForHubRemoval).mockReturnValue(stop);

    const { unmount } = renderSection();
    const button = await screen.findByTestId('remove-hub-from-account-btn');
    await waitFor(() => expect(button).not.toBeDisabled());
    await userEvent.click(button);

    unmount();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cannot start a removal when the Portal address or device id is unknown', async () => {
    fixtures.portalConfig = { portalUrl: null, deviceId: null, registrationUrl: null, demoMode: false };

    renderSection();

    const button = await screen.findByTestId('remove-hub-from-account-btn');
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('resets only this Hub after confirmation, warning that the Portal keeps the device', async () => {
    vi.mocked(resetRegistration).mockResolvedValue({ data: { success: true }, error: undefined } as never);

    renderSection();
    await userEvent.click(await screen.findByTestId('reregister-device-btn'));

    expect(await screen.findByText('SETTINGS_HUB_ACCOUNT_RESET_CONFIRM')).toBeTruthy();
    await userEvent.click(screen.getByTestId('reregister-confirm-btn'));

    await waitFor(() => expect(resetRegistration).toHaveBeenCalledWith());
    expect(toast.success).toHaveBeenCalledWith('SETTINGS_NETWORK_RESET_REGISTRATION_SUCCESS');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
