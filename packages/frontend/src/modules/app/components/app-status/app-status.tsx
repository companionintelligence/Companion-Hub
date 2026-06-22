import type { AppStatus as AppStatusType } from '@/types/app.types';
import { cn } from '@/lib/utils';
import type { AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import type React from 'react';
import { useTranslation } from 'react-i18next';

type AppStatusVariant = 'inline' | 'pill';

const friendlyStatusLabels: Partial<Record<AppStatusType, string>> = {
  installing: 'Installing',
  starting: 'Starting up',
  stopping: 'Stopping',
  restarting: 'Restarting',
  uninstalling: 'Removing',
  updating: 'Updating',
  resetting: 'Resetting',
  backing_up: 'Backing up',
  restoring: 'Restoring',
  install_failed: 'Install failed',
  stopped: 'Stopped',
  running: 'Running',
};

function humanizeStatus(status: string) {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getAppStatusPresentation(
  status: AppStatusType,
  runtimeHealth?: AppRuntimeHealth | null,
): {
  labelKey: string;
  fallbackLabel: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  animate: boolean;
  detail: string | null;
} {
  const containers = runtimeHealth?.containers ?? [];
  const runningContainers = containers.filter((container) => container.state === 'running').length;
  const hasUnhealthyContainer = containers.some((container) => container.health === 'unhealthy' || ['dead', 'exited'].includes(container.state));
  const hasTransitionalContainer = containers.some(
    (container) =>
      ['created', 'restarting'].includes(container.state) || container.health === 'starting' || container.status.toLowerCase().includes('starting'),
  );

  if (status === 'running') {
    if (hasUnhealthyContainer || runtimeHealth?.degraded || runtimeHealth?.responsive === false) {
      return {
        labelKey: 'APP_STATUS_DEGRADED',
        fallbackLabel: 'Needs attention',
        tone: 'danger',
        animate: false,
        detail: runtimeHealth?.reason ?? 'One or more containers are unhealthy or unresponsive.',
      };
    }

    if (containers.length === 0 || hasTransitionalContainer || runningContainers < containers.length) {
      return {
        labelKey: 'APP_STATUS_INITIALIZING',
        fallbackLabel: 'Initializing',
        tone: 'warning',
        animate: true,
        detail: containers.length > 0 ? `${runningContainers}/${containers.length} containers ready` : 'Containers are still starting.',
      };
    }
  }

  if (status === 'install_failed') {
    return {
      labelKey: 'APP_STATUS_INSTALL_FAILED',
      fallbackLabel: friendlyStatusLabels[status] ?? humanizeStatus(status),
      tone: 'danger',
      animate: false,
      detail: runtimeHealth?.reason ?? null,
    };
  }

  if (status === 'stopped') {
    return {
      labelKey: 'APP_STATUS_STOPPED',
      fallbackLabel: friendlyStatusLabels[status] ?? humanizeStatus(status),
      tone: 'danger',
      animate: false,
      detail: runtimeHealth?.reason ?? null,
    };
  }

  if (['installing', 'starting', 'stopping', 'restarting', 'updating', 'resetting', 'backing_up', 'restoring', 'uninstalling'].includes(status)) {
    return {
      labelKey: `APP_STATUS_${status.toUpperCase()}`,
      fallbackLabel: friendlyStatusLabels[status] ?? humanizeStatus(status),
      tone: 'warning',
      animate: true,
      detail: runtimeHealth?.reason ?? null,
    };
  }

  return {
    labelKey: `APP_STATUS_${status.toUpperCase()}`,
    fallbackLabel: friendlyStatusLabels[status] ?? humanizeStatus(status),
    tone: status === 'running' ? 'success' : 'neutral',
    animate: status === 'running',
    detail: runtimeHealth?.reason ?? null,
  };
}

export const AppStatus: React.FC<{ lite?: boolean; status: AppStatusType; runtimeHealth?: AppRuntimeHealth | null; variant?: AppStatusVariant }> = ({
  status,
  lite,
  runtimeHealth,
  variant = 'inline',
}) => {
  const { t } = useTranslation();

  if (status === 'missing') return null;

  const presentation = getAppStatusPresentation(status, runtimeHealth);
  const formattedStatus = t(presentation.labelKey, presentation.fallbackLabel);
  const dotClasses = cn(
    'inline-block h-2 w-2 rounded-full',
    presentation.tone === 'success' && 'bg-green-500',
    presentation.tone === 'warning' && 'bg-amber-400',
    presentation.tone === 'danger' && 'bg-red-500',
    presentation.tone === 'neutral' && 'bg-slate-400',
    presentation.animate && 'animate-pulse',
  );

  if (variant === 'pill') {
    return (
      <div
        className={cn(
          'inline-flex min-h-12 items-center gap-3 rounded-md border px-4 py-2 shadow-sm',
          presentation.tone === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
          presentation.tone === 'warning' && 'border-amber-500/30 bg-amber-500/10 text-amber-500',
          presentation.tone === 'danger' && 'border-red-500/30 bg-red-500/10 text-red-500',
          presentation.tone === 'neutral' && 'border-border/70 bg-muted/30 text-muted-foreground',
        )}
        title={presentation.detail ?? formattedStatus}
      >
        <span className={dotClasses} />
        <span className="text-sm font-semibold">{formattedStatus}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center" title={lite ? formattedStatus : (presentation.detail ?? undefined)}>
      <span className={dotClasses} />
      {!lite && <span className="ml-2 text-sm text-muted-foreground">{formattedStatus}</span>}
    </div>
  );
};
