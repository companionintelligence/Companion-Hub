import {
  DASH,
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
import { type RoutingBucket, routingActivity, routingBuckets } from '@/modules/system/pool-node-series';
import { type LoadState, type RoutingLogEntry, routingByNode, routingLogKeys } from '@/modules/system/use-dashboard-data';
import { useMemo } from 'react';
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
 *     fake queue by the back door, with a four-minute job reading 200ms;
 *   - `inFlightRequests` is a COUNT per node, never a list, so nothing links a live request to a
 *     row in this table.
 *
 * So: a feed of DECISIONS, newest first, next to counts. The one thing here that IS a real time
 * series is the decisions-per-minute chart, and it is measured rather than watched — every record
 * carries the instant of its decision, so the shape survives a reload. It still charts requests
 * ROUTED per minute, never work in progress.
 */

const NODE_TONES = ['ok', 'plain', 'warn', 'muted'] as const;

const BUCKET_MS = 60_000;
const BUCKET_COUNT = 30;

function DecisionBars({ buckets }: { buckets: RoutingBucket[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...buckets.map((bucket) => bucket.served + bucket.failed));
  const busiest = buckets.reduce((sum, bucket) => sum + bucket.served + bucket.failed, 0);

  return (
    <div className="space-y-1.5">
      <div className="flex h-24 w-full items-end gap-[2px] rounded-md border border-border/60 bg-muted/20 p-2">
        {buckets.map((bucket) => {
          const total = bucket.served + bucket.failed;

          return (
            <div
              key={bucket.at}
              className="flex h-full flex-1 flex-col justify-end gap-[1px]"
              title={t('DASHBOARD_ACTIVITY_BUCKET_HINT', {
                time: new Date(bucket.at).toLocaleTimeString(),
                served: bucket.served,
                failed: bucket.failed,
              })}
            >
              {bucket.failed > 0 ? (
                <div className="w-full rounded-t-[1px] bg-destructive" style={{ height: `${(bucket.failed / max) * 100}%` }} />
              ) : null}
              {bucket.served > 0 ? <div className="w-full bg-success" style={{ height: `${(bucket.served / max) * 100}%` }} /> : null}
              {/* An interval the log covers in which nothing was routed is a measured zero, so it
                  gets a baseline tick rather than nothing — an empty column and a column off the
                  end of the log must not look the same. */}
              {total === 0 ? <div className="h-[2px] w-full rounded-sm bg-muted-foreground/25" /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-muted-foreground">
        <span>{t('DASHBOARD_ACTIVITY_WINDOW', { minutes: BUCKET_COUNT })}</span>
        <span className="tabular-nums">{t('DASHBOARD_ACTIVITY_WINDOW_TOTAL', { total: busiest, peak: max })}</span>
      </div>
    </div>
  );
}

export function PoolActivity({ entries, state }: { entries: RoutingLogEntry[]; state: LoadState }) {
  const { t } = useTranslation();
  const now = Date.now();

  // Content-derived keys: the log grows at the head, so an index would shift under every row.
  const keys = routingLogKeys(entries);
  const activity = routingActivity(entries);

  // Reused, never re-derived: `entry.node` means the SERVER on an outbound row and the SENDER on
  // an inbound one, and collapsing that distinction is the regression #1366 fixed.
  const byNode = routingByNode(entries, t('DASHBOARD_ROUTING_UNPLACED'));
  const segments = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label, value, tone: NODE_TONES[index % NODE_TONES.length] as Tone }));

  const buckets = useMemo(() => routingBuckets(entries, { now, bucketMs: BUCKET_MS, buckets: BUCKET_COUNT }), [entries, now]);

  return (
    <Panel
      title={t('DASHBOARD_ACTIVITY_TITLE')}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{entries.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_ROUTING_LOG_FAILED')} lines={8}>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t('DASHBOARD_ACTIVITY_CAVEAT')}</p>

        <StatChipRow>
          <StatChip value={activity.total} label={t('DASHBOARD_ACTIVITY_DECISIONS')} tone={activity.total > 0 ? 'plain' : 'muted'} />
          <StatChip value={activity.served} label={t('DASHBOARD_SERVED')} tone={activity.served > 0 ? 'ok' : 'muted'} />
          <StatChip value={activity.failed} label={t('DASHBOARD_FAILED')} tone={activity.failed > 0 ? 'bad' : 'muted'} />
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

        <KpiTable
          className="max-h-[420px] overflow-y-auto"
          head={
            <>
              <Th align="right">{t('DASHBOARD_COL_AGE')}</Th>
              <Th>{t('DASHBOARD_COL_DIRECTION')}</Th>
              <Th>{t('DASHBOARD_COL_NODE')}</Th>
              <Th>{t('DASHBOARD_COL_MODEL')}</Th>
              <Th>{t('DASHBOARD_COL_ENGINE')}</Th>
              <Th align="right">{t('DASHBOARD_COL_FIRST_BYTE')}</Th>
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
              // An outbound row with no node is an attempt nothing took — a real outcome, and the
              // one most worth seeing. It must not read as the local node having served it.
              const unplaced = !inbound && !entry.node;

              return (
                <Tr key={keys[index]}>
                  <Td align="right" className="text-muted-foreground">
                    {relativeAge(entry.at, now)}
                  </Td>
                  <Td className={inbound ? 'text-muted-foreground' : 'text-primary'}>
                    {inbound ? t('DASHBOARD_ACTIVITY_DIR_IN') : t('DASHBOARD_ACTIVITY_DIR_OUT')}
                  </Td>
                  <Td className="max-w-[180px] truncate font-medium" title={entry.node ?? undefined}>
                    {unplaced ? (
                      <span className="italic text-destructive">{t('DASHBOARD_ROUTING_UNPLACED')}</span>
                    ) : (
                      (entry.node ?? DASH).split('.')[0]
                    )}
                  </Td>
                  {/* An inbound row never carries a model — the peer asked, it did not say what
                      for. A dash here is the record, not a gap. */}
                  <Td className="max-w-[200px] truncate font-mono" title={inbound ? t('DASHBOARD_INBOUND_NO_MODEL') : (entry.model ?? undefined)}>
                    {entry.model ?? DASH}
                  </Td>
                  <Td className="text-muted-foreground">{entry.backend ?? DASH}</Td>
                  <Td align="right">{typeof entry.durationMs === 'number' ? `${Math.round(entry.durationMs)}ms` : DASH}</Td>
                  <Td align="right" title={entry.outcome}>
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {failedOver.length > 0 ? (
                        <span className="text-[11px] text-warning" title={t('DASHBOARD_ACTIVITY_FAILOVER_FROM', { nodes: failedOver.join(', ') })}>
                          {t('DASHBOARD_FAILOVER_SHORT', { total: failedOver.length })}
                        </span>
                      ) : null}
                      {entry.pin ? <span className="text-[11px] text-muted-foreground">{t('DASHBOARD_PIN_SHORT')}</span> : null}
                      <StatusDot tone={entry.outcome === 'served' ? 'ok' : 'bad'} />
                    </span>
                  </Td>
                </Tr>
              );
            })
          )}
        </KpiTable>
      </PanelBody>
    </Panel>
  );
}
