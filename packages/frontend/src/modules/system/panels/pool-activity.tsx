import {
  compactTokens,
  DASH,
  humanDuration,
  KpiTable,
  Panel,
  PanelBody,
  relativeAge,
  StackedBar,
  StatChip,
  StatChipRow,
  StatusDot,
  TableEmpty,
  Td,
  Th,
  type Tone,
  Tr,
} from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import { bucketTotal, isRefused, outputFault, type RoutingBucket, routingActivity, settledOutcome } from '@/modules/system/pool-node-series';
import {
  estimatedPromptTokens,
  isExhausted,
  type LoadState,
  type RoutingLogEntry,
  routingByNode,
  routingLogKeys,
  tokensByModel,
} from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * POOL ACTIVITY — the pool in use, as honestly as the data allows.
 *
 * ⚠ THIS IS NOT A JOB QUEUE, and the difference is the whole design. The reference this page is
 * modelled on shows in-flight jobs with a start time each, the node that asked and the node that
 * is running it. We cannot reproduce that and must not imply we have:
 *
 *   - the routing log is APPEND-ONLY and written at the DECISION, before the response streams. A
 *     four-minute generation is one row logged in its first second, and nothing is ever written
 *     when a request finishes or is abandoned. There is no job id, no start/end pair, no state;
 *   - `durationMs` is time to response HEADERS including failed attempts, not generation time.
 *     Labelled "first byte" here for exactly that reason — as "duration" it would recreate the
 *     fake queue by the back door, with a four-minute job reading 200ms. It is printed in the unit
 *     a person reads (`6m 40s`, not `399710ms`): on this fleet a cold 40k-token prompt takes
 *     minutes to prefill, and a seven-digit millisecond count hid which rows were slow;
 *   - `inFlightRequests` is a COUNT per node, never a list, so nothing links a live request to a
 *     row in this table.
 *
 * So: a feed of DECISIONS, newest first, next to counts. The one thing here that IS a real time
 * series is the decisions-per-minute chart, and it is measured rather than watched — every record
 * carries the instant of its decision, so the shape survives a reload. It still charts requests
 * ROUTED per minute, never work in progress.
 */

const NODE_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

function DecisionBars({ buckets }: { buckets: RoutingBucket[] }) {
  const { t } = useTranslation();
  const peak = Math.max(0, ...buckets.map(bucketTotal));
  const total = buckets.reduce((sum, bucket) => sum + bucketTotal(bucket), 0);
  /*
   * The floor of 1 is for the AXIS ONLY — a bar needs a non-zero denominator. It used to be printed
   * too, as "0 in window · busiest minute 1": a measurement of a minute that did not happen, on every
   * idle Hub, directly under an empty chart.
   */
  const axis = Math.max(1, peak);

  return (
    <div className="space-y-1.5">
      <div className="flex h-24 w-full items-end gap-[2px] rounded-md border border-border/60 bg-muted/20 p-2">
        {buckets.map((bucket) => {
          const placed = bucketTotal(bucket);

          return (
            <div
              key={bucket.at}
              className="flex h-full flex-1 flex-col justify-end gap-[1px]"
              title={t('DASHBOARD_ACTIVITY_BUCKET_HINT', {
                time: new Date(bucket.at).toLocaleTimeString(),
                served: bucket.served,
                failed: bucket.failed,
                pending: bucket.pending,
              })}
            >
              {/* Waiting on top, in amber: it is the newest state a request can be in, and it is not
                  a failure yet — an agent turn waits minutes for its first byte here and then
                  succeeds. It used to be drawn red, as part of `failed`, for that whole wait. */}
              {bucket.pending > 0 ? (
                <div className="w-full rounded-t-[1px] bg-warning" style={{ height: `${(bucket.pending / axis) * 100}%` }} />
              ) : null}
              {bucket.failed > 0 ? (
                <div className="w-full rounded-t-[1px] bg-destructive" style={{ height: `${(bucket.failed / axis) * 100}%` }} />
              ) : null}
              {bucket.served > 0 ? <div className="w-full bg-success" style={{ height: `${(bucket.served / axis) * 100}%` }} /> : null}
              {/* An interval the log covers in which nothing was routed is a measured zero, so it
                  gets a baseline tick rather than nothing — an empty column and a column off the
                  end of the log must not look the same. */}
              {placed === 0 ? <div className="h-[2px] w-full rounded-sm bg-muted-foreground/25" /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted-foreground">
        <span>{t('DASHBOARD_ACTIVITY_WINDOW', { minutes: buckets.length })}</span>
        <span className="tabular-nums" data-testid="decision-bars-total">
          {total === 0 ? t('DASHBOARD_ACTIVITY_WINDOW_EMPTY', { minutes: buckets.length }) : t('DASHBOARD_ACTIVITY_WINDOW_TOTAL', { total, peak })}
        </span>
      </div>
    </div>
  );
}

/**
 * `buckets` are computed ONCE at page level and handed down, not derived here.
 *
 * The rail's "routed / failed, last 30 minutes" reads the same array. Deriving it twice — once
 * for the chart and once for the headline above it — is how two figures about the same half hour
 * end up disagreeing after a poll lands between the two calls to `Date.now()`.
 */
export function PoolActivity({
  entries,
  buckets,
  state,
  className,
}: {
  entries: RoutingLogEntry[];
  buckets: RoutingBucket[];
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = Date.now();

  // Content-derived keys: the log grows at the head, so an index would shift under every row.
  const keys = routingLogKeys(entries);
  const activity = routingActivity(entries);

  // Reused, never re-derived: `entry.node` means the SERVER on an outbound row and the SENDER on
  // an inbound one, and collapsing that distinction is the regression #1366 fixed.
  const byNode = routingByNode(entries, t('DASHBOARD_ROUTING_UNPLACED'), t('DASHBOARD_ROUTING_EXHAUSTED_LABEL'));

  /*
   * Tokens over the SAME window as the bars beside them, split into what the engines read and what
   * they wrote. One whole-ring "Tokens" sum mixed the two — and on this fleet they differ by two
   * orders of magnitude (an agent turn is ~16k prompt tokens for ~300 out) — over a span that was
   * eighteen hours on one Hub and twenty minutes on another. The ring figure is kept, in the hint.
   */
  const promptTokens = buckets.reduce((sum, bucket) => sum + bucket.promptTokens, 0);
  const completionTokens = buckets.reduce((sum, bucket) => sum + bucket.completionTokens, 0);
  const segments = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, tone: NODE_TONES[index % NODE_TONES.length] as Tone }));

  // Same partial-coverage reality as the `tokensServed` chip above: a model absent here is not
  // "used zero tokens", it is "every request for it so far landed on an entry with no usage frame".
  const byModel = tokensByModel(entries);
  const tokenSegments = [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, tone: NODE_TONES[index % NODE_TONES.length] as Tone }));

  return (
    <Panel
      title={t('DASHBOARD_ACTIVITY_TITLE')}
      density="compact"
      className={className}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{entries.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_ROUTING_LOG_FAILED')} lines={8}>
        {/* Two columns from `xl` up, where this panel is ~718px wide and a single stack wastes
            half of it. Rate-over-time then sits BESIDE the rows it is read against instead of
            560px above them. Below `xl` the panel is full width and the stack is correct. */}
        <div className="grid gap-3 @4xl:grid-cols-2">
          <div className="space-y-2.5">
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t('DASHBOARD_ACTIVITY_CAVEAT')}</p>

            <StatChipRow>
              <StatChip value={activity.total} label={t('DASHBOARD_ACTIVITY_DECISIONS')} tone={activity.total > 0 ? 'plain' : 'muted'} />
              <StatChip value={activity.served} label={t('DASHBOARD_SERVED')} tone={activity.served > 0 ? 'ok' : 'muted'} />
              <StatChip
                value={promptTokens.toLocaleString()}
                label={t('DASHBOARD_ACTIVITY_PROMPT_TOKENS', { minutes: buckets.length })}
                tone={promptTokens > 0 ? 'plain' : 'muted'}
                hint={t('DASHBOARD_ACTIVITY_TOKENS_WINDOW_HINT', { total: activity.tokensServed.toLocaleString() })}
                hintId="dashboard-activity-prompt-tokens"
              />
              <StatChip
                value={completionTokens.toLocaleString()}
                label={t('DASHBOARD_ACTIVITY_OUTPUT_TOKENS', { minutes: buckets.length })}
                tone={completionTokens > 0 ? 'plain' : 'muted'}
                hint={t('DASHBOARD_ACTIVITY_TOKENS_WINDOW_HINT', { total: activity.tokensServed.toLocaleString() })}
                hintId="dashboard-activity-output-tokens"
              />
              <StatChip value={activity.pending} label={t('DASHBOARD_ACTIVITY_IN_FLIGHT')} tone={activity.pending > 0 ? 'warn' : 'muted'} />
              <StatChip value={activity.failed} label={t('DASHBOARD_FAILED')} tone={activity.failed > 0 ? 'bad' : 'muted'} />
              <StatChip
                value={activity.refused}
                label={t('DASHBOARD_REFUSED')}
                tone={activity.refused > 0 ? 'warn' : 'muted'}
                hint={t('DASHBOARD_REFUSED_HINT')}
                hintId="dashboard-activity-refused"
              />
              <StatChip
                value={activity.failovers}
                label={t('DASHBOARD_FAILOVERS')}
                tone={activity.failovers > 0 ? 'warn' : 'muted'}
                hint={t('DASHBOARD_FAILOVERS_HINT')}
                hintId="dashboard-activity-failovers"
              />
              <StatChip
                value={activity.unplaced}
                label={t('DASHBOARD_ROUTING_UNPLACED')}
                tone={activity.unplaced > 0 ? 'bad' : 'muted'}
                hint={t('DASHBOARD_ACTIVITY_UNPLACED_HINT')}
                hintId="dashboard-activity-unplaced"
              />
              <StatChip value={activity.outbound} label={t('DASHBOARD_OUTBOUND')} tone="muted" />
              <StatChip value={activity.inbound} label={t('DASHBOARD_INBOUND')} tone="muted" />
            </StatChipRow>

            <DecisionBars buckets={buckets} />

            {segments.length > 0 ? (
              <div className="space-y-1.5">
                <StackedBar segments={segments} className="h-3" />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  {segments.map((segment) => (
                    <span key={segment.label} className="inline-flex items-center gap-1.5">
                      <StatusDot tone={segment.tone} className="h-2 w-2" />
                      {segment.label} <span className="tabular-nums font-medium text-foreground">{segment.value}</span>
                    </span>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/80">{t('DASHBOARD_ACTIVITY_BY_NODE_CAVEAT')}</p>
              </div>
            ) : null}

            {tokenSegments.length > 0 ? (
              <div className="space-y-1.5">
                <StackedBar segments={tokenSegments} className="h-3" />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  {tokenSegments.map((segment) => (
                    <span key={segment.label} className="inline-flex items-center gap-1.5">
                      <StatusDot tone={segment.tone} className="h-2 w-2" />
                      {segment.label} <span className="tabular-nums font-medium text-foreground">{segment.value.toLocaleString()}</span>
                    </span>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground/80">{t('DASHBOARD_ACTIVITY_BY_MODEL_TOKENS_CAVEAT')}</p>
              </div>
            ) : null}
          </div>

          {/*
           * Column drops, and what each one costs. FIRST BYTE and ENGINE are diagnostics you go
           * looking for; AGE, NODE, MODEL and OUTCOME are what the feed is scanned for, and they
           * are the four that survive to 360px. DIRECTION is folded into the NODE cell as a
           * glyph rather than dropped, because `entry.node` MEANS SOMETHING DIFFERENT in the two
           * directions — the server on an outbound row, the sender on an inbound one — so a node
           * name with no direction beside it is ambiguous at any width. The glyph carries the
           * word in its `title`.
           *
           * ⚠ ITS OWN `@container`, nested inside the Panel's. Once this panel splits two-up the
           * feed holds only HALF the panel, so drops measured against the Panel let ENGINE in at a
           * 1044px panel and then hand it a 501px box — the table scrolled sideways at exactly the
           * width the split was supposed to make roomy. A container query resolves against the
           * NEAREST container ancestor, so wrapping the feed makes its columns answer to the box
           * they are actually drawn in.
           */}
          <div className="@container">
            <KpiTable
              className="max-h-[420px] overflow-y-auto xl:max-h-[560px]"
              head={
                <>
                  <Th align="right">{t('DASHBOARD_COL_AGE')}</Th>
                  <Th>{t('DASHBOARD_COL_NODE')}</Th>
                  <Th>{t('DASHBOARD_COL_MODEL')}</Th>
                  <Th className="hidden @2xl:table-cell">{t('DASHBOARD_COL_ENGINE')}</Th>
                  <Th align="right" className="hidden @xl:table-cell">
                    {t('DASHBOARD_COL_PROMPT')}
                  </Th>
                  <Th align="right" className="hidden @sm:table-cell">
                    {t('DASHBOARD_COL_FIRST_BYTE')}
                  </Th>
                  <Th align="right">{t('DASHBOARD_COL_OUTCOME')}</Th>
                </>
              }
            >
              {entries.length === 0 ? (
                <TableEmpty colSpan={7}>{t('DASHBOARD_ROUTING_LOG_EMPTY')}</TableEmpty>
              ) : (
                entries.map((entry, index) => {
                  const inbound = entry.direction === 'inbound';
                  const failedOver = entry.failedOverFrom ?? [];
                  // Placed on a node and still waiting for headers. The row is the placement itself,
                  // so the node column names where it is waiting and the first-byte column counts up.
                  const pending = entry.outcome === 'pending';
                  // Answered, but with a refusal of the request: red like any failure, with the status
                  // beside it, since "failed" alone reads as the node breaking. See `isRefused`.
                  const served = settledOutcome(entry) === 'served';
                  const refused = isRefused(entry);
                  // The node's own bad answer, named so it is not read as the app's request or a dead node.
                  const fault = outputFault(entry);
                  // Each node passed over and what it answered, where the Hub says; the names alone otherwise.
                  const failoverDetail =
                    entry.attempts && entry.attempts.length > 0
                      ? entry.attempts.map((attempt) => `${attempt.node} (${attempt.reason})`).join(', ')
                      : failedOver.join(', ');
                  // A nodeless outbound row is one of two outcomes, and they are named apart: every
                  // candidate tried and failed, or none existed. Either way it must not read as the
                  // local node having served it. The first used to render "Unplaced · +9 tried",
                  // which says nothing was tried and that nine nodes were, in one row.
                  const exhausted = isExhausted(entry);
                  const unplaced = !inbound && !entry.node && !pending && !exhausted;
                  const triedCount = typeof entry.candidates === 'number' && entry.candidates > 0 ? entry.candidates : failedOver.length;
                  const promptEstimate = estimatedPromptTokens(entry);

                  return (
                    <Tr key={keys[index]}>
                      <Td align="right" className="text-muted-foreground">
                        {relativeAge(entry.at, now)}
                      </Td>
                      <Td className="max-w-[104px] truncate font-medium @sm:max-w-[160px]" title={entry.node ?? undefined}>
                        <span
                          className={cn('mr-1 text-[11px]', inbound ? 'text-muted-foreground' : 'text-primary')}
                          title={inbound ? t('DASHBOARD_ACTIVITY_DIR_IN') : t('DASHBOARD_ACTIVITY_DIR_OUT')}
                        >
                          {inbound ? '↓' : '↑'}
                        </span>
                        {exhausted ? (
                          <span className="italic text-destructive" title={t('DASHBOARD_ACTIVITY_FAILOVER_FROM', { nodes: failoverDetail })}>
                            {t('DASHBOARD_ROUTING_EXHAUSTED', { count: triedCount })}
                          </span>
                        ) : unplaced ? (
                          <span className="italic text-destructive">{t('DASHBOARD_ROUTING_UNPLACED')}</span>
                        ) : (
                          (entry.node ?? DASH).split('.')[0]
                        )}
                      </Td>
                      {/* An inbound row names the model the peer asked for; a Hub predating that, or a
                        peer that said nothing, leaves it empty, and a dash here is the record. */}
                      <Td
                        className="max-w-[88px] truncate font-mono @sm:max-w-[140px] @2xl:max-w-[200px]"
                        title={inbound && !entry.model ? t('DASHBOARD_INBOUND_NO_MODEL') : (entry.model ?? undefined)}
                      >
                        {entry.model ?? DASH}
                      </Td>
                      <Td className="hidden text-muted-foreground @2xl:table-cell">{entry.backend ?? DASH}</Td>
                      {/* The prompt's size is what a first-byte time has to be read against: 6 minutes
                          for ~39k tokens on a CPU-served node is the machine working, and for ~2k it is
                          a fault. An estimate (`bytes / 4`), so it carries a tilde. */}
                      <Td align="right" className="hidden text-muted-foreground @xl:table-cell">
                        {promptEstimate === null ? DASH : t('DASHBOARD_PROMPT_TOKENS', { tokens: compactTokens(promptEstimate) })}
                      </Td>
                      <Td
                        align="right"
                        className="hidden whitespace-nowrap @sm:table-cell"
                        title={
                          [
                            promptEstimate !== null || typeof entry.budgetMs === 'number'
                              ? t('DASHBOARD_FIRST_BYTE_HINT', {
                                  tokens: promptEstimate === null ? DASH : compactTokens(promptEstimate),
                                  budget: humanDuration(entry.budgetMs),
                                })
                              : undefined,
                            // The cell is the wait for headers; the whole answer took this long.
                            typeof entry.totalMs === 'number' ? t('DASHBOARD_TOTAL_TIME_HINT', { total: humanDuration(entry.totalMs) }) : undefined,
                          ]
                            .filter(Boolean)
                            .join(' · ') || undefined
                        }
                      >
                        {pending ? (
                          <span className="text-warning">{t('DASHBOARD_ACTIVITY_WAITING', { elapsed: relativeAge(entry.at, now) })}</span>
                        ) : (
                          humanDuration(entry.durationMs)
                        )}
                      </Td>
                      <Td
                        align="right"
                        title={[typeof entry.status === 'number' ? `${entry.outcome} ${entry.status}` : entry.outcome, entry.reason ?? undefined]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        <span className="inline-flex items-center justify-end gap-1.5">
                          {refused ? (
                            <span className="text-[11px] text-destructive" title={t('DASHBOARD_REFUSED_ROW_HINT', { status: entry.status ?? DASH })}>
                              {t('DASHBOARD_REFUSED_SHORT', { status: entry.status ?? DASH })}
                            </span>
                          ) : null}
                          {fault ? (
                            <span
                              className="text-[11px] text-destructive"
                              data-testid="pool-activity-bad-output"
                              title={t(fault === 'degenerate-output' ? 'DASHBOARD_DEGENERATE_ROW_HINT' : 'DASHBOARD_TRUNCATED_ROW_HINT')}
                            >
                              {t(fault === 'degenerate-output' ? 'DASHBOARD_DEGENERATE_SHORT' : 'DASHBOARD_TRUNCATED_SHORT')}
                            </span>
                          ) : null}
                          {/* Not on an exhausted row: its node cell already says how many were tried. */}
                          {failedOver.length > 0 && !exhausted ? (
                            <span className="text-[11px] text-warning" title={t('DASHBOARD_ACTIVITY_FAILOVER_FROM', { nodes: failoverDetail })}>
                              {t('DASHBOARD_FAILOVER_SHORT', { total: failedOver.length })}
                            </span>
                          ) : null}
                          {entry.pin ? <span className="text-[11px] text-muted-foreground">{t('DASHBOARD_PIN_SHORT')}</span> : null}
                          <StatusDot tone={served ? 'ok' : pending ? 'warn' : 'bad'} className={pending ? 'motion-safe:animate-pulse' : undefined} />
                        </span>
                      </Td>
                    </Tr>
                  );
                })
              )}
            </KpiTable>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}
