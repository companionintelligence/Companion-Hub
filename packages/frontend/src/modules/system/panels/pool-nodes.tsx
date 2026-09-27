import {
  BandMeter,
  DASH,
  humanBytes,
  humanCount,
  humanDuration,
  KpiTable,
  Panel,
  PanelBody,
  relativeAge,
  StatusBadge,
  StatusDot,
  StepAreaChart,
  Td,
  Th,
  TONE_TEXT,
  type Tone,
  Tr,
} from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import {
  computeCountChartScale,
  type DecodeReading,
  nodeInFlightSeries,
  observedPointCount,
  type PoolNodeCard,
  type PoolSampleWindow,
} from '@/modules/system/pool-node-series';
import type { LoadState } from '@/modules/system/use-dashboard-data';
import { ChevronRight } from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

/*
 * THE POOL AS A SET OF MACHINES — one row per node, and the full card one click below it.
 *
 * The row is for scanning across nodes; `NodeCard` is for reading one. Both are here because they
 * are the same facts at two depths, and the card is reused as the expanded row rather than
 * duplicated — see {@link PoolNodes} at the bottom of the file for why that matters.
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

/** A generation rate at the precision it is worth: one decimal below 10 tok/s, where a CPU-served node lives. */
function formatRate(reading: DecodeReading): string {
  return reading.tokensPerSec >= 10 ? String(Math.round(reading.tokensPerSec)) : reading.tokensPerSec.toFixed(1);
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
          {/* `null` is "we could not ask", and renders as a dash rather than a confident zero. */}
          <Readout
            label={t('DASHBOARD_NODE_MODELS')}
            value={card.models === null ? DASH : humanCount(card.models)}
            tone={card.models ? 'plain' : 'muted'}
          />
          {/* The two figures that answer "is this node slow": how long a request waited for its
              first byte here, and how fast it then generated. Neither is a percentage and neither
              is invented for a node that served nothing — see `firstByteByNode` and `latestDecode`. */}
          <Readout
            label={t('DASHBOARD_NODE_FIRST_BYTE')}
            value={
              card.firstByte ? (
                <span className="text-[12px]">
                  {t('DASHBOARD_NODE_FIRST_BYTE_VALUE', { p50: humanDuration(card.firstByte.p50Ms), max: humanDuration(card.firstByte.maxMs) })}
                </span>
              ) : (
                DASH
              )
            }
            tone={card.firstByte ? 'plain' : 'muted'}
            hint={card.firstByte ? t('DASHBOARD_NODE_FIRST_BYTE_HINT', { count: card.firstByte.count }) : t('DASHBOARD_NODE_FIRST_BYTE_NONE')}
          />
          <Readout
            label={t('DASHBOARD_NODE_DECODE')}
            value={card.decode ? t('DASHBOARD_NODE_DECODE_VALUE', { rate: formatRate(card.decode) }) : DASH}
            tone={card.decode ? 'plain' : 'muted'}
            hint={
              card.decode
                ? t('DASHBOARD_NODE_DECODE_HINT', { model: card.decode.model, age: humanDuration(card.decode.ageMs) })
                : t('DASHBOARD_NODE_DECODE_NONE')
            }
          />
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
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
        <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">{card.capabilitiesError}</p>
      ) : null}
    </section>
  );
}

/**
 * The pool as a TABLE of machines, one row each, with the full card one click away.
 *
 * A grid of cards spent ~270px per node on chrome to say what a 22px row says — four nodes filled
 * a laptop screen before a single number about this machine appeared. The row carries the facts an
 * operator scans across nodes (status, name, tier, in-flight now, slowest first byte, its trend, GPU
 * pressure band where any node measures one, generation rate, containers); everything else lives in
 * `NodeCard`, which is REUSED VERBATIM as the expanded
 * row rather than reimplemented. That matters twice over: no information is lost by the collapse,
 * and there is exactly one source for the detail view at every width — so a column dropped below a
 * breakpoint is still reachable, not gone.
 *
 * The drop ORDER is the workload's. In the app shell this panel's container is 481 px at a 1280
 * window, 515 px at 1440 and ~590 px at 1536 (the 17px root makes `@md` 476 px, `@lg` 544, `@xl` 612,
 * `@2xl` 714). The speed columns — slowest first byte and generation rate — are what an agent turn is
 * placed by, so they come in at `@md` with the row's core; tier and the container count, both on the
 * card, wait for `@lg`; the in-flight trend for `@xl`; GPU pressure, where anything measures it, for
 * `@2xl`. They used to sit at `@lg` and `@2xl`, measured on a bare page with no gutter, and neither
 * appeared on a laptop.
 *
 * The WHOLE ROW toggles for pointer and touch, which is what makes this usable on a phone: the row
 * is ~33px tall at `Td`'s `py-1.5` with 13px text — well short of the 44px guideline, and the reason the
 * target is the entire row rather than the 20px chevron, which alone would be well under it. Raising
 * `Td`'s padding to clear 44px was rejected: `Td` is shared with the settings module and every other
 * table on this board, so it would cost vertical density everywhere to fix one row. (An earlier
 * version of this comment claimed `py-2` "clears a 44px target"; it never did, and the 20% vertical-
 * padding trim since took the row from 38px to 33px, so the gap is wider now than when it was written.)
 * The real
 * `<button>` in the first cell carries `aria-expanded`/`aria-controls` for keyboard and screen
 * readers. The button has no handler of its own on purpose: activating it by keyboard dispatches a
 * click that bubbles to the row, so there is one code path and no double-toggle.
 *
 * `KpiTable` keeps its own `overflow-x-auto`. A table scrolling inside its own box is a legitimate
 * idiom and the column drops mean it rarely triggers — unlike the 720px-wide chart this rebuild
 * deleted, which forced the whole PAGE sideways on a phone.
 */
export function PoolNodes({
  cards,
  window: samples,
  state,
  className,
}: {
  cards: PoolNodeCard[];
  window: PoolSampleWindow;
  state: LoadState;
  className?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (key: string) => setExpanded((current) => (current.includes(key) ? current.filter((open) => open !== key) : [...current, key]));

  /*
   * The GPU-pressure column exists only when some node can fill it. On the 2026-09-27 fleet it was
   * empty on all seventeen: the band needs `/host/sys` (mounted nowhere) and reads 0 under Vulkan,
   * which is what these nodes serve on. A column of hollow pips on every row is a column of "not
   * measured", and it cost the width the first-byte and generation columns now use. The header and
   * its cells are gated on the SAME boolean, so the table cannot shift. The card keeps its readout,
   * where "not measured on this node" is said once, in words.
   */
  const showPressure = cards.some((card) => card.pressureBand !== null);
  const columns = 9 + (showPressure ? 1 : 0);

  return (
    <Panel
      title={t('DASHBOARD_POOL_NODES_TITLE')}
      density="compact"
      className={className}
      actions={state.pending || state.failed ? null : <span className="text-[11px] text-muted-foreground">{cards.length}</span>}
    >
      <PanelBody state={state} error={t('DASHBOARD_POOL_FAILED')} lines={6}>
        {cards.length === 0 ? (
          <p className="py-5 text-center text-[13px] italic text-muted-foreground">{t('DASHBOARD_POOL_NODES_EMPTY')}</p>
        ) : (
          <KpiTable
            head={
              <>
                <Th className="w-8">
                  <span className="sr-only">{t('DASHBOARD_COL_EXPAND')}</span>
                </Th>
                <Th>{t('DASHBOARD_COL_STATE')}</Th>
                <Th>{t('DASHBOARD_COL_NODE')}</Th>
                <Th className="hidden @lg:table-cell">{t('DASHBOARD_COL_TIER')}</Th>
                <Th align="right">{t('DASHBOARD_NODE_NOW')}</Th>
                <Th align="right" className="hidden @md:table-cell">
                  {t('DASHBOARD_COL_FIRST_BYTE_MAX')}
                </Th>
                <Th className="hidden w-24 @xl:table-cell">{t('DASHBOARD_COL_TREND')}</Th>
                {showPressure ? <Th className="hidden @2xl:table-cell">{t('DASHBOARD_NODE_PRESSURE')}</Th> : null}
                <Th align="right" className="hidden @md:table-cell">
                  {t('DASHBOARD_COL_DECODE')}
                </Th>
                <Th align="right" className="hidden @lg:table-cell">
                  {t('DASHBOARD_COL_CONTAINERS')}
                </Th>
              </>
            }
          >
            {cards.map((card) => {
              const open = expanded.includes(card.key);
              const detailId = `pool-node-detail-${card.key}`;
              const series = nodeInFlightSeries(samples, card.key);
              const { max } = computeCountChartScale(series);
              const statusLabel = t(`DASHBOARD_NODE_STATUS_${card.status.toUpperCase()}`, { defaultValue: card.status });
              const inFlightLabel = card.local ? t('DASHBOARD_NODE_IN_FLIGHT_LOCAL') : t('DASHBOARD_NODE_IN_FLIGHT_FORWARDED');

              return (
                <Fragment key={card.key}>
                  <Tr className="cursor-pointer" onClick={() => toggle(card.key)} data={{ node: card.key }}>
                    <Td>
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={detailId}
                        className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} strokeWidth={2} />
                        <span className="sr-only">{card.label}</span>
                      </button>
                    </Td>
                    {/* Below `sm` the dot carries the status on its own and the word is dropped —
                        "unreachable" is 80px of a 375px row, and the dot's tone already says it.
                        The word is on the cell's `title` and in the expanded card, so nothing is
                        lost; this is the one column drop where the CONTENT thins rather than the
                        whole cell, because a status column with no cell at all would shift the
                        table and leave the row unreadable. */}
                    <Td title={statusLabel}>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot tone={STATUS_TONE[card.status] ?? 'muted'} />
                        <span className="hidden text-[11px] uppercase tracking-[0.5px] text-muted-foreground sm:inline">{statusLabel}</span>
                      </span>
                    </Td>
                    {/* No "this Hub" badge here: `card.label` for the local node already IS that
                        string, and the status cell beside it already reads "local". The badge
                        earns its place on the expanded card, where the name is a heading. */}
                    <Td className="max-w-[160px] truncate font-medium" title={card.fqdn ?? card.label}>
                      {card.label}
                    </Td>
                    <Td className="hidden text-muted-foreground @lg:table-cell">{card.hardwareTier ?? DASH}</Td>
                    {/* Dash, not 0: a node that reported no counter is unread, not idle. */}
                    <Td align="right" className={(card.inFlight ?? 0) > 0 ? 'font-medium text-success' : 'text-muted-foreground'}>
                      {humanCount(card.inFlight)}
                    </Td>
                    {/* The slowest first byte this node gave in the window — the figure that says
                        which node an agent turn should not be waiting on. A dash is "served nothing
                        streamed in 30 minutes", never "fast". */}
                    <Td
                      align="right"
                      className="hidden whitespace-nowrap @md:table-cell"
                      title={card.firstByte ? t('DASHBOARD_NODE_FIRST_BYTE_HINT', { count: card.firstByte.count }) : undefined}
                    >
                      {card.firstByte ? humanDuration(card.firstByte.maxMs) : <span className="text-muted-foreground">{DASH}</span>}
                    </Td>
                    <Td className="hidden @xl:table-cell">
                      <StepAreaChart variant="row" height={20} points={series} max={max} tone="ok" label={`${card.label} — ${inFlightLabel}`} />
                    </Td>
                    {/* Band 0 is a real measurement and `null` is "this node cannot measure",
                        so the pips are driven off `null` rather than off the number. */}
                    {showPressure ? (
                      <Td className="hidden @2xl:table-cell">
                        <BandMeter value={card.pressureBand} />
                      </Td>
                    ) : null}
                    <Td
                      align="right"
                      className="hidden whitespace-nowrap @md:table-cell"
                      title={
                        card.decode ? t('DASHBOARD_NODE_DECODE_HINT', { model: card.decode.model, age: humanDuration(card.decode.ageMs) }) : undefined
                      }
                    >
                      {card.decode ? (
                        t('DASHBOARD_NODE_DECODE_VALUE', { rate: formatRate(card.decode) })
                      ) : (
                        <span className="text-muted-foreground">{DASH}</span>
                      )}
                    </Td>
                    <Td align="right" className="hidden @lg:table-cell">
                      {card.containers === null ? (
                        <span className="italic text-muted-foreground">{t('DASHBOARD_NODE_CONTAINERS_SHORT_UNREPORTED')}</span>
                      ) : (
                        `${card.containers.running}/${card.containers.total}`
                      )}
                    </Td>
                  </Tr>
                  {open ? (
                    <tr id={detailId}>
                      <td colSpan={columns} className="border-b border-border/70 bg-muted/10 p-0">
                        <NodeCard card={card} window={samples} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </KpiTable>
        )}
      </PanelBody>
    </Panel>
  );
}
