import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaSetupCard } from '../ollama-setup-card';

const mockOpenExternal = vi.fn();
vi.mock('@/lib/helpers/open-external', () => ({
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
}));

const ollamaMissing = {
  ready: false,
  running: false,
  endpointUrl: 'http://localhost:11434',
};

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } };

function installTauriMock(invoke: (cmd: string) => Promise<unknown>) {
  (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
}

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

describe('OllamaSetupCard auto-install', () => {
  it('hides the auto-install button outside the desktop app (no Tauri)', () => {
    render(<OllamaSetupCard status={ollamaMissing} checking={false} onRecheck={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /Auto-Install Ollama/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get Ollama/i })).toBeInTheDocument();
  });

  it('still opens ollama.com from the Get Ollama button without Tauri', async () => {
    const user = userEvent.setup();
    render(<OllamaSetupCard status={ollamaMissing} checking={false} onRecheck={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Get Ollama/i }));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://ollama.com');
  });

  it('shows the auto-install button in the desktop app and invokes install_ollama_command', async () => {
    const invoke = vi.fn().mockResolvedValue({ state: 'completed', detail: null });
    installTauriMock(invoke);
    const onRecheck = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<OllamaSetupCard status={ollamaMissing} checking={false} onRecheck={onRecheck} />);

    await user.click(screen.getByRole('button', { name: /Auto-Install Ollama/i }));

    expect(invoke).toHaveBeenCalledWith('install_ollama_command');
    await waitFor(() => expect(screen.getByText(/Ollama installed/i)).toBeInTheDocument());
    await waitFor(() => expect(onRecheck).toHaveBeenCalled());
  });

  it('shows a spinner while the install runs', async () => {
    let resolveInstall: (v: unknown) => void = () => {};
    const invoke = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    installTauriMock(invoke);
    const user = userEvent.setup();
    render(<OllamaSetupCard status={ollamaMissing} checking={false} onRecheck={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Auto-Install Ollama/i }));
    expect(screen.getByText(/Installing Ollama/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Auto-Install Ollama/i })).not.toBeInTheDocument();

    resolveInstall({ state: 'completed', detail: null });
    await waitFor(() => expect(screen.getByText(/Ollama installed/i)).toBeInTheDocument());
  });

  it('surfaces the installer error and offers retry on failure', async () => {
    const invoke = vi.fn().mockRejectedValue('Authorization was cancelled or denied.');
    installTauriMock(invoke);
    const user = userEvent.setup();
    render(<OllamaSetupCard status={ollamaMissing} checking={false} onRecheck={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Auto-Install Ollama/i }));

    await waitFor(() => expect(screen.getByText(/Authorization was cancelled or denied/i)).toBeInTheDocument());
    // The button returns for a retry.
    expect(screen.getByRole('button', { name: /Auto-Install Ollama/i })).toBeInTheDocument();
  });

  it('still offers auto-install when Ollama is installed but the bridge is unreachable', () => {
    installTauriMock(vi.fn());
    render(
      <OllamaSetupCard
        status={{ ...ollamaMissing, bridgeUnreachable: true, hint: 'Ensure the Ollama app is running.' }}
        checking={false}
        onRecheck={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Auto-Install Ollama/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Get Ollama/i })).not.toBeInTheDocument();
  });
});
