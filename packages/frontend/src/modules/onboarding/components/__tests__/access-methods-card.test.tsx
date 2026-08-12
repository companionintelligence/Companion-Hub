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
  it('hides the local-only note when remote access is already selected', () => {
    render(<AccessMethodsCard remoteAccess={['cloudflare']} onToggleAccess={vi.fn()} />);
    expect(screen.queryByTestId('access-local-baseline')).not.toBeInTheDocument();
    expect((screen.getByTestId('access-cloudflare') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('access-tailscale') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('access-this-computer')).not.toBeInTheDocument();
  });

  it('toggles VPN and Web access options', async () => {
    const user = userEvent.setup();
    const onToggleAccess = vi.fn();
    render(<AccessMethodsCard remoteAccess={['cloudflare']} onToggleAccess={onToggleAccess} />);

    await user.click(screen.getByTestId('access-tailscale'));
    expect(onToggleAccess).toHaveBeenCalledWith('tailscale');
  });

  it('renders inline Tailscale setup when provided', () => {
    render(
      <AccessMethodsCard
        remoteAccess={['cloudflare', 'tailscale']}
        onToggleAccess={vi.fn()}
        tailscaleSetup={<div data-testid="tailscale-inline">Tailscale</div>}
      />,
    );
    expect(screen.getByTestId('tailscale-inline')).toBeInTheDocument();
  });

  it('shows local-only copy when no remote access is selected', () => {
    render(<AccessMethodsCard remoteAccess={[]} onToggleAccess={vi.fn()} />);
    expect(screen.getByText('ONBOARDING_ACCESS_LOCAL_ONLY_NOTE')).toBeInTheDocument();
  });
});
