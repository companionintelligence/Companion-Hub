import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { HintMarker } from '@/components/ui/field-hint/field-hint';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { cn } from '@/lib/utils';
import { type OwnInference, type RoutingBucket, settledOutcome } from '@/modules/system/pool-node-series';
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
 * A row the Hub logged as `inbound` was sent here by the Hub its `node` names and ran here. An
 * `outbound` row started here and ran on its `node`: `local` for this Hub, a peer's address, or
 * nothing when no Hub took it. Nearly every row runs on this Hub, so there is no "served by" column:
 * the Result cell names the other Hub on the rare row that ran on one.
 */

type Tone = 'ok' | 'bad' | 'wait' | 'muted';

function resultOf(
  entry: RoutingLogEntry,
  ranOn: string | null,
  t: (key: string, vars?: Record<string, unknown>) => string,
): { label: string; tone: Tone } {
  // `settledOutcome`, as the bars above count it: a refusal the Hub wrote as `served` (an inbound
  // row, or a Hub predating the change) is a failure, not a green "Served".
  const outcome = settledOutcome(entry);
  if (outcome === 'served') return { label: ranOn ? t('RESOURCES_RESULT_SERVED_BY', { hub: ranOn }) : t('RESOURCES_RESULT_SERVED'), tone: 'ok' };
  if (outcome === 'pending') return { label: ranOn ? t('RESOURCES_RESULT_WORKING_ON', { hub: ranOn }) : t('RESOURCES_RESULT_WORKING'), tone: 'wait' };
  if (entry.clientClosed) return { label: t('RESOURCES_RESULT_CALLER_LEFT'), tone: 'muted' };
  if (entry.requestError?.basis === 'node') return { label: t('RESOURCES_RESULT_CUT_OFF'), tone: 'bad' };
  const reason = entry.reason ?? (typeof entry.status === 'number' ? String(entry.status) : null);
  return { label: reason ? t('RESOURCES_RESULT_FAILED_BECAUSE', { reason }) : t('RESOURCES_RESULT_FAILED'), tone: 'bad' };
}

/**
 * The First reply cell. A streamed reply's `durationMs` is the wait for its first word. A reply that
 * came all at once arrives only when it is done, so its `durationMs` is the whole answer's time, and
 * the cell says so instead of passing it off as a first reply. A Hub too old to report `stream`
 * can't say which, so those rows show the time alone, as before.
 */
function ReplyTime({ entry, t }: { entry: RoutingLogEntry; t: (key: string) => string }) {
  const time = formatDuration(entry.durationMs);
  if (entry.stream !== false) return <>{time}</>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{time}</span>
      <span className="text-xs text-muted-foreground">{t('RESOURCES_WHOLE_ANSWER')}</span>
    </span>
  );
}

const TONE: Record<Tone, string> = { ok: 'bg-success', bad: 'bg-destructive', wait: 'bg-warning', muted: 'bg-muted-foreground' };

/**
 * Where a row came from, and the other Hub it ran on when that wasn't this one, as the names this
 * page uses for Hubs.
 */
export function requestRoute(entry: RoutingLogEntry, hubName: (node: string) => string, thisHub: string): { from: string; ranOn: string | null } {
  if (entry.direction === 'inbound') return { from: entry.node ? hubName(entry.node) : '—', ranOn: null };
  return { from: thisHub, ranOn: entry.node && entry.node !== 'local' ? hubName(entry.node) : null };
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
  partial = false,
  now,
}: {
  entries: RoutingLogEntry[];
  state: QueryState;
  /** Outbound rows only, so the bars count the requests the figures above them count. */
  buckets: RoutingBucket[];
  own: OwnInference;
  hubName: (node: string) => string;
  unlogged: boolean;
  /** The log may be missing rows from the window, so every count above is a floor. */
  partial?: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 12);
  const keys = routingLogKeys(entries);
  const bars = buckets.map((b) => ({ at: b.at, ok: b.served + b.pending, bad: b.failed }));
  const thisHub = t('RESOURCES_THIS_HUB');

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
            {partial ? <p className="text-sm text-warning">{t('RESOURCES_REQUESTS_PARTIAL')}</p> : null}
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
                  <TableHead className="hidden sm:table-cell">{t('RESOURCES_FROM')}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{t('RESOURCES_PROMPT')}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{t('RESOURCES_FIRST_REPLY')}</TableHead>
                  <TableHead className="pr-4 sm:pr-6">{t('RESOURCES_RESULT')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((entry, index) => {
                  const route = requestRoute(entry, hubName, thisHub);
                  const result = resultOf(entry, route.ranOn, t);
                  const prompt = estimatedPromptTokens(entry);
                  return (
                    <TableRow key={keys[index]} data-testid="resources-request-row">
                      <TableCell className="py-2.5 pl-4 whitespace-nowrap text-muted-foreground sm:pl-6">{formatAgo(entry.at, now, t)}</TableCell>
                      <TableCell className="max-w-[12rem] truncate py-2.5 font-medium">{entry.model ?? '—'}</TableCell>
                      <TableCell className="hidden py-2.5 sm:table-cell">{route.from}</TableCell>
                      <TableCell className="hidden py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">
                        {prompt ? t('RESOURCES_TOKENS', { value: formatTokens(prompt) }) : '—'}
                      </TableCell>
                      <TableCell className="hidden py-2.5 text-right tabular-nums sm:table-cell">
                        <ReplyTime entry={entry} t={t} />
                      </TableCell>
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
