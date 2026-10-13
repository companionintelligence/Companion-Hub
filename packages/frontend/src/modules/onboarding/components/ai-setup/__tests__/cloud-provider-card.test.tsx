import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CloudProviderInput } from '../../../helpers/ai-setup-types';
import { CloudProviderCard } from '../cloud-provider-card';

/** What Settings > AI shows in place of a key the Hub already holds. */
const SAVED = '••••••••';

/** The card as Settings > AI holds it: every change it reports comes back in as its providers. */
function Harness({ initial, onUpdate }: { initial: CloudProviderInput[]; onUpdate?: (providers: CloudProviderInput[]) => void }) {
  const [providers, setProviders] = useState(initial);
  return (
    <CloudProviderCard
      providers={providers}
      insufficientHardware={false}
      onUpdate={(next) => {
        onUpdate?.(next);
        setProviders(next);
      }}
    />
  );
}

describe('CloudProviderCard', () => {
  // A provider turned off through the API still showed its masked key and "Optional", with nothing
  // saying the Hub had stopped using it.
  it('says whether a saved key is on or off', () => {
    render(
      <Harness
        initial={[
          { provider: 'openai', apiKey: SAVED, enabled: false, stored: true },
          { provider: 'anthropic', apiKey: SAVED, enabled: true, stored: true },
        ]}
      />,
    );

    expect(within(screen.getByTestId('cloud-provider-openai')).getByText('Off')).toBeInTheDocument();
    expect(within(screen.getByTestId('cloud-provider-anthropic')).getByText('On')).toBeInTheDocument();
    expect(within(screen.getByTestId('cloud-provider-google')).getByText('Optional')).toBeInTheDocument();
  });

  it('removes a saved key with one click and says the Hub deletes it on save', async () => {
    const onUpdate = vi.fn();
    render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true }]} onUpdate={onUpdate} />);
    const card = screen.getByTestId('cloud-provider-openai');

    await userEvent.click(within(card).getByRole('button', { name: 'Remove the saved OpenAI key' }));

    expect(onUpdate).toHaveBeenLastCalledWith([{ provider: 'openai', apiKey: '', enabled: false, stored: true }]);
    expect(within(card).getByTestId('cloud-key-openai')).toHaveValue('');
    expect(within(card).getByText('The saved key is deleted when you save.')).toBeInTheDocument();
  });

  it('treats a saved key cleared by hand as a removal too', async () => {
    const onUpdate = vi.fn();
    render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true }]} onUpdate={onUpdate} />);

    await userEvent.clear(screen.getByTestId('cloud-key-openai'));

    expect(onUpdate).toHaveBeenLastCalledWith([{ provider: 'openai', apiKey: '', enabled: false, stored: true }]);
    expect(screen.getByText('The saved key is deleted when you save.')).toBeInTheDocument();
  });

  it('leaves onboarding as it was: every provider optional and nothing to remove', () => {
    render(<Harness initial={[]} />);

    expect(screen.getAllByText('Optional')).toHaveLength(4);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
