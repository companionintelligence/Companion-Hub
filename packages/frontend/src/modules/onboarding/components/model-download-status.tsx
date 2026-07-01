import { Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WizardCard, WizardHeader } from './wizard-ui';
import type { ModelPullOrchestratorResult } from '../helpers/use-model-pull-orchestrator';

interface ModelDownloadStatusProps {
  selectedModelIds: string[];
  installedCatalogIds: string[];
  pullState: ModelPullOrchestratorResult;
}

function isComplete(modelId: string, installedSet: Set<string>, pullState: ModelPullOrchestratorResult): boolean {
  return installedSet.has(modelId) || pullState.progressById[modelId] === 100;
}

export function ModelDownloadStatus({ selectedModelIds, installedCatalogIds, pullState }: ModelDownloadStatusProps) {
  const { t } = useTranslation();
  const installedSet = new Set(installedCatalogIds);
  const modelsToShow = selectedModelIds.filter((id) => !installedSet.has(id));

  if (modelsToShow.length === 0) {
    return null;
  }

  const allComplete = modelsToShow.every((id) => isComplete(id, installedSet, pullState));

  if (allComplete) {
    return null;
  }

  return (
    <WizardCard>
      <div data-testid="model-download-status">
        <WizardHeader icon={<Download />} title={t('ONBOARDING_MODEL_DOWNLOADS_TITLE')} description={t('ONBOARDING_MODEL_DOWNLOADS_DESC')} />
        <div className="space-y-3">
          {modelsToShow.map((modelId) => {
            const error = pullState.errorsById[modelId];
            const progress = pullState.progressById[modelId];
            const complete = isComplete(modelId, installedSet, pullState);
            const downloading = !complete && !error && progress !== undefined && progress < 100;
            const waiting = !complete && !error && progress === undefined;

            return (
              <div key={modelId} className="space-y-1.5" data-testid={`model-download-row-${modelId}`}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium truncate">{modelId}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
                    {error ? (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
                        {t('ONBOARDING_MODEL_DOWNLOAD_STATUS_FAILED')}
                      </>
                    ) : complete ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                        {t('ONBOARDING_MODEL_DOWNLOAD_STATUS_COMPLETE')}
                      </>
                    ) : downloading ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('ONBOARDING_MODEL_DOWNLOAD_STATUS_DOWNLOADING', { percent: progress ?? 0 })}
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {waiting ? t('ONBOARDING_INSTALL_STATUS_DOWNLOADING') : t('ONBOARDING_MODEL_DOWNLOAD_STATUS_DOWNLOADING', { percent: 0 })}
                      </>
                    )}
                  </span>
                </div>
                {!error && !complete && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-1.5 rounded-full bg-primary transition-all duration-500 ease-out"
                      style={{ width: `${Math.max(progress ?? 0, 2)}%` }}
                      data-testid={`model-download-progress-${modelId}`}
                    />
                  </div>
                )}
                {error && <p className="text-xs text-destructive truncate">{error}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </WizardCard>
  );
}

export function ModelDownloadFooterSummary({ pullState }: { pullState: ModelPullOrchestratorResult }) {
  const { t } = useTranslation();

  if (!pullState.isPulling || pullState.activeCount === 0) {
    return null;
  }

  return (
    <span className="text-sm text-muted-foreground" data-testid="model-download-footer-summary">
      {t('ONBOARDING_MODEL_DOWNLOADS_SUMMARY', {
        count: pullState.activeCount,
        percent: pullState.averageActiveProgress,
      })}
    </span>
  );
}
