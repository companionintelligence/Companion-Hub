import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelContextPlan } from '@ci-hub/common/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key) }),
}));
vi.mock('@/api-client/@tanstack/react-query.gen', () => ({ getInstalledAppsOptions: () => ({ queryKey: ['installedApps'] }) }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { installed: [{ info: { urn: 'ci-hermes:ci-marketplace', name: 'Hermes' } }] } }),
}));

import { ModelContextNote, formatTokens } from './model-context-note';

const plan = (overrides: Partial<ModelContextPlan> = {}): ModelContextPlan => ({
  window: 65_536,
  kvCacheType: 'f16',
  basis: 'measured',
  kvCacheMeasured: false,
  floor: null,
  ...overrides,
});

describe('formatTokens', () => {
  it('says windows the way people say them', () => {
    expect(formatTokens(65_536)).toBe('64k');
    expect(formatTokens(32_768)).toBe('32k');
    expect(formatTokens(64_000)).toBe('64k');
    expect(formatTokens(8_192)).toBe('8k');
    expect(formatTokens(40_000)).toBe('40k');
    expect(formatTokens(50_500)).toBe('49.3k');
  });
});

describe('ModelContextNote', () => {
  it('shows the window, and nothing more for a 16-bit model with no app floor', () => {
    render(<ModelContextNote plan={plan()} />);
    expect(screen.getByTestId('model-context-note').textContent).toContain('MODEL_CONTEXT_WINDOW {"window":"64k"}');
    expect(screen.queryByTestId('model-context-8bit')).toBeNull();
    expect(screen.queryByTestId('model-context-floor-unmet')).toBeNull();
  });

  it('says when the Hub would use the 8-bit cache, naming the app it is for', () => {
    render(<ModelContextNote plan={plan({ kvCacheType: 'q8_0', floor: { minContextLength: 64_000, apps: ['ci-hermes'], met: true } })} />);
    const badge = screen.getByTestId('model-context-8bit');
    expect(badge.textContent).toContain('MODEL_CONTEXT_8BIT');
    expect(badge.getAttribute('title')).toContain('"apps":"Hermes","floor":"64k"');
  });

  it('warns when the model cannot reach an installed app floor here', () => {
    render(<ModelContextNote plan={plan({ window: 32_768, floor: { minContextLength: 64_000, apps: ['ci-hermes'], met: false } })} />);
    expect(screen.getByTestId('model-context-floor-unmet').textContent).toContain(
      'MODEL_CONTEXT_FLOOR_UNMET {"apps":"Hermes","floor":"64k","window":"32k"}',
    );
  });

  it('marks an estimate, says when nothing fits, and renders nothing without a plan', () => {
    const { container, rerender } = render(<ModelContextNote plan={plan({ basis: 'estimated' })} />);
    expect(container.textContent).toContain('MODEL_CONTEXT_ESTIMATED');

    rerender(<ModelContextNote plan={plan({ window: null })} />);
    expect(container.textContent).toContain('MODEL_CONTEXT_NONE');

    rerender(<ModelContextNote plan={undefined} />);
    expect(container.textContent).toBe('');
  });
});
