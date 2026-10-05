import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SetupStep } from './pool-setup-model';

const STEPS: { id: SetupStep; labelKey: string }[] = [
  { id: 'ready', labelKey: 'HUB_POOL_SETUP_STEP_READY' },
  { id: 'find', labelKey: 'HUB_POOL_SETUP_STEP_FIND' },
  { id: 'connect', labelKey: 'HUB_POOL_SETUP_STEP_CONNECT' },
  { id: 'approve', labelKey: 'HUB_POOL_SETUP_STEP_APPROVE' },
];

/**
 * Where the user is in the guide. A list, not a set of tabs: it is not interactive, because every step
 * is entered through that step's own buttons, and a clickable step would let someone jump to Connect
 * with nothing selected to connect.
 *
 * Two looks for one list. From the `sm` breakpoint it is a labelled row with connectors; on a phone the
 * row would wrap into a ragged block, so it collapses to "Step 2 of 4 · Find Hubs" over a progress bar.
 * The list itself stays in the page on both (visually hidden on a phone) so assistive technology reads
 * the same structure, and the phone indicator is hidden from it to avoid saying everything twice.
 */
export function PoolSetupStepper({ step }: { step: SetupStep }) {
  const { t } = useTranslation();
  const activeIndex = STEPS.findIndex((item) => item.id === step);
  const current = STEPS[activeIndex];

  return (
    <div>
      <ol aria-label={t('HUB_POOL_SETUP_STEPS_LABEL')} data-testid="pool-setup-stepper" className="max-sm:sr-only flex items-center gap-2">
        {STEPS.map((item, index) => {
          const state = index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'upcoming';
          return (
            <li
              key={item.id}
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 text-xs',
                index < STEPS.length - 1 && 'flex-1',
                state === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                  state === 'current' && 'border-primary bg-primary text-primary-foreground',
                  state === 'complete' && 'border-success/40 bg-success/15 text-success',
                )}
              >
                {state === 'complete' ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="whitespace-nowrap">{t(item.labelKey)}</span>
              {state === 'complete' ? <span className="sr-only">{t('HUB_POOL_SETUP_STEP_COMPLETE_SR')}</span> : null}
              {state === 'current' ? <span className="sr-only">{t('HUB_POOL_SETUP_STEP_CURRENT_SR')}</span> : null}
              {index < STEPS.length - 1 ? (
                <span aria-hidden="true" className={cn('h-px flex-1 bg-border', state === 'complete' && 'bg-success/40')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div aria-hidden="true" className="space-y-2 sm:hidden" data-testid="pool-setup-stepper-compact">
        <p className="text-xs text-muted-foreground">
          {t('HUB_POOL_SETUP_STEP_PROGRESS', { current: activeIndex + 1, total: STEPS.length })}
          {current ? <span className="font-semibold text-foreground"> · {t(current.labelKey)}</span> : null}
        </p>
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${((activeIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
