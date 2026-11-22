import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmlxStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { isLocalOmlxUrl } from '../omlx-admin-key-prompt';
import { OmlxSetupCard } from '../omlx-setup-card';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

const omlxReady: OmlxStatus = {
  ready: true,
  running: true,
  endpointUrl: 'http://host.docker.internal:8000',
  displayEndpoint: 'http://host.docker.internal:8000/v1',
};

const PROMPT = 'The Hub needs an oMLX key to download models. Set one now? Apps keep using oMLX without a key.';

/** The desktop app, answering the key status and key setup commands as given. */
function desktopApp(answers: { keySet?: boolean | Error; setup?: { apiKey: string; warning?: string } | string }) {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'omlx_admin_key_status_command') {
      if (answers.keySet instanceof Error) throw answers.keySet;
      return { keySet: answers.keySet ?? false };
    }
    if (command === 'omlx_setup_admin_key_command') {
      if (typeof answers.setup === 'string') throw answers.setup;
      return answers.setup;
    }
    return null;
  });
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

function renderCard(props: Partial<Parameters<typeof OmlxSetupCard>[0]> = {}) {
  const onAdminKeySet = vi.fn().mockResolvedValue(undefined);
  render(
    <OmlxSetupCard
      status={omlxReady}
      checking={false}
      onRecheck={vi.fn()}
      endpointUrl=""
      onEndpointUrlChange={vi.fn()}
      apiKey=""
      onApiKeyChange={vi.fn()}
      onAdminKeySet={onAdminKeySet}
      {...props}
    />,
  );
  return { onAdminKeySet };
}

describe("oMLX's admin key prompt", () => {
  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('offers a key in the desktop app while neither the Hub nor oMLX has one', async () => {
    const invoke = desktopApp({ keySet: false });
    renderCard();

    expect(await screen.findByText(PROMPT)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('omlx_admin_key_status_command');
  });

  it('offers nothing in a browser, which cannot reach oMLX on the Mac', async () => {
    renderCard();

    await waitFor(() => expect(screen.getByText('oMLX detected')).toBeInTheDocument());
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
  });

  it('offers nothing when the Hub has a key, typed or stored', async () => {
    const invoke = desktopApp({ keySet: false });
    renderCard({ apiKey: 'typed-key' });
    renderCard({ hubHasApiKey: true });

    await waitFor(() => expect(screen.getAllByText('oMLX detected')).toHaveLength(2));
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("offers nothing when oMLX's settings hold a key", async () => {
    const invoke = desktopApp({ keySet: true });
    renderCard();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('omlx_admin_key_status_command'));
    // Let the answer land before looking.
    await act(async () => {});
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
  });

  it('offers nothing when the desktop app cannot say, as one too old to have the command', async () => {
    const invoke = desktopApp({ keySet: new Error('Command omlx_admin_key_status_command not found') });
    renderCard();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('omlx_admin_key_status_command'));
    // Let the answer land before looking.
    await act(async () => {});
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
  });

  it('offers nothing for an oMLX on another machine, which the desktop app cannot give a key', async () => {
    const invoke = desktopApp({ keySet: false });
    renderCard({ endpointUrl: 'http://mac-studio.lan:8000' });

    await waitFor(() => expect(screen.getByText('oMLX detected')).toBeInTheDocument());
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
    expect(isLocalOmlxUrl('http://localhost:8000')).toBe(true);
    expect(isLocalOmlxUrl('http://host.docker.internal:8000/')).toBe(true);
    expect(isLocalOmlxUrl('http://localhost:8002')).toBe(false);
  });

  it('saves the new key to the Hub, then shows it once with where it signs in', async () => {
    const invoke = desktopApp({ keySet: false, setup: { apiKey: 'ci-hub-new-key' } });
    const user = userEvent.setup();
    const { onAdminKeySet } = renderCard();

    await user.click(await screen.findByTestId('omlx-admin-key-set-btn'));

    await waitFor(() => expect(screen.getByTestId('omlx-admin-key-value')).toHaveTextContent('ci-hub-new-key'));
    expect(invoke).toHaveBeenCalledWith('omlx_setup_admin_key_command');
    expect(onAdminKeySet).toHaveBeenCalledWith('ci-hub-new-key');
    expect(screen.getByTestId('omlx-admin-key-done')).toHaveTextContent('the Hub saved it');
    expect(screen.getByTestId('omlx-admin-key-done')).toHaveTextContent("It signs in to oMLX's page at http://localhost:8000/admin.");
    expect(screen.getByTestId('omlx-admin-key-copy')).toBeInTheDocument();
    expect(screen.queryByTestId('omlx-admin-key-prompt')).not.toBeInTheDocument();
  });

  it("keeps showing the key when the Hub's save fails, since oMLX will not hand it out again", async () => {
    desktopApp({ keySet: false, setup: { apiKey: 'ci-hub-new-key', warning: 'oMLX now has an API key, but it did not keep /v1 open.' } });
    const user = userEvent.setup();
    renderCard({ onAdminKeySet: vi.fn().mockRejectedValue(new Error('HTTP 503')) });

    await user.click(await screen.findByTestId('omlx-admin-key-set-btn'));

    await waitFor(() => expect(screen.getByTestId('omlx-admin-key-value')).toHaveTextContent('ci-hub-new-key'));
    expect(screen.getByTestId('omlx-admin-key-done')).toHaveTextContent('the Hub could not save it (HTTP 503)');
    expect(screen.getByTestId('omlx-admin-key-warning')).toHaveTextContent('did not keep /v1 open');
  });

  it("shows oMLX's reason when it does not take a key, and saves nothing", async () => {
    const reason = "oMLX already has an API key, so the Hub cannot set one. Enter oMLX's key in Settings > AI.";
    desktopApp({ keySet: false, setup: reason });
    const user = userEvent.setup();
    const { onAdminKeySet } = renderCard();

    await user.click(await screen.findByTestId('omlx-admin-key-set-btn'));

    await waitFor(() => expect(screen.getByTestId('omlx-admin-key-error')).toHaveTextContent(`Could not set a key: ${reason}`));
    expect(onAdminKeySet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('omlx-admin-key-value')).not.toBeInTheDocument();
  });
});
