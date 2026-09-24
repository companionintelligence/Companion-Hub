import { useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

import { Button } from '@/components/ui/Button';
import { fetchPublicWebDiagnostics, repairPublicWebRouting, type PublicWebDiagnosticsApp } from '@/lib/cloudflare-api';
import { formatApiError } from '@/lib/format-api-error';

interface CustomDomainRestartBannerProps {
  /** Diagnostics entries, unfiltered. The banner decides which of them it speaks for. */
  apps: PublicWebDiagnosticsApp[];
  /** Display names by URN, so the banner can name the app rather than print a URN. */
  namesByUrn: Record<string, string>;
}

/**
 * A domain the customer connected is not serving, and only a restart will finish it.
 *
 * ⚠ KEYED ON `awaitingCustomDomainRestart`, NOT `pendingRestart`. The raw flag is
 * raised by any settings change, so a banner built on it would be showing most of
 * the time and saying something untrue most of the time — and a banner that is
 * usually wrong is one operators learn to scroll past. This narrower state means
 * exactly "a bound custom domain is dark", which is worth interrupting someone for.
 */
export const CustomDomainRestartBanner = ({ apps, namesByUrn }: CustomDomainRestartBannerProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [restarting, setRestarting] = useState<string | null>(null);

  const waiting = apps.filter((app) => app.awaitingCustomDomainRestart && app.customDomain);

  if (waiting.length === 0) {
    return null;
  }

  const [first] = waiting;

  const handleRestart = async (appUrn: string) => {
    setRestarting(appUrn);
    try {
      /*
       * RE-READ BEFORE ACTING. This banner is rendered from a cached report and the
       * restart it asks for may already have happened — through the app's own page,
       * the CLI, or an unrelated save. Restarting on a stale banner would take a
       * working app down to apply a change that is already applied, which is the
       * opposite of what the click meant.
       */
      const current = await fetchPublicWebDiagnostics();
      const entry = current?.apps.find((app) => app.appUrn === appUrn);

      if (!entry?.awaitingCustomDomainRestart) {
        await queryClient.invalidateQueries();
        toast.success(t('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED'));
        return;
      }

      await repairPublicWebRouting(appUrn);
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(formatApiError(error, t));
    } finally {
      setRestarting(null);
    }
  };

  const single = waiting.length === 1 && first;

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
      data-testid="custom-domain-restart-banner"
    >
      <RotateCw className="w-4 h-4 text-warning shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        {single
          ? t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_ONE', {
              domain: first.customDomain,
              name: namesByUrn[first.appUrn] ?? first.appUrn,
            })
          : t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_MANY', { count: waiting.length })}
      </p>
      {single && (
        <Button size="sm" variant="outline" loading={restarting === first.appUrn} onClick={() => void handleRestart(first.appUrn)}>
          {t('MY_APPS_CUSTOM_DOMAIN_RESTART_ACTION')}
        </Button>
      )}
    </div>
  );
};
