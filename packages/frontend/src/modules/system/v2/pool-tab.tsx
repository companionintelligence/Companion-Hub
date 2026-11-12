import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { cn } from '@/lib/utils';
import { PoolReachGraph } from '@/modules/system/panels/pool-reach';
import type { PoolNodeCard } from '@/modules/system/pool-node-series';
import type { PoolReach, PoolStatusSummary } from '@/modules/system/use-dashboard-data';
import { ChevronRight, ExternalLink, Network } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CardBody, type QueryState } from './card-state';
import { formatAgo, formatDuration } from './format';

/*
 * The pool, for the people who run one: the reach drawing (this Hub in the middle, a spoke per
 * paired Hub), one list of Hubs and one list of models. Pool settings live in Settings > AI, so the
 * old page's read-only configuration drawer becomes a link there, shown only to someone who may
 * change them. Everyone else sees the same facts and no buttons.
 */

const STATE: Record<string, { key: string; dot: string; rank: number }> = {
  local: { key: 'RESOURCES_POOL_STATE_ONLINE', dot: 'bg-success', rank: 0 },
  connected: { key: 'RESOURCES_POOL_STATE_CONNECTED', dot: 'bg-success', rank: 1 },
  pending: { key: 'RESOURCES_POOL_STATE_PENDING', dot: 'bg-warning', rank: 2 },
  unreachable: { key: 'RESOURCES_POOL_STATE_UNREACHABLE', dot: 'bg-destructive', rank: 3 },
  disabled: { key: 'RESOURCES_POOL_STATE_OFF', dot: 'bg-muted-foreground', rank: 4 },
};
const stateOf = (status: string) => STATE[status] ?? { key: '', dot: 'bg-muted-foreground', rank: 5 };

function Detail({ label, children, tone }: { label: string; children: React.ReactNode; tone?: 'bad' }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('truncate', tone === 'bad' && 'text-destructive')}>{children}</dd>
    </div>
  );
}

export function PoolTab({
  pool,
  state,
  cards,
  reach,
  models,
  manageHub,
  now,
}: {
  pool: PoolStatusSummary | undefined;
  state: QueryState;
  cards: PoolNodeCard[];
  reach: PoolReach;
  models: { model: string; nodes: string[] }[];
  manageHub: boolean;
  now: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string[]>([]);
  const [allModels, setAllModels] = useState(false);
  const peers = cards.filter((card) => !card.local);
  const local = pool?.localNode;

  if (state.pending || state.failed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('RESOURCES_POOL_HUBS')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CardBody state={state} error={t('RESOURCES_POOL_FAILED')} lines={5}>
            {null}
          </CardBody>
        </CardContent>
      </Card>
    );
  }

  if (peers.length === 0) {
    const off = pool?.enabled === false;
    return (
      <Card data-testid="resources-pool-empty">
        <CardContent className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Network className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
            <div className="space-y-1">
              <h3 className="text-base font-medium">{off ? t('RESOURCES_POOL_OFF_TITLE') : t('RESOURCES_POOL_EMPTY_TITLE')}</h3>
              <p className="text-sm text-muted-foreground">{manageHub ? t('RESOURCES_POOL_EMPTY_BODY') : t('RESOURCES_POOL_EMPTY_MEMBER')}</p>
            </div>
          </div>
          {manageHub ? (
            <Button asChild variant="outline">
              <Link to="/settings?tab=ai">{off ? t('RESOURCES_POOL_TURN_ON') : t('RESOURCES_POOL_ADD_HUB')}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const routingOff = pool?.enabled === false ? 'pool' : pool?.directions?.outbound?.enabled === false ? 'outbound' : null;
  const rows = [...cards].sort((a, b) => stateOf(a.status).rank - stateOf(b.status).rank || a.label.localeCompare(b.label));
  const toggle = (key: string) => setOpen((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  const shownModels = allModels ? models : models.slice(0, 8);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t('RESOURCES_POOL_HUBS')}</CardTitle>
            <CardDescription>
              {t('RESOURCES_POOL_SUMMARY', { connected: reach.connected, count: peers.length, models: reach.reachableModels })}
            </CardDescription>
          </div>
          {manageHub ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/settings?tab=ai">{t('RESOURCES_POOL_SETTINGS')}</Link>
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="pb-2">
          {routingOff ? (
            <p className="mb-3 text-sm text-warning">{routingOff === 'pool' ? t('RESOURCES_POOL_ROUTING_OFF') : t('RESOURCES_POOL_OUTBOUND_OFF')}</p>
          ) : null}
          <PoolReachGraph cards={cards} routingOff={routingOff} className="mx-auto max-w-2xl" />
        </CardContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4 sm:pl-6">{t('RESOURCES_POOL_HUB')}</TableHead>
              <TableHead>{t('RESOURCES_STATUS')}</TableHead>
              <TableHead className="pr-4 text-right sm:pr-6 md:pr-4">{t('RESOURCES_POOL_MODELS')}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t('RESOURCES_POOL_WORKING_ON')}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t('RESOURCES_FIRST_REPLY')}</TableHead>
              <TableHead className="hidden pr-6 text-right md:table-cell">{t('RESOURCES_POOL_SPEED')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((card) => {
              const status = stateOf(card.status);
              const expanded = open.includes(card.key);
              const label = card.local ? t('RESOURCES_THIS_HUB') : card.label;
              return (
                <Fragment key={card.key}>
                  <TableRow className="cursor-pointer" onClick={() => toggle(card.key)} data-testid="resources-pool-row">
                    <TableCell className="py-2.5 pl-4 sm:pl-6">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={t(expanded ? 'RESOURCES_POOL_HIDE_DETAILS' : 'RESOURCES_POOL_SHOW_DETAILS', { name: label })}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(card.key);
                          }}
                          className="-ml-2 cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRight className={cn('size-4 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                        </button>
                        <span className="font-medium">{label}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <span className="inline-flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                        <span className={cn('size-2 rounded-full', status.dot)} aria-hidden="true" />
                        {status.key ? t(status.key) : card.status}
                      </span>
                    </TableCell>
                    <TableCell className="py-2.5 pr-4 text-right tabular-nums sm:pr-6 md:pr-4">{card.models ?? '—'}</TableCell>
                    <TableCell className="hidden py-2.5 text-right tabular-nums md:table-cell">{card.inFlight ?? '—'}</TableCell>
                    <TableCell className="hidden py-2.5 text-right tabular-nums md:table-cell">
                      {card.firstByte ? formatDuration(card.firstByte.p50Ms) : '—'}
                    </TableCell>
                    <TableCell className="hidden py-2.5 pr-6 text-right tabular-nums md:table-cell">
                      {card.decode ? t('RESOURCES_TOKENS_PER_SECOND', { value: Math.round(card.decode.tokensPerSec) }) : '—'}
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell colSpan={6} className="px-4 py-3 sm:px-6">
                        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                          <Detail label={t('RESOURCES_POOL_ADDRESS')}>{(card.local ? local?.nodeFqdn : card.fqdn) ?? '—'}</Detail>
                          {card.local ? (
                            <Detail label={t('RESOURCES_POOL_TAILSCALE')}>
                              {local?.tailscaleConnected
                                ? t('RESOURCES_POOL_TAILSCALE_ON', { tailnet: local.tailnet ?? '—' })
                                : t('RESOURCES_POOL_TAILSCALE_OFF')}
                            </Detail>
                          ) : (
                            <Detail label={t('RESOURCES_POOL_LAST_SEEN')}>{formatAgo(card.lastSeenAt, now, t)}</Detail>
                          )}
                          <Detail label={t('RESOURCES_ENGINES')}>
                            {card.backends
                              .filter((backend) => backend.healthy)
                              .map((backend) => `${backend.type} (${backend.models})`)
                              .join(', ') || '—'}
                          </Detail>
                          {card.hardwareTier ? <Detail label={t('RESOURCES_POOL_TIER')}>{card.hardwareTier}</Detail> : null}
                          {card.consecutiveFailures ? (
                            <Detail label={t('RESOURCES_POOL_FAILED_CHECKS')} tone="bad">
                              {card.consecutiveFailures}
                            </Detail>
                          ) : null}
                        </dl>
                        {!card.local && card.fqdn ? (
                          <a
                            href={`https://${card.fqdn}/resource-monitor`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
                          >
                            {t('RESOURCES_POOL_OPEN_REMOTE')}
                            <ExternalLink className="size-3.5" aria-hidden="true" />
                          </a>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('RESOURCES_POOL_MODELS_TITLE')}</CardTitle>
          <CardDescription>{t('RESOURCES_POOL_MODELS_SUMMARY', { count: models.length })}</CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4 sm:pl-6">{t('RESOURCES_MODEL')}</TableHead>
              <TableHead className="pr-4 text-right sm:pr-6 md:pr-4">{t('RESOURCES_POOL_HUBS_COUNT')}</TableHead>
              <TableHead className="hidden pr-6 sm:table-cell">{t('RESOURCES_POOL_WHERE')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownModels.map((entry) => (
              <TableRow key={entry.model}>
                <TableCell className="max-w-[16rem] truncate py-2.5 pl-4 font-medium sm:pl-6">{entry.model}</TableCell>
                <TableCell className="py-2.5 pr-4 text-right tabular-nums sm:pr-6 md:pr-4">{entry.nodes.length}</TableCell>
                <TableCell className="hidden max-w-[24rem] truncate py-2.5 pr-6 text-muted-foreground sm:table-cell">
                  {entry.nodes.join(', ')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {models.length > 8 ? (
          <div className="border-t border-border px-6 py-3">
            <Button variant="ghost" size="sm" onClick={() => setAllModels((v) => !v)}>
              {allModels ? t('RESOURCES_SHOW_FEWER') : t('RESOURCES_SHOW_ALL', { count: models.length })}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
