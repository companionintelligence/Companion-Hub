import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { OnboardingApp } from '../../helpers/types';
import { RecommendationsStep } from '../recommendations-step';

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    apps: [{ id: 'immich', name: 'Immich', urn: 'urn:store:immich', short_desc: 'Photos' }],
  }),
}));

vi.mock('@/lib/portal-alternatives', () => ({
  portalAlternativesQueryOptions: () => ({ queryKey: ['portal-alternatives'] }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: {
      photos: [{ proprietary: [{ name: 'Google Photos' }], alternatives: [{ appSlug: 'immich', name: 'Immich', icon: '' }] }],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// A parent that, like onboarding-page, stores the emitted selection in state AND re-creates the
// detectedServices / onChange references on every render. This is the worst case for the embedded
// emit effect: before the fix it looped forever (onChange -> setState -> re-render -> emit -> ...).
function Harness({ onEmit }: { onEmit: (apps: OnboardingApp[]) => void }) {
  const [, setSelected] = useState<OnboardingApp[]>([]);
  return (
    <RecommendationsStep
      embedded
      detectedServices={[]}
      onChange={(apps) => {
        onEmit(apps);
        setSelected(apps);
      }}
    />
  );
}

describe('RecommendationsStep (embedded emit)', () => {
  it('emits the selection once and does not loop on unchanged selections', () => {
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);

    // No runaway re-render loop: the empty selection is emitted exactly once.
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });

  it('re-emits only when the selected slugs actually change', async () => {
    const user = userEvent.setup();
    const onEmit = vi.fn();
    render(<Harness onEmit={onEmit} />);
    onEmit.mockClear();

    await user.click(screen.getByTestId('recommended-app'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([expect.objectContaining({ appSlug: 'immich', urn: 'urn:store:immich' })]);

    onEmit.mockClear();
    await user.click(screen.getByTestId('recommended-app'));
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit).toHaveBeenLastCalledWith([]);
  });
});
