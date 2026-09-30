import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    expect(script).toHaveTextContent('Environment=LEMONADE_API_KEY=%s');
    expect(script).toHaveTextContent('Add to the Hub .env, then recreate the Hub: LEMONADE_API_KEY=$KEY');
    // `lemond` from Lemonade 11 on, `lemonade-server` on the 10.x packages the fleet runs.
    expect(script).toHaveTextContent('systemctl cat lemond');
    expect(script).toHaveTextContent('echo lemonade-server');
    expect(screen.getByTestId('lemonade-api-key-guidance')).toHaveTextContent(/lemond on Lemonade 11 and later and lemonade-server on Lemonade 10/);
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
});
