import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card/Card';
import type { AppReadiness, AppReadinessCheck } from '@/lib/app-runtime-monitor';
import { cn } from '@/lib/utils';
import { AlertCircle, CheckCircle2, HeartPulse, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The checks the app itself says are not passing, by name, in the order the app listed them. */
export function failingReadinessChecks(readiness: AppReadiness): Array<[string, AppReadinessCheck]> {
  return Object.entries(readiness.checks).filter(([, check]) => check.status !== 'ok');
}

/**
 * Compact readiness pill for the app-detail header, next to the Companion Memory badge.
 * Mirrors `memory-status-badge` styling. Renders nothing unless the app declares a readiness
 * endpoint and is running (`readiness` is `null` otherwise), so the ~500 apps that declare
 * nothing never see it. `unknown` is muted, not a warning: one missed probe is not a fault.
 */
export function AppReadinessBadge({ readiness }: { readiness?: AppReadiness | null }) {
  const { t } = useTranslation();

  if (!readiness) {
    return null;
  }

  const pill = 'inline-flex shrink-0 items-center rounded-full border px-2 py-1 text-[11px] font-medium';

  if (readiness.status === 'ok') {
    return (
      <span className={cn(pill, 'border-success/30 bg-success/10 text-success')} title={t('APP_READINESS_OK_DESC')}>
        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
        {t('APP_READINESS_BADGE_OK')}
      </span>
    );
  }

  if (readiness.status === 'degraded') {
    const failing = failingReadinessChecks(readiness).map(([name]) => name);
    return (
      <span className={cn(pill, 'border-warning/40 bg-warning/10 text-warning')} title={failing.join(', ') || undefined}>
        <AlertCircle className="mr-1 h-3.5 w-3.5" />
        {t('APP_READINESS_BADGE_DEGRADED')}
      </span>
    );
  }

  return (
    <span className={cn(pill, 'border-border/70 bg-muted/30 text-muted-foreground')} title={t('APP_READINESS_UNKNOWN_DESC')}>
      <HelpCircle className="mr-1 h-3.5 w-3.5" />
      {t('APP_READINESS_BADGE_UNKNOWN')}
    </span>
  );
}

/**
 * The failing checks by name with the app's own detail, so "the model endpoint the Hub handed
 * out is unreachable from inside the agent" is readable on the page instead of only in the
 * container log. Rendered only when there is something failing to show: an all-ok or checkless
 * sample is the pill alone.
 */
export function AppReadinessChecksCard({ readiness }: { readiness?: AppReadiness | null }) {
  const { t } = useTranslation();

  if (!readiness) {
    return null;
  }

  const failing = failingReadinessChecks(readiness);
  if (failing.length === 0) {
    return null;
  }

  return (
    <Card className="border-warning/30 bg-card/80 shadow-sm" data-testid="app-readiness-checks">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <HeartPulse className="h-4 w-4 text-warning" />
          {t('APP_READINESS_CHECKS_TITLE')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('APP_READINESS_CHECKS_SUBTITLE')}</p>
        <ul className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-3">
          {failing.map(([name, check]) => (
            <li key={name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{name}</code>
              <span className="font-medium text-warning">{check.status}</span>
              {check.detail ? <span className="text-muted-foreground">{check.detail}</span> : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
