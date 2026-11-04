import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveSessionNotice } from '../live-session-notice';

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> } };

describe('LiveSessionNotice', () => {
  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('says what a live session cannot do', async () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue({ live: true, ollamaBlocked: true, tailscaleBlocked: true }),
    };

    render(<LiveSessionNotice />);

    const notice = await screen.findByTestId('live-session-notice');
    expect(notice).toHaveTextContent("You're running from the USB stick");
    expect(notice).toHaveTextContent('gone after a restart');
  });

  it('stays away on a normal desktop', async () => {
    const invoke = vi.fn().mockResolvedValue({ live: false, ollamaBlocked: false, tailscaleBlocked: false });
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    render(<LiveSessionNotice />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('live_session_state_command'));
    expect(screen.queryByTestId('live-session-notice')).not.toBeInTheDocument();
  });

  it('stays away in a browser and on a desktop app too old to answer', async () => {
    const { unmount } = render(<LiveSessionNotice />);
    expect(screen.queryByTestId('live-session-notice')).not.toBeInTheDocument();
    unmount();

    const invoke = vi.fn().mockRejectedValue('command not found');
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    render(<LiveSessionNotice />);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByTestId('live-session-notice')).not.toBeInTheDocument();
  });
});
