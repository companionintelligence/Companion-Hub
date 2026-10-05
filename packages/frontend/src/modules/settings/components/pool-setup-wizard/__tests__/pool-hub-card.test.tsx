import { render, screen, within } from '@testing-library/react';
import { Check } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { PoolHubCard, type PoolPillTone, PoolHubSummary, PoolStatusPill } from '../pool-hub-card';

type SummaryProps = Parameters<typeof PoolHubSummary>[0];

const renderSummary = (props: Partial<SummaryProps> = {}) => render(<PoolHubSummary name="hub-b" {...props} />);
const summary = () => screen.getByTestId('pool-hub-summary');
/** The leading tile: the first drawing in the card, before any fact. */
const leadingTile = () => summary().querySelector('[aria-hidden="true"]') as HTMLElement;
const leadingIcon = () => leadingTile().querySelector('svg') as SVGElement;

describe('PoolHubSummary', () => {
  describe('name and address', () => {
    it('shows the name, and the tailnet name under it as the address', () => {
      renderSummary({ address: 'hub-b.example-tailnet.ts.net' });

      expect(within(summary()).getByText('hub-b')).toBeInTheDocument();
      expect(within(summary()).getByTitle('hub-b.example-tailnet.ts.net')).toHaveTextContent('hub-b.example-tailnet.ts.net');
    });

    it.each([[undefined], [null], ['']])('draws no address line for %j', (address) => {
      renderSummary({ address });

      expect(summary()).toHaveTextContent(/^hub-b$/);
      expect(screen.queryByTitle(/./)).not.toBeInTheDocument();
    });

    it('keeps the address whole when asked to wrap it, and lets it truncate otherwise', () => {
      const { rerender } = renderSummary({ address: 'hub-b.example-tailnet.ts.net', wrapAddress: true });
      expect(screen.getByTitle('hub-b.example-tailnet.ts.net')).toHaveClass('break-all');
      expect(screen.getByTitle('hub-b.example-tailnet.ts.net')).not.toHaveClass('truncate');

      rerender(<PoolHubSummary name="hub-b" address="hub-b.example-tailnet.ts.net" />);

      expect(screen.getByTitle('hub-b.example-tailnet.ts.net')).toHaveClass('truncate');
    });

    it('puts the trailing content on the header row with the name, not under the address', () => {
      renderSummary({ address: 'hub-b.example-tailnet.ts.net', trailing: <button type="button">Cancel request</button> });

      const name = within(summary()).getByText('hub-b');
      const action = within(summary()).getByRole('button', { name: 'Cancel request' });

      expect(name.parentElement).toBe(action.parentElement);
      expect(screen.getByTitle('hub-b.example-tailnet.ts.net').parentElement).not.toBe(action.parentElement);
    });
  });

  describe('the OS', () => {
    it.each([
      ['linux', 'Linux'],
      ['Linux', 'Linux'],
      ['macOS', 'macOS'],
      ['darwin', 'macOS'],
      ['windows', 'Windows'],
      ['iOS', 'Other'],
      ['freebsd', 'Other'],
    ])('shows %s as %s', (os, label) => {
      renderSummary({ os });

      expect(within(summary()).getByText(label)).toBeInTheDocument();
    });

    it.each([[undefined], [null], ['']])('shows no OS when it is %j', (os) => {
      renderSummary({ os });

      expect(summary()).toHaveTextContent(/^hub-b$/);
    });
  });

  describe('online', () => {
    it('says Online for true and Offline for false', () => {
      const { rerender } = renderSummary({ online: true });
      expect(within(summary()).getByText('Online')).toBeInTheDocument();
      expect(within(summary()).queryByText('Offline')).not.toBeInTheDocument();

      rerender(<PoolHubSummary name="hub-b" online={false} />);

      expect(within(summary()).getByText('Offline')).toBeInTheDocument();
      expect(within(summary()).queryByText('Online')).not.toBeInTheDocument();
    });

    it.each([[undefined], [null]])('says nothing when the tailnet did not say (%j), rather than guessing a state', (online) => {
      renderSummary({ online });

      expect(summary()).not.toHaveTextContent(/Online|Offline/);
    });
  });

  describe('the hardware tier', () => {
    it.each([
      ['high', 'High-end'],
      ['medium', 'Mid-range'],
      ['cpu-only', 'CPU only'],
    ])('labels %s as %s', (tier, label) => {
      renderSummary({ tier });

      expect(within(summary()).getByText(label)).toBeInTheDocument();
    });

    it.each([['server'], ['workstation'], ['High'], ['quantum'], [''], [null], [undefined]])(
      'shows no tier for %j, and never the raw value',
      (tier) => {
        renderSummary({ tier });

        expect(summary()).toHaveTextContent(/^hub-b$/);
      },
    );
  });

  describe('engines', () => {
    it('shows only the engines that are running', () => {
      renderSummary({
        engines: [
          { type: 'ollama', healthy: true },
          { type: 'vllm', healthy: false },
          { type: 'lemonade', healthy: true },
        ],
      });

      expect(within(summary()).getByText('ollama')).toBeInTheDocument();
      expect(within(summary()).getByText('lemonade')).toBeInTheDocument();
      expect(within(summary()).queryByText('vllm')).not.toBeInTheDocument();
      expect(within(summary()).queryByText('No engine running')).not.toBeInTheDocument();
    });

    it('shows one No engine running tag, and no engine names, when engines were reported and none is running', () => {
      renderSummary({
        engines: [
          { type: 'ollama', healthy: false },
          { type: 'vllm', healthy: false },
        ],
      });

      expect(within(summary()).getAllByText('No engine running')).toHaveLength(1);
      expect(within(summary()).queryByText('ollama')).not.toBeInTheDocument();
      expect(within(summary()).queryByText('vllm')).not.toBeInTheDocument();
    });

    it.each([[undefined], [[]]])('shows nothing, not even No engine running, when no engines were reported (%j)', (engines) => {
      renderSummary({ engines });

      expect(summary()).toHaveTextContent(/^hub-b$/);
    });
  });

  describe('models', () => {
    it.each([
      [0, '0 models'],
      [1, '1 model'],
      [5, '5 models'],
    ])('says %i as %s', (models, text) => {
      renderSummary({ models });

      expect(within(summary()).getByText(text)).toBeInTheDocument();
    });

    it('marks a Hub with no models in the warning colour, and one with models in the plain one', () => {
      const { rerender } = renderSummary({ models: 0 });
      expect(within(summary()).getByText('0 models')).toHaveClass('text-warning');

      rerender(<PoolHubSummary name="hub-b" models={5} />);

      expect(within(summary()).getByText('5 models')).not.toHaveClass('text-warning');
    });

    it.each([[undefined], [null]])('shows no count when it is %j, because a count nobody read is not zero', (models) => {
      renderSummary({ models });

      expect(summary()).not.toHaveTextContent(/models?/);
    });
  });

  describe('load', () => {
    it('says how many requests the Hub is serving only while it is serving some', () => {
      const { rerender } = renderSummary({ running: 3 });
      expect(within(summary()).getByText('3 running')).toBeInTheDocument();

      rerender(<PoolHubSummary name="hub-b" running={1} />);
      expect(within(summary()).getByText('1 running')).toBeInTheDocument();

      for (const running of [0, null, undefined]) {
        rerender(<PoolHubSummary name="hub-b" running={running} />);
        expect(summary()).not.toHaveTextContent(/running/);
      }
    });
  });

  describe('identity', () => {
    it('names a signed pairing and a token pairing in words, for assistive technology, and shows nothing when it is not given', () => {
      const { rerender } = renderSummary({ identity: 'signed' });
      expect(within(summary()).getByText('Signed identity')).toBeInTheDocument();
      expect(within(summary()).queryByText('Token pairing')).not.toBeInTheDocument();

      rerender(<PoolHubSummary name="hub-b" identity="token" />);
      expect(within(summary()).getByText('Token pairing')).toBeInTheDocument();
      expect(within(summary()).queryByText('Signed identity')).not.toBeInTheDocument();

      for (const identity of [null, undefined]) {
        rerender(<PoolHubSummary name="hub-b" identity={identity} />);
        expect(summary()).not.toHaveTextContent(/Signed identity|Token pairing/);
      }
    });
  });

  describe('the leading tile', () => {
    it.each([
      ['high', 'lucide-zap'],
      ['medium', 'lucide-gauge'],
      ['cpu-only', 'lucide-cpu'],
    ])('shows the %s tier icon when the Hub has a valid tier, whatever its OS', (tier, icon) => {
      renderSummary({ tier, os: 'macOS' });

      expect(leadingIcon()).toHaveClass(icon);
    });

    it.each([
      ['linux', 'lucide-server'],
      ['macOS', 'lucide-laptop'],
      ['windows', 'lucide-monitor'],
      ['iOS', 'lucide-hard-drive'],
    ])('falls back to the icon of the machine (%s) when the Hub has no valid tier', (os, icon) => {
      renderSummary({ os, tier: 'server' });

      expect(leadingIcon()).toHaveClass(icon);
    });

    it('shows the generic machine icon when nothing at all is known', () => {
      renderSummary();

      expect(leadingIcon()).toHaveClass('lucide-hard-drive');
    });

    it('gives each tier its own colour, so how much a Hub can take reads at a glance', () => {
      const looks = (['high', 'medium', 'cpu-only'] as const).map((tier) => {
        const { unmount } = renderSummary({ tier });
        const look = leadingTile().className;
        unmount();
        return look;
      });

      expect(new Set(looks).size).toBe(3);
    });

    it('is decoration only: hidden from assistive technology, with the facts carried by text', () => {
      renderSummary({ tier: 'high', os: 'linux' });

      expect(leadingTile()).toHaveAttribute('aria-hidden', 'true');
      expect(within(summary()).getByText('High-end')).toBeInTheDocument();
    });
  });

  it('draws only the name when nothing else is known', () => {
    renderSummary();

    expect(summary()).toHaveTextContent(/^hub-b$/);
  });

  it('draws every fact it was given together', () => {
    renderSummary({
      address: 'hub-b.example-tailnet.ts.net',
      os: 'linux',
      online: true,
      tier: 'high',
      engines: [
        { type: 'ollama', healthy: true },
        { type: 'vllm', healthy: false },
      ],
      models: 4,
      running: 2,
      identity: 'signed',
    });

    for (const text of ['hub-b', 'Linux', 'Online', 'High-end', 'ollama', '4 models', '2 running', 'Signed identity']) {
      expect(within(summary()).getByText(text), text).toBeInTheDocument();
    }
    expect(within(summary()).queryByText('vllm')).not.toBeInTheDocument();
  });
});

describe('PoolHubCard', () => {
  it('is a list item carrying its test id and state, with the summary first and its children after', () => {
    render(
      <ul>
        <PoolHubCard name="hub-b" data-testid="card" data-state="verified">
          <button type="button">Unpair</button>
        </PoolHubCard>
      </ul>,
    );

    const card = screen.getByTestId('card');

    expect(card.tagName).toBe('LI');
    expect(card).toHaveAttribute('data-state', 'verified');
    expect(card.children[0]).toBe(within(card).getByTestId('pool-hub-summary'));
    expect(card.children[1]).toBe(within(card).getByRole('button', { name: 'Unpair' }));
  });

  it('passes the summary props through to the summary', () => {
    render(
      <ul>
        <PoolHubCard name="hub-b" address="hub-b.example-tailnet.ts.net" os="linux" online tier="medium" models={2} data-testid="card" />
      </ul>,
    );

    const card = within(screen.getByTestId('card'));

    for (const text of ['hub-b', 'Linux', 'Online', 'Mid-range', '2 models']) {
      expect(card.getByText(text), text).toBeInTheDocument();
    }
  });

  it.each([
    ['success', 'border-success/30'],
    ['warning', 'border-warning/40'],
    ['danger', 'border-destructive/40'],
  ] as const)('marks the %s tone with its border', (tone, border) => {
    render(
      <ul>
        <PoolHubCard name="hub-b" tone={tone} data-testid="card" />
      </ul>,
    );

    expect(screen.getByTestId('card')).toHaveClass(border);
  });

  it('draws the default tone with none of the coloured borders, and merges an extra class', () => {
    render(
      <ul>
        <PoolHubCard name="hub-b" className="extra" data-testid="card" />
      </ul>,
    );

    const card = screen.getByTestId('card');

    expect(card).toHaveClass('extra');
    expect(card.className).not.toMatch(/border-(success|warning|destructive)/);
  });
});

describe('PoolStatusPill', () => {
  it('says the state in words', () => {
    render(<PoolStatusPill tone="success">Verified</PoolStatusPill>);

    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('draws no glyph unless given an icon or told to spin, and hides any glyph from assistive technology', () => {
    const { container, rerender } = render(<PoolStatusPill tone="muted">Off</PoolStatusPill>);
    expect(container.querySelector('svg')).toBeNull();

    rerender(
      <PoolStatusPill tone="success" icon={Check}>
        Verified
      </PoolStatusPill>,
    );
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).not.toHaveClass('animate-spin');
  });

  it('shows a spinner instead of the icon when it spins, never both', () => {
    const { container } = render(
      <PoolStatusPill tone="muted" icon={Check} spin>
        Reading…
      </PoolStatusPill>,
    );

    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelector('svg')).toHaveClass('animate-spin');
  });

  it('looks different for each tone', () => {
    const tones: PoolPillTone[] = ['success', 'warning', 'danger', 'muted'];
    const looks = tones.map((tone) => {
      const { container, unmount } = render(<PoolStatusPill tone={tone}>{tone}</PoolStatusPill>);
      const look = (container.firstElementChild as HTMLElement).className;
      unmount();
      return look;
    });

    expect(new Set(looks).size).toBe(tones.length);
  });
});
