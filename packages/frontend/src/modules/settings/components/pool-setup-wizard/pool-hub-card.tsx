import { cn } from '@/lib/utils';
import { Activity, Cpu, Gauge, HardDrive, Laptop, Layers, Loader2, Monitor, Server, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type HubOs, type HubTier, type PeerEngine, normalizeOs, normalizeTier } from './pool-setup-model';

const OS_ICON: Record<HubOs, LucideIcon> = {
  linux: Server,
  macos: Laptop,
  windows: Monitor,
  other: HardDrive,
};

const OS_LABEL_KEY: Record<HubOs, string> = {
  linux: 'HUB_POOL_SETUP_OS_LINUX',
  macos: 'HUB_POOL_SETUP_OS_MACOS',
  windows: 'HUB_POOL_SETUP_OS_WINDOWS',
  other: 'HUB_POOL_SETUP_OS_OTHER',
};

/**
 * What a hardware tier looks like. The colour answers one question at a glance, how much a Hub can take:
 * violet for the strongest, blue for the middle, grey for a machine that only has a CPU. (Not the brand
 * colour: in this theme it is close to white and would make the best Hub look the weakest.)
 * Warning and danger colours are kept for things that are actually wrong, never for a weaker machine.
 */
const TIER_STYLE: Record<HubTier, { icon: LucideIcon; labelKey: string; tile: string; text: string }> = {
  high: {
    icon: Zap,
    labelKey: 'HUB_POOL_SETUP_TIER_HIGH',
    tile: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    text: 'text-violet-600 dark:text-violet-400',
  },
  medium: {
    icon: Gauge,
    labelKey: 'HUB_POOL_SETUP_TIER_MEDIUM',
    tile: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    text: 'text-sky-600 dark:text-sky-400',
  },
  'cpu-only': { icon: Cpu, labelKey: 'HUB_POOL_SETUP_TIER_CPU', tile: 'bg-muted text-muted-foreground', text: 'text-muted-foreground' },
};

export type PoolHubIdentity = 'signed' | 'token';

interface PoolHubSummaryProps {
  /** The name to lead with: the OS hostname, or the display name a peer gave. */
  name: string;
  /** The tailnet name, which is the Hub's identity. Shown small; `wrapAddress` keeps it whole where it is what you approve. */
  address?: string | null;
  wrapAddress?: boolean;
  os?: string | null;
  /** `null` or absent when the tailnet did not say: nothing is shown rather than a guess. */
  online?: boolean | null;
  tier?: string | null;
  /** Only running engines are drawn. A Hub that does not use vLLM is not unhealthy for it. */
  engines?: readonly PeerEngine[];
  models?: number | null;
  /** Requests this Hub is serving for the pool right now. Shown only when above zero. */
  running?: number | null;
  /** How the pairing authenticates: a pinned key, or the older shared token. */
  identity?: PoolHubIdentity | null;
  /** Right-aligned in the header: a status pill, or the one action that belongs to this Hub. */
  trailing?: ReactNode;
}

/**
 * What a Hub is, at a glance, in three bands: who it is (a tile whose colour and glyph say how capable it
 * is, then name and address, then its status), what it offers (tier, models, load, identity as small icon
 * facts), and which engines are running. Spans only, so the same body sits inside a selectable label
 * (Find) and inside a plain card (Connect, Approve).
 *
 * Every fact is optional and drawn only when it is known. Before pairing a Hub is its name, its OS and
 * whether the tailnet sees it online; after, its own report of tier, engines and models joins them.
 */
export function PoolHubSummary({ name, address, wrapAddress, os, online, tier, engines, models, running, identity, trailing }: PoolHubSummaryProps) {
  const { t } = useTranslation();
  const osKey = normalizeOs(os);
  const tierKey = normalizeTier(tier);
  const tierStyle = tierKey ? TIER_STYLE[tierKey] : null;
  // Capability when the Hub has told us, else the machine it runs on.
  const LeadIcon = tierStyle ? tierStyle.icon : OS_ICON[osKey];
  const healthyEngines = engines?.filter((engine) => engine.healthy) ?? [];
  const noEngineRunning = (engines?.length ?? 0) > 0 && healthyEngines.length === 0;
  const hasFacts =
    Boolean(os) || typeof online === 'boolean' || tierStyle !== null || typeof models === 'number' || (running ?? 0) > 0 || identity != null;

  return (
    <span className="flex min-w-0 flex-1 items-start gap-3" data-testid="pool-hub-summary">
      <span
        aria-hidden="true"
        className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tierStyle ? tierStyle.tile : 'bg-muted text-muted-foreground')}
      >
        <LeadIcon className="size-[18px]" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-2">
        {/* The status shares a row with the name only, so the address under it keeps the whole width of the card. */}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">{name}</span>
            {trailing}
          </span>
          {address ? (
            <span
              title={address}
              className={cn('font-mono text-[11px] font-normal leading-4 text-muted-foreground', wrapAddress ? 'break-all' : 'truncate')}
            >
              {address}
            </span>
          ) : null}
        </span>

        {hasFacts ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-normal">
            {tierStyle ? (
              <Fact icon={tierStyle.icon} className={cn('font-medium', tierStyle.text)}>
                {t(tierStyle.labelKey)}
              </Fact>
            ) : null}
            {typeof models === 'number' ? (
              <Fact icon={Layers} className={models === 0 ? 'text-warning' : 'text-muted-foreground'}>
                {t('HUB_POOL_SETUP_MODELS_COUNT', { count: models })}
              </Fact>
            ) : null}
            {(running ?? 0) > 0 ? (
              <Fact icon={Activity} className="font-medium text-primary">
                {t('HUB_POOL_SETUP_RUNNING', { count: running ?? 0 })}
              </Fact>
            ) : null}
            {os ? <span className="text-muted-foreground">{t(OS_LABEL_KEY[osKey])}</span> : null}
            {typeof online === 'boolean' ? (
              <span className={cn('inline-flex items-center gap-1.5', online ? 'text-foreground' : 'text-muted-foreground')}>
                <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', online ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
                {online ? t('HUB_POOL_SETUP_ONLINE') : t('HUB_POOL_SETUP_OFFLINE')}
              </span>
            ) : null}
            {identity ? (
              <Fact
                icon={identity === 'signed' ? ShieldCheck : ShieldAlert}
                className={identity === 'signed' ? 'text-success' : 'text-muted-foreground'}
                title={t(identity === 'signed' ? 'HUB_POOL_SETUP_IDENTITY_SIGNED' : 'HUB_POOL_SETUP_IDENTITY_TOKEN')}
              >
                <span className="sr-only">{t(identity === 'signed' ? 'HUB_POOL_SETUP_IDENTITY_SIGNED' : 'HUB_POOL_SETUP_IDENTITY_TOKEN')}</span>
              </Fact>
            ) : null}
          </span>
        ) : null}

        {healthyEngines.length > 0 || noEngineRunning ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {healthyEngines.map((engine) => (
              <span
                key={engine.type}
                className="inline-flex items-center gap-1.5 rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-foreground"
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                {engine.type}
              </span>
            ))}
            {noEngineRunning ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium leading-4 text-destructive">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
                {t('HUB_POOL_SETUP_NO_ENGINE')}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** One small fact: a glyph and a value. The glyph is decoration; the value (or an sr-only label) carries the meaning. */
function Fact({ icon: Icon, children, className, title }: { icon: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1', className)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}

export type PoolPillTone = 'success' | 'warning' | 'danger' | 'muted';

const PILL_TONE: Record<PoolPillTone, string> = {
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
};

/**
 * The state of a Hub's request or connection, as a pill in the card header. It is always words, with the
 * glyph only as an extra, so colour is never the sole signal.
 */
export function PoolStatusPill({
  tone,
  icon: Icon,
  spin = false,
  children,
}: {
  tone: PoolPillTone;
  icon?: LucideIcon;
  spin?: boolean;
  children: ReactNode;
}) {
  const Glyph = spin ? Loader2 : Icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4',
        PILL_TONE[tone],
      )}
    >
      {Glyph ? <Glyph aria-hidden="true" className={cn('size-3 shrink-0', spin && 'animate-spin')} /> : null}
      {children}
    </span>
  );
}

interface PoolHubCardProps extends PoolHubSummaryProps {
  tone?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
  /** Extra lines under the summary: an explanation, the actions for this Hub. */
  children?: ReactNode;
  'data-testid'?: string;
  'data-state'?: string;
}

/** A Hub in a plain (non-selectable) card: the summary plus whatever belongs under it. */
export function PoolHubCard({ tone = 'default', className, children, 'data-testid': testId, 'data-state': state, ...summary }: PoolHubCardProps) {
  return (
    <li
      data-testid={testId}
      data-state={state}
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border bg-card/40 p-3 shadow-xs',
        tone === 'success' && 'border-success/30',
        tone === 'warning' && 'border-warning/40',
        tone === 'danger' && 'border-destructive/40',
        className,
      )}
    >
      <PoolHubSummary {...summary} />
      {children}
    </li>
  );
}
