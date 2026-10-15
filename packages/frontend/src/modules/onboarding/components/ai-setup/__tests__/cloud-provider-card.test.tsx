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

  describe('a provider set to another server', () => {
    const PROXY_URL = 'https://llm-proxy.example.test/v1';

    it('shows where the requests of a provider with a saved key go', () => {
      render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true, baseUrl: PROXY_URL }]} />);

      expect(screen.getByTestId('cloud-base-url-openai')).toHaveTextContent(`Requests go to ${PROXY_URL}.`);
      expect(within(screen.getByTestId('cloud-provider-openai')).getByText('On')).toBeInTheDocument();
    });

    it('lists it without a key, says it needs one for that URL and offers Remove', async () => {
      const onUpdate = vi.fn();
      render(<Harness initial={[{ provider: 'anthropic', apiKey: '', enabled: true, baseUrl: PROXY_URL }]} onUpdate={onUpdate} />);
      const card = screen.getByTestId('cloud-provider-anthropic');

      expect(within(card).getByText('Needs key')).toBeInTheDocument();
      expect(screen.getByTestId('cloud-base-url-anthropic')).toHaveTextContent(`Needs a key for ${PROXY_URL}.`);

      await userEvent.click(within(card).getByRole('button', { name: 'Remove the Anthropic URL' }));

      expect(onUpdate).toHaveBeenLastCalledWith([{ provider: 'anthropic', apiKey: '', enabled: false, baseUrl: PROXY_URL, removed: true }]);
      expect(within(card).getByText('The URL is deleted when you save. A key entered after that goes to Anthropic.')).toBeInTheDocument();
      expect(screen.queryByTestId('cloud-base-url-anthropic')).toBeNull();
      expect(within(card).queryByRole('button')).toBeNull();
    });

    it('says the saved key goes with the URL when Remove is pressed', async () => {
      render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true, baseUrl: PROXY_URL }]} />);

      await userEvent.click(screen.getByRole('button', { name: 'Remove the saved OpenAI key' }));

      expect(screen.getByText('The saved key and URL are deleted when you save. A key entered after that goes to OpenAI.')).toBeInTheDocument();
    });

    it('shows a URL with markup in it as the text it is', () => {
      const odd = 'https://llm-proxy.example.test/<strong>v1</strong></url>';
      render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true, baseUrl: odd }]} />);

      expect(screen.getByTestId('cloud-base-url-openai')).toHaveTextContent(`Requests go to ${odd}.`);
    });

    it('names the URL a typed key goes to and keeps the URL with the key', async () => {
      const onUpdate = vi.fn();
      render(<Harness initial={[{ provider: 'anthropic', apiKey: '', enabled: true, baseUrl: PROXY_URL }]} onUpdate={onUpdate} />);

      await userEvent.type(screen.getByTestId('cloud-key-anthropic'), 'sk-ant-new');

      expect(screen.getByTestId('cloud-base-url-anthropic')).toHaveTextContent(`This key goes to ${PROXY_URL}.`);
      expect(onUpdate).toHaveBeenLastCalledWith([{ provider: 'anthropic', apiKey: 'sk-ant-new', enabled: true, baseUrl: PROXY_URL }]);
    });

    // The line sits below the field, so a screen reader in the field never said where the key goes.
    it('reads the URL out with the key field', async () => {
      render(<Harness initial={[{ provider: 'anthropic', apiKey: '', enabled: true, baseUrl: PROXY_URL }]} />);
      const field = screen.getByTestId('cloud-key-anthropic');

      expect(field).toHaveAccessibleDescription(`Needs a key for ${PROXY_URL}.`);
      await userEvent.type(field, 'sk-ant-new');
      expect(field).toHaveAccessibleDescription(`This key goes to ${PROXY_URL}.`);
      await userEvent.click(screen.getByRole('button', { name: 'Remove the Anthropic URL' }));
      expect(field).not.toHaveAttribute('aria-describedby');
    });

    it('takes a key typed after Remove as the key for that URL, not a removal', async () => {
      const onUpdate = vi.fn();
      render(<Harness initial={[{ provider: 'anthropic', apiKey: '', enabled: true, baseUrl: PROXY_URL }]} onUpdate={onUpdate} />);

      await userEvent.click(screen.getByRole('button', { name: 'Remove the Anthropic URL' }));
      await userEvent.type(screen.getByTestId('cloud-key-anthropic'), 'sk-ant-new');

      expect(onUpdate).toHaveBeenLastCalledWith([{ provider: 'anthropic', apiKey: 'sk-ant-new', enabled: true, baseUrl: PROXY_URL }]);
      expect(screen.getByTestId('cloud-base-url-anthropic')).toHaveTextContent(`This key goes to ${PROXY_URL}.`);
    });
  });

  it('shows no URL for a provider on its own server, saved or typed', async () => {
    render(<Harness initial={[{ provider: 'openai', apiKey: SAVED, enabled: true, stored: true }]} />);

    expect(screen.queryByTestId('cloud-base-url-openai')).toBeNull();
    await userEvent.type(screen.getByTestId('cloud-key-google'), 'AIza-new');
    expect(screen.queryByTestId('cloud-base-url-google')).toBeNull();
    expect(screen.queryByText('Needs key')).toBeNull();
  });

  it('leaves onboarding as it was: every provider optional and nothing to remove', () => {
    render(<Harness initial={[]} />);

    expect(screen.getAllByText('Optional')).toHaveLength(4);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
