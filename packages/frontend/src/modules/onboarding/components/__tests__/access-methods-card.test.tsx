import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccessMethodsCard } from '../ai-setup/access-methods-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('AccessMethodsCard', () => {
  it('highlights this-computer when no remote access is selected', () => {
    render(<AccessMethodsCard remoteAccess={[]} onToggleAccess={vi.fn()} />);
    expect(screen.getByTestId('access-this-computer')).toBeInTheDocument();
    expect((screen.getByTestId('access-tailscale') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(false);
  });

  it('toggles VPN and Web access options', async () => {
    const user = userEvent.setup();
    const onToggleAccess = vi.fn();
    render(<AccessMethodsCard remoteAccess={[]} onToggleAccess={onToggleAccess} />);

    await user.click(screen.getByTestId('access-tailscale'));
    expect(onToggleAccess).toHaveBeenCalledWith('tailscale');
  });

  it('renders inline Tailscale setup when provided', () => {
    render(
      <AccessMethodsCard
        remoteAccess={['tailscale']}
        onToggleAccess={vi.fn()}
        tailscaleSetup={<div data-testid="tailscale-inline">Tailscale</div>}
      />,
    );
    expect(screen.getByTestId('tailscale-inline')).toBeInTheDocument();
  });
});
