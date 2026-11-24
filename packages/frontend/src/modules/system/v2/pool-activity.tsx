import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { StackedBar, StatusDot, type Tone } from '@/components/ui/dense/dense';
import { bucketTotal, LOCAL_NODE_KEY, type RoutingBucket } from '@/modules/system/pool-node-series';
import { type RoutingLogEntry, routingByNode } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';
import { CardBody, type QueryState } from './card-state';

/*
 * POOL ACTIVITY: the routing decisions of the last half hour, as bars, and where they were sent.
 *
 * THIS IS NOT A JOB QUEUE. The routing log is written at the DECISION, before the answer streams, so
 * each bar counts requests ROUTED in that minute. A generation that ran for four minutes is one bar,
 * in the minute it was placed, and never a load curve. Amber is a request still waiting for its first
 * byte: it is not a failure yet.
 */

const NODE_TONES: Tone[] = ['ok', 'plain', 'warn', 'muted'];

function DecisionBars({ buckets }: { buckets: RoutingBucket[] }) {
  const { t } = useTranslation();
  const peak = Math.max(0, ...buckets.map(bucketTotal));
  const total = buckets.reduce((sum, bucket) => sum + bucketTotal(bucket), 0);
  // The floor of 1 is for the AXIS only: a bar needs a non-zero denominator. It is never printed.
  const axis = Math.max(1, peak);

  return (
    <div className="space-y-1.5">
      <div className="flex h-24 w-full items-end gap-[2px] rounded-md border border-border/60 bg-muted/20 p-2">
        {buckets.map((bucket) => (
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
            {bucket.pending > 0 ? (
              <div className="w-full rounded-t-[1px] bg-warning" style={{ height: `${(bucket.pending / axis) * 100}%` }} />
            ) : null}
            {bucket.failed > 0 ? (
              <div className="w-full rounded-t-[1px] bg-destructive" style={{ height: `${(bucket.failed / axis) * 100}%` }} />
            ) : null}
            {bucket.served > 0 ? <div className="w-full bg-success" style={{ height: `${(bucket.served / axis) * 100}%` }} /> : null}
            {/* An interval the log covers in which nothing was routed is a measured zero: a baseline tick, not an empty column. */}
            {bucketTotal(bucket) === 0 ? <div className="h-[2px] w-full rounded-sm bg-muted-foreground/25" /> : null}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
        <span>{t('DASHBOARD_ACTIVITY_WINDOW', { minutes: buckets.length })}</span>
        <span className="tabular-nums" data-testid="decision-bars-total">
          {total === 0 ? t('DASHBOARD_ACTIVITY_WINDOW_EMPTY', { minutes: buckets.length }) : t('DASHBOARD_ACTIVITY_WINDOW_TOTAL', { total, peak })}
        </span>
      </div>
    </div>
  );
}

/** The bars, and the share of the half hour each node took. `buckets` is computed once by the page and read here as given. */
export function PoolActivityCard({ buckets, entries, state }: { buckets: RoutingBucket[]; entries: RoutingLogEntry[]; state: QueryState }) {
  const { t } = useTranslation();
  // Reused, never re-derived: `entry.node` means the SERVER on an outbound row and the SENDER on an inbound one.
  const byNode = routingByNode(entries, t('DASHBOARD_ROUTING_UNPLACED'), t('DASHBOARD_ROUTING_EXHAUSTED_LABEL'));
  const nodeName = (node: string) => (node === LOCAL_NODE_KEY ? t('RESOURCES_THIS_HUB') : node);
  const segments = [...byNode.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({ label: nodeName(label), value, tone: NODE_TONES[index % NODE_TONES.length] ?? 'plain' }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('DASHBOARD_ACTIVITY_TITLE')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs leading-relaxed text-muted-foreground">{t('DASHBOARD_ACTIVITY_CAVEAT')}</p>
        <CardBody state={state} error={t('DASHBOARD_ROUTING_LOG_FAILED')} lines={4}>
          <div className="space-y-4">
            <DecisionBars buckets={buckets} />
            {segments.length > 0 ? (
              <div className="space-y-1.5">
                <StackedBar segments={segments} className="h-3" />
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {segments.map((segment) => (
                    <span key={segment.label} className="inline-flex items-center gap-1.5">
                      <StatusDot tone={segment.tone} className="h-2 w-2" />
                      {segment.label} <span className="tabular-nums font-medium text-foreground">{segment.value}</span>
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground/80">{t('DASHBOARD_ACTIVITY_BY_NODE_CAVEAT')}</p>
              </div>
            ) : null}
          </div>
        </CardBody>
      </CardContent>
    </Card>
  );
}
