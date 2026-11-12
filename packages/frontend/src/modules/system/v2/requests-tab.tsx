import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { cn } from '@/lib/utils';
import type { OwnInference, RoutingBucket } from '@/modules/system/pool-node-series';
import { estimatedPromptTokens, type RoutingLogEntry, routingLogKeys } from '@/modules/system/use-dashboard-data';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MinuteBars } from './area-chart';
import { CardBody, type QueryState } from './card-state';
import { formatAgo, formatDuration, formatTokens } from './format';

/*
 * The routing log, which was half of the old page's height. It answers "did the AI requests through
 * this Hub work, and where did they run?", so it has a tab of its own: the last half hour at the
 * top, the log below, newest first. What the old page explained in paragraphs is behind the "?"
 * beside each title.
 *
 * Where a request came from and where it ran are two columns because they are two facts. A row the
 * Hub logged as `inbound` was SENT here by the Hub its `node` names and served here; an `outbound`
 * row started here and ran on its `node` (`local` for this Hub, nothing when no Hub took it).
 */

type Tone = 'ok' | 'bad' | 'wait' | 'muted';

function resultOf(entry: RoutingLogEntry, t: (key: string, vars?: Record<string, unknown>) => string): { label: string; tone: Tone } {
  if (entry.outcome === 'served') return { label: t('RESOURCES_RESULT_SERVED'), tone: 'ok' };
  if (entry.outcome === 'pending') return { label: t('RESOURCES_RESULT_WORKING'), tone: 'wait' };
  if (entry.clientClosed) return { label: t('RESOURCES_RESULT_CALLER_LEFT'), tone: 'muted' };
  if (entry.requestError?.basis === 'node') return { label: t('RESOURCES_RESULT_CUT_OFF'), tone: 'bad' };
  return { label: entry.reason ? t('RESOURCES_RESULT_FAILED_BECAUSE', { reason: entry.reason }) : t('RESOURCES_RESULT_FAILED'), tone: 'bad' };
}

const TONE: Record<Tone, string> = { ok: 'bg-success', bad: 'bg-destructive', wait: 'bg-warning', muted: 'bg-muted-foreground' };

/** Where a row came from and where it ran, as the names this page uses for Hubs. */
export function requestRoute(entry: RoutingLogEntry, hubName: (node: string) => string, thisHub: string, nobody: string) {
  if (entry.direction === 'inbound') return { from: entry.node ? hubName(entry.node) : nobody, servedBy: thisHub };
  const node = entry.node;
  return { from: thisHub, servedBy: node ? (node === 'local' ? thisHub : hubName(node)) : nobody };
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-2xl font-medium tabular-nums', tone === 'bad' && 'text-destructive')}>{value}</dd>
    </div>
  );
}

export function RequestsTab({
  entries,
  state,
  buckets,
  own,
  hubName,
  unlogged,
  now,
}: {
  entries: RoutingLogEntry[];
  state: QueryState;
  buckets: RoutingBucket[];
  own: OwnInference;
  hubName: (node: string) => string;
  unlogged: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 12);
  const keys = routingLogKeys(entries);
  const bars = buckets.map((b) => ({ at: b.at, ok: b.served + b.pending, bad: b.failed }));
  const thisHub = t('RESOURCES_THIS_HUB');
  const nobody = t('RESOURCES_NO_HUB');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{t('RESOURCES_REQUESTS_WINDOW')}</CardTitle>
            <HintMarker anchorClass="resources-requests-window-hint" hint={t('RESOURCES_REQUESTS_WINDOW_HINT')} />
          </div>
          <CardDescription>{t('RESOURCES_REQUESTS_WINDOW_DESC')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <CardBody state={state} error={t('RESOURCES_REQUESTS_FAILED')} lines={3}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Figure label={t('RESOURCES_REQUESTS')} value={String(own.requests)} />
              <Figure label={t('RESOURCES_FAILED')} value={String(own.failed)} tone={own.failed > 0 ? 'bad' : undefined} />
              <Figure label={t('RESOURCES_FIRST_REPLY_TYPICAL')} value={own.firstByte ? formatDuration(own.firstByte.p50Ms) : '—'} />
              <Figure
                label={t('RESOURCES_TOKENS_IN_OUT')}
                value={own.usageReported ? `${formatTokens(own.promptTokens)} / ${formatTokens(own.completionTokens)}` : '—'}
              />
            </dl>
            {bars.some((bar) => bar.ok + bar.bad > 0) ? (
              <MinuteBars buckets={bars} label={t('RESOURCES_REQUESTS_CHART')} />
            ) : (
              <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                {t('RESOURCES_REQUESTS_WINDOW_EMPTY')}
              </p>
            )}
            {unlogged ? <p className="text-sm text-muted-foreground">{t('RESOURCES_REQUESTS_UNLOGGED')}</p> : null}
          </CardBody>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{t('RESOURCES_REQUESTS_RECENT')}</CardTitle>
            <HintMarker anchorClass="resources-requests-log-hint" hint={t('RESOURCES_REQUESTS_LOG_HINT')} />
          </div>
          {!state.pending && !state.failed ? (
            <CardDescription>
              {entries.length === 0 ? t('RESOURCES_REQUESTS_LOG_EMPTY') : t('RESOURCES_REQUESTS_LOG_SUMMARY', { count: entries.length })}
            </CardDescription>
          ) : null}
        </CardHeader>
        {state.pending || state.failed ? (
          <CardContent>
            <CardBody state={state} error={t('RESOURCES_REQUESTS_FAILED')} lines={5}>
              {null}
            </CardBody>
          </CardContent>
        ) : entries.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 sm:pl-6">{t('RESOURCES_WHEN')}</TableHead>
                  <TableHead>{t('RESOURCES_MODEL')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('RESOURCES_FROM')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('RESOURCES_SERVED_BY')}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t('RESOURCES_PROMPT')}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t('RESOURCES_FIRST_REPLY')}</TableHead>
                  <TableHead className="pr-4 sm:pr-6">{t('RESOURCES_RESULT')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((entry, index) => {
                  const result = resultOf(entry, t);
                  const route = requestRoute(entry, hubName, thisHub, nobody);
                  const prompt = estimatedPromptTokens(entry);
                  return (
                    <TableRow key={keys[index]} data-testid="resources-request-row">
                      <TableCell className="py-2.5 pl-4 whitespace-nowrap text-muted-foreground sm:pl-6">{formatAgo(entry.at, now, t)}</TableCell>
                      <TableCell className="max-w-[12rem] truncate py-2.5 font-medium">{entry.model ?? '—'}</TableCell>
                      <TableCell className="hidden py-2.5 md:table-cell">{route.from}</TableCell>
                      <TableCell className="hidden py-2.5 sm:table-cell">{route.servedBy}</TableCell>
                      <TableCell className="hidden py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">
                        {prompt ? t('RESOURCES_TOKENS', { value: formatTokens(prompt) }) : '—'}
                      </TableCell>
                      <TableCell className="hidden py-2.5 text-right tabular-nums sm:table-cell">{formatDuration(entry.durationMs)}</TableCell>
                      <TableCell className="py-2.5 pr-4 sm:pr-6">
                        <span className={cn('inline-flex items-center gap-2', result.tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>
                          <span className={cn('size-2 shrink-0 rounded-full', TONE[result.tone])} aria-hidden="true" />
                          <span className="truncate">{result.label}</span>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {entries.length > 12 ? (
              <div className="border-t border-border px-6 py-3">
                <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
                  {all ? t('RESOURCES_SHOW_FEWER') : t('RESOURCES_SHOW_ALL', { count: entries.length })}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </div>
  );
}
