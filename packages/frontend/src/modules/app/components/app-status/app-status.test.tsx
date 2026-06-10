import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { AppStatus } from './app-status';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (key === 'APP_STATUS_INSTALLING' ? 'Installing' : (fallback ?? key)),
  }),
}));

describe('AppStatus', () => {
  it('renders the translated installing label', () => {
    render(<AppStatus status="installing" />);

    expect(screen.getByText('Installing')).toBeInTheDocument();
  });

  it('falls back to a humanized label when a status key is missing', () => {
    render(<AppStatus status={'install_failed' as never} />);

    expect(screen.getByText('Install Failed')).toBeInTheDocument();
  });
});
