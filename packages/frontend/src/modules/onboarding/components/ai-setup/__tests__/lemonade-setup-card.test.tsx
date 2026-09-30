import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LemonadeSetupCard } from '../lemonade-setup-card';

describe('LemonadeSetupCard', () => {
  it('explains how to let the Hub reach a localhost-only Lemonade, on the probed port', () => {
    render(
      <LemonadeSetupCard
        status={{ ready: false, running: false, endpointUrl: 'http://host.docker.internal:13400' }}
        checking={false}
        onRecheck={vi.fn()}
      />,
    );

    const hint = screen.getByTestId('lemonade-docker-access-hint');
    expect(hint).toHaveTextContent('lemonade config set host=0.0.0.0');
    expect(hint).toHaveTextContent('sudo systemctl restart lemond');
    expect(hint).toHaveTextContent('sudo ufw allow from 172.16.0.0/12 to any port 13400 proto tcp');
  });

  it('falls back to the default port when the endpoint is not a URL', () => {
    render(<LemonadeSetupCard status={{ ready: false, running: false, endpointUrl: '' }} checking={false} onRecheck={vi.fn()} />);

    expect(screen.getByTestId('lemonade-docker-access-hint')).toHaveTextContent('any port 13305 proto tcp');
  });

  it('does not show the hint once Lemonade is detected', () => {
    render(
      <LemonadeSetupCard
        status={{ ready: true, running: true, endpointUrl: 'http://host.docker.internal:13305' }}
        checking={false}
        onRecheck={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('lemonade-docker-access-hint')).not.toBeInTheDocument();
  });
});
