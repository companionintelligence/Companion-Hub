import { fireEvent, render, screen } from '@/tests/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsTerminal } from './logs-terminal';

const mockUseLocalStorage = vi.fn();

vi.mock('@uidotdev/usehooks', () => ({
  useLocalStorage: (...args: unknown[]) => mockUseLocalStorage(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('LogsTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLocalStorage.mockImplementation((_key: string, defaultValue: boolean) => [defaultValue, vi.fn()]);
  });

  it('updates max lines from numeric input values', () => {
    const onMaxLinesChange = vi.fn();

    render(<LogsTerminal logs={[]} maxLines={300} onMaxLinesChange={onMaxLinesChange} />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '25' } });

    expect(onMaxLinesChange).toHaveBeenCalledWith(25);
  });

  it('ignores cleared max-lines input values and enforces a minimum of 1', () => {
    const onMaxLinesChange = vi.fn();

    render(<LogsTerminal logs={[]} maxLines={300} onMaxLinesChange={onMaxLinesChange} />);

    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('min', '1');

    fireEvent.change(input, { target: { value: '' } });

    expect(onMaxLinesChange).not.toHaveBeenCalled();
  });

  it('keeps the themed scrollbar hook on the log terminal element', () => {
    const onMaxLinesChange = vi.fn();

    const { container } = render(<LogsTerminal logs={[]} maxLines={300} onMaxLinesChange={onMaxLinesChange} />);

    expect(container.querySelector('#log-terminal')).toHaveClass('log-terminal');
  });
});
