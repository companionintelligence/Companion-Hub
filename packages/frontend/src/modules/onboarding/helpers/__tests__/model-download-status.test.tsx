import { render, screen } from '@/tests/test-utils';
import { describe, expect, it } from 'vitest';
import { ModelDownloadFooterSummary, ModelDownloadStatus } from '../../components/model-download-status';
import type { ModelPullOrchestratorResult } from '../use-model-pull-orchestrator';

const basePullState: ModelPullOrchestratorResult = {
  progressById: {},
  errorsById: {},
  isPulling: false,
  activeCount: 0,
  completedCount: 0,
  averageActiveProgress: 0,
};

describe('ModelDownloadStatus', () => {
  it('hides when all selected models are already installed', () => {
    const { container } = render(
      <ModelDownloadStatus selectedModelIds={['phi-4-mini']} installedCatalogIds={['phi-4-mini']} pullState={basePullState} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders progress rows for models needing download', () => {
    render(
      <ModelDownloadStatus
        selectedModelIds={['phi-4-mini', 'llama3-3-70b']}
        installedCatalogIds={[]}
        pullState={{
          ...basePullState,
          progressById: { 'phi-4-mini': 37, 'llama3-3-70b': 100 },
          isPulling: true,
          activeCount: 1,
          completedCount: 1,
          averageActiveProgress: 37,
        }}
      />,
    );

    expect(screen.getByTestId('model-download-status')).toBeInTheDocument();
    expect(screen.getByTestId('model-download-row-phi-4-mini')).toBeInTheDocument();
    expect(screen.getByTestId('model-download-progress-phi-4-mini')).toHaveStyle({ width: '37%' });
  });

  it('shows footer summary while downloads are active', () => {
    render(
      <ModelDownloadFooterSummary
        pullState={{
          ...basePullState,
          isPulling: true,
          activeCount: 2,
          averageActiveProgress: 34,
        }}
      />,
    );

    expect(screen.getByTestId('model-download-footer-summary')).toHaveTextContent('2');
    expect(screen.getByTestId('model-download-footer-summary')).toHaveTextContent('34%');
  });
});
