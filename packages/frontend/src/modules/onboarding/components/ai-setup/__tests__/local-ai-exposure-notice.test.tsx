import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAiExposureNotice } from '../local-ai-exposure-notice';

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } };

/** The desktop app's side: what the exposure command answers, and what the protect command does. */
function desktop(exposure: Record<string, boolean>, protect: () => Promise<unknown> = async () => undefined) {
  let current = exposure;
  const invoke = vi.fn(async (command: string) => {
    if (command === 'local_ai_network_exposure_command') return current;
    if (command === 'protect_local_ai_command') {
      await protect();
      current = { ...current, guarded: true };
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  });
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

describe('LocalAiExposureNotice', () => {
  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('warns when the AI servers listen on every interface with no guard, and keeps them to this computer', async () => {
    const invoke = desktop({ listeningOnAllInterfaces: true, guarded: false, canProtect: true });

    render(<LocalAiExposureNotice />);

    const notice = await screen.findByTestId('local-ai-exposure-notice');
    expect(notice).toHaveTextContent("Other devices on your network can use this computer's AI");
    expect(notice).toHaveTextContent('it has no password');

    fireEvent.click(screen.getByRole('button', { name: 'Keep it to this computer' }));

    await waitFor(() => expect(screen.queryByTestId('local-ai-exposure-notice')).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('protect_local_ai_command');
  });

  it.each([
    ['guarded', { listeningOnAllInterfaces: true, guarded: true, canProtect: true }],
    ['on loopback only', { listeningOnAllInterfaces: false, guarded: false, canProtect: true }],
  ])('says nothing when the servers are %s', async (_case, exposure) => {
    const invoke = desktop(exposure);

    render(<LocalAiExposureNotice />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('local_ai_network_exposure_command'));
    expect(screen.queryByTestId('local-ai-exposure-notice')).not.toBeInTheDocument();
  });

  it('says nothing outside the desktop app, or with a desktop app that has no such command', async () => {
    const { container } = render(<LocalAiExposureNotice />);
    expect(container).toBeEmptyDOMElement();

    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke: vi.fn().mockRejectedValue(new Error('Command not found')) };
    const older = render(<LocalAiExposureNotice />);
    await waitFor(() => expect(older.container).toBeEmptyDOMElement());
  });

  it('tells how to do it by hand where the desktop cannot, and shows a refused password prompt', async () => {
    desktop({ listeningOnAllInterfaces: true, guarded: false, canProtect: false });
    const manual = render(<LocalAiExposureNotice />);
    expect(await manual.findByText(/Block ports 11434 and 8002/)).toBeInTheDocument();
    manual.unmount();

    desktop({ listeningOnAllInterfaces: true, guarded: false, canProtect: true }, async () => {
      throw new Error('Authorization was cancelled or denied.');
    });
    render(<LocalAiExposureNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it to this computer' }));
    expect(await screen.findByText('Authorization was cancelled or denied.')).toBeInTheDocument();
    expect(screen.getByTestId('local-ai-exposure-notice')).toBeInTheDocument();
  });
});
