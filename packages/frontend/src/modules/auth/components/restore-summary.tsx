import { Button } from '@/components/ui/Button';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { describeRestoreFailure, isSettlingStatus, storePathFor, type RestoreSummary as RestoreSummaryData } from '../helpers/restore-status';

interface RestoreSummaryProps {
  summary: RestoreSummaryData;
  /** Leaves the restore page for `to`, recording that the restore was seen. */
  onLeave: (to?: string) => void;
}

function StatusLabel({ status }: { status: string }) {
  const { t, i18n } = useTranslation();
  const key = `APP_STATUS_${status.toUpperCase()}`;
  const label = i18n.exists(key) ? t(key) : status;

  if (isSettlingStatus(status)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        {label}
      </span>
    );
  }

  const tone =
    status === 'running' ? 'text-success' : status === 'install_failed' || status === 'missing' ? 'text-destructive' : 'text-muted-foreground';
  return <span className={`text-xs ${tone}`}>{label}</span>;
}

/**
 * What the restore after this pairing brought back and what it could not, shown once to whoever signs
 * in next instead of the setup wizard. Each app that was not restored says why and links to its App
 * Store page where its install form can be filled in.
 */
export function RestoreSummary({ summary, onLeave }: RestoreSummaryProps) {
  const { t, i18n } = useTranslation();
  const exists = (key: string) => i18n.exists(key);
  const aiApps = summary.restored.filter((app) => app.usesAi).map((app) => app.name);
  const nameList = (names: string[]) =>
    names.length > 1 ? t('RESTORE_APPS_NAME_LIST', { names: names.slice(0, -1).join(', '), last: names[names.length - 1] }) : (names[0] ?? '');

  return (
    <div className="w-full max-w-2xl space-y-4" data-testid="restore-summary">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">
          {summary.restored.length > 0 ? t('RESTORE_APPS_DONE_TITLE') : t('RESTORE_APPS_DONE_TITLE_NONE')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t('RESTORE_APPS_DONE_DESCRIPTION')}</p>
      </div>

      {summary.notRestored.length > 0 ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4" data-testid="restore-summary-not-restored">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <TriangleAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            {t('RESTORE_APPS_NOT_RESTORED_TITLE')}
          </p>
          <ul className="mt-3 space-y-3 text-sm">
            {summary.notRestored.map((failure) => {
              const storePath = storePathFor(failure.urn);
              return (
                <li key={`${failure.name}-${failure.reason}`} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{failure.name}</p>
                    <p className="text-muted-foreground">{describeRestoreFailure(t, exists, failure)}</p>
                  </div>
                  {storePath ? (
                    <Button intent="secondary" size="sm" className="shrink-0" onClick={() => onLeave(storePath)}>
                      {t('RESTORE_APPS_OPEN_IN_STORE')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {summary.restored.length > 0 ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-foreground">{t('RESTORE_APPS_RESTORED_TITLE')}</p>
          <ul className="mt-3 space-y-2">
            {summary.restored.map((app) => (
              <li key={app.urn} className="flex items-center justify-between gap-3 text-sm" data-testid={`restore-summary-app-${app.urn}`}>
                <span className="font-medium text-foreground">{app.name}</span>
                <StatusLabel status={app.status} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {aiApps.length > 0 && !summary.aiModelChosen ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>{t('RESTORE_APPS_AI_DEFAULT_NOTE', { apps: nameList(aiApps), count: aiApps.length })}</p>
          <Button intent="secondary" size="sm" className="shrink-0" onClick={() => onLeave('/settings?tab=ai')}>
            {t('RESTORE_APPS_CHOOSE_MODEL')}
          </Button>
        </div>
      ) : null}

      <Button intent="primary" className="w-full" onClick={() => onLeave()} data-testid="restore-summary-continue">
        {t('RESTORE_APPS_CONTINUE_IN_BACKGROUND')}
      </Button>
    </div>
  );
}
