import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompleteStep } from '../complete-step';
import type { InstallSummary } from '../../helpers/types';

const mockNavigate = vi.fn();

vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/lib/api-fetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/context/app-context', () => ({
  useAppContext: () => ({
    refreshAppContext: vi.fn().mockResolvedValue(undefined),
  }),
}));

function makeSummary(running: number, incomplete: number, failed: number): InstallSummary {
  const results = [];
  for (let i = 0; i < running; i++) {
    results.push({
      app: { appSlug: `run-${i}`, name: `Running ${i}`, icon: '', category: '', replacesNames: [] },
      status: 'running' as const,
    });
  }
  for (let i = 0; i < incomplete; i++) {
    results.push({
      app: { appSlug: `inc-${i}`, name: `Incomplete ${i}`, icon: '', category: '', replacesNames: [] },
      status: 'incomplete' as const,
      error: 'Install started but not yet confirmed running',
    });
  }
  for (let i = 0; i < failed; i++) {
    results.push({
      app: { appSlug: `fail-${i}`, name: `Failed ${i}`, icon: '', category: '', replacesNames: [] },
      status: 'failed' as const,
      error: 'HTTP 500',
    });
  }
  return {
    results,
    running,
    incomplete,
    failed,
    total: running + incomplete + failed,
  };
}

describe('CompleteStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Your Hub Is Ready" when no apps were installed (skipped)', () => {
    render(<CompleteStep />);

    expect(screen.getByTestId('complete-heading')).toHaveTextContent('Your Hub Is Ready');
    expect(screen.getByTestId('complete-body')).toHaveTextContent('install apps anytime from the App Store');
  });

  it('shows "All Apps Running" when every app is confirmed running', () => {
    render(<CompleteStep installSummary={makeSummary(3, 0, 0)} />);

    expect(screen.getByTestId('complete-heading')).toHaveTextContent('All Apps Running');
    expect(screen.getByTestId('complete-body')).toHaveTextContent('3 apps are confirmed running');
  });

  it('shows truthful mixed summary when some apps are incomplete', () => {
    render(<CompleteStep installSummary={makeSummary(1, 1, 1)} />);

    const body = screen.getByTestId('complete-body');
    expect(body).toHaveTextContent('1 running');
    expect(body).toHaveTextContent('1 still starting');
    expect(body).toHaveTextContent('1 failed');
  });

  it('shows "Installation Issues" when all installs failed', () => {
    render(<CompleteStep installSummary={makeSummary(0, 0, 2)} />);

    expect(screen.getByTestId('complete-heading')).toHaveTextContent('Installation Issues');
  });

  it('shows incomplete-only summary when no running and no failed', () => {
    render(<CompleteStep installSummary={makeSummary(0, 2, 0)} />);

    const body = screen.getByTestId('complete-body');
    expect(body).toHaveTextContent('2 still starting');
    expect(body).not.toHaveTextContent('running');
    expect(body).not.toHaveTextContent('failed');
  });

  it('CTA button says "Go to App Store"', () => {
    render(<CompleteStep installSummary={makeSummary(1, 0, 0)} />);

    expect(screen.getByTestId('complete-cta')).toHaveTextContent('Go to App Store');
  });

  it('navigates to /app-store on click', async () => {
    render(<CompleteStep installSummary={makeSummary(1, 0, 0)} />);

    await userEvent.click(screen.getByTestId('complete-cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/app-store', { replace: true });
  });

  it('singular grammar for single app', () => {
    render(<CompleteStep installSummary={makeSummary(1, 0, 0)} />);

    expect(screen.getByTestId('complete-body')).toHaveTextContent('1 app is confirmed running');
  });
});
