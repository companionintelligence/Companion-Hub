import { DASH, humanDuration, Panel, PanelBody, parseHubTimestamp, StatChip } from '@/components/ui/dense/dense';
import type { OwnInference } from '@/modules/system/pool-node-series';
import type { LoadState } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * INFERENCE FROM THIS HUB — what this machine's own callers asked the pool for, in the last 30 minutes.
 *
 * It sits in the workload band because it is the nearest thing to "what are my workloads doing with
 * the models" the Hub can state: which app made a call is not known (inference routes admit apps by
 * network origin and never ask which one), but which calls came from HERE is — the routing log marks
 * them `outbound`. Work a peer forwarded to our engines is `inbound`, and is not this Hub's demand, so
 * it is left out; the rail and Pool activity count both directions, which is why their totals are
 * larger.
 *
 * Every figure is `inferenceFromHere` over the rail's own bucket window, computed once by the page.
 */

export function InferenceFromHere({
  own,
  minutes,
  partial,
  windowFrom,
  startedAt,
  unlogged,
  now,
  state,
  className,
}: {
  own: OwnInference;
  minutes: number;
  /** The ring may have dropped rows from the window (`routingWindowPartial`), so counts are floors. */
  partial: boolean;
  /** Start of the window, to tell whether the log itself starts inside it. */
  windowFrom: number | null;
  /** The routing log's `summary.startedAt`: this Hub process's start, when the log began. */
  startedAt: string | undefined;
  /**
   * `true` when pooling is off or no peer is connected. Then `/api/inference/v1` serves apps from the
   * local router without touching the routing log, so zero here is not proof of zero calls.
   */
  unlogged: boolean;
  now: number;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const started = parseHubTimestamp(startedAt);
  const restartedInWindow = windowFrom !== null && Number.isFinite(started) && started > windowFrom;
  const usagePartial = own.served > 0 && own.usageReported < own.served;
  // No usage frame on any served request is "not reported", never "0 tokens".
  const tokensKnown = own.usageReported > 0;
  const usageSub = usagePartial ? t('DASHBOARD_OWN_USAGE_PARTIAL', { reported: own.usageReported, served: own.served }) : undefined;

  return (
    <Panel
      title={t('DASHBOARD_OWN_TITLE')}
      density="compact"
      className={className}
      actions={<span className="text-[11px] text-muted-foreground">{t('DASHBOARD_OWN_WINDOW', { minutes })}</span>}
    >
      <p className="text-[11px] leading-snug text-muted-foreground">{t('DASHBOARD_OWN_CAPTION')}</p>
      <PanelBody state={state} error={t('DASHBOARD_ROUTING_LOG_FAILED')} lines={6}>
        <div data-testid="inference-from-here" className="space-y-2">
          {own.requests === 0 ? (
            <p className="py-3 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_OWN_NONE', { minutes })}</p>
          ) : (
            <>
              {/* A grid rather than a wrapping row: six chips of uneven width wrapped into a ragged
                  stack in a quarter-width tile. */}
              <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
                <StatChip
                  value={own.requests}
                  label={t('DASHBOARD_OWN_REQUESTS')}
                  sub={partial ? t('DASHBOARD_OWN_AT_LEAST') : own.pending > 0 ? t('DASHBOARD_OWN_WAITING', { count: own.pending }) : undefined}
                />
                <StatChip value={own.failed} label={t('DASHBOARD_FAILED')} tone={own.failed > 0 ? 'bad' : 'muted'} />
                <StatChip value={own.failovers} label={t('DASHBOARD_FAILOVERS')} tone={own.failovers > 0 ? 'warn' : 'muted'} />
                <StatChip
                  value={own.firstByte ? humanDuration(own.firstByte.p50Ms) : DASH}
                  label={t('DASHBOARD_OWN_FIRST_BYTE')}
                  sub={
                    own.firstByte === null
                      ? t('DASHBOARD_OWN_FIRST_BYTE_NONE')
                      : own.firstByte.p90Ms === null
                        ? t('DASHBOARD_OWN_FIRST_BYTE_COUNT', { count: own.firstByte.count })
                        : t('DASHBOARD_OWN_FIRST_BYTE_P90', { p90: humanDuration(own.firstByte.p90Ms) })
                  }
                  hint={t('DASHBOARD_OWN_FIRST_BYTE_HINT')}
                  hintId="dashboard-own-first-byte"
                />
                <StatChip
                  value={tokensKnown ? own.promptTokens.toLocaleString() : DASH}
                  label={t('DASHBOARD_OWN_PROMPT_TOKENS')}
                  tone={tokensKnown ? 'plain' : 'muted'}
                  sub={usageSub}
                />
                <StatChip
                  value={tokensKnown ? own.completionTokens.toLocaleString() : DASH}
                  label={t('DASHBOARD_OWN_OUTPUT_TOKENS')}
                  tone={tokensKnown ? 'plain' : 'muted'}
                  sub={usageSub}
                />
              </div>

              {own.models.length > 0 ? (
                <div className="space-y-0.5 border-t border-border pt-1.5 text-[11px]">
                  <p className="uppercase tracking-[0.5px] text-muted-foreground">{t('DASHBOARD_OWN_TOP_MODELS')}</p>
                  <ul data-testid="inference-from-here-models" className="space-y-0.5">
                    {own.models.map((row) => (
                      <li key={row.model} className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono" title={row.model}>
                          {row.model}
                        </span>
                        <span className="shrink-0 tabular-nums text-foreground">{t('DASHBOARD_OWN_MODEL_REQUESTS', { count: row.requests })}</span>
                        <span className="w-[76px] shrink-0 text-right tabular-nums text-muted-foreground">
                          {row.tokens === null ? DASH : t('DASHBOARD_OWN_MODEL_TOKENS', { tokens: row.tokens.toLocaleString() })}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {own.modelCount > own.models.length ? (
                    <p className="text-muted-foreground">{t('DASHBOARD_OWN_MORE_MODELS', { count: own.modelCount - own.models.length })}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

          {restartedInWindow ? (
            <p className="text-[11px] text-muted-foreground">{t('DASHBOARD_OWN_SINCE_START', { age: humanDuration(now - started) })}</p>
          ) : null}
          {unlogged ? (
            <p data-testid="inference-from-here-unlogged" className="text-[11px] leading-snug text-warning">
              {t('DASHBOARD_OWN_UNLOGGED')}
            </p>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}
