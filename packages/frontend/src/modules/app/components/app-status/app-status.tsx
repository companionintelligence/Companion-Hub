import type { AppStatus as AppStatusType } from '@/types/app.types';
import { cn } from '@/lib/utils';
import type { AppContainerRuntimeStats, AppRuntimeHealth } from '@/lib/app-runtime-monitor';
import type React from 'react';
import { useTranslation } from 'react-i18next';

type AppStatusVariant = 'inline' | 'pill';

/** Init containers for multi-service stacks (ci-memory setup/migrate jobs, etc.). */
const EPHEMERAL_INIT_CONTAINER = /-(setup-|migrate-|fix-db-permissions)/i;

/** One-shot compose jobs (e.g. ci-memory setup-secrets) exit 0 and should not alarm the UI. */
export function isCompletedOneShotContainer(container: Pick<AppContainerRuntimeStats, 'state' | 'exitCode'>) {
  return container.state === 'exited' && (container.exitCode === 0 || container.exitCode === null);
}

/**
 * Ephemeral init jobs should not keep a running app in "Initializing" once the
 * long-lived services are up. Failed init containers (non-zero exit) stay in
 * the monitored set so the pill can surface "Needs attention".
 */
export function isEphemeralInitContainer(container: Pick<AppContainerRuntimeStats, 'name' | 'state' | 'exitCode'>) {
  if (!EPHEMERAL_INIT_CONTAINER.test(container.name)) {
    return isCompletedOneShotContainer(container);
  }

  if (container.state === 'exited') {
    return container.exitCode === 0 || container.exitCode === null;
  }

  // Not started yet — do not wait on it when judging readiness.
  if (container.state === 'created') {
    return true;
  }

  return false;
}

export function isConcerningContainer(container: Pick<AppContainerRuntimeStats, 'state' | 'health' | 'exitCode'>) {
  if (container.health === 'unhealthy') {
    return true;
  }

  if (container.state === 'dead') {
    return true;
  }

  if (container.state === 'exited') {
    return container.exitCode != null && container.exitCode !== 0;
  }

  return false;
}

function containersExpectedToRun(containers: AppContainerRuntimeStats[]) {
  return containers.filter((container) => !isEphemeralInitContainer(container));
}

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

/**
 * Public-route readiness, folded into the pill so it can't contradict the
 * launch action. Container health and route availability are different facts —
 * an app can be fully "Running" while Cloudflare is still publishing its
 * hostname — and showing them as two independent signals read as "up and not-up
 * at once". Supplied by `useAppUrlAvailability` on the app-detail pages.
 */
export interface AppPublicUrlStatus {
  /** Containers are up, but the public address is still coming up. */
  propagating: boolean;
  /** Already-translated tooltip detail (e.g. "DNS propagating..."). */
  detail: string | null;
}

/**
 * Map an app's status (plus what we know about its containers and its public
 * route) onto a single pill presentation: label key, tone, pulse and tooltip
 * detail. Kept pure and translation-free — callers translate `labelKey` and
 * pass in already-translated details — so it can be unit-tested directly.
 */
export function getAppStatusPresentation(
  status: AppStatusType,
  runtimeHealth?: AppRuntimeHealth | null,
  publicUrl?: AppPublicUrlStatus | null,
): {
  labelKey: string;
  fallbackLabel: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  animate: boolean;
  detail: string | null;
} {
  const containers = runtimeHealth?.containers ?? [];
  const monitoredContainers = containersExpectedToRun(containers);
  const runningContainers = monitoredContainers.filter((container) => container.state === 'running').length;
  const hasUnhealthyContainer = monitoredContainers.some(isConcerningContainer);
  const hasTransitionalContainer = monitoredContainers.some(
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

    // Trust the durable Hub status until runtime stats arrive; an empty snapshot
    // is indistinguishable from "still loading" and left ci-memory stuck on
    // Initializing even when every long-lived container was healthy.
    if (runtimeHealth && (monitoredContainers.length === 0 || hasTransitionalContainer || runningContainers < monitoredContainers.length)) {
      return {
        labelKey: 'APP_STATUS_INITIALIZING',
        fallbackLabel: 'Initializing',
        tone: 'warning',
        animate: true,
        detail:
          monitoredContainers.length > 0 ? `${runningContainers}/${monitoredContainers.length} containers ready` : 'Containers are still starting.',
      };
    }

    // Containers are all up and healthy, but the public address isn't serving
    // yet. Deliberately checked last: container-level truth outranks
    // route-level truth, so a degraded or still-initializing app keeps its more
    // urgent pill rather than being described as a DNS delay.
    if (publicUrl?.propagating) {
      return {
        labelKey: 'APP_STATUS_RUNNING_PROPAGATING',
        fallbackLabel: 'Running (DNS propagating...)',
        tone: 'warning',
        animate: true,
        detail: publicUrl.detail ?? 'The app is running. Its public web address is still coming up.',
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

  if (status === 'stopped' || status === 'missing') {
    return {
      labelKey: 'APP_STATUS_STOPPED',
      fallbackLabel: friendlyStatusLabels.stopped ?? 'Stopped',
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

export const AppStatus: React.FC<{
  lite?: boolean;
  status: AppStatusType;
  runtimeHealth?: AppRuntimeHealth | null;
  /** Only the app-detail pill knows about the public route; list tiles omit it. */
  publicUrl?: AppPublicUrlStatus | null;
  variant?: AppStatusVariant;
}> = ({ status, lite, runtimeHealth, publicUrl, variant = 'inline' }) => {
  const { t } = useTranslation();

  const presentation = getAppStatusPresentation(status, runtimeHealth, publicUrl);
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
        data-testid="app-status-pill"
        // The label changes underneath the user (e.g. Running → "Running (DNS
        // propagating...)" → Running); announce it instead of silently swapping text.
        role="status"
        aria-live="polite"
        className={cn(
          'inline-flex min-h-12 items-center gap-3 rounded-md border px-4 py-2 shadow-sm',
          presentation.tone === 'success' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-500',
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
