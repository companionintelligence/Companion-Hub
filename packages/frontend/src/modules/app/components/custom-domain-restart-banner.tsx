import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription, AlertIcon } from '@/components/ui/Alert/Alert';
import { Button } from '@/components/ui/Button';
import { customDomainAwaitingRestart, type PublicWebDiagnosticsApp } from '@/lib/cloudflare-api';
import { RestartDialog } from '@/modules/app/components/dialogs/restart-dialog/restart-dialog';

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
 *
 * ⚠ THE BUTTON ASKS BEFORE IT RESTARTS. A restart makes the app briefly
 * unavailable, and connecting a domain deliberately leaves the moment to a
 * person. So the button opens the same confirmation as the app's own Restart —
 * which also means the same grant (`restart`) gates both, where a direct repair
 * needed `configure` and refused operators who could restart the app from its
 * own page.
 */
export const CustomDomainRestartBanner = ({ apps, namesByUrn }: CustomDomainRestartBannerProps) => {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<PublicWebDiagnosticsApp | null>(null);

  /*
   * An app set to restart on its own is not waiting on anyone — the Hub restarts it
   * on its next sync. Offering a button there would ask a person to do something
   * that is already happening. Its tile still badges the pending restart.
   */
  const waiting = apps.filter((app) => customDomainAwaitingRestart(app) !== null && app.autoRestartOnDomainChange !== true);

  const nameFor = (app: PublicWebDiagnosticsApp) => namesByUrn[app.appUrn] ?? app.appName ?? app.appUrn;

  const restartButton = (app: PublicWebDiagnosticsApp) => (
    <Button size="sm" variant="outline" onClick={() => setConfirming(app)}>
      {t('MY_APPS_CUSTOM_DOMAIN_RESTART_ACTION')}
    </Button>
  );

  /*
   * Rendered whether or not the banner is, so a confirmation opened just before the
   * report refreshed — and the app dropped out of `waiting` — still closes cleanly
   * instead of vanishing mid-decision.
   */
  const dialog = confirming ? (
    <RestartDialog
      info={{ urn: confirming.appUrn, name: nameFor(confirming) }}
      isOpen
      onClose={() => setConfirming(null)}
      reason={t('APP_RESTART_FORM_CUSTOM_DOMAIN_REASON', { domain: confirming.customDomain, name: nameFor(confirming) })}
    />
  ) : null;

  if (waiting.length === 0) {
    return dialog;
  }

  /*
   * Styled here rather than through `Alert variant="warning"`: that variant only
   * emits the class names `alert`/`alert-warning`, and this design system defines
   * no rule for either — the banner would render as ordinary body text inside the
   * dashboard card, which for the one warning worth interrupting someone over is
   * the same as not showing it. `border-warning/30 bg-warning/10 text-warning` is
   * what every other warning surface in this frontend uses.
   */
  const frame = 'mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning';

  const only = waiting.length === 1 ? waiting[0] : undefined;

  if (only) {
    return (
      <>
        <Alert variant="warning" className={`${frame} flex flex-wrap items-center gap-3`} data-testid="custom-domain-restart-banner">
          <AlertIcon>
            <RotateCw className="w-4 h-4 shrink-0" />
          </AlertIcon>
          <AlertDescription className="min-w-0 flex-1 text-sm">
            {t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_ONE', { domain: only.customDomain, name: nameFor(only) })}
          </AlertDescription>
          {restartButton(only)}
        </Alert>
        {dialog}
      </>
    );
  }

  /*
   * Every waiting app gets its own row and its own button. The count sentence on
   * its own says "Restart them to finish" and offers nothing to click and no way
   * to tell which apps it means — the operator's only remedy would be to guess at
   * tiles and open each app's page.
   */
  return (
    <>
      <Alert variant="warning" className={`${frame} space-y-2`} data-testid="custom-domain-restart-banner">
        <div className="flex items-center gap-3">
          <AlertIcon>
            <RotateCw className="w-4 h-4 shrink-0" />
          </AlertIcon>
          <AlertDescription className="min-w-0 flex-1 text-sm">
            {/*
             * `_COUNT` with i18next's own `_one`/`_other` suffixes, not a hand-rolled
             * `_MANY`: en.json is pushed to 30 locales, several of which have three to
             * six plural categories, and a single flat string leaves no slot for them.
             */}
            {t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_COUNT', { count: waiting.length })}
          </AlertDescription>
        </div>
        <ul className="space-y-1.5">
          {waiting.map((app) => (
            <li key={app.appUrn} className="flex flex-wrap items-center gap-3 pl-7">
              <span className="min-w-0 flex-1 truncate text-sm">
                {t('MY_APPS_CUSTOM_DOMAIN_RESTART_BANNER_ONE', { domain: app.customDomain, name: nameFor(app) })}
              </span>
              {restartButton(app)}
            </li>
          ))}
        </ul>
      </Alert>
      {dialog}
    </>
  );
};
