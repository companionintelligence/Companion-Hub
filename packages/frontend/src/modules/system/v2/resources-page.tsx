import { parseHubTimestamp } from '@/components/ui/dense/dense';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHubAccess } from '@/lib/hooks/use-hub-access';
import { poolConfigWarnings } from '@/modules/system/pool-config-warnings';
import {
  bucketWindow,
  firstByteByNode,
  inferenceFromHere,
  LOCAL_NODE_KEY,
  localContainerRollup,
  poolNodeCards,
  routingBuckets,
  routingWindowPartial,
  unloggedCalls,
  waitingNow,
} from '@/modules/system/pool-node-series';
import { pageVerdict } from '@/modules/system/triage';
import { loadState, poolModelIndex, poolReach, useDashboardData } from '@/modules/system/use-dashboard-data';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { AppsTab } from './apps-tab';
import { AttentionNotice, type Notice } from './attention-notice';
import { PerformanceTab, type SystemLoad } from './performance-tab';
import { PoolTab } from './pool-tab';
import { RequestsTab } from './requests-tab';
import { type TelemetrySpan, useAppNames, useDiskModels, useTelemetry } from './use-resources-data';

/*
 * Resources, organised the way Windows Task Manager organises a PC (Companion-Hub#2423).
 *
 *   Performance   how this machine is doing: CPU, memory, GPU, disk, AI models
 *   Apps          what is using it: one table, one row per app the person may view
 *   AI pool       the other Hubs this one shares AI work with
 *   Requests      the AI requests that went through this Hub
 *
 * It reads the queries the previous page read (`useDashboardData`) and reuses its checks
 * (`pageVerdict`), so a fault is still a fault and an unknown is still an unknown. What changed is
 * where things sit: the twelve-tile rail and its fault chips became one notice above the tabs that
 * appears only when something needs attention, the four per-workload panels and the container table
 * became the Apps table, and the configuration drawer became a link to Settings > AI, where those
 * settings are edited.
 *
 * Anyone signed in sees all four tabs. What they see in them is what the Hub lets them read: the
 * Apps rows are filtered on the Hub by view grant, and the buttons that change pool settings show
 * only for someone who manages the Hub.
 */

const TABS = ['performance', 'apps', 'pool', 'requests'] as const;
type Tab = (typeof TABS)[number];

const BUCKET_MS = 60_000;
const BUCKET_COUNT = 30;
const WINDOW_MS = BUCKET_MS * BUCKET_COUNT;

export default function ResourcesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: Tab = TABS.includes(requested as Tab) ? (requested as Tab) : 'performance';
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const [span, setSpan] = useState<TelemetrySpan>(30);

  const { manageHub } = useHubAccess();
  const { containers, pool, routingLog, inference, memory, residency, hardware, cloudProviders, systemLoad } = useDashboardData();
  const telemetry = useTelemetry(span);
  const disk = useDiskModels(inference.data?.backends);
  const names = useAppNames();

  const now = Date.now();
  const localLabel = t('RESOURCES_THIS_HUB');
  const apps = containers.data?.apps ?? [];
  const entries = routingLog.data?.entries ?? [];
  const peers = pool.data?.peers ?? [];
  const containerState = loadState(containers);
  const poolState = loadState(pool);
  const routingState = loadState(routingLog);

  // Not memoised: `now` is read every render, so a memo keyed on it would never hit.
  const firstByte = firstByteByNode(entries, { now, windowMs: WINDOW_MS });
  const cards = poolNodeCards(pool.data?.localNode, peers, {
    localLabel,
    localContainers: localContainerRollup(containers.data?.apps),
    healthPollSeconds: pool.data?.settings?.poolHealthPollSeconds,
    now,
    firstByte,
  });
  const reach = poolReach(peers, pool.data?.localNode);
  const buckets = routingBuckets(entries, { now, bucketMs: BUCKET_MS, buckets: BUCKET_COUNT });
  // The Requests card's figures count outbound rows only (`inferenceFromHere`), so its bars must too:
  // with every direction a Hub that mostly serves its peers drew busy bars under "Requests 0".
  const outboundBuckets = routingBuckets(
    entries.filter((entry) => entry.direction === 'outbound'),
    { now, bucketMs: BUCKET_MS, buckets: BUCKET_COUNT },
  );
  const span30 = bucketWindow(buckets, BUCKET_MS);
  const own = inferenceFromHere(entries, span30 ?? { from: now - WINDOW_MS, to: now });
  // The ring dropped rows from the window, or the Hub started inside it: the counts are a floor.
  const startedAt = parseHubTimestamp(routingLog.data?.summary?.startedAt);
  const routingPartial =
    routingWindowPartial(routingLog.data, { now, windowMs: WINDOW_MS }) ||
    (Number.isFinite(startedAt) && startedAt > (span30?.from ?? now - WINDOW_MS));
  const models = poolModelIndex(pool.data?.localNode, peers, localLabel);
  const configWarnings = poolConfigWarnings(pool.data);
  const waiting = waitingNow(entries, now);
  const unlogged = unloggedCalls(pool.data, poolState);

  const unplaced = buckets.reduce((sum, bucket) => sum + bucket.unplaced, 0);

  const sampledAtMs = parseHubTimestamp(containers.data?.sampledAt);
  const sampleAgeMs = containers.data && Number.isFinite(sampledAtMs) ? Math.max(0, containers.dataUpdatedAt - sampledAtMs) : null;
  const degradedApps = apps.filter((app) => app.degraded);
  const degraded = degradedApps.length;

  const verdict = pageVerdict({
    containers: { state: containerState, degraded, sampleAgeMs },
    pool: {
      state: poolState,
      unreachablePeers: reach.unreachable,
      probeFailures: reach.probeFailures,
      stalePins: configWarnings.stalePins,
      envDisabledDirections: configWarnings.envDisabledDirections,
      capabilitiesError: configWarnings.capabilitiesError,
    },
    routing: {
      state: routingState,
      unplaced,
      waiting: waiting.oldest
        ? {
            ageMs: waiting.oldest.ageMs,
            budgetMs: waiting.oldest.budgetMs,
            node: waiting.oldest.node === LOCAL_NODE_KEY ? localLabel : (waiting.oldest.node ?? '—'),
          }
        : null,
    },
    otherStates: [
      loadState(inference),
      loadState(memory),
      loadState(hardware),
      loadState(cloudProviders),
      loadState(residency),
      loadState(systemLoad),
    ],
    t: (key: string, vars?: Record<string, unknown>) => t(key, vars),
  });

  // The faults the previous page raised as chips, said once each in words, with where to go next.
  const ids = new Set(verdict.faults.map((fault) => fault.id));
  const notices: Notice[] = [];
  // Each notice's `key` names WHICH apps or Hubs it is about, so dismissing "1 app isn't responding"
  // for one app does not also hide it next week for another.
  if (ids.has('workloads-degraded')) {
    notices.push({
      id: 'apps',
      key: degradedApps
        .map((app) => app.appUrn)
        .sort()
        .join(','),
      tone: 'bad',
      text: t('RESOURCES_NOTICE_APPS', { count: degraded }),
      action: { label: t('RESOURCES_NOTICE_SHOW_APPS'), onClick: () => setTab('apps') },
    });
  }
  if (ids.has('stale-sample')) notices.push({ id: 'stale', tone: 'warn', text: t('RESOURCES_NOTICE_STALE') });
  if (ids.has('peers-unreachable') || ids.has('probe-failures')) {
    // One count over both checks: a peer that is down usually fails its probes too, and is one Hub.
    const affected = peers.filter((peer) => peer.enabled !== false && (peer.status === 'unreachable' || (peer.consecutiveFailures ?? 0) > 0));
    const unreachable = ids.has('peers-unreachable');
    notices.push({
      id: 'peers',
      key: affected
        .map((peer) => peer.id)
        .sort()
        .join(','),
      tone: unreachable ? 'bad' : 'warn',
      // Only failing probes, with every peer still connected, is not "can't be reached".
      text: t(unreachable ? 'RESOURCES_NOTICE_PEERS' : 'RESOURCES_NOTICE_PEER_CHECKS', { count: affected.length }),
      action: { label: t('RESOURCES_NOTICE_SHOW_POOL'), onClick: () => setTab('pool') },
    });
  }
  if (ids.has('stale-pins') || ids.has('env-disabled') || ids.has('capabilities-error')) {
    notices.push({
      id: 'config',
      key: `${configWarnings.stalePins},${configWarnings.envDisabledDirections},${configWarnings.capabilitiesError}`,
      tone: 'warn',
      text: t('RESOURCES_NOTICE_CONFIG'),
      action: manageHub ? { label: t('RESOURCES_POOL_SETTINGS'), to: '/settings?tab=ai' } : undefined,
    });
  }
  if (ids.has('unplaced')) {
    notices.push({
      id: 'unplaced',
      key: String(unplaced),
      tone: 'bad',
      text: t('RESOURCES_NOTICE_UNPLACED'),
      action: { label: t('RESOURCES_NOTICE_SHOW_REQUESTS'), onClick: () => setTab('requests') },
    });
  }
  if (ids.has('near-budget')) {
    notices.push({
      id: 'waiting',
      tone: 'warn',
      text: t('RESOURCES_NOTICE_WAITING'),
      action: { label: t('RESOURCES_NOTICE_SHOW_REQUESTS'), onClick: () => setTab('requests') },
    });
  }
  if (verdict.unavailable > 0)
    notices.push({ id: 'unavailable', tone: 'warn', text: t('RESOURCES_NOTICE_UNAVAILABLE', { count: verdict.unavailable }) });

  const appName = (urn: string, fallback: string) => names.get(urn) ?? fallback;
  // A Hub as the routing log names it (its tailnet name, or `local`) to the name the pool list uses.
  const hubName = (node: string) => {
    if (node === LOCAL_NODE_KEY) return localLabel;
    const card = cards.find((entry) => entry.fqdn === node || entry.key === node);
    return card && !card.local ? card.label : node.split('.')[0] || node;
  };
  const load = systemLoad.data as SystemLoad | undefined;

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-4 pb-12">
      <AttentionNotice notices={notices} allClear={verdict.kind === 'clear'} />

      <Tabs value={tab} onValueChange={setTab} className="w-full min-w-0">
        <TabsList className="w-full min-w-0 justify-center border border-border/50 bg-card/50 max-md:justify-start max-md:overflow-x-auto max-md:[scrollbar-width:none]">
          <TabsTrigger value="performance">{t('RESOURCES_TAB_PERFORMANCE')}</TabsTrigger>
          <TabsTrigger value="apps">{t('RESOURCES_TAB_APPS')}</TabsTrigger>
          <TabsTrigger value="pool">{t('RESOURCES_TAB_POOL')}</TabsTrigger>
          <TabsTrigger value="requests">{t('RESOURCES_TAB_REQUESTS')}</TabsTrigger>
        </TabsList>

        <TabsContent value="performance" className="mt-4">
          <PerformanceTab
            load={load}
            loadState={loadState(systemLoad)}
            telemetry={telemetry.points}
            telemetryState={loadState(telemetry.query)}
            bucketSeconds={telemetry.bucketSeconds}
            span={span}
            onSpanChange={setSpan}
            hardware={hardware.data}
            hardwareState={loadState(hardware)}
            memory={memory.data}
            residency={residency.data}
            budgetState={loadState(memory)}
            residencyState={loadState(residency)}
            modelsState={{
              pending: loadState(inference).pending || loadState(residency).pending || disk.pending,
              failed: loadState(inference).failed || disk.failed,
            }}
            engines={inference.data?.backends}
            diskModels={disk.models}
            monitor={containers.data}
            monitorState={containerState}
            appName={appName}
            now={now}
            onShowApps={() => setTab('apps')}
          />
        </TabsContent>
        <TabsContent value="apps" className="mt-4">
          <AppsTab
            apps={apps}
            history={containers.data?.history ?? []}
            state={containerState}
            cores={hardware.data?.cpu?.cores ?? load?.cpuCores ?? null}
            ramTotalMb={hardware.data?.ram?.totalMb ?? (load ? load.memoryTotal * 1024 : null)}
            appName={appName}
          />
        </TabsContent>
        <TabsContent value="pool" className="mt-4">
          <PoolTab pool={pool.data} state={poolState} cards={cards} reach={reach} models={models} manageHub={manageHub} now={now} />
        </TabsContent>
        <TabsContent value="requests" className="mt-4">
          <RequestsTab
            entries={entries}
            state={routingState}
            buckets={outboundBuckets}
            own={own}
            hubName={hubName}
            unlogged={unlogged === 'v1' || unlogged === 'apps'}
            partial={routingPartial}
            now={now}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
