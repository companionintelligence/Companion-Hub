import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repairPublicWebRouting, restartDialogProps } = vi.hoisted(() => ({
  repairPublicWebRouting: vi.fn(),
  restartDialogProps: vi.fn(),
}));

vi.mock('@/lib/cloudflare-api', async (importOriginal) => ({
  // Keep the real `customDomainAwaitingRestart` / `restartCanApply` — the status
  // rule is exactly what these tests are about, so stubbing it would prove nothing.
  ...(await importOriginal<typeof import('@/lib/cloudflare-api')>()),
  repairPublicWebRouting,
}));

/*
 * The dialog is the app's own Restart confirmation and carries its own tests. What
 * matters here is that the banner opens it — for the right app, with the reason —
 * instead of restarting anything itself.
 */
vi.mock('@/modules/app/components/dialogs/restart-dialog/restart-dialog', () => ({
  RestartDialog: (props: { info: { urn: string; name: string }; isOpen: boolean; reason?: string }) => {
    restartDialogProps(props);
    return props.isOpen ? <div data-testid="restart-dialog">{props.info.urn}</div> : null;
  },
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
  autoRestartOnDomainChange: false,
};

const renderBanner = (apps: (typeof waitingEntry)[], names: Record<string, string> = { 'wordpress:store': 'WordPress' }) =>
  render(<CustomDomainRestartBanner apps={apps} namesByUrn={names} />);

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
    // A stopped app picks the domain up when it next starts, so there is nothing to
    // confirm — and nothing a restart could do that the start will not.
    renderBanner([{ ...waitingEntry, status: 'stopped' }]);

    expect(screen.queryByTestId('custom-domain-restart-banner')).not.toBeInTheDocument();
  });

  it('asks before restarting, and restarts nothing on its own', async () => {
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    // The click opens a confirmation. Connecting a domain leaves the moment of the
    // restart to a person, so the banner must never skip straight to one.
    expect(screen.getByTestId('restart-dialog')).toHaveTextContent('wordpress:store');
    expect(repairPublicWebRouting).not.toHaveBeenCalled();
  });

  it('tells the confirmation which domain the restart is for', async () => {
    renderBanner([waitingEntry]);

    await userEvent.click(screen.getByRole('button'));

    const lastOpen = restartDialogProps.mock.calls.at(-1)?.[0];
    expect(lastOpen?.info).toEqual({ urn: 'wordpress:store', name: 'WordPress' });
    expect(lastOpen?.reason).toContain('wp.example.com');
  });

  it('offers a restart for every waiting app, and confirms the one that was clicked', async () => {
    const second = { ...waitingEntry, appUrn: 'ghost:store', customDomain: 'blog.example.com' };
    renderBanner([waitingEntry, second], { 'wordpress:store': 'WordPress', 'ghost:store': 'Ghost' });

    const [, secondButton] = screen.getAllByRole('button');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    if (!secondButton) throw new Error('expected a button per waiting app');

    await userEvent.click(secondButton);
    expect(screen.getByTestId('restart-dialog')).toHaveTextContent('ghost:store');
  });

  it('asks nobody about an app set to restart on its own', () => {
    // The Hub restarts it on its next sync. A button here would ask a person to do
    // something that is already on its way.
    renderBanner([{ ...waitingEntry, autoRestartOnDomainChange: true }]);

    expect(screen.queryByTestId('custom-domain-restart-banner')).not.toBeInTheDocument();
  });
});
