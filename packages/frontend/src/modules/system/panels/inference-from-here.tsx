import { DASH, humanDuration, Panel, PanelBody, parseHubTimestamp, StatChip } from '@/components/ui/dense/dense';
import type { OwnInference, UnloggedCalls } from '@/modules/system/pool-node-series';
import type { LoadState } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * INFERENCE FROM THIS HUB — what entered the pool here, in the last 30 minutes.
 *
 * It sits in the workload band because it is the nearest thing to "what are my workloads doing with
 * the models" the Hub can state. Which app made a call is not known: inference routes admit callers
 * by network origin and never ask which one, and that origin check admits any machine on the LAN or
 * tailnet too, so the caption names those callers rather than calling them "this Hub's apps". What
 * IS known is which calls entered the pool here — the routing log marks them `outbound`. Work a
 * peer forwarded to our engines is `inbound` and is not demand from here, so it is left out; the
 * rail and Pool activity count both directions, which is why their totals are larger.
 *
 * Two things can make the log an incomplete record, and the tile never states a count as a total
 * past either: the ring dropping rows from the window (`partial`), and calls that bypass the log
 * altogether (`unlogged`, see `unloggedCalls`). "Nothing sent" is said only when neither applies.
 *
 * Every figure is `inferenceFromHere` over the rail's own bucket window, computed once by the page.
 */

const UNLOGGED_KEY: Record<Exclude<UnloggedCalls, 'none'>, string> = {
  v1: 'DASHBOARD_OWN_UNLOGGED_V1',
  apps: 'DASHBOARD_OWN_UNLOGGED_APPS',
  unknown: 'DASHBOARD_OWN_UNLOGGED_UNKNOWN',
};

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
  /** Which calls never reach the routing log right now. See `unloggedCalls`. */
  unlogged: UnloggedCalls;
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
  const joinSubs = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

  /*
   * An empty window, in the one wording each state can back. "Nothing sent" needs a log that holds
   * the whole window AND sees every call; a log that dropped rows can only speak for what it held,
   * and one that some calls bypass can only speak for what it logged. When apps skip it entirely,
   * there is no count worth stating, so the gap line below is the whole of the body.
   */
  const emptyLine =
    unlogged === 'apps'
      ? null
      : partial
        ? t('DASHBOARD_OWN_NONE_PARTIAL')
        : unlogged === 'none'
          ? t('DASHBOARD_OWN_NONE', { minutes })
          : t('DASHBOARD_OWN_NONE_LOGGED', { minutes });

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
            emptyLine ? (
              <p className="py-3 text-center text-[13px] italic text-muted-foreground">{emptyLine}</p>
            ) : null
          ) : (
            <>
              {/* One note for every chip: they are all sums over the same rows, so a per-chip "at
                  least" would say one thing six times in a quarter-width tile. */}
              {partial ? (
                <p data-testid="inference-from-here-partial" className="text-[11px] leading-snug text-muted-foreground">
                  {t('DASHBOARD_OWN_PARTIAL')}
                </p>
              ) : null}
              {/* A grid rather than a wrapping row: six chips of uneven width wrapped into a ragged
                  stack in a quarter-width tile. */}
              <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
                <StatChip
                  value={own.requests}
                  label={t('DASHBOARD_OWN_REQUESTS')}
                  sub={joinSubs(
                    unlogged === 'none' ? undefined : t('DASHBOARD_OWN_LOGGED_ONLY'),
                    own.pending > 0 ? t('DASHBOARD_OWN_WAITING', { count: own.pending }) : undefined,
                  )}
                />
                {/* Split as the rail splits "Failed 30m": a caller that hung up, a failure that ran a
                    whole budget, and a request a node refused as bad point at different fixes, and
                    none of them is a node failing to do work it was able to do. */}
                <StatChip
                  value={own.failed}
                  label={t('DASHBOARD_FAILED')}
                  tone={own.failed > 0 ? 'bad' : 'muted'}
                  sub={joinSubs(
                    own.overBudget > 0 ? t('DASHBOARD_RAIL_PAST_BUDGET', { count: own.overBudget }) : undefined,
                    own.clientClosed > 0 ? t('DASHBOARD_RAIL_CALLERS_LEFT', { count: own.clientClosed }) : undefined,
                    own.refused > 0 ? t('DASHBOARD_RAIL_REFUSED', { count: own.refused }) : undefined,
                  )}
                />
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
          {unlogged === 'none' ? null : (
            <p data-testid="inference-from-here-unlogged" className="text-[11px] leading-snug text-warning">
              {t(UNLOGGED_KEY[unlogged])}
            </p>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}
