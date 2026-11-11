import type { ModelContextPlan } from '@ci-hub/common/types';
import { Lightbulb, MessagesSquare, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** "64k", "32k", "62.5k": powers of two in binary thousands (65536 → 64k), round decimal floors in decimal ones (64000 → 64k). */
export function formatTokens(tokens: number): string {
  const k = tokens % 1024 === 0 ? tokens / 1024 : tokens % 1000 === 0 ? tokens / 1000 : Math.round((tokens / 1024) * 10) / 10;
  return `${k}k`;
}

/**
 * What a model gets on this hardware, from the onboarding profile's `contextPlans`: its context window,
 * the 8-bit or 4-bit KV cache when the Hub would use one to reach an installed app's floor (4-bit's
 * tooltip says what it costs) — for Ollama, the cache its server runs, and the server setting that would
 * reach the floor when the current one does not (Ollama's cache is one setting for every model), and a warning when
 * the window cannot reach that floor here. The floor is said generically ("some apps need 64k") rather
 * than by app: most people run none of the apps that set one. Nothing when there is no plan.
 */
export function ModelContextNote({ plan }: { plan: ModelContextPlan | undefined }) {
  const { t } = useTranslation();
  if (!plan) return null;

  const window = plan.window === null ? null : formatTokens(plan.window);
  const floor = plan.floor ? formatTokens(plan.floor.minContextLength) : null;
  // Ollama runs one cache for every model, set on the server; Lemonade's is the Hub's choice for this model.
  const server = plan.kvCacheSetBy === 'server';
  const advice = plan.kvCacheAdvice;

  return (
    <span className="flex flex-col gap-1 text-xs" data-testid="model-context-note">
      <span className="flex items-center gap-1 text-muted-foreground">
        <MessagesSquare className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
        {window === null ? t('MODEL_CONTEXT_NONE') : t('MODEL_CONTEXT_WINDOW', { window })}
        {plan.kvCacheType === 'q8_0' && (
          <span title={server ? t('MODEL_CONTEXT_SERVER_8BIT_TITLE') : t('MODEL_CONTEXT_8BIT_TITLE', { floor })} data-testid="model-context-8bit">
            {' · '}
            {t('MODEL_CONTEXT_8BIT')}
          </span>
        )}
        {plan.kvCacheType === 'q4_0' && (
          <span title={server ? t('MODEL_CONTEXT_SERVER_4BIT_TITLE') : t('MODEL_CONTEXT_4BIT_TITLE', { floor })} data-testid="model-context-4bit">
            {' · '}
            {t('MODEL_CONTEXT_4BIT')}
          </span>
        )}
        {plan.basis === 'estimated' && window !== null && <span className="italic">{` (${t('MODEL_CONTEXT_ESTIMATED')})`}</span>}
      </span>
      {plan.floor && !plan.floor.met && (
        <span className="flex items-center gap-1 text-warning" data-testid="model-context-floor-unmet">
          <TriangleAlert className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {t('MODEL_CONTEXT_FLOOR_UNMET', { floor, window: window ?? '0' })}
        </span>
      )}
      {advice && (
        <span
          className="flex items-center gap-1 text-muted-foreground"
          title={t(advice.type === 'q4_0' ? 'MODEL_CONTEXT_ADVICE_4BIT_TITLE' : 'MODEL_CONTEXT_ADVICE_TITLE', {
            setting: advice.setting,
            type: advice.type,
          })}
          data-testid="model-context-advice"
        >
          <Lightbulb className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          {t(advice.type === 'q4_0' ? 'MODEL_CONTEXT_ADVICE_4BIT' : 'MODEL_CONTEXT_ADVICE_8BIT', { window: formatTokens(advice.window) })}
        </span>
      )}
    </span>
  );
}
