import {
  BandMeter,
  DASH,
  humanBytes,
  humanCount,
  Panel,
  PanelBody,
  relativeAge,
  StatusBadge,
  StatusDot,
  StepAreaChart,
  TONE_TEXT,
  type Tone,
} from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import {
  computeCountChartScale,
  nodeInFlightSeries,
  observedPointCount,
  type PoolNodeCard,
  type PoolSampleWindow,
} from '@/modules/system/pool-node-series';
import type { LoadState } from '@/modules/system/use-dashboard-data';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * ONE CARD PER NODE — this Hub and every peer, the pool as a set of machines.
 *
 * The reference this is modelled on puts a live GPU-utilisation curve, VRAM used/total and a CPU
 * percentage on every node. None of those three exist here for a PEER, and inventing them is the
 * one thing this page must not do:
 *
 *   - there is no GPU utilisation percentage anywhere in this product. `gpuPressure` is a smoothed
 *     0-3 BAND, AMD-only, and `null` on most of the fleet — including permanently on any Hub with
 *     no connected peer, where the sampler is disarmed by design. It is drawn as four pips, never
 *     as a meter, because a meter reads as a percentage;
 *   - `/inference/memory` and `/inference/hardware` are LOCAL-ONLY. A peer publishes a hardware
 *     TIER string and nothing else about its CPU, RAM or VRAM;
 *   - a peer's container rollup is real but arrives on a 60-90s chain against our 15s poll, so it
 *     is a readout with an age, never a series. Four identical points per real measurement is a
 *     staircase of the poll, not of the machine.
 *
 * What is left is genuinely live, and it is what the cards chart: in-flight requests, held for the
 * whole request including token streaming, so a long generation is visible for as long as it runs.
 */

const STATUS_TONE: Record<string, Tone> = {
  local: 'ok',
  connected: 'ok',
  pending: 'warn',
  unreachable: 'bad',
  disabled: 'muted',
};

function BackendChip({ backend }: { backend: PoolNodeCard['backends'][number] }) {
  const { t } = useTranslation();

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/20 px-2 py-1 text-[11px]"
      title={t('DASHBOARD_NODE_MODELS_HELD', { total: backend.models })}
    >
      {/* Unknown health is its own dot. A backend on a build that does not report the flag is not
          a healthy backend, and it is not a broken one either. */}
      <StatusDot tone={backend.healthy === null ? 'muted' : backend.healthy ? 'ok' : 'bad'} />
      {backend.type}
      <span className="tabular-nums text-muted-foreground">{backend.models}</span>
    </span>
  );
}

/** One line of the card's right-hand legend: a quiet label, a loud value, an optional caveat. */
function Readout({ label, value, tone = 'plain', hint }: { label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <>
      <dt className="uppercase leading-tight tracking-[0.5px] text-muted-foreground">
        {label}
        {hint ? <span className="block normal-case tracking-normal text-[10px] text-muted-foreground/70">{hint}</span> : null}
      </dt>
      <dd className={cn('text-right text-[15px] font-bold leading-none tabular-nums', TONE_TEXT[tone])}>{value}</dd>
    </>
  );
}

function NodeCard({ card, window: samples }: { card: PoolNodeCard; window: PoolSampleWindow }) {
  const { t } = useTranslation();
  const now = Date.now();

  const series = nodeInFlightSeries(samples, card.key);
  const observed = observedPointCount(series);
  const { max } = computeCountChartScale(series);

  const inFlightLabel = card.local ? t('DASHBOARD_NODE_IN_FLIGHT_LOCAL') : t('DASHBOARD_NODE_IN_FLIGHT_FORWARDED');
  const statusLabel = t(`DASHBOARD_NODE_STATUS_${card.status.toUpperCase()}`, { defaultValue: card.status });

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <StatusDot tone={STATUS_TONE[card.status] ?? 'muted'} className="h-2.5 w-2.5" />
        <h3 className="text-base font-bold tracking-tight">{card.label}</h3>
        {card.local ? <StatusBadge connected label={t('DASHBOARD_NODE_LOCAL')} /> : null}
        <span className="text-[11px] uppercase tracking-[0.5px] text-muted-foreground">{statusLabel}</span>
        {card.direction ? <span className="text-[11px] text-muted-foreground/80">{card.direction}</span> : null}
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={card.fqdn ?? undefined}>
          {card.fqdn ?? DASH}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <span className="rounded-md border border-border bg-muted/20 px-2 py-1 text-[11px] text-muted-foreground">
          {t('DASHBOARD_NODE_TIER', { tier: card.hardwareTier ?? DASH })}
        </span>
        {card.backends.length === 0 ? (
          <span className="rounded-md border border-dashed border-border px-2 py-1 text-[11px] italic text-muted-foreground">
            {t('DASHBOARD_NODE_NO_ENGINES')}
          </span>
        ) : (
          card.backends.map((backend) => <BackendChip key={backend.type} backend={backend} />)
        )}
      </div>

      {/* The chart takes the width and the readouts sit beside it as a legend, which is the
          reference's shape — and the one that stops a 0-3 count from being a thin mark adrift
          in a wide empty box, the complaint that started this rebuild. */}
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_190px]">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.5px] text-muted-foreground">
            <span>{inFlightLabel}</span>
            <span className="tabular-nums">{t('DASHBOARD_NODE_CHART_PEAK', { max })}</span>
          </div>
          <StepAreaChart points={series} max={max} tone="ok" height={84} label={inFlightLabel} />
          <p className="text-[11px] leading-snug text-muted-foreground">
            {observed < 2 ? t('DASHBOARD_NODE_CHART_WAITING', { total: observed }) : t('DASHBOARD_NODE_CHART_SESSION', { total: observed })}
          </p>
        </div>

        <dl className="grid grid-cols-[1fr_auto] content-start items-baseline gap-x-3 gap-y-1.5 text-[11px]">
          {/* Dash, not 0: a node that reported no counter is unread, not idle. */}
          {/* Labelled "now" rather than repeating the chart's own title directly above it. */}
          <Readout label={t('DASHBOARD_NODE_NOW')} value={humanCount(card.inFlight)} tone={(card.inFlight ?? 0) > 0 ? 'ok' : 'muted'} />
          {card.local ? null : (
            <Readout
              label={t('DASHBOARD_NODE_IN_FLIGHT_REPORTED')}
              value={humanCount(card.peerReportedInFlight)}
              tone={(card.peerReportedInFlight ?? 0) > 0 ? 'ok' : 'muted'}
              hint={t('DASHBOARD_NODE_IN_FLIGHT_REPORTED_SUB')}
            />
          )}
          <Readout label={t('DASHBOARD_NODE_MODELS')} value={card.models} tone={card.models > 0 ? 'plain' : 'muted'} />
          {/* Band 0 is a real measurement and must not look like the absence of one, so the pips
              and the words are both driven off `null` rather than off the number. */}
          <Readout
            label={t('DASHBOARD_NODE_PRESSURE')}
            value={<BandMeter value={card.pressureBand} />}
            tone="muted"
            hint={
              card.pressureBand === null
                ? t('DASHBOARD_NODE_PRESSURE_UNKNOWN')
                : t('DASHBOARD_NODE_PRESSURE_BAND', { band: card.pressureBand, source: card.pressureSource ?? t('DASHBOARD_NODE_PRESSURE_POOLED') })
            }
          />
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-2.5 text-[11px] text-muted-foreground">
        {card.containers === null ? (
          <span className="italic">{t('DASHBOARD_NODE_CONTAINERS_UNREPORTED')}</span>
        ) : (
          <>
            <span>
              {t('DASHBOARD_NODE_CONTAINERS', { running: card.containers.running, total: card.containers.total })}
              {card.containers.stopped > 0 ? ` · ${t('DASHBOARD_NODE_CONTAINERS_STOPPED', { total: card.containers.stopped })}` : ''}
            </span>
            <span className="tabular-nums">{t('DASHBOARD_NODE_CONTAINER_CPU', { percent: Math.round(card.containers.cpuPercent) })}</span>
            <span className="tabular-nums">{humanBytes(card.containers.memoryBytes)}</span>
          </>
        )}
        {card.local ? null : <span className="tabular-nums">{t('DASHBOARD_NODE_LAST_SEEN', { age: relativeAge(card.lastSeenAt, now) })}</span>}
        {card.consecutiveFailures ? (
          <span className="text-destructive">{t('DASHBOARD_NODE_FAILURES', { total: card.consecutiveFailures })}</span>
        ) : null}
        {card.fqdn && !card.local ? (
          <a href={`https://${card.fqdn}/resource-monitor`} target="_blank" rel="noreferrer" className="ml-auto underline hover:text-foreground">
            {t('DASHBOARD_NODE_OPEN_MONITOR')}
          </a>
        ) : null}
      </div>

      {card.capabilitiesError ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">{card.capabilitiesError}</p>
      ) : null}
    </section>
  );
}

export function PoolNodes({ cards, window: samples, state }: { cards: PoolNodeCard[]; window: PoolSampleWindow; state: LoadState }) {
  const { t } = useTranslation();

  return (
    <Panel
      // Borderless: the cards carry their own frame, and nesting one border inside another turns
      // a grid of machines into a box of boxes. The Panel is here for its three-state contract.
      className="border-0 bg-transparent p-0"
      title={t('DASHBOARD_POOL_NODES_TITLE')}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{cards.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={6}>
        {cards.length === 0 ? (
          <p className="py-6 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_POOL_NODES_EMPTY')}</p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {cards.map((card) => (
              <NodeCard key={card.key} card={card} window={samples} />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
