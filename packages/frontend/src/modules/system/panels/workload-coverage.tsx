import { StatusDot } from '@/components/ui/dense/dense';
import { cn } from '@/lib/utils';
import type { HardwareSummary } from '@/modules/system/use-dashboard-data';
import { useTranslation } from 'react-i18next';

/*
 * THE FOURTH TILE: what this page still does not measure per workload, said in words.
 *
 * The request that produced this board asked for three line graphs — CPU, GPU and LLM tokens.
 * As of the original build, two of those three metrics did not exist anywhere in this product.
 * One of them has since become partly real, and the other has moved to a different axis:
 *
 *   - GPU per workload. Real per-process VRAM now exists (`gpu-process-sampler.service.ts`,
 *     shelling `rocm-smi --showpids` / `nvidia-smi --query-compute-apps`), attributed to whichever
 *     workload's container holds it via `docker top` (`DockerReadFacade.mapPidsToContainers`), and
 *     is drawn as a real chart in `workload-trends.tsx` beside CPU and memory. What is STILL not
 *     measured, and is not a gap in this repo's code but a ceiling in the tools it shells out to:
 *     compute UTILIZATION per process. `rocm-smi`'s own `CU OCCUPANCY` column reads `UNKNOWN` on
 *     every process this fleet has ever shown it, and `nvidia-smi pmon`'s per-process sm/mem/enc/
 *     dec columns are all `-` on this driver — confirmed live on beta-max (AMD) and beta-red
 *     (NVIDIA), 2026-09-15. Neither vendor's own tooling exposes it here.
 *   - Tokens per workload. The routing log now records real token usage when a backend's response
 *     reports one (`response-usage-tap.ts`, wired through `HubPoolRoutingLogService.attachUsage`)
 *     — see the per-model breakdown in `pool-activity.tsx`. But that is tokens per MODEL/NODE, not
 *     per WORKLOAD, and the two are not interchangeable: every inference route apps call
 *     (`v1/chat/completions` etc.) is admitted by `InferenceAccessGuard` on network origin alone
 *     (an `inference` API key is read only for callers outside the appliance, and apps are never
 *     issued one) — it has no concept of which APP is calling at all.
 *     `HUB_INFERENCE_URL` is one shared address every app is configured with the same value for.
 *     Attributing a request to a workload needs caller identity added to that path first; nothing
 *     here estimates one from which model or node happened to serve it.
 *
 * ── Why this is not a Panel, and takes no LoadState ──────────────────────────────────────────
 *
 * It is a statement about INSTRUMENTATION, not a query result. Building it out of `Panel` +
 * `PanelBody` would make it structurally capable of rendering a skeleton or a red failure box,
 * and either one would say "this measurement is on its way / temporarily broken" about a
 * measurement that was never built. Nothing here changes with data.
 *
 * ── Why there is no dashed border ────────────────────────────────────────────────────────────
 *
 * `StepAreaChart`'s zero-observation branch renders `border-dashed border-border/70 bg-muted/20`,
 * and `pool-nodes.tsx` uses a dashed border for "no engines reported". On this page dashed already
 * means WAITING FOR SAMPLES. Reusing it here would make "never built" and "not yet observed" share
 * an encoding — the same class of error as rendering an unmeasured value as 0. A solid left accent
 * rule is unambiguous and collides with nothing.
 *
 * ── Why there is no icon ─────────────────────────────────────────────────────────────────────
 *
 * There is deliberately no `<svg>` in this subtree, and `workload-coverage.render.test.tsx`
 * asserts it. An empty bordered plot area beside a populated one reads as loading-or-broken, so
 * the guarantee worth having is structural rather than a matter of care: this tile has no axis,
 * no gridline, no baseline, no plot frame, no legend swatch and no tone colour. A decorative icon
 * would be an `<svg>` and would cost that guarantee its enforceability, which is a poor trade for
 * an 14px glyph.
 *
 * ── Copy rules, for whoever edits the strings later ──────────────────────────────────────────
 *
 * The GPU tag is now "VRAM only" — real, but scoped, so it must never regress back to a blanket
 * "not measured" now that half of it is true. The tokens tag stays "not recorded", present tense —
 * that half genuinely still is not, per-workload. NEVER "0". Never a dash. Never "no data" (reads
 * as an empty result set). Never "unavailable" (reads as a failed fetch). Never "coming soon" (a
 * roadmap promise this page has no business making).
 *
 * NEVER, so that a later contributor does not undo this: no zero series in the trend charts this
 * tile points at; no percentage derived from `gpuPressure` (a 0-3 band — `BandMeter`'s doc comment
 * explains why a meter would be a lie, and it is a per-NODE figure regardless, not per-workload);
 * no per-process GPU UTILIZATION invented from VRAM, CPU%, or anything else, because the real VRAM
 * number existing now is exactly what makes a fabricated utilization number beside it most
 * dangerous — it would borrow the real one's credibility; and no token count attributed to a
 * WORKLOAD by guessing from model/node/timing, because the real per-model number existing now is
 * the same trap one level over.
 */

function CoverageBlock({ label, tag, why, enable, nearest }: { label: string; tag: string; why: string; enable: string; nearest: string }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <StatusDot tone="muted" />
        <span className="text-[12px] font-medium">{label}</span>
        <span className="text-[10px] uppercase tracking-[0.5px] text-muted-foreground/70">{tag}</span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{why}</p>
      <p className="text-[11px] leading-snug text-muted-foreground/70">{enable}</p>
      <p className="text-[11px] leading-snug text-muted-foreground/70">{nearest}</p>
    </div>
  );
}

export function WorkloadCoverage({ hardware, className }: { hardware: HardwareSummary | undefined; className?: string }) {
  const { t } = useTranslation();

  /*
   * The one thing this tile reads, and the only number it is allowed to show: the host GPU's own
   * identity. That is a fact about hardware, not a metric, and it cannot be mistaken for a
   * per-workload measurement. It is optional and never gates the tile — the statement about what
   * is not instrumented is true whether or not `/inference/hardware` answered.
   */
  const gpu = hardware?.gpu;
  const describedGpu = gpu ? [gpu.vendor, gpu.model].filter(Boolean).join(' ') : '';
  const gpuName = describedGpu && gpu?.vramMb ? `${describedGpu} · ${Math.round(gpu.vramMb / 1024)}G` : describedGpu;

  /*
   * Three states, not two, for the one line that reads live data.
   *
   * `hardware` being undefined means `/inference/hardware` has not answered — in flight, or failed
   * — which is NOT the same fact as a host that answered and reported no GPU. Collapsing them
   * would have this tile, of all the panels on the page, commit the exact absence-vs-failure error
   * it exists to name. The tile still never gates on the query: all three branches render, and the
   * sentence about node pressure bands is true in every one of them.
   */
  const hostLine = gpuName
    ? t('DASHBOARD_COVERAGE_GPU_HOST', { gpu: gpuName })
    : hardware
      ? t('DASHBOARD_COVERAGE_GPU_HOST_UNKNOWN')
      : t('DASHBOARD_COVERAGE_GPU_HOST_UNREAD');

  return (
    <section
      // Named so a test can assert on THIS subtree rather than on the page: the guarantee worth
      // enforcing is that the tile itself draws nothing, and the page around it is full of charts.
      data-testid="workload-coverage"
      className={cn('flex flex-col gap-3 rounded-lg border border-l-2 border-border border-l-muted-foreground/40 bg-card p-3', className)}
    >
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('DASHBOARD_COVERAGE_TITLE')}</h3>

      <CoverageBlock
        label={t('DASHBOARD_COVERAGE_GPU_LABEL')}
        tag={t('DASHBOARD_COVERAGE_GPU_TAG')}
        why={t('DASHBOARD_COVERAGE_GPU_WHY')}
        enable={t('DASHBOARD_COVERAGE_GPU_ENABLE')}
        nearest={hostLine}
      />

      <CoverageBlock
        label={t('DASHBOARD_COVERAGE_TOKENS_LABEL')}
        tag={t('DASHBOARD_COVERAGE_TOKENS_TAG')}
        why={t('DASHBOARD_COVERAGE_TOKENS_WHY')}
        enable={t('DASHBOARD_COVERAGE_TOKENS_ENABLE')}
        nearest={t('DASHBOARD_COVERAGE_TOKENS_NEAREST')}
      />
    </section>
  );
}
