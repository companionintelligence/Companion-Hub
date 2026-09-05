import {
  getPoolRoutingLogOptions,
  getPoolRoutingLogQueryKey,
  listDiscoverableOptions,
  listDiscoverableQueryKey,
  poolStatusOptions,
  poolStatusQueryKey,
  updatePoolSettingsMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { approvePeer, pairPeer, rejectPeer, removePeer } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Network } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Detail, DetailGrid, LoadingCard, SectionHeader, StatusBadge } from '../components/network-section/network-section';

/* Shapes mirrored by hand from the backend: every pool route has an empty response schema in
   swagger.json, so the generated SDK types these payloads as `unknown`. Authoritative sources are
   `hub-pool.types.ts` (PoolStatus) and `hub-pool-routing-log.service.ts` (PoolRoutingRecord). */

interface PoolBackendCapability {
  type: string;
  healthy: boolean;
  modelsLoaded: string[];
}

interface PoolPeerCapabilities {
  hardwareTier: string;
  backends: PoolBackendCapability[];
  inFlightRequests?: number;
  updatedAt: string;
}

type PoolPeerStatus = 'pending' | 'connected' | 'unreachable' | 'rejected';

interface PoolPeer {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: PoolPeerStatus;
  consecutiveFailures: number;
  lastSeenAt: string | null;
  lastCapabilities: PoolPeerCapabilities | null;
  inFlightRequests: number;
}

interface PoolSettings {
  poolEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
}

interface PoolStatus {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
  reason: 'active' | 'no_peers' | 'disabled_by_env' | 'disabled_by_setting';
  routingActive: boolean;
  settings: PoolSettings;
  tailscaleAdminApiConfigured: boolean;
  localNode: {
    nodeFqdn: string | null;
    tailnet: string | null;
    tailscaleConnected: boolean;
    inFlightRequests: number;
    hardwareTier: string | null;
    backends: PoolBackendCapability[];
    capabilitiesError: string | null;
  };
  peers: PoolPeer[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number };
  routing: { recorded: number; capacity: number; served: number; failed: number; failovers: number; lastAt: string | null };
}

interface PoolRoutingRecord {
  at: string;
  direction: 'outbound' | 'inbound';
  path: string;
  model: string | null;
  node: string | null;
  peerId: string | null;
  backend: string | null;
  candidates: number;
  attempt: number;
  failedOverFrom: string[];
  outcome: 'served' | 'failed';
  status: number | null;
  durationMs: number;
}

interface PoolRoutingLog {
  entries: PoolRoutingRecord[];
  summary: { recorded: number; capacity: number; served: number; failed: number; failovers: number; lastAt: string | null };
}

interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
}

/** How many routing decisions to render. The buffer holds 200; an operator reads the recent ones. */
const ROUTING_LOG_LIMIT = 25;
const MIN_LOCAL_AFFINITY = 0;
const MAX_LOCAL_AFFINITY = 20;
const MIN_HEALTH_POLL_SECONDS = 10;
const MAX_HEALTH_POLL_SECONDS = 300;

type Translate = (key: string, options?: Record<string, unknown>) => string;

const peerLabel = (peer: { displayName: string | null; nodeFqdn: string }) => peer.displayName || peer.nodeFqdn;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const PeerStatusBadge = ({ status, t }: { status: PoolPeerStatus; t: Translate }) => {
  if (status === 'connected') {
    return <StatusBadge connected label={t('HUB_POOL_STATUS_CONNECTED')} />;
  }
  if (status === 'unreachable') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        {t('HUB_POOL_STATUS_UNREACHABLE')}
      </span>
    );
  }
  return <StatusBadge connected={false} label={t('HUB_POOL_STATUS_PENDING')} />;
};

/** Sub-heading + one line of plain-language help, repeated for each block of the section. */
const Block = ({ title, help, children }: { title: string; help?: string; children: ReactNode }) => (
  <div className="space-y-2 border-t pt-4">
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
    {children}
  </div>
);

/**
 * What the pool can actually serve: every model any reachable node reports, and which nodes have it.
 * Unreachable peers are left out on purpose — their `lastCapabilities` is a cached snapshot of a node
 * that is not currently answering, so listing it would promise capacity the pool cannot deliver.
 */
const mergePoolModels = (status: PoolStatus, localLabel: string): Array<{ model: string; nodes: string[] }> => {
  const byModel = new Map<string, Set<string>>();
  const add = (model: string, node: string) => {
    const nodes = byModel.get(model) ?? new Set<string>();
    nodes.add(node);
    byModel.set(model, nodes);
  };

  for (const backend of status.localNode.backends) {
    if (!backend.healthy) continue;
    for (const model of backend.modelsLoaded) add(model, localLabel);
  }
  for (const peer of status.peers) {
    if (peer.status !== 'connected') continue;
    for (const backend of peer.lastCapabilities?.backends ?? []) {
      if (!backend.healthy) continue;
      for (const model of backend.modelsLoaded) add(model, peerLabel(peer));
    }
  }

  return [...byModel.entries()]
    .map(([model, nodes]) => ({ model, nodes: [...nodes].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.model.localeCompare(b.model));
};

const backendSummary = (backends: PoolBackendCapability[], t: Translate): string =>
  backends
    .map((backend) =>
      backend.healthy
        ? // `models`, not `count`: i18next reads `count` as a plural selector and these keys have no plural forms.
          t('HUB_POOL_BACKEND_SUMMARY', { backend: backend.type, models: backend.modelsLoaded.length })
        : t('HUB_POOL_BACKEND_DOWN', { backend: backend.type }),
    )
    .join(' · ');

export const HubPoolSection = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const demoMode = useDemoMode();

  // `null` means "showing what the server has"; a value means the operator has edited the form and
  // it must not be overwritten by the next 15s poll landing mid-edit.
  const [draft, setDraft] = useState<{ poolLocalAffinity: number; poolHealthPollSeconds: number } | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery({
    ...poolStatusOptions(),
    select: (payload) => payload as PoolStatus,
    refetchInterval: 15_000,
  });

  const { data: discoverable } = useQuery({
    ...listDiscoverableOptions(),
    select: (payload) => payload as DiscoverablePoolPeer[],
    refetchInterval: 30_000,
  });

  const { data: routingLog } = useQuery({
    ...getPoolRoutingLogOptions({ query: { limit: ROUTING_LOG_LIMIT } }),
    select: (payload) => payload as PoolRoutingLog,
    refetchInterval: 15_000,
  });

  const invalidatePool = () => {
    void queryClient.invalidateQueries({ queryKey: poolStatusQueryKey() });
    void queryClient.invalidateQueries({ queryKey: listDiscoverableQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getPoolRoutingLogQueryKey() });
  };

  const settingsMutation = useMutation({
    ...updatePoolSettingsMutation(),
    onSuccess: () => {
      setDraft(null);
      toast.success(t('HUB_POOL_SETTINGS_SAVED'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_SETTINGS_ERROR')),
  });

  const pairMutation = useMutation({
    mutationFn: (nodeFqdn: string) => pairPeer({ body: { nodeFqdn } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_PAIR_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PAIR_ERROR')),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvePeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_APPROVE_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_APPROVE_ERROR')),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectPeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_REJECT_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_REJECT_ERROR')),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => removePeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_UNPAIR_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_UNPAIR_ERROR')),
  });

  if (statusLoading || !status) {
    return <LoadingCard icon={Network} title={t('HUB_POOL_SECTION_TITLE')} />;
  }

  const envLocked = status.disabledBy === 'env';
  const localLabel = t('HUB_POOL_LOCAL_NODE_LABEL');
  const models = mergePoolModels(status, localLabel);
  const pendingInbound = status.peers.filter((peer) => peer.direction === 'inbound' && peer.status === 'pending');
  const pendingOutbound = status.peers.filter((peer) => peer.direction === 'outbound' && peer.status === 'pending');
  const paired = status.peers.filter((peer) => peer.status === 'connected' || peer.status === 'unreachable');

  const form = draft ?? { poolLocalAffinity: status.settings.poolLocalAffinity, poolHealthPollSeconds: status.settings.poolHealthPollSeconds };
  const formDirty =
    form.poolLocalAffinity !== status.settings.poolLocalAffinity || form.poolHealthPollSeconds !== status.settings.poolHealthPollSeconds;

  const reasonCopy: Record<PoolStatus['reason'], string> = {
    active: t('HUB_POOL_REASON_ACTIVE'),
    no_peers: t('HUB_POOL_REASON_NO_PEERS'),
    disabled_by_setting: t('HUB_POOL_REASON_DISABLED_SETTING'),
    disabled_by_env: t('HUB_POOL_REASON_DISABLED_ENV'),
  };

  const saveTuning = () =>
    settingsMutation.mutate({
      body: {
        poolLocalAffinity: clamp(form.poolLocalAffinity, MIN_LOCAL_AFFINITY, MAX_LOCAL_AFFINITY),
        poolHealthPollSeconds: clamp(form.poolHealthPollSeconds, MIN_HEALTH_POLL_SECONDS, MAX_HEALTH_POLL_SECONDS),
      },
    });

  return (
    <Card data-testid="hub-pool-card">
      <SectionHeader
        icon={Network}
        title={t('HUB_POOL_SECTION_TITLE')}
        description={t('HUB_POOL_SECTION_DESC')}
        badge={
          <StatusBadge
            connected={status.routingActive}
            label={status.routingActive ? t('HUB_POOL_STATE_ROUTING') : status.enabled ? t('HUB_POOL_STATE_LOCAL_ONLY') : t('HUB_POOL_STATE_OFF')}
          />
        }
      />
      <CardContent className="space-y-5">
        {/* ── State at a glance ───────────────────────────────────────── */}
        <div className="space-y-3">
          <p
            data-testid="hub-pool-state"
            data-reason={status.reason}
            className={cn(
              'rounded-md border px-3 py-2.5 text-sm',
              status.routingActive ? 'border-success/30 bg-success/10 text-foreground' : 'border-border/70 bg-muted/30 text-muted-foreground',
            )}
          >
            {reasonCopy[status.reason]}
          </p>

          {/* The env flag is the one state a control on this page cannot change, so it reads as a
              notice with a file to edit rather than anything clickable. */}
          {envLocked ? (
            <div data-testid="hub-pool-env-lock" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              <p className="font-medium">{t('HUB_POOL_ENV_LOCK_TITLE')}</p>
              <p className="mt-1 text-xs">{t('HUB_POOL_ENV_LOCK_HINT')}</p>
            </div>
          ) : null}

          <DetailGrid>
            <Detail label={t('HUB_POOL_FIELD_NODE')} value={status.localNode.nodeFqdn ?? t('COMMON_UNKNOWN')} />
            <Detail label={t('HUB_POOL_FIELD_TAILNET')} value={status.localNode.tailnet ?? t('COMMON_UNKNOWN')} />
            <Detail label={t('HUB_POOL_FIELD_HARDWARE')} value={status.localNode.hardwareTier ?? t('COMMON_UNKNOWN')} />
            <Detail label={t('HUB_POOL_FIELD_QUEUE')} value={String(status.localNode.inFlightRequests)} />
            <Detail
              label={t('HUB_POOL_FIELD_PEERS')}
              value={t('HUB_POOL_PEER_COUNTS', {
                connected: status.peerCounts.connected,
                pending: status.peerCounts.pending,
                unreachable: status.peerCounts.unreachable,
              })}
            />
            <Detail
              label={t('HUB_POOL_FIELD_LOCAL_BACKENDS')}
              value={status.localNode.backends.length ? backendSummary(status.localNode.backends, t) : t('HUB_POOL_NO_BACKENDS')}
            />
          </DetailGrid>
          <p className="text-xs text-muted-foreground">{t('HUB_POOL_QUEUE_HINT')}</p>

          {status.localNode.capabilitiesError ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t('HUB_POOL_LOCAL_CAPABILITIES_ERROR', { error: status.localNode.capabilitiesError })}
            </p>
          ) : null}

          {status.localNode.tailscaleConnected ? null : (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{t('HUB_POOL_TAILSCALE_OFFLINE')}</p>
          )}
        </div>

        {/* ── Controls ────────────────────────────────────────────────── */}
        <Block title={t('HUB_POOL_CONTROLS_TITLE')}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Switch
                name="hubPoolEnabled"
                data-testid="hub-pool-toggle"
                checked={status.settings.poolEnabled}
                disabled={demoMode || envLocked || settingsMutation.isPending}
                onCheckedChange={(checked: boolean) => settingsMutation.mutate({ body: { poolEnabled: checked } })}
                label={t('HUB_POOL_TOGGLE_LABEL')}
              />
              <p className="text-xs text-muted-foreground">{envLocked ? t('HUB_POOL_TOGGLE_ENV_LOCKED') : t('HUB_POOL_TOGGLE_HELP')}</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Input
                  type="number"
                  min={MIN_LOCAL_AFFINITY}
                  max={MAX_LOCAL_AFFINITY}
                  name="hubPoolLocalAffinity"
                  data-testid="hub-pool-affinity-input"
                  label={t('HUB_POOL_AFFINITY_LABEL')}
                  disabled={demoMode || settingsMutation.isPending}
                  value={form.poolLocalAffinity}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDraft({ ...form, poolLocalAffinity: Number.isFinite(next) ? next : MIN_LOCAL_AFFINITY });
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('HUB_POOL_AFFINITY_HELP')}</p>
              </div>

              <div className="space-y-1.5">
                <Input
                  type="number"
                  min={MIN_HEALTH_POLL_SECONDS}
                  max={MAX_HEALTH_POLL_SECONDS}
                  name="hubPoolHealthPollSeconds"
                  data-testid="hub-pool-poll-input"
                  label={t('HUB_POOL_POLL_LABEL')}
                  disabled={demoMode || settingsMutation.isPending}
                  value={form.poolHealthPollSeconds}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDraft({ ...form, poolHealthPollSeconds: Number.isFinite(next) ? next : MIN_HEALTH_POLL_SECONDS });
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('HUB_POOL_POLL_HELP')}</p>
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              data-testid="hub-pool-settings-save"
              disabled={demoMode || !formDirty}
              loading={settingsMutation.isPending}
              onClick={saveTuning}
            >
              {t('HUB_POOL_SAVE_BUTTON')}
            </Button>
          </div>
        </Block>

        {/* ── The pool ────────────────────────────────────────────────── */}
        <Block title={t('HUB_POOL_CONNECTED_TITLE')} help={t('HUB_POOL_CONNECTED_HELP')}>
          {paired.length ? (
            <ul className="space-y-2">
              {paired.map((peer) => (
                <li key={peer.id} data-testid="hub-pool-peer" className="space-y-2 rounded-md border px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{peerLabel(peer)}</span>
                        <PeerStatusBadge status={peer.status} t={t} />
                      </div>
                      {/* The FQDN is the identity the token was issued to; the display name is only a label. */}
                      <span className="block truncate font-mono text-xs text-muted-foreground" title={peer.nodeFqdn}>
                        {peer.nodeFqdn}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      intent="danger"
                      disabled={demoMode}
                      loading={removeMutation.isPending && removeMutation.variables === peer.id}
                      onClick={() => removeMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_UNPAIR_BUTTON')}
                    </Button>
                  </div>

                  <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <Detail
                      label={t('HUB_POOL_FIELD_LAST_SEEN')}
                      value={peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleString() : t('HUB_POOL_NEVER_SEEN')}
                    />
                    <Detail label={t('HUB_POOL_FIELD_QUEUE')} value={String(peer.inFlightRequests)} />
                    <Detail label={t('HUB_POOL_FIELD_HARDWARE')} value={peer.lastCapabilities?.hardwareTier ?? t('COMMON_UNKNOWN')} />
                    <Detail
                      label={t('HUB_POOL_FIELD_BACKENDS')}
                      value={peer.lastCapabilities?.backends.length ? backendSummary(peer.lastCapabilities.backends, t) : t('COMMON_UNKNOWN')}
                    />
                  </dl>

                  {peer.status === 'unreachable' ? (
                    <p data-testid="hub-pool-unreachable-hint" className="text-xs text-muted-foreground">
                      {t('HUB_POOL_UNREACHABLE_HINT', { failures: peer.consecutiveFailures })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_CONNECTED_EMPTY')}</p>
          )}
        </Block>

        {/* ── What the pool can serve ─────────────────────────────────── */}
        <Block title={t('HUB_POOL_MODELS_TITLE')} help={t('HUB_POOL_MODELS_HELP')}>
          {models.length ? (
            <ul className="space-y-1.5">
              {models.map((entry) => (
                <li
                  key={entry.model}
                  data-testid="hub-pool-model"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-xs" title={entry.model}>
                    {entry.model}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {entry.nodes.map((node) => (
                      <span key={node} className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground">
                        {node}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_MODELS_EMPTY')}</p>
          )}
        </Block>

        {/* ── Recent routing ──────────────────────────────────────────── */}
        <Block title={t('HUB_POOL_ROUTING_TITLE')} help={t('HUB_POOL_ROUTING_HELP')}>
          {routingLog?.entries.length ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('HUB_POOL_ROUTING_SUMMARY', {
                  served: routingLog.summary.served,
                  failed: routingLog.summary.failed,
                  failovers: routingLog.summary.failovers,
                })}
              </p>
              <ul className="space-y-1.5">
                {routingLog.entries.map((entry) => (
                  <li
                    key={`${entry.at}-${entry.path}-${entry.node ?? 'none'}`}
                    data-testid="hub-pool-routing-entry"
                    className="space-y-1 rounded-md border px-3 py-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{new Date(entry.at).toLocaleTimeString()}</span>
                      <ArrowRightLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="font-medium">
                        {entry.direction === 'outbound'
                          ? t('HUB_POOL_ROUTING_OUTBOUND', { node: entry.node ?? t('HUB_POOL_ROUTING_NO_NODE') })
                          : t('HUB_POOL_ROUTING_INBOUND', { node: entry.node ?? t('HUB_POOL_ROUTING_NO_NODE') })}
                      </span>
                      <span className="font-mono text-muted-foreground">{entry.model ?? entry.path}</span>
                      <span className={cn('ml-auto', entry.outcome === 'served' ? 'text-muted-foreground' : 'font-medium text-danger')}>
                        {entry.outcome === 'served' ? t('HUB_POOL_ROUTING_DURATION', { ms: entry.durationMs }) : t('HUB_POOL_ROUTING_FAILED_LABEL')}
                      </span>
                    </div>
                    {/* One entry per request, so a failover is a chain here, not a run of rows. */}
                    {entry.failedOverFrom.length ? (
                      <p data-testid="hub-pool-routing-failover" className="text-warning">
                        {t('HUB_POOL_ROUTING_FAILOVER', { nodes: entry.failedOverFrom.join(' → ') })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_ROUTING_EMPTY')}</p>
          )}
        </Block>

        {/* ── Discovery and pairing ───────────────────────────────────── */}
        <Block title={t('HUB_POOL_DISCOVERABLE_TITLE')} help={t('HUB_POOL_DISCOVERABLE_HELP')}>
          {status.tailscaleAdminApiConfigured ? (
            discoverable?.length ? (
              <ul className="space-y-2">
                {discoverable.map((device) => (
                  <li key={device.tailscaleDeviceId} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <span className="min-w-0 truncate font-mono text-xs" title={device.nodeFqdn}>
                      {device.hostname}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={demoMode || pairMutation.isPending}
                      loading={pairMutation.isPending && pairMutation.variables === device.nodeFqdn}
                      onClick={() => pairMutation.mutate(device.nodeFqdn)}
                    >
                      {pairMutation.isPending && pairMutation.variables === device.nodeFqdn ? t('HUB_POOL_PAIRING') : t('HUB_POOL_PAIR_BUTTON')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('HUB_POOL_DISCOVERABLE_EMPTY')}</p>
            )
          ) : (
            <p
              data-testid="hub-pool-discovery-unconfigured"
              className="rounded-md border border-border/70 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground"
            >
              {t('HUB_POOL_DISCOVERY_UNCONFIGURED')}
            </p>
          )}
        </Block>

        <Block title={t('HUB_POOL_PENDING_TITLE')} help={t('HUB_POOL_PENDING_HELP')}>
          {!pendingInbound.length && !pendingOutbound.length ? (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_PENDING_EMPTY')}</p>
          ) : (
            <ul className="space-y-2">
              {pendingInbound.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  {/* The FQDN, not the display name: approving issues a fresh token to this exact host,
                      and the name is whatever the (unauthenticated) requester chose to call itself. */}
                  <div className="min-w-0">
                    <span className="block truncate font-mono text-xs" title={peer.nodeFqdn} data-testid="hub-pool-pending-fqdn">
                      {peer.nodeFqdn}
                    </span>
                    {peer.displayName ? <span className="block truncate text-xs text-muted-foreground">{peer.displayName}</span> : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={demoMode}
                      loading={rejectMutation.isPending && rejectMutation.variables === peer.id}
                      onClick={() => rejectMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_REJECT_BUTTON')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={demoMode}
                      loading={approveMutation.isPending && approveMutation.variables === peer.id}
                      onClick={() => approveMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_APPROVE_BUTTON')}
                    </Button>
                  </div>
                </li>
              ))}
              {pendingOutbound.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                  <span className="min-w-0 truncate font-mono text-xs" title={peer.nodeFqdn}>
                    {peerLabel(peer)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t('HUB_POOL_OUTBOUND_WAITING', { name: peerLabel(peer) })}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </CardContent>
    </Card>
  );
};
