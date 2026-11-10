import { getInstalledAppsOptions } from '@/api-client/@tanstack/react-query.gen';
import type { ModelContextPlan } from '@ci-hub/common/types';
import { useQuery } from '@tanstack/react-query';
import { MessagesSquare, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** "64k", "32k", "62.5k": powers of two in binary thousands (65536 → 64k), round decimal floors in decimal ones (64000 → 64k). */
export function formatTokens(tokens: number): string {
  const k = tokens % 1024 === 0 ? tokens / 1024 : tokens % 1000 === 0 ? tokens / 1000 : Math.round((tokens / 1024) * 10) / 10;
  return `${k}k`;
}

/**
 * What a model gets on this hardware, from the onboarding profile's `contextPlans`: its context window,
 * the 8-bit KV cache when the Hub would use one to reach an installed app's floor, and a warning when
 * the window cannot reach that floor here (Hermes refuses below 64000). Nothing when there is no plan.
 */
export function ModelContextNote({ plan }: { plan: ModelContextPlan | undefined }) {
  const { t } = useTranslation();
  const { data } = useQuery({ ...getInstalledAppsOptions(), staleTime: 60_000 });
  if (!plan) return null;

  // A floor names apps by their directory name (`ci-hermes`); say them as the Hub does (`Hermes`).
  const names = new Map((data?.installed ?? []).map(({ info }) => [info.urn.split(':')[0] ?? info.urn, info.name]));
  const apps = (plan.floor?.apps ?? []).map((app) => names.get(app) ?? app).join(', ');
  const window = plan.window === null ? null : formatTokens(plan.window);
  const floor = plan.floor ? formatTokens(plan.floor.minContextLength) : null;

  return (
    <span className="flex flex-col gap-1 text-xs" data-testid="model-context-note">
      <span className="flex items-center gap-1 text-muted-foreground">
        <MessagesSquare className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        {window === null ? t('MODEL_CONTEXT_NONE') : t('MODEL_CONTEXT_WINDOW', { window })}
        {plan.kvCacheType === 'q8_0' && (
          <span title={t('MODEL_CONTEXT_8BIT_TITLE', { apps, floor })} data-testid="model-context-8bit">
            {' · '}
            {t('MODEL_CONTEXT_8BIT')}
          </span>
        )}
        {plan.basis === 'estimated' && window !== null && <span className="italic">{` (${t('MODEL_CONTEXT_ESTIMATED')})`}</span>}
      </span>
      {plan.floor && !plan.floor.met && (
        <span className="flex items-center gap-1 text-warning" data-testid="model-context-floor-unmet">
          <TriangleAlert className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {t('MODEL_CONTEXT_FLOOR_UNMET', { apps, floor, window: window ?? '0' })}
        </span>
      )}
    </span>
  );
}
