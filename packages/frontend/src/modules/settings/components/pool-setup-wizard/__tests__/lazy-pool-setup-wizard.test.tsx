import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LazyPoolSetupWizard } from '../lazy-pool-setup-wizard';

const module = vi.hoisted(() => ({ evaluated: 0 }));

vi.mock('../pool-setup-wizard', () => {
  module.evaluated += 1;
  return { PoolSetupWizard: ({ startAt }: { startAt?: 'find' }) => <div data-testid="wizard-stub" data-start-at={startAt ?? ''} /> };
});

describe('LazyPoolSetupWizard', () => {
  it('does not load the wizard module while closed and renders it once open', async () => {
    const { rerender } = render(<LazyPoolSetupWizard open={false} onOpenChange={vi.fn()} />);

    expect(module.evaluated).toBe(0);
    expect(screen.queryByTestId('wizard-stub')).not.toBeInTheDocument();

    rerender(<LazyPoolSetupWizard open onOpenChange={vi.fn()} />);

    expect(await screen.findByTestId('wizard-stub')).toBeInTheDocument();
    expect(module.evaluated).toBe(1);
  });

  it('unmounts the wizard when closed again, so nothing keeps running for a guide nobody can see', async () => {
    const { rerender } = render(<LazyPoolSetupWizard open onOpenChange={vi.fn()} />);
    expect(await screen.findByTestId('wizard-stub')).toBeInTheDocument();

    rerender(<LazyPoolSetupWizard open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId('wizard-stub')).not.toBeInTheDocument();
  });

  it("hands startAt 'find' on to the wizard, so a host whose button says add a Hub opens on the scan", async () => {
    render(<LazyPoolSetupWizard open onOpenChange={vi.fn()} startAt="find" />);

    expect(await screen.findByTestId('wizard-stub')).toHaveAttribute('data-start-at', 'find');
  });

  it('hands the wizard no starting step when the host gives none, so it resumes wherever the pool is', async () => {
    render(<LazyPoolSetupWizard open onOpenChange={vi.fn()} />);

    expect(await screen.findByTestId('wizard-stub')).toHaveAttribute('data-start-at', '');
  });
});
