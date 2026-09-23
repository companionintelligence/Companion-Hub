import {
  getPoolRoutingLogOptions,
  getPoolRoutingLogQueryKey,
  listDiscoverableOptions,
  listDiscoverableQueryKey,
  poolStatusOptions,
  poolStatusQueryKey,
  updatePoolSettingsMutation,
} from '@/api-client/@tanstack/react-query.gen';
import { client } from '@/api-client/client.gen';
import { approvePeer, deletePoolPin, pairPeer, rejectPeer, removePeer, upsertPoolPin } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { HintText } from '@/components/ui/field-hint/field-hint';
import { useDemoMode } from '@/lib/hooks/use-demo-mode';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronRight, Network } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import {
  Detail,
  DetailGrid,
  KpiTable,
  LoadingCard,
  SectionHeader,
  StatChip,
  StatChipRow,
  StatusBadge,
  StatusDot,
  TableEmpty,
  Td,
  Th,
  Tr,
} from '../components/network-section/network-section';

/* Shapes mirrored by hand from the backend: every pool route has an empty response schema in
   swagger.json, so the generated SDK types these payloads as `unknown`. Authoritative sources are
   `hub-pool.types.ts` (PoolStatus) and `hub-pool-routing-log.service.ts` (PoolRoutingRecord). */

interface PoolBackendCapability {
  type: string;
  healthy: boolean;
  modelsLoaded: string[];
}

/**
 * Why a peer's health probes are failing, and what to do about it, mirrored from the backend's
 * `PoolPeerProbeFailure` (`hub-pool-probe-failure.ts`). Only `kind` and `action` are read here —
 * `action` is `null` exactly for `'unreachable'`, the one kind the backend expects to clear on its
 * own, so "is action present" is what actually distinguishes "wait" from "go do something."
 */
interface PoolPeerProbeFailureSummary {
  kind: 'unreachable' | 'unauthorized' | 'identity_changed';
  action: string | null;
}

interface PoolPeerCapabilities {
  hardwareTier: string;
  backends: PoolBackendCapability[];
  inFlightRequests?: number;
  /** The far side told us it is not taking work right now. Absent on a peer running an older build. */
  acceptingWork?: boolean;
  updatedAt: string;
}

/* 'rejected' was retired in migration 0059 — nothing ever wrote it, and it overlapped `enabled`. */
type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';

interface PoolPeer {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: PoolPeerStatus;
  /** Per-peer kill switch. Not a lifecycle state: a disabled peer can be `connected` and healthy. */
  enabled: boolean;
  consecutiveFailures: number;
  /** Why this peer's probes are failing, or `null`/absent while they succeed. Process-local on the backend. */
  probeFailure?: PoolPeerProbeFailureSummary | null;
  lastSeenAt: string | null;
  lastCapabilities: PoolPeerCapabilities | null;
  inFlightRequests: number;
  /** How this peer authenticates to us: the original token, or a pinned Ed25519 key. */
  authMode?: 'bearer' | 'signed';
  /** A short hash of the peer's pinned public key. Never the key — the fingerprint is what a human compares. */
  peerKeyFingerprint?: string | null;
}

/**
 * An operator routing pin, as `/status` reports it. `targetAvailable` is the field this card exists
 * to surface: a `prefer` pin never errors, so a pin at a node that is unreachable, disabled,
 * unpaired, or simply no longer holding the model is invisible everywhere else.
 */
interface PoolPin {
  scope: 'default' | 'model';
  model?: string;
  targetKind: 'local' | 'peer';
  peerId?: string;
  mode: 'prefer';
  nodeFqdn: string | null;
  targetAvailable: boolean;
}

interface PoolSettings {
  poolEnabled: boolean;
  poolOutboundEnabled: boolean;
  poolInboundEnabled: boolean;
  poolLocalAffinity: number;
  poolHealthPollSeconds: number;
  poolRequireSignedPeers: boolean;
}

/** This node's own pool identity. Never the private key — only the UUID and a short fingerprint. */
interface PoolIdentitySummary {
  nodeUuid: string | null;
  publicKeyFingerprint: string | null;
  /** Why identity is unusable, when it is — surfaced the same way `capabilitiesError` is. */
  identityError: string | null;
}

/** An outstanding pairing PIN. The digits are returned exactly once, by the mint call, and never here. */
interface PoolPairingPinState {
  active: boolean;
  expiresAt: string | null;
}

interface PoolEnabledState {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
}

interface PoolStatus {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
  directions: { outbound: PoolEnabledState; inbound: PoolEnabledState };
  reason: 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';
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
    identity?: PoolIdentitySummary;
  };
  peers: PoolPeer[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** Optional here, unlike on the backend, so a stale cached payload cannot blank the whole card. */
  pins?: PoolPin[];
  pairingPin?: PoolPairingPinState;
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
  /** Which pin shaped this decision, if any. */
  pin?: { scope: 'default' | 'model'; mode: 'prefer'; targetKind: 'local' | 'peer' } | null;
}

interface PoolRoutingLog {
  entries: PoolRoutingRecord[];
  summary: { recorded: number; capacity: number; served: number; failed: number; failovers: number; lastAt: string | null };
}

/**
 * An unpaired node this Hub can offer to pair with **by name**, from any directory that can attest
 * one: the tailnet (the local Tailscale daemon's peer map, plus the Admin API when a credential is
 * configured) or the CI Portal device registry. The backend merges the two, so a node both know
 * appears once; which directory named it is not rendered, and this shape deliberately omits the
 * `source` badge the backend type carries.
 *
 * A Hub found by LAN address is deliberately not in here: `GET /identify` is unauthenticated and
 * reports no MagicDNS name, so an address has no name to hand the Pair button. Those are paired with
 * from the CLI, where the operator also supplies the PIN that makes the far side disclose its name —
 * `cihub pool pair <address> --pin <digits>`.
 */
interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
}

/** How many routing decisions to render. The buffer holds 200; an operator reads the recent ones. */
const ROUTING_LOG_LIMIT = 25;
/** Above this the matrix is collapsed on first paint — 12 rows is ~340px, the scroll cap. */
const MODEL_TABLE_OPEN_MAX = 12;
/** Past six columns the matrix stops being readable at this card width, so it degrades to a node list. */
const MODEL_MATRIX_MAX_NODES = 6;

const MIN_LOCAL_AFFINITY = 0;
const MAX_LOCAL_AFFINITY = 20;
const MIN_HEALTH_POLL_SECONDS = 10;
const MAX_HEALTH_POLL_SECONDS = 300;

type Translate = (key: string, options?: Record<string, unknown>) => string;

const peerLabel = (peer: { displayName: string | null; nodeFqdn: string }) => peer.displayName || peer.nodeFqdn;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const PeerStatusBadge = ({
  status,
  enabled,
  probeFailureKind,
  t,
}: {
  status: PoolPeerStatus;
  enabled: boolean;
  /** `'identity_changed'` gets its own badge: the one failure kind with a single, certain remedy — see {@link PoolPeerProbeFailureSummary}. */
  probeFailureKind?: PoolPeerProbeFailureSummary['kind'] | null;
  t: Translate;
}) => {
  // Shown instead of, not beside, the lifecycle badge: a peer the operator switched off must not
  // read as "connected" at a glance, whatever the health poll says about it.
  if (!enabled) {
    return (
      <span
        data-testid="hub-pool-peer-disabled-badge"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
        {t('HUB_POOL_STATUS_DISABLED')}
      </span>
    );
  }
  if (status === 'connected') {
    return <StatusBadge connected label={t('HUB_POOL_STATUS_CONNECTED')} />;
  }
  if (status === 'unreachable') {
    // Distinct from plain "Unreachable": this one will never clear on its own, unlike every other
    // reason a probe fails (see HUB_POOL_UNREACHABLE_HINT) — an operator needs to see that at a glance,
    // not only after reading the hint text underneath.
    if (probeFailureKind === 'identity_changed') {
      return (
        <span
          data-testid="hub-pool-peer-needs-repair-badge"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          {t('HUB_POOL_STATUS_NEEDS_REPAIR')}
        </span>
      );
    }
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        {t('HUB_POOL_STATUS_UNREACHABLE')}
      </span>
    );
  }
  return <StatusBadge connected={false} label={t('HUB_POOL_STATUS_PENDING')} />;
};

/**
 * Sub-heading for each block of the section.
 *
 * `help` is a TOOLTIP on the heading, not a paragraph under it. Eight blocks each carried
 * a 25-to-47-word explanation, which together were most of the page's height and pushed
 * the peer table — the thing an operator opens this section to read — below the fold.
 * The strings are unchanged and one hover away; the dotted underline advertises that.
 */
const Block = ({ title, help, children }: { title: string; help?: string; children: ReactNode }) => (
  <div className="space-y-2 border-t pt-3">
    <h3 className="text-[10px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
      {help ? (
        <HintText id={`hub-pool-block-${title}`} hint={help} className="cursor-help underline decoration-dotted underline-offset-2">
          {title}
        </HintText>
      ) : (
        title
      )}
    </h3>
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
  /* Per-view, never persisted: it narrows what is rendered and changes nothing the pool does. */
  const [modelFilter, setModelFilter] = useState('');

  // The peer an Unpair click is waiting on confirmation for; `null` closes the dialog.
  const [unpairTarget, setUnpairTarget] = useState<PoolPeer | null>(null);

  // `isPending`, not `isLoading`: an errored query has `isLoading` false and `data` undefined, so
  // keying the skeleton off `isLoading` would leave a failed fetch rendering it forever.
  const {
    data: status,
    isPending: statusPending,
    isError: statusFailed,
  } = useQuery({
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

  /* The pin being composed: `''` as the model means the pool-wide default pin, and `'local'` as the
     node means this Hub, which has no peer id because it has no peer row. */
  const [pinDraft, setPinDraft] = useState<{ model: string; node: string }>({ model: '', node: 'local' });

  const pinMutation = useMutation({
    mutationFn: (pin: { model: string; node: string }) =>
      upsertPoolPin({
        body: {
          scope: pin.model ? 'model' : 'default',
          ...(pin.model ? { model: pin.model } : {}),
          ...(pin.node === 'local' ? { targetKind: 'local' } : { targetKind: 'peer', targetPeerId: pin.node }),
        } as never,
      }),
    onSuccess: () => {
      setPinDraft({ model: '', node: 'local' });
      toast.success(t('HUB_POOL_PINS_SAVED'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PINS_ERROR')),
  });

  const unpinMutation = useMutation({
    mutationFn: (pin: PoolPin) => deletePoolPin({ query: { scope: pin.scope, ...(pin.model ? { model: pin.model } : {}) } as never }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_PINS_REMOVED'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PINS_ERROR')),
  });

  /* The PIN an operator read off the OTHER Hub's screen. Optional: without one this is the
     pre-existing request/approve flow, which is what keeps a mixed-version fleet pairing at all. */
  const [pairingPinInput, setPairingPinInput] = useState('');
  const pairMutation = useMutation({
    mutationFn: (nodeFqdn: string) => pairPeer({ body: { nodeFqdn, ...(/^\d{6}$/.test(pairingPinInput) ? { pin: pairingPinInput } : {}) } as never }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_PAIR_SUCCESS'));
      setPairingPinInput('');
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
      setUnpairTarget(null);
      toast.success(t('HUB_POOL_UNPAIR_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_UNPAIR_ERROR')),
  });

  /* The two new directional switches. Sent through the generated client's low-level `patch` rather
     than `updatePoolSettingsMutation`: `UpdateHubPoolPreferencesBody` in the generated types does
     not carry these fields until swagger.json and the api-client are regenerated, which happens
     after this lands. Same route, same body shape — fold it back into `settingsMutation` once
     codegen has run. */
  const directionMutation = useMutation({
    mutationFn: (body: { poolOutboundEnabled?: boolean; poolInboundEnabled?: boolean }) =>
      client.patch({ url: '/api/inference/pool/settings', body }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_SETTINGS_SAVED'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_SETTINGS_ERROR')),
  });

  /* The two per-peer verbs. Called through the generated client's low-level `post` rather than a
     named SDK function: `packages/frontend/src/api-client/*` is regenerated from swagger.json after
     this lands, so the typed `enablePeer`/`disablePeer` helpers do not exist yet. Swap this for
     them once codegen has run — the URL is the contract either way. */
  const peerEnabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      client.post({ url: `/api/inference/pool/peers/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}` }),
    onSuccess: (_data, variables) => {
      toast.success(variables.enabled ? t('HUB_POOL_PEER_ENABLED') : t('HUB_POOL_PEER_DISABLED'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PEER_TOGGLE_ERROR')),
  });

  /* Pairing PIN. Through the generated client's low-level verbs for the same reason as the two
     blocks above: the routes are new and `packages/frontend/src/api-client/*` is regenerated from
     swagger.json after this lands. The mint RESPONSE is the only place the digits ever appear —
     `GET status` reports `pairingPin: { active, expiresAt }` and never the value, so polling can
     render the countdown without the PIN becoming re-servable. */
  const [mintedPin, setMintedPin] = useState<string | null>(null);
  const mintPinMutation = useMutation({
    mutationFn: () => client.post({ url: '/api/inference/pool/pairing-pin' }),
    onSuccess: (response) => {
      // Cast rather than a generic: the low-level client types every response as `unknown` until
      // swagger.json and the api-client are regenerated. `hub-pool.controller.ts` is the contract.
      setMintedPin((response.data as { pin?: string } | undefined)?.pin ?? null);
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PIN_MINT_ERROR')),
  });
  const cancelPinMutation = useMutation({
    mutationFn: () => client.delete({ url: '/api/inference/pool/pairing-pin' }),
    onSuccess: () => {
      setMintedPin(null);
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_PIN_CANCEL_ERROR')),
  });

  /* Same DELETE as Unpair, split out only so the toasts match what the operator did: cancelling
     an unanswered outbound request is not the same event as tearing down a live pairing. */
  const cancelRequestMutation = useMutation({
    mutationFn: (id: string) => removePeer({ path: { id } }),
    onSuccess: () => {
      toast.success(t('HUB_POOL_CANCEL_REQUEST_SUCCESS'));
      invalidatePool();
    },
    onError: () => toast.error(t('HUB_POOL_CANCEL_REQUEST_ERROR')),
  });

  if (statusPending) {
    return <LoadingCard icon={Network} title={t('HUB_POOL_SECTION_TITLE')} />;
  }

  /* A poll that failed leaves no status to render. The section self-heals on the next 15s tick, so
     this says what happened rather than sitting on a skeleton that never resolves. */
  if (statusFailed || !status) {
    return (
      <Card data-testid="hub-pool-card">
        <SectionHeader icon={Network} title={t('HUB_POOL_SECTION_TITLE')} />
        <CardContent>
          <p
            data-testid="hub-pool-status-error"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {t('HUB_POOL_STATUS_ERROR')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const envLocked = status.disabledBy === 'env';
  // Each direction has its own .env override, and only its own switch is uncontrollable because of
  // it — the master lock above already disables everything.
  const outboundEnvLocked = !envLocked && status.directions.outbound.disabledBy === 'env';
  const inboundEnvLocked = !envLocked && status.directions.inbound.disabledBy === 'env';
  const localLabel = t('HUB_POOL_LOCAL_NODE_LABEL');
  const models = mergePoolModels(status, localLabel);
  /* Column order is the order the ranker considers: this Hub first, then peers by name.
     Derived from the PEER list rather than from `models`, so a connected peer holding
     nothing still gets a column and reads as empty instead of vanishing from the matrix. */
  const poolNodes = [
    localLabel,
    ...status.peers
      .filter((peer) => peer.status === 'connected')
      .map((peer) => peerLabel(peer))
      .sort((a, b) => a.localeCompare(b)),
  ];
  const asMatrix = poolNodes.length <= MODEL_MATRIX_MAX_NODES;
  const modelQuery = modelFilter.trim().toLowerCase();
  const shownModels = modelQuery ? models.filter((entry) => entry.model.toLowerCase().includes(modelQuery)) : models;
  /* The number worth surfacing while collapsed: a model only one node can serve goes dark
     with that node. */
  const soleSourced = models.filter((entry) => entry.nodes.length === 1).length;
  const pendingInbound = status.peers.filter((peer) => peer.direction === 'inbound' && peer.status === 'pending');
  const pendingOutbound = status.peers.filter((peer) => peer.direction === 'outbound' && peer.status === 'pending');
  const paired = status.peers.filter((peer) => peer.status === 'connected' || peer.status === 'unreachable');
  const pins = status.pins ?? [];
  // Every node an operator can pin to: this Hub, plus each peer that is actually in the pairing (a
  // pending request is not a routing target yet).
  const pinnableNodes = status.peers.filter((peer) => peer.status !== 'pending');
  const pinnedPeerIds = new Set(pins.filter((pin) => pin.targetKind === 'peer').map((pin) => pin.peerId));
  const describePinScope = (pin: PoolPin) => pin.model ?? t('HUB_POOL_PINS_ALL_MODELS');
  const describePinTarget = (pin: PoolPin) => (pin.targetKind === 'local' ? localLabel : (pin.nodeFqdn ?? t('HUB_POOL_PINS_UNPAIRED')));

  const form = draft ?? { poolLocalAffinity: status.settings.poolLocalAffinity, poolHealthPollSeconds: status.settings.poolHealthPollSeconds };
  const formDirty =
    form.poolLocalAffinity !== status.settings.poolLocalAffinity || form.poolHealthPollSeconds !== status.settings.poolHealthPollSeconds;

  const reasonCopy: Record<PoolStatus['reason'], string> = {
    active: t('HUB_POOL_REASON_ACTIVE'),
    no_peers: t('HUB_POOL_REASON_NO_PEERS'),
    partially_disabled: t('HUB_POOL_REASON_PARTIAL'),
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
        badge={
          <StatusBadge
            connected={status.routingActive}
            label={status.routingActive ? t('HUB_POOL_STATE_ROUTING') : status.enabled ? t('HUB_POOL_STATE_LOCAL_ONLY') : t('HUB_POOL_STATE_OFF')}
          />
        }
      />
      <CardContent className="space-y-4">
        {/* ── State at a glance ───────────────────────────────────────── */}
        <div className="space-y-3">
          {/* Only when something is NOT nominal. With routing active the badge in the header
              already says so in one word, and the paragraph restating it was the single largest
              block of prose on the page. `data-reason` stays on a hidden node so the state is
              still assertable without rendering a sentence nobody needs. */}
          {status.routingActive ? (
            <span data-testid="hub-pool-state" data-reason={status.reason} className="sr-only">
              {reasonCopy[status.reason]}
            </span>
          ) : (
            <p
              data-testid="hub-pool-state"
              data-reason={status.reason}
              className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
            >
              {reasonCopy[status.reason]}
            </p>
          )}

          {/* The env flag is the one state a control on this page cannot change, so it reads as a
              notice with a file to edit rather than anything clickable. */}
          {envLocked ? (
            <div data-testid="hub-pool-env-lock" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              <p className="font-medium">{t('HUB_POOL_ENV_LOCK_TITLE')}</p>
              <p className="mt-1 text-xs">{t('HUB_POOL_ENV_LOCK_HINT')}</p>
            </div>
          ) : null}

          {/* Deliberately NOT the pending/unreachable/disabled counts: those are already one
              row each in the paired-Hubs table below, and rendering them twice both duplicated
              the badge text and made the number row longer than the thing it summarises. These
              are the facts that appear nowhere else on the page. */}
          <StatChipRow>
            <StatChip value={status.peerCounts.connected} label={t('HUB_POOL_FIELD_PEERS')} tone={status.peerCounts.connected > 0 ? 'ok' : 'muted'} />
            <StatChip value={status.routing.served} label={t('HUB_POOL_ROUTING_SERVED')} tone={status.routing.served > 0 ? 'ok' : 'muted'} />
            <StatChip value={status.routing.failed} label={t('HUB_POOL_ROUTING_FAILED')} tone={status.routing.failed > 0 ? 'bad' : 'muted'} />
            <StatChip
              value={status.localNode.inFlightRequests}
              label={t('HUB_POOL_FIELD_QUEUE')}
              hint={t('HUB_POOL_QUEUE_HINT')}
              hintId="hub-pool-queue"
            />
            <StatChip value={status.localNode.hardwareTier ?? t('COMMON_UNKNOWN')} label={t('HUB_POOL_FIELD_HARDWARE')} tone="muted" />
          </StatChipRow>

          <DetailGrid>
            <Detail label={t('HUB_POOL_FIELD_NODE')} value={status.localNode.nodeFqdn ?? t('COMMON_UNKNOWN')} />
            <Detail label={t('HUB_POOL_FIELD_TAILNET')} value={status.localNode.tailnet ?? t('COMMON_UNKNOWN')} />
            <Detail
              label={t('HUB_POOL_FIELD_LOCAL_BACKENDS')}
              value={status.localNode.backends.length ? backendSummary(status.localNode.backends, t) : t('HUB_POOL_NO_BACKENDS')}
            />
          </DetailGrid>

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
          {/*
            One wrapping row, not a stack with an indented sub-stack. The indent drew
            "these two are halves of the master", which the disabled state already
            enforces — both halves disable when the master is off — so the vertical
            hierarchy was 196px spent restating a rule the controls apply themselves.
            Env-lock notices stay visible: they name a file to edit, which a tooltip
            would hide from anyone who does not know to hover.
          */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="space-y-1">
                <Switch
                  name="hubPoolEnabled"
                  data-testid="hub-pool-toggle"
                  checked={status.settings.poolEnabled}
                  disabled={demoMode || envLocked || settingsMutation.isPending}
                  onCheckedChange={(checked: boolean) => settingsMutation.mutate({ body: { poolEnabled: checked } })}
                  label={
                    <HintText
                      id="hub-pool-toggle"
                      hint={t('HUB_POOL_TOGGLE_HELP')}
                      className="cursor-help underline decoration-dotted underline-offset-2"
                    >
                      {t('HUB_POOL_TOGGLE_LABEL')}
                    </HintText>
                  }
                />
                {envLocked ? <p className="text-[10px] text-warning">{t('HUB_POOL_TOGGLE_ENV_LOCKED')}</p> : null}
              </div>

              {/* Each renders the PERSISTED value, like the master, so an env override shows
                  what is stored while the state banner explains what is actually in force. */}
              <div className="space-y-1">
                <Switch
                  name="hubPoolOutboundEnabled"
                  data-testid="hub-pool-outbound-toggle"
                  checked={status.settings.poolOutboundEnabled}
                  disabled={demoMode || envLocked || outboundEnvLocked || !status.settings.poolEnabled || directionMutation.isPending}
                  onCheckedChange={(checked: boolean) => directionMutation.mutate({ poolOutboundEnabled: checked })}
                  label={
                    <HintText
                      id="hub-pool-outbound"
                      hint={t('HUB_POOL_OUTBOUND_HELP')}
                      className="cursor-help underline decoration-dotted underline-offset-2"
                    >
                      {t('HUB_POOL_OUTBOUND_LABEL')}
                    </HintText>
                  }
                />
                {outboundEnvLocked ? <p className="text-[10px] text-warning">{t('HUB_POOL_OUTBOUND_ENV_LOCKED')}</p> : null}
              </div>

              <div className="space-y-1">
                <Switch
                  name="hubPoolInboundEnabled"
                  data-testid="hub-pool-inbound-toggle"
                  checked={status.settings.poolInboundEnabled}
                  disabled={demoMode || envLocked || inboundEnvLocked || !status.settings.poolEnabled || directionMutation.isPending}
                  onCheckedChange={(checked: boolean) => directionMutation.mutate({ poolInboundEnabled: checked })}
                  label={
                    <HintText
                      id="hub-pool-inbound"
                      hint={t('HUB_POOL_INBOUND_HELP')}
                      className="cursor-help underline decoration-dotted underline-offset-2"
                    >
                      {t('HUB_POOL_INBOUND_LABEL')}
                    </HintText>
                  }
                />
                {inboundEnvLocked ? <p className="text-[10px] text-warning">{t('HUB_POOL_INBOUND_ENV_LOCKED')}</p> : null}
              </div>
            </div>

            {/* The two tuning numbers sit on the switch row's line rather than in a grid of
                their own: they are small, always both present, and never wrap apart. */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Input
                  type="number"
                  min={MIN_LOCAL_AFFINITY}
                  max={MAX_LOCAL_AFFINITY}
                  name="hubPoolLocalAffinity"
                  data-testid="hub-pool-affinity-input"
                  label={
                    <HintText
                      id="hub-pool-affinity"
                      hint={t('HUB_POOL_AFFINITY_HELP')}
                      className="cursor-help underline decoration-dotted underline-offset-2"
                    >
                      {t('HUB_POOL_AFFINITY_LABEL')}
                    </HintText>
                  }
                  disabled={demoMode || settingsMutation.isPending}
                  value={form.poolLocalAffinity}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDraft({ ...form, poolLocalAffinity: Number.isFinite(next) ? next : MIN_LOCAL_AFFINITY });
                  }}
                />
              </div>

              <div className="w-32">
                <Input
                  type="number"
                  min={MIN_HEALTH_POLL_SECONDS}
                  max={MAX_HEALTH_POLL_SECONDS}
                  name="hubPoolHealthPollSeconds"
                  data-testid="hub-pool-poll-input"
                  label={
                    <HintText
                      id="hub-pool-poll"
                      hint={t('HUB_POOL_POLL_HELP')}
                      className="cursor-help underline decoration-dotted underline-offset-2"
                    >
                      {t('HUB_POOL_POLL_LABEL')}
                    </HintText>
                  }
                  disabled={demoMode || settingsMutation.isPending}
                  value={form.poolHealthPollSeconds}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDraft({ ...form, poolHealthPollSeconds: Number.isFinite(next) ? next : MIN_HEALTH_POLL_SECONDS });
                  }}
                />
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

        {/* ── Routing pins ────────────────────────────────────────────── */}
        {/* Directly under Controls, because a pin overrides the local-affinity knob above it. */}
        <Block title={t('HUB_POOL_PINS_TITLE')} help={t('HUB_POOL_PINS_HELP')}>
          <div className="space-y-3">
            {pins.length ? (
              <ul className="space-y-2">
                {pins.map((pin) => (
                  <li
                    key={`${pin.scope}-${pin.model ?? ''}`}
                    data-testid="hub-pool-pin"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 space-y-0.5">
                      <span className="block break-all font-mono text-xs sm:truncate" title={describePinScope(pin)}>
                        {describePinScope(pin)}
                      </span>
                      <span className="block text-xs text-muted-foreground">{describePinTarget(pin)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {/* The whole reason this list is rendered from `/status` rather than from the
                          stored settings: a soft pin fails silently, so "doing nothing right now"
                          has to be visible or it is never discovered. */}
                      {pin.targetAvailable ? null : (
                        <span
                          data-testid="hub-pool-pin-unavailable"
                          className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning"
                        >
                          {t('HUB_POOL_PINS_UNAVAILABLE')}
                        </span>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="hub-pool-pin-remove"
                        disabled={demoMode}
                        loading={unpinMutation.isPending && unpinMutation.variables === pin}
                        onClick={() => unpinMutation.mutate(pin)}
                      >
                        {t('HUB_POOL_PINS_REMOVE_BUTTON')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t('HUB_POOL_PINS_EMPTY')}</p>
            )}

            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              {/* Populated from the same merged inventory the "What the pool can serve" block below
                  renders, so an operator can only pin a model the pool has actually seen. */}
              <Select value={pinDraft.model} onValueChange={(model: string) => setPinDraft({ ...pinDraft, model: model === '*' ? '' : model })}>
                <SelectTrigger name="hub-pool-pin-model" data-testid="hub-pool-pin-model" label={t('HUB_POOL_PINS_MODEL_LABEL')}>
                  <SelectValue placeholder={t('HUB_POOL_PINS_ALL_MODELS')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">{t('HUB_POOL_PINS_ALL_MODELS')}</SelectItem>
                  {models.map((entry) => (
                    <SelectItem key={entry.model} value={entry.model}>
                      {entry.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={pinDraft.node} onValueChange={(node: string) => setPinDraft({ ...pinDraft, node })}>
                <SelectTrigger name="hub-pool-pin-node" data-testid="hub-pool-pin-node" label={t('HUB_POOL_PINS_NODE_LABEL')}>
                  <SelectValue placeholder={localLabel} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">{localLabel}</SelectItem>
                  {pinnableNodes.map((peer) => (
                    <SelectItem key={peer.id} value={peer.id}>
                      {peerLabel(peer)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                type="button"
                size="sm"
                data-testid="hub-pool-pin-add"
                disabled={demoMode}
                loading={pinMutation.isPending}
                onClick={() => pinMutation.mutate(pinDraft)}
              >
                {t('HUB_POOL_PINS_ADD_BUTTON')}
              </Button>
            </div>
          </div>
        </Block>

        {/* ── The pool ────────────────────────────────────────────────── */}
        {/*
          One row per peer instead of a bordered card carrying a 4-cell `<dl>`. The card
          cost ~128px each; the row costs ~34px, which is set by the switch it has to hold.

          This does NOT undo the mobile stacking from the previous change: `KpiTable` wraps
          in `overflow-x-auto`, so a narrow screen scrolls the table inside its own box
          rather than the page sideways, and every column keeps its natural width instead of
          the identity column being crushed to 31px to make room for the buttons.

          The two capability markers stay because each explains an otherwise-confusing
          reading: `not accepting` is why a healthy peer shows no models, and `bearer` is the
          precondition for `poolRequireSignedPeers` — turning that on while a peer has not
          upgraded takes the pairing down in both directions.
        */}
        <Block title={t('HUB_POOL_CONNECTED_TITLE')} help={t('HUB_POOL_CONNECTED_HELP')}>
          {paired.length ? (
            <KpiTable
              head={
                <>
                  <Th>{t('HUB_POOL_PEER_COL_NODE')}</Th>
                  <Th>{t('HUB_POOL_FIELD_HARDWARE')}</Th>
                  <Th align="right">{t('HUB_POOL_FIELD_QUEUE')}</Th>
                  <Th>{t('HUB_POOL_FIELD_BACKENDS')}</Th>
                  <Th align="right">{t('HUB_POOL_FIELD_LAST_SEEN')}</Th>
                  <Th align="right">{t('HUB_POOL_PEER_COL_ACTIONS')}</Th>
                </>
              }
            >
              {paired.map((peer) => (
                <Tr key={peer.id} testId="hub-pool-peer" data={{ status: peer.status, enabled: String(peer.enabled) }}>
                  <Td className="max-w-[240px]">
                    <div className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="break-all font-medium sm:truncate">{peerLabel(peer)}</span>
                        <PeerStatusBadge status={peer.status} enabled={peer.enabled} probeFailureKind={peer.probeFailure?.kind} t={t} />
                        {peer.enabled && peer.lastCapabilities?.acceptingWork === false ? (
                          <span
                            data-testid="hub-pool-peer-not-accepting"
                            title={t('HUB_POOL_PEER_NOT_ACCEPTING')}
                            className="shrink-0 rounded-sm border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
                          >
                            {t('HUB_POOL_PEER_NOT_ACCEPTING_MARK')}
                          </span>
                        ) : null}
                        {peer.status !== 'pending' && peer.authMode !== 'signed' ? (
                          <span
                            data-testid="hub-pool-peer-bearer"
                            title={t('HUB_POOL_PEER_BEARER_HELP')}
                            className="shrink-0 rounded-sm border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
                          >
                            {t('HUB_POOL_PEER_BEARER')}
                          </span>
                        ) : null}
                      </span>
                      {/* The FQDN is the identity the token was issued to; the label is only a label. */}
                      <span className="break-all font-mono text-[10px] text-muted-foreground sm:truncate" title={peer.nodeFqdn}>
                        {peer.nodeFqdn}
                      </span>
                      {peer.status === 'unreachable' && peer.probeFailure?.action ? (
                        // The backend only sets `action` when "wait, it clears on its own" is false
                        // (see PoolPeerProbeFailureSummary) — this is the operator's actual next step,
                        // already worded with the exact cihub commands, not a generic hint.
                        <span
                          data-testid="hub-pool-peer-needs-repair-hint"
                          className={cn('text-[10px]', peer.probeFailure.kind === 'identity_changed' ? 'text-destructive' : 'text-muted-foreground')}
                        >
                          {peer.probeFailure.action}
                        </span>
                      ) : peer.status === 'unreachable' ? (
                        <span data-testid="hub-pool-unreachable-hint" className="text-[10px] text-muted-foreground">
                          {t('HUB_POOL_UNREACHABLE_HINT', { failures: peer.consecutiveFailures })}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="text-muted-foreground">{peer.lastCapabilities?.hardwareTier ?? t('COMMON_UNKNOWN')}</Td>
                  {/* Dash, not 0, when the probe has not landed: an idle peer and an unread
                      counter are different facts that send an operator to different places. */}
                  <Td align="right">{typeof peer.inFlightRequests === 'number' ? String(peer.inFlightRequests) : t('COMMON_UNKNOWN')}</Td>
                  <Td
                    className="max-w-[200px] truncate text-muted-foreground"
                    title={peer.lastCapabilities?.backends.length ? backendSummary(peer.lastCapabilities.backends, t) : undefined}
                  >
                    {peer.lastCapabilities?.backends.length ? backendSummary(peer.lastCapabilities.backends, t) : t('COMMON_UNKNOWN')}
                  </Td>
                  <Td align="right" className="whitespace-nowrap text-muted-foreground">
                    {peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleString() : t('HUB_POOL_NEVER_SEEN')}
                  </Td>
                  <Td align="right">
                    <span className="flex items-center justify-end gap-2">
                      {/* Instantly reversible and NOT a revocation: both tokens and the pairing
                          survive, so this needs no dialog. Unpair, beside it, is the one that revokes. */}
                      <Switch
                        name={`hub-pool-peer-enabled-${peer.id}`}
                        data-testid="hub-pool-peer-toggle"
                        checked={peer.enabled}
                        disabled={demoMode || peerEnabledMutation.isPending}
                        onCheckedChange={(checked: boolean) => peerEnabledMutation.mutate({ id: peer.id, enabled: checked })}
                        aria-label={t('HUB_POOL_PEER_TOGGLE_LABEL')}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        intent="danger"
                        data-testid="hub-pool-unpair-btn"
                        disabled={demoMode}
                        loading={removeMutation.isPending && removeMutation.variables === peer.id}
                        onClick={() => setUnpairTarget(peer)}
                      >
                        {t('HUB_POOL_UNPAIR_BUTTON')}
                      </Button>
                    </span>
                  </Td>
                </Tr>
              ))}
            </KpiTable>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_CONNECTED_EMPTY')}</p>
          )}
        </Block>

        {/* ── What the pool can serve ─────────────────────────────────── */}
        {/*
          A presence MATRIX, not one bordered row per model.
          The chip list spent 47px per model — a border, `py-2` and a gap — to carry a name
          and a few node pills, and it answered the wrong question. Scanning thirty rows of
          chips, an operator cannot see which model lives on exactly ONE node, and that is
          the fact that predicts an outage: when that node goes, those models go with it.
          Nodes as columns makes it readable straight down, and the row cost drops to ~25px.
        */}
        <Block title={t('HUB_POOL_MODELS_TITLE')} help={t('HUB_POOL_MODELS_HELP')}>
          {models.length ? (
            <details className="group" open={models.length <= MODEL_TABLE_OPEN_MAX}>
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] text-muted-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
                {t('HUB_POOL_MODELS_COUNT', { models: models.length, nodes: poolNodes.length })}
                {/* Stated on the collapsed summary too — it is the reason to open it. */}
                {soleSourced > 0 ? <span className="text-warning">{t('HUB_POOL_MODELS_SOLE_SOURCED', { count: soleSourced })}</span> : null}
              </summary>
              <div className="mt-2 space-y-2">
                <Input
                  type="search"
                  name="hubPoolModelFilter"
                  data-testid="hub-pool-model-filter"
                  className="h-7 text-xs"
                  placeholder={t('HUB_POOL_MODELS_FILTER')}
                  value={modelFilter}
                  onChange={(event) => setModelFilter(event.target.value)}
                />
                <KpiTable
                  className="max-h-[340px] overflow-y-auto"
                  head={
                    <>
                      <Th>{t('HUB_POOL_MODELS_COL_MODEL')}</Th>
                      {asMatrix ? (
                        poolNodes.map((node) => (
                          <Th key={node} align="right">
                            {node}
                          </Th>
                        ))
                      ) : (
                        <Th>{t('HUB_POOL_MODELS_COL_NODES')}</Th>
                      )}
                    </>
                  }
                >
                  {shownModels.length === 0 ? (
                    <TableEmpty colSpan={asMatrix ? poolNodes.length + 1 : 2}>{t('HUB_POOL_MODELS_NO_MATCH')}</TableEmpty>
                  ) : (
                    shownModels.map((entry) => {
                      const sole = entry.nodes.length === 1;

                      return (
                        <Tr key={entry.model} testId="hub-pool-model" data={{ model: entry.model, nodes: entry.nodes.join(',') }}>
                          <Td className="max-w-[220px] font-mono" title={entry.model}>
                            <span className="flex items-center gap-1.5">
                              <span className="truncate">{entry.model}</span>
                              {/* Only one node can serve this. Marked on the row rather than
                                  left to be inferred from counting dots. */}
                              {sole ? <StatusDot tone="warn" className="h-1.5 w-1.5 shrink-0" /> : null}
                            </span>
                          </Td>
                          {asMatrix ? (
                            poolNodes.map((node) => (
                              <Td key={node} align="right">
                                {entry.nodes.includes(node) ? (
                                  <StatusDot tone={sole ? 'warn' : 'ok'} />
                                ) : (
                                  <span className="text-muted-foreground/40">·</span>
                                )}
                              </Td>
                            ))
                          ) : (
                            <Td className="text-muted-foreground" title={entry.nodes.join(', ')}>
                              {entry.nodes.join(', ')}
                            </Td>
                          )}
                        </Tr>
                      );
                    })
                  )}
                </KpiTable>
              </div>
            </details>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_MODELS_EMPTY')}</p>
          )}
        </Block>

        {/* ── Recent routing ──────────────────────────────────────────── */}
        {/*
          The routing log as a table. It was one bordered `<li>` per request at ~57px, so
          twenty requests cost 1,134px — more than a screen, for a list whose whole job is
          to be skimmed. Columns make it skimmable and drop the row to ~25px.

          The two facts the old rows carried as extra lines survive as markers, because
          both change what an operator concludes: a PIN is why everything landed on one
          node when the ranker would not have chosen it, and a failover chain is why one
          request touched three nodes. They are markers with titles rather than lines, so
          they cost nothing on the rows that do not have them — which is almost all of them.
        */}
        <Block title={t('HUB_POOL_ROUTING_TITLE')} help={t('HUB_POOL_ROUTING_HELP')}>
          {routingLog?.entries.length ? (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">
                {t('HUB_POOL_ROUTING_SUMMARY', {
                  served: routingLog.summary.served,
                  failed: routingLog.summary.failed,
                  failovers: routingLog.summary.failovers,
                })}
              </p>
              <KpiTable
                className="max-h-[220px] overflow-y-auto"
                head={
                  <>
                    <Th>{t('HUB_POOL_ROUTING_COL_WHEN')}</Th>
                    <Th>{t('HUB_POOL_ROUTING_COL_NODE')}</Th>
                    <Th>{t('HUB_POOL_ROUTING_COL_MODEL')}</Th>
                    <Th align="right">{t('HUB_POOL_ROUTING_COL_RESULT')}</Th>
                  </>
                }
              >
                {routingLog.entries.map((entry) => (
                  <Tr
                    key={`${entry.at}-${entry.path}-${entry.node ?? 'none'}`}
                    testId="hub-pool-routing-entry"
                    data={{
                      direction: entry.direction,
                      outcome: entry.outcome,
                      ...(entry.pin ? { pinned: 'true' } : {}),
                      ...(entry.failedOverFrom.length ? { failedover: entry.failedOverFrom.join(',') } : {}),
                    }}
                  >
                    <Td className="whitespace-nowrap text-muted-foreground">{new Date(entry.at).toLocaleTimeString()}</Td>
                    <Td className="max-w-[180px]">
                      <span className="flex items-center gap-1.5">
                        <ArrowRightLeft
                          className={cn('h-3 w-3 shrink-0', entry.direction === 'outbound' ? 'text-primary' : 'text-muted-foreground')}
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {entry.direction === 'outbound'
                            ? t('HUB_POOL_ROUTING_OUTBOUND', { node: entry.node ?? t('HUB_POOL_ROUTING_NO_NODE') })
                            : t('HUB_POOL_ROUTING_INBOUND', { node: entry.node ?? t('HUB_POOL_ROUTING_NO_NODE') })}
                        </span>
                        {/* Named on the row it shaped: an operator seeing everything land on one
                            node cannot otherwise tell a pin from the ranker deciding the same. */}
                        {entry.pin ? (
                          <span
                            data-testid="hub-pool-routing-pinned"
                            title={t('HUB_POOL_ROUTING_PINNED')}
                            className="shrink-0 rounded-sm border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
                          >
                            {t('HUB_POOL_ROUTING_PIN_MARK')}
                          </span>
                        ) : null}
                        {/* One entry per request, so a failover is a chain here, not a run of rows. */}
                        {entry.failedOverFrom.length ? (
                          <span
                            data-testid="hub-pool-routing-failover"
                            title={t('HUB_POOL_ROUTING_FAILOVER', { nodes: entry.failedOverFrom.join(' → ') })}
                            className="shrink-0 rounded-sm border border-warning/40 px-1 text-[9px] uppercase tracking-wide text-warning"
                          >
                            {t('HUB_POOL_ROUTING_FAILOVER_MARK', { count: entry.failedOverFrom.length })}
                          </span>
                        ) : null}
                      </span>
                    </Td>
                    <Td className="max-w-[160px] truncate font-mono text-muted-foreground" title={entry.model ?? entry.path}>
                      {entry.model ?? entry.path}
                    </Td>
                    <Td
                      align="right"
                      className={cn('whitespace-nowrap', entry.outcome === 'served' ? 'text-muted-foreground' : 'font-medium text-warning')}
                    >
                      {entry.outcome === 'served' ? t('HUB_POOL_ROUTING_DURATION', { ms: entry.durationMs }) : t('HUB_POOL_ROUTING_FAILED_LABEL')}
                    </Td>
                  </Tr>
                ))}
              </KpiTable>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('HUB_POOL_ROUTING_EMPTY')}</p>
          )}
        </Block>

        {/* ── Pairing PIN and this node's identity ────────────────────── */}
        <Block title={t('HUB_POOL_PIN_TITLE')} help={t('HUB_POOL_PIN_HELP')}>
          <div className="space-y-3">
            {status.localNode.identity?.identityError ? (
              /* Surfaced exactly the way `capabilitiesError` is: identity bootstrap degrades and
                 reports rather than throwing, so a Hub whose JWT_SECRET was regenerated over a
                 retained volume still boots, still verifies its peers, and says why it cannot sign. */
              <p data-testid="hub-pool-identity-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                {t('HUB_POOL_IDENTITY_ERROR', { error: status.localNode.identity.identityError })}
              </p>
            ) : (
              <p className="font-mono text-xs text-muted-foreground" data-testid="hub-pool-local-fingerprint">
                {t('HUB_POOL_LOCAL_FINGERPRINT', { fingerprint: status.localNode.identity?.publicKeyFingerprint ?? '—' })}
              </p>
            )}

            {mintedPin ? (
              <div className="flex flex-col gap-2 rounded-md border px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                {/* The only place the digits are ever rendered: they came back from the mint call and
                    are held in this component's state, never re-fetched. A reload loses them, which
                    is correct — the operator mints a new one. */}
                <span className="font-mono text-2xl tracking-[0.3em]" data-testid="hub-pool-minted-pin">
                  {mintedPin}
                </span>
                <Button type="button" size="sm" variant="outline" disabled={demoMode} onClick={() => cancelPinMutation.mutate()}>
                  {t('HUB_POOL_PIN_CANCEL_BUTTON')}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground" data-testid="hub-pool-pin-state">
                  {status.pairingPin?.active ? t('HUB_POOL_PIN_ACTIVE_ELSEWHERE') : t('HUB_POOL_PIN_NONE')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  data-testid="hub-pool-mint-pin-btn"
                  disabled={demoMode}
                  loading={mintPinMutation.isPending}
                  onClick={() => mintPinMutation.mutate()}
                >
                  {t('HUB_POOL_PIN_MINT_BUTTON')}
                </Button>
              </div>
            )}

            {/* Entered on the OTHER Hub, next to the address being paired. Left blank, pairing
                behaves exactly as it did before this shipped. */}
            <Input
              value={pairingPinInput}
              inputMode="numeric"
              maxLength={6}
              data-testid="hub-pool-pin-input"
              placeholder={t('HUB_POOL_PIN_INPUT_PLACEHOLDER')}
              onChange={(event) => setPairingPinInput(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
        </Block>

        {/* ── Discovery and pairing ───────────────────────────────────── */}
        <Block title={t('HUB_POOL_DISCOVERABLE_TITLE')} help={t('HUB_POOL_DISCOVERABLE_HELP')}>
          {/* `tailscaleAdminApiConfigured` covers one of three sources: the daemon peer map and the
              Portal registry need no credential, and neither RESULT is reported by `GET status`. The
              two fields that come close — `localNode.tailscaleConnected` (rendered above) and
              `localNode.tailnet` — are preconditions, not results, and nothing reports the Portal
              leg at all. So this branch cannot mean "discovery is off", and
              HUB_POOL_DISCOVERY_UNCONFIGURED must not claim it does — nor that the list came back
              empty, since `discoverable` is also undefined while its query is in flight or errored.
              It is the one hint the status response can honestly offer, and nothing more. */}
          {status.tailscaleAdminApiConfigured || discoverable?.length ? (
            discoverable?.length ? (
              <ul className="space-y-2">
                {discoverable.map((device) => (
                  // Keyed on the FQDN, not the Tailscale device id: the FQDN is unique across this
                  // list by construction, and it is the value the Pair button posts.
                  <li key={device.nodeFqdn} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <span className="min-w-0 break-all font-mono text-xs sm:truncate" title={device.nodeFqdn}>
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
              <p className="py-2 text-center text-xs italic text-muted-foreground">
                <HintText
                  id="hub-pool-discoverable-empty"
                  hint={t('HUB_POOL_DISCOVERABLE_EMPTY')}
                  className="cursor-help underline decoration-dotted underline-offset-2"
                >
                  {t('HUB_POOL_DISCOVERABLE_EMPTY_SHORT')}
                </HintText>
              </p>
            )
          ) : (
            <p
              data-testid="hub-pool-discovery-unconfigured"
              className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
            >
              <HintText
                id="hub-pool-discovery-unconfigured-hint"
                hint={t('HUB_POOL_DISCOVERY_UNCONFIGURED')}
                className="cursor-help underline decoration-dotted underline-offset-2"
              >
                {t('HUB_POOL_DISCOVERY_UNCONFIGURED_SHORT')}
              </HintText>
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
                    <span className="block break-all font-mono text-xs sm:truncate" title={peer.nodeFqdn} data-testid="hub-pool-pending-fqdn">
                      {peer.nodeFqdn}
                    </span>
                    {peer.displayName ? <span className="block truncate text-xs text-muted-foreground">{peer.displayName}</span> : null}
                    {/* The other half of the confirmation. A PIN-authenticated request arrives with the
                        requester's key already pinned, so the operator can compare this fingerprint
                        against the one shown on that Hub's own screen before approving. Absent means
                        the request carried no PIN — i.e. an unauthenticated claim of a name, which is
                        exactly the case the PIN exists to close. */}
                    <span
                      className="block break-all font-mono text-[11px] text-muted-foreground sm:truncate"
                      data-testid="hub-pool-pending-fingerprint"
                    >
                      {peer.peerKeyFingerprint
                        ? t('HUB_POOL_PEER_FINGERPRINT', { fingerprint: peer.peerKeyFingerprint })
                        : t('HUB_POOL_PEER_FINGERPRINT_UNVERIFIED')}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-2 self-end sm:self-auto">
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
              {/* Without this row's cancel the request is unrecoverable from the page: nothing sweeps
                  outbound pending rows, and discovery hides any FQDN already in the peer table, so a
                  peer that never answers would drop out of the pairing list forever. */}
              {pendingOutbound.map((peer) => (
                <li
                  key={peer.id}
                  data-testid="hub-pool-pending-outbound"
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <span className="min-w-0 break-all font-mono text-xs sm:truncate" title={peer.nodeFqdn}>
                    {peerLabel(peer)}
                  </span>
                  <div className="flex shrink-0 items-center justify-end gap-3 self-end sm:self-auto">
                    <span className="text-xs text-muted-foreground">{t('HUB_POOL_OUTBOUND_WAITING', { name: peerLabel(peer) })}</span>
                    {/* No confirm dialog, unlike Unpair: this discards a request nobody answered, so
                        there is no established pairing or issued token to lose. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="hub-pool-cancel-request-btn"
                      disabled={demoMode}
                      loading={cancelRequestMutation.isPending && cancelRequestMutation.variables === peer.id}
                      onClick={() => cancelRequestMutation.mutate(peer.id)}
                    >
                      {t('HUB_POOL_CANCEL_REQUEST_BUTTON')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </CardContent>

      <Dialog open={!!unpairTarget} onOpenChange={(open) => !open && setUnpairTarget(null)}>
        <DialogContent type="danger" size="sm">
          <DialogHeader>
            <DialogTitle>{t('HUB_POOL_UNPAIR_BUTTON')}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="py-2">
            {unpairTarget ? t('HUB_POOL_UNPAIR_CONFIRM', { name: peerLabel(unpairTarget) }) : null}
            {/* A pin naming this peer is not deleted with it — it simply stops matching anything, so
                say so here rather than letting routing quietly go back to the ranker unexplained. */}
            {unpairTarget && pinnedPeerIds.has(unpairTarget.id) ? (
              <span data-testid="hub-pool-unpair-pins-warning" className="mt-2 block">
                {t('HUB_POOL_UNPAIR_CONFIRM_PINS')}
              </span>
            ) : null}
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnpairTarget(null)} disabled={removeMutation.isPending}>
              {t('COMMON_CANCEL')}
            </Button>
            <Button
              intent="danger"
              data-testid="hub-pool-unpair-confirm-btn"
              loading={removeMutation.isPending}
              onClick={() => unpairTarget && removeMutation.mutate(unpairTarget.id)}
            >
              {t('HUB_POOL_UNPAIR_BUTTON')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
