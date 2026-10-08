import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LemonadeStatus } from '@/modules/onboarding/helpers/ai-setup-types';
import { LemonadeSetupCard } from '../lemonade-setup-card';

const renderCard = (status: LemonadeStatus) => render(<LemonadeSetupCard status={status} checking={false} onRecheck={vi.fn()} />);

describe('LemonadeSetupCard', () => {
  it('explains how to let the Hub reach a localhost-only Lemonade, on the probed port', () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13400', failureMode: 'refused', hostPlatform: 'linux' });

    const hint = screen.getByTestId('lemonade-docker-access-hint');
    // `lemonade` is a client of the running server, which it looks for on 13305 unless told otherwise.
    expect(hint).toHaveTextContent('LEMONADE_PORT=13400 lemonade config set host=0.0.0.0');
  });

  // Binding 0.0.0.0 alone left beta-red's Lemonade answering anyone on the tailnet with no key.
  it('pairs the 0.0.0.0 bind with an API key, and names both service units', () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13305', failureMode: 'refused', hostPlatform: 'linux' });

    expect(screen.getByTestId('lemonade-docker-access-hint')).toHaveTextContent('lemonade config set host=0.0.0.0');
    expect(screen.getByTestId('lemonade-api-key-guidance')).toHaveTextContent(/API key/);
    const script = screen.getByTestId('lemonade-api-key-script');
    expect(script).toHaveTextContent('KEY=$(openssl rand -hex 32)');
    expect(script).toHaveTextContent('Add to the Hub .env, then recreate the Hub: LEMONADE_API_KEY=$KEY');
    // `lemond` from Lemonade 11 on, `lemonade-server` on the 10.x packages the fleet runs.
    expect(script).toHaveTextContent('systemctl cat lemond');
    expect(script).toHaveTextContent('echo lemonade-server');
    expect(screen.getByTestId('lemonade-api-key-guidance')).toHaveTextContent(/lemond on Lemonade 11 and later and lemonade-server on Lemonade 10/);
  });

  // A drop-in and `systemctl show` are readable by every local user, and both packages read their own
  // environment file (10.2.0: /etc/lemonade/conf.d/*.conf), which overrides `Environment=`. So a key
  // already set there won, and Lemonade rejected the key this script printed.
  it('keeps the key in a root-only environment file the drop-in names, never in the drop-in itself', () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13305', failureMode: 'refused', hostPlatform: 'linux' });

    const script = screen.getByTestId('lemonade-api-key-script').textContent ?? '';
    const lines = script.split('\n');
    const createIndex = lines.findIndex((line) => line.includes('install -m 600 /dev/null $DIR/api-key.env'));
    const writeIndex = lines.findIndex((line) => line.includes('printf \'LEMONADE_API_KEY=%s\\n\' "$KEY" | sudo tee $DIR/api-key.env'));

    // Created 0600 before the key goes in; tee keeps an existing file's mode.
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(createIndex);
    expect(script).toContain('printf \'[Service]\\nEnvironmentFile=%s/api-key.env\\n\' "$DIR" | sudo tee $DIR/api-key.conf');
    expect(script).not.toContain('Environment=LEMONADE_API_KEY');
  });

  it("uses the Hub's own key when it already has one", () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13305', hostPlatform: 'linux', apiKeyConfigured: true });

    const script = screen.getByTestId('lemonade-api-key-script');
    expect(script).toHaveTextContent("KEY='<LEMONADE_API_KEY from the Hub .env>'");
    expect(script).not.toHaveTextContent('openssl rand');
  });

  it("shows the firewall rules the Hub built for this host's firewall, app subnet included", () => {
    renderCard({
      ready: false,
      running: false,
      endpointUrl: 'http://host.docker.internal:13305',
      failureMode: 'refused',
      hostPlatform: 'linux',
      firewallCommands: [
        'sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 13305 proto tcp',
        'sudo ufw allow from 10.128.0.0/9 to 172.17.0.1 port 13305 proto tcp',
      ],
    });

    const rules = screen.getByTestId('lemonade-firewall-commands');
    expect(rules).toHaveTextContent('sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 13305 proto tcp');
    expect(rules).toHaveTextContent('sudo ufw allow from 10.128.0.0/9 to 172.17.0.1 port 13305 proto tcp');
    expect(screen.getByTestId('lemonade-docker-access-hint')).toHaveTextContent('10.128.0.0/9');
  });

  it('shows no firewall step when the host has no enabled firewall', () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13305', hostPlatform: 'linux', firewallCommands: [] });

    expect(screen.queryByTestId('lemonade-firewall-commands')).not.toBeInTheDocument();
  });

  it('falls back to ufw rules for the Hub and the app subnet, on the default port, when the Hub sends none', () => {
    renderCard({ ready: false, running: false, endpointUrl: '' });

    const rules = screen.getByTestId('lemonade-firewall-commands');
    expect(rules).toHaveTextContent('sudo ufw allow from 172.16.0.0/12 to any port 13305 proto tcp');
    expect(rules).toHaveTextContent('sudo ufw allow from 10.128.0.0/9 to any port 13305 proto tcp');
  });

  it('gives macOS and Windows hosts no systemd or firewall commands', () => {
    renderCard({ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13305', failureMode: 'refused', hostPlatform: 'darwin' });

    expect(screen.queryByTestId('lemonade-docker-access-hint')).not.toBeInTheDocument();
  });

  it('points a refused key at the key instead of a wider bind', () => {
    renderCard({
      ready: false,
      running: true,
      endpointUrl: 'http://host.docker.internal:13305',
      failureMode: 'auth',
      hostPlatform: 'linux',
      hint: "Lemonade answered but refused the Hub's API key.",
    });

    expect(screen.getByText("Lemonade answered but refused the Hub's API key.")).toBeInTheDocument();
    expect(screen.queryByTestId('lemonade-docker-access-hint')).not.toBeInTheDocument();
  });

  it('does not show the hint once Lemonade is detected', () => {
    renderCard({ ready: true, running: true, endpointUrl: 'http://host.docker.internal:13305' });

    expect(screen.queryByTestId('lemonade-docker-access-hint')).not.toBeInTheDocument();
  });

  it('names the model Lemonade is holding, and otherwise how many are downloaded', () => {
    const { rerender } = renderCard({
      ready: true,
      running: true,
      endpointUrl: 'http://host.docker.internal:13305',
      loadedModels: ['Qwen3-0.6B-GGUF', 'Qwen3-Coder-30B'],
      residentModels: ['Qwen3-Coder-30B'],
    });

    expect(screen.getByTestId('lemonade-resident-model')).toHaveTextContent('Loaded: Qwen3-Coder-30B');
    expect(screen.queryByText(/Model available: Qwen3-0.6B-GGUF/)).not.toBeInTheDocument();

    rerender(
      <LemonadeSetupCard
        status={{
          ready: true,
          running: true,
          endpointUrl: 'http://host.docker.internal:13305',
          loadedModels: ['Qwen3-0.6B-GGUF', 'Qwen3-Coder-30B'],
          residentModels: [],
        }}
        checking={false}
        onRecheck={vi.fn()}
      />,
    );

    expect(screen.getByTestId('lemonade-downloaded-count')).toHaveTextContent('2 models downloaded');
  });

  // Audit NIT-2 of #1679: no block had a copy button, and the key script is seven lines an operator
  // had to select by hand out of a block that scrolls sideways.
  describe('copying a command', () => {
    const LINUX_REFUSED: LemonadeStatus = {
      ready: false,
      running: false,
      endpointUrl: 'http://host.docker.internal:13305',
      failureMode: 'refused',
      hostPlatform: 'linux',
    };
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

    afterEach(() => {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor);
      else Reflect.deleteProperty(document, 'execCommand');
      window.getSelection()?.removeAllRanges();
    });

    function setClipboard(value: unknown): void {
      Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
    }

    function setExecCommand(value: unknown): void {
      Object.defineProperty(document, 'execCommand', { value, configurable: true });
    }

    it('copies each block exactly as shown, line breaks included', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText });
      renderCard(LINUX_REFUSED);

      const script = screen.getByTestId('lemonade-api-key-script').textContent ?? '';
      expect(script.split('\n').length).toBeGreaterThan(1);
      fireEvent.click(screen.getByTestId('lemonade-api-key-script-copy'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(script));
      await waitFor(() => expect(screen.getByTestId('lemonade-api-key-script-copy')).toHaveAttribute('aria-label', 'Copied'));

      fireEvent.click(screen.getByTestId('lemonade-bind-command-copy'));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('lemonade config set host=0.0.0.0'));

      fireEvent.click(screen.getByTestId('lemonade-firewall-commands-copy'));
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          'sudo ufw allow from 172.16.0.0/12 to any port 13305 proto tcp\nsudo ufw allow from 10.128.0.0/9 to any port 13305 proto tcp',
        ),
      );
    });

    // Plain http on the LAN, how the Hub is often opened, is not a secure context: there is no
    // Clipboard API at all, and a button that silently did nothing there is the one it replaced.
    it('selects the command and says how to copy it where the page has no clipboard access', async () => {
      setClipboard(undefined);
      setExecCommand(vi.fn().mockReturnValue(false));
      renderCard(LINUX_REFUSED);

      fireEvent.click(screen.getByTestId('lemonade-bind-command-copy'));

      expect(await screen.findByText(/press Ctrl\+C/)).toBeInTheDocument();
      expect(window.getSelection()?.toString()).toBe('lemonade config set host=0.0.0.0');
    });

    it('copies the selection with the browser copy command where that still works', async () => {
      setClipboard(undefined);
      const execCommand = vi.fn().mockReturnValue(true);
      setExecCommand(execCommand);
      renderCard(LINUX_REFUSED);

      fireEvent.click(screen.getByTestId('lemonade-api-key-script-copy'));

      await waitFor(() => expect(screen.getByTestId('lemonade-api-key-script-copy')).toHaveAttribute('aria-label', 'Copied'));
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(window.getSelection()?.toString()).toBe(screen.getByTestId('lemonade-api-key-script').textContent);
      expect(screen.queryByText(/press Ctrl\+C/)).not.toBeInTheDocument();
    });

    it('falls back to the selection when the browser denies the clipboard write', async () => {
      setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError')) });
      setExecCommand(undefined);
      renderCard(LINUX_REFUSED);

      fireEvent.click(screen.getByTestId('lemonade-firewall-commands-copy'));

      expect(await screen.findByText(/press Ctrl\+C/)).toBeInTheDocument();
      expect(window.getSelection()?.toString()).toBe(screen.getByTestId('lemonade-firewall-commands').textContent);
    });
  });
});
