import { poolStatusOptions } from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { useDisclosure } from '@/lib/hooks/use-disclosure';
import { useRegistrationStatus } from '@/lib/hooks/use-registration-status';
import { POLLING } from '@/lib/polling-budget';
import { LazyPoolSetupWizard } from '@/modules/settings/components/pool-setup-wizard/lazy-pool-setup-wizard';
import { poolInvitation } from '@/modules/settings/components/pool-setup-wizard/pool-setup-model';
import type { PoolStatus } from '@/modules/settings/helpers/hub-pool-shared';
import { useQuery } from '@tanstack/react-query';
import { Network, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { usePoolSetupDismissal } from '../helpers/pool-setup-dismissal';

/** How many requesters the review card names before leaving the rest to the count in its title. */
const MAX_NAMED_REQUESTERS = 3;

/**
 * Home page nudges toward the Hub Pool setup guide.
 *
 * Two cards, one wizard:
 * - Invite: a registered Hub with Tailscale connected and no peer row at all. The first-run prompt;
 *   dismissible, because it is a suggestion.
 * - Review: another Hub asked to join. That request lands on THIS Hub as a pending row and nothing else
 *   here says so, so it ignores dismissal and resolves only by acting on it.
 *
 * The status read is the cheap `/status` route, never the discovery route. A pending or failed read
 * renders nothing: this card decorates the page and must not raise an error over something nobody asked for.
 */
export function PoolSetupCard() {
  const { t } = useTranslation();
  const headingId = useId();
  const demoMode = useDemoMode();
  const { data: registration } = useRegistrationStatus();
  const { dismissed, dismiss } = usePoolSetupDismissal();
  const wizard = useDisclosure();

  const { data: status } = useQuery({
    ...poolStatusOptions(),
    select: (payload) => payload as PoolStatus,
    staleTime: 30_000,
    retry: false,
    refetchInterval: POLLING.POOL_NUDGE_MS,
    enabled: !demoMode,
  });

  const invitation = poolInvitation({ registered: Boolean(registration?.registered), demoMode, dismissed, status });

  return (
    <>
      {invitation.kind === 'invite' ? (
        <section
          aria-labelledby={headingId}
          data-testid="pool-setup-card"
          className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/10 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <Network aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="min-w-0 space-y-1">
              <h2 id={headingId} className="text-sm font-semibold">
                {t('HUB_POOL_SETUP_CARD_TITLE')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_CARD_BODY')}</p>
              <p className="text-xs text-muted-foreground">{t('HUB_POOL_SETUP_CARD_LATER')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 self-start sm:self-auto">
            <Button type="button" size="sm" onClick={wizard.open} data-testid="pool-setup-card-open">
              {t('HUB_POOL_SETUP_OPEN')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('HUB_POOL_SETUP_CARD_DISMISS')}
              onClick={dismiss}
              data-testid="pool-setup-card-dismiss"
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </section>
      ) : null}

      {invitation.kind === 'review' ? (
        <section
          role="status"
          aria-live="polite"
          aria-labelledby={headingId}
          data-testid="pool-setup-review-card"
          className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-3">
            <Network aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="min-w-0 space-y-1">
              <h2 id={headingId} className="text-sm font-semibold">
                {t('HUB_POOL_SETUP_REVIEW_TITLE', { count: invitation.requests.length })}
              </h2>
              <p className="text-sm text-muted-foreground">{t('HUB_POOL_SETUP_REVIEW_BODY')}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {t('HUB_POOL_SETUP_REVIEW_FROM', {
                  names: invitation.requests
                    .slice(0, MAX_NAMED_REQUESTERS)
                    .map((request) => request.label)
                    .join(', '),
                })}
              </p>
            </div>
          </div>
          <Button type="button" size="sm" className="shrink-0 self-start sm:self-auto" onClick={wizard.open} data-testid="pool-setup-review-open">
            {t('HUB_POOL_SETUP_REVIEW_BUTTON', { count: invitation.requests.length })}
          </Button>
        </section>
      ) : null}

      {/* Outside the two cards on purpose: the invite hides itself the moment the first request makes the
          peer count 1, and a guide that was a child of it would unmount in the middle of sending. */}
      <LazyPoolSetupWizard open={wizard.isOpen} onOpenChange={wizard.toggle} />
    </>
  );
}
