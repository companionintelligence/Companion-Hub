import { fireEvent, render, screen } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { QrCode } from './qr-code';

const VALUE = 'https://hub.example.com/pair?code=ABC123';

describe('<QrCode />', () => {
  it('renders the fallback payload as selectable text', () => {
    // arrange
    render(<QrCode value={VALUE} fallback={VALUE} />);

    // assert — a camera that will not focus must never dead-end the user
    expect(screen.getByText(VALUE)).toBeInTheDocument();
  });

  it('renders the caption above the code', () => {
    render(<QrCode value={VALUE} fallback={VALUE} caption="Scan with your phone" />);

    expect(screen.getByText('Scan with your phone')).toBeInTheDocument();
  });

  it('keeps modules dark on a light plate regardless of theme', () => {
    // arrange
    const { container } = render(<QrCode value={VALUE} fallback={VALUE} />);
    const paths = container.querySelectorAll('svg path');

    // assert — scanners expect dark-on-light, so these colours are theme-invariant
    expect(paths[0]).toHaveAttribute('fill', '#ffffff');
    expect(paths[1]).toHaveAttribute('fill', '#0b0f19');
  });

  describe('mark', () => {
    it('draws the mark and excavates the modules underneath it', () => {
      // arrange — same level on both sides, so the only difference is the excavation
      const { container: withMark } = render(<QrCode value={VALUE} fallback={VALUE} mark />);
      const { container: withoutMark } = render(<QrCode value={VALUE} fallback={VALUE} level="H" />);

      const modulePath = (root: HTMLElement) => root.querySelectorAll('svg path')[1]?.getAttribute('d');

      // assert — the mark is painted, and the modules it covers are cleared rather
      // than left under it (excavate), which is what keeps the code decodable
      expect(withMark.querySelector('image')).toBeInTheDocument();
      expect(withoutMark.querySelector('image')).not.toBeInTheDocument();
      expect(modulePath(withMark)).not.toEqual(modulePath(withoutMark));
    });

    it('forces error correction to H so the occluded modules stay recoverable', () => {
      // A code at level H reserves ~30% of its capacity for recovery, which is what
      // pays for the logo; at the default M the same occlusion can push it past the
      // budget. Version (and therefore module count) is the observable proxy.
      const { container: withMark } = render(<QrCode value={VALUE} fallback={VALUE} mark />);
      const { container: withoutMark } = render(<QrCode value={VALUE} fallback={VALUE} level="M" />);

      const modules = (root: HTMLElement) => root.querySelector('svg')?.getAttribute('viewBox');

      expect(modules(withMark)).not.toEqual(modules(withoutMark));
    });
  });

  describe('bare', () => {
    it('drops the plate padding and the printed fallback text', () => {
      const { container } = render(<QrCode value={VALUE} fallback={VALUE} bare />);

      expect(screen.queryByText(VALUE)).not.toBeInTheDocument();
      expect(container.querySelector('.p-3')).not.toBeInTheDocument();
      expect(container.querySelector('.p-0')).toBeInTheDocument();
    });

    it('still carries the payload as the accessible name', () => {
      // The fallback text is gone from the page, but the payload must stay
      // reachable for assistive tech — otherwise `bare` silently reintroduces
      // the dead end `fallback` exists to prevent, just for screen readers.
      render(<QrCode value={VALUE} fallback={VALUE} bare />);

      expect(screen.getByRole('img', { name: VALUE })).toBeInTheDocument();
    });

    it('renders the caption and the fallback by default', () => {
      render(<QrCode value={VALUE} fallback={VALUE} />);

      expect(screen.getByText(VALUE)).toBeInTheDocument();
    });
  });

  describe('reveal', () => {
    it('hides the code and the payload until asked for', () => {
      render(<QrCode value={VALUE} fallback={VALUE} reveal />);

      expect(screen.queryByText(VALUE)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show code' })).toBeInTheDocument();
    });

    it('reveals the payload on request and can hide it again', () => {
      // arrange
      render(<QrCode value={VALUE} fallback={VALUE} reveal />);

      // act
      fireEvent.click(screen.getByRole('button', { name: 'Show code' }));

      // assert
      expect(screen.getByText(VALUE)).toBeInTheDocument();

      // act
      fireEvent.click(screen.getByRole('button', { name: 'Hide code' }));

      // assert
      expect(screen.queryByText(VALUE)).not.toBeInTheDocument();
    });

    it('shows the payload immediately when reveal is not set', () => {
      render(<QrCode value={VALUE} fallback={VALUE} />);

      expect(screen.queryByRole('button', { name: 'Show code' })).not.toBeInTheDocument();
      expect(screen.getByText(VALUE)).toBeInTheDocument();
    });
  });
});
