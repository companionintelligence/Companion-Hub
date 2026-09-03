import { render, screen } from '@/tests/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { SelectAppsStep } from '../select-apps-step';
import type { OnboardingApp } from '../../helpers/types';

const app: OnboardingApp = {
  appSlug: 'nextcloud',
  name: 'Nextcloud',
  icon: 'https://example.com/icon.png',
  category: 'productivity',
  replacesNames: ['Dropbox'],
};

describe('SelectAppsStep', () => {
  it('updates the displayed list when selectedApps prop changes after mount', () => {
    const onConfirm = vi.fn();
    const onBack = vi.fn();

    const { rerender } = render(<SelectAppsStep selectedApps={[]} onConfirm={onConfirm} onBack={onBack} />);
    expect(screen.getByText('No apps selected.')).toBeInTheDocument();

    rerender(<SelectAppsStep selectedApps={[app]} onConfirm={onConfirm} onBack={onBack} />);

    expect(screen.getByText('Nextcloud')).toBeInTheDocument();
    expect(screen.queryByText('No apps selected.')).not.toBeInTheDocument();
  });
});
