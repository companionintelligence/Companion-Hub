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
    expect(notice).toHaveTextContent("Ollama and Private VPN can't run in this live session.");
    expect(notice).toHaveTextContent('Unless your stick was set up with persistence');
    expect(notice).toHaveTextContent('gone after a restart');
  });

  it.each([
    [{ ollamaBlocked: true, tailscaleBlocked: false }, "Ollama can't run in this live session.", 'Private VPN'],
    [{ ollamaBlocked: false, tailscaleBlocked: true }, "Private VPN can't run in this live session.", 'Ollama'],
  ])('names only what this image blocks: %o', async (blocks, says, leavesOut) => {
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue({ live: true, ...blocks }) };

    render(<LiveSessionNotice />);

    const notice = await screen.findByTestId('live-session-notice');
    expect(notice).toHaveTextContent(says);
    expect(notice).not.toHaveTextContent(leavesOut);
  });

  it('claims no block when the image has none', async () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: vi.fn().mockResolvedValue({ live: true, ollamaBlocked: false, tailscaleBlocked: false }),
    };

    render(<LiveSessionNotice />);

    const notice = await screen.findByTestId('live-session-notice');
    expect(notice).not.toHaveTextContent("can't run");
    expect(notice).toHaveTextContent('gone after a restart');
  });

  it('reads once however many callers mount, and a remount knows straight away', async () => {
    const invoke = vi.fn().mockResolvedValue({ live: true, ollamaBlocked: true, tailscaleBlocked: true });
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    const { unmount } = render(
      <>
        <LiveSessionNotice />
        <LiveSessionNotice />
      </>,
    );
    expect(await screen.findAllByTestId('live-session-notice')).toHaveLength(2);
    unmount();

    render(<LiveSessionNotice />);

    expect(screen.getByTestId('live-session-notice')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledTimes(1);
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
