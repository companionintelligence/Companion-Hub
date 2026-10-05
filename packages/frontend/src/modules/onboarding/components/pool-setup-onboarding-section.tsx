import { Button } from '@/components/ui/Button';
import { tailscaleStatusOptions } from '@/lib/api-routes/named-status-routes';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { POLLING } from '@/lib/polling-budget';
import { LazyPoolSetupWizard } from '@/modules/settings/components/pool-setup-wizard/lazy-pool-setup-wizard';
import type { TailscaleSetupStatus } from '@/modules/settings/components/pool-setup-wizard/pool-setup-model';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * An optional, unnumbered section of first-run setup that offers the Hub Pool guide once Tailscale is up.
 *
 * It only opens the guide. It never reports into the setup config, so it cannot affect whether the user
 * may finish, and whatever the guide does is on the server, so a reload loses nothing.
 *
 * It decides for itself whether to appear, from a live Tailscale read, rather than from
 * `appContext.tailscaleAvailable`: that flag also needs Serve enabled and is not polled, so it would not
 * notice a Hub that connected a moment ago on this very page.
 */
export function PoolSetupOnboardingSection() {
  const { t } = useTranslation();
  const headingId = useId();
  const wizard = useDisclosure();

  const { data: tailscale } = useQuery({
    ...tailscaleStatusOptions(),
    select: (payload) => payload as unknown as TailscaleSetupStatus,
    refetchInterval: POLLING.REGISTRATION_MS,
    refetchOnWindowFocus: true,
  });

  const connected = Boolean(tailscale?.installed && tailscale.connected);

  return (
    <>
      {connected ? (
        <section
          aria-labelledby={headingId}
          data-testid="pool-setup-onboarding"
          className="rounded-lg border border-border bg-gradient-to-b from-card to-card/60 p-5 shadow-sm sm:p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={headingId} className="text-base font-bold uppercase tracking-wide sm:text-lg">
                  {t('HUB_POOL_SETUP_ONBOARDING_TITLE')}
                </h2>
                <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {t('ONBOARDING_BADGE_OPTIONAL')}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_ONBOARDING_BODY')}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 self-start sm:self-auto"
              onClick={wizard.open}
              data-testid="pool-setup-onboarding-open"
            >
              {t('HUB_POOL_SETUP_OPEN')}
            </Button>
          </div>
        </section>
      ) : null}

      {/* Outside the section: it disappears if Tailscale drops, and the guide must not go with it. */}
      <LazyPoolSetupWizard open={wizard.isOpen} onOpenChange={wizard.toggle} />
    </>
  );
}
