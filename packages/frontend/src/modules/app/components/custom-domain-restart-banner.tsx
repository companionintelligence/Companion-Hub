import { useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { customDomainAwaitingRestart, fetchPublicWebDiagnostics, repairPublicWebRouting, type PublicWebDiagnosticsApp } from '@/lib/cloudflare-api';
import { formatApiError } from '@/lib/format-api-error';
import { invalidateAppQueries } from '@/modules/app/helpers/app-sse-cache';

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

  const waiting = apps.filter((app) => customDomainAwaitingRestart(app) !== null);

  if (waiting.length === 0) {
    return null;
  }

  /*
   * `invalidateAppQueries` — the app's own queries plus the Public Web report — is
   * the whole blast radius of a restart, and it is not awaited. An unfiltered
   * `invalidateQueries()` would also throw away caches held deliberately (app image
   * size is given an hour because it hits a registry), and awaiting either would
   * hold the button's spinner behind the slowest unrelated refetch.
   */
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
      if (!current) {
        /*
         * `null` is "the Hub did not answer" — a 401, a 403, a 500, a dropped
         * connection. Folding it into the already-synced branch below would report a
         * failed read as a fixed domain, which is the one thing this banner exists to
         * never do.
         */
        toast.error(t('APP_PUBLIC_WEB_REPAIR_ERROR'));
        return;
      }

      const entry = current.apps.find((app) => app.appUrn === appUrn);
      if (customDomainAwaitingRestart(entry) === null) {
        invalidateAppQueries(queryClient, appUrn);
        toast.success(t('APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED'));
        return;
      }

      const results = await repairPublicWebRouting(appUrn);
      const outcome = results.find((result) => result.appUrn === appUrn);
      /*
       * The Hub reports a per-app failure INSIDE a 200 — "the routing was rewritten
       * but the app failed to restart" is the likely one. Dropping the result would
       * let the banner clear itself (the env now matches) while the app is down, and
       * say nothing at all.
       */
      if (outcome && !outcome.success) {
        toast.error(t('APP_PUBLIC_WEB_REPAIR_ERROR'));
        return;
      }

      invalidateAppQueries(queryClient, appUrn);
      // No entry at all is not a failure: the Hub returns one per app it found
      // drifted, so an empty result means someone else already repaired this one.
      toast.success(t(outcome ? 'APP_PUBLIC_WEB_REPAIR_SUCCESS' : 'APP_PUBLIC_WEB_REPAIR_ALREADY_SYNCED'));
    } catch (error) {
      // `formatApiError`, not a fixed string: a repair the operator has no grant for
      // comes back as APP_ACTION_GRANT_DENIED, and "check the Hub logs" would send
      // them looking for a fault that is not there.
      toast.error(formatApiError(error, t));
    } finally {
      setRestarting(null);
    }
  };

  const only = waiting.length === 1 ? waiting[0] : undefined;

  return (
    <Alert variant="warning" className="mb-3 flex flex-wrap items-center gap-3" data-testid="custom-domain-restart-banner">
      <AlertIcon>
        <RotateCw className="w-4 h-4 shrink-0" />
      </AlertIcon>
      <AlertDescription className="min-w-0 flex-1 text-sm">
        {only
          ? t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_ONE', {
              domain: only.customDomain,
              name: namesByUrn[only.appUrn] ?? only.appUrn,
            })
          : // `_COUNT` with i18next's own `_one`/`_other` suffixes, not a hand-rolled `_MANY`:
            // en.json is pushed to 30 locales, several of which have three to six plural
            // categories, and a single flat string leaves a translator no slot for them.
            t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_COUNT', { count: waiting.length })}
      </AlertDescription>
      {only && (
        /*
         * `restarting !== null`, not `restarting === only.appUrn`: a repair blocks on
         * the container for tens of seconds, and the report can refetch underneath it.
         * Keying the spinner to whichever app is currently first would re-enable the
         * button mid-flight the moment the list reorders, and a second click would
         * fire a concurrent repair.
         */
        <Button size="sm" variant="outline" loading={restarting !== null} onClick={() => void handleRestart(only.appUrn)}>
          {t('MY_APPS_CUSTOM_DOMAIN_RESTART_ACTION')}
        </Button>
      )}
    </Alert>
  );
};
