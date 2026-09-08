/**
 * `cihub pool` — API calls and pure formatters for multi-Hub inference pooling.
 *
 * Split out of `cihub-cli.ts` the way `network-diagnostics-cli.ts` is: the formatters take a payload
 * and return lines, so presentation is asserted with no mocking, and `cihub-cli.ts` keeps only the
 * arg/confirm/box plumbing. It must not import `cihub-cli.ts` for values — that file imports this
 * one, and the dispatcher imports that.
 *
 * Every response type here is hand-mirrored from
 * `packages/backend/src/modules/hub-pool/hub-pool.types.ts` and `hub-pool-routing-log.service.ts`:
 * the pool routes all declare an empty response schema in swagger.json, so the generated client types
 * them as `unknown` and there is nothing to import.
 */
import { sanitizeForBox } from './lib/cli-ui';
import { hubApiFetch } from './public-web-cli';

/** Reads are cheap and local; a hung one should surface, not wedge the CLI. Matches register-hub's GET budget. */
const POOL_GET_TIMEOUT_MS = 10_000;
/** Pairing is a two-way handshake with a peer that may be offline, so it gets the POST budget, not the GET one. */
const POOL_MUTATION_TIMEOUT_MS = 30_000;

/** 'rejected' was retired in migration 0059 — nothing ever wrote it, and it overlapped `enabled`. */
export type PoolPeerStatus = 'pending' | 'connected' | 'unreachable';
export type PoolStatusReason = 'active' | 'no_peers' | 'partially_disabled' | 'disabled_by_env' | 'disabled_by_setting';

/** One side of the kill switch, as `/status` reports it. */
export interface PoolEnabledState {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
}

export interface PoolBackendCapability {
  type: string;
  healthy: boolean;
  modelsLoaded: string[];
}

export interface PoolPeerRow {
  id: string;
  nodeFqdn: string;
  displayName: string | null;
  direction: 'inbound' | 'outbound';
  status: PoolPeerStatus;
  /** Per-peer kill switch. Absent on a Hub predating it, where every peer is in the pool. */
  enabled?: boolean;
  consecutiveFailures: number;
  lastSeenAt: string | null;
  lastCapabilities: { hardwareTier?: string; backends?: PoolBackendCapability[]; inFlightRequests?: number; acceptingWork?: boolean } | null;
  /** Present on `/status` rows only: what this node currently has forwarded to the peer. */
  inFlightRequests?: number;
}

export interface PoolRoutingSummary {
  recorded: number;
  capacity: number;
  served: number;
  failed: number;
  failovers: number;
  lastAt: string | null;
}

/** A pin's reach and how hard it binds. `prefer` is the only mode: see `hub-pool.types.ts`. */
export type PoolPinScope = 'default' | 'model';
export type PoolPinTargetKind = 'local' | 'peer';

/** A pin as `/inference/pool/status` reports it, with its target resolved. Absent on a Hub predating pinning. */
export interface PoolStatusPin {
  scope: PoolPinScope;
  model?: string;
  targetKind: PoolPinTargetKind;
  peerId?: string;
  mode: 'prefer';
  nodeFqdn: string | null;
  targetAvailable: boolean;
}

export interface PoolStatusResponse {
  enabled: boolean;
  disabledBy: 'env' | 'setting' | null;
  directions: { outbound: PoolEnabledState; inbound: PoolEnabledState };
  reason: PoolStatusReason;
  routingActive: boolean;
  settings: {
    poolEnabled: boolean;
    poolOutboundEnabled: boolean;
    poolInboundEnabled: boolean;
    poolLocalAffinity: number;
    poolHealthPollSeconds: number;
  };
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
  peers: PoolPeerRow[];
  peerCounts: { total: number; connected: number; pending: number; unreachable: number; disabled: number };
  /** Optional so this CLI keeps parsing a Hub that predates pinning, where the key is simply absent. */
  pins?: PoolStatusPin[];
  routing: PoolRoutingSummary;
}

/**
 * An unpaired node the Hub can offer to pair with **by name**.
 *
 * Every entry has a tailnet name, because pairing from this list hands `nodeFqdn` to `pool pair`. A
 * Hub found by address is not in here — `/identify` discloses no name — and is paired with directly:
 * `cihub pool pair <address> --pin <digits>`.
 */
export interface DiscoverablePoolPeer {
  tailscaleDeviceId: string;
  nodeFqdn: string;
  hostname: string;
}

/**
 * What `POST /inference/pool/peers/probe` found at an operator-typed address.
 *
 * Reachability and protocol only. It deliberately does not name the node: `/identify` is
 * unauthenticated and reachable through the Cloudflare tunnel, so the MagicDNS name lives behind the
 * pairing PIN instead.
 */
export interface PoolProbeResult {
  address: string;
  isCiHub: boolean;
  poolProtocol: number | null;
  pairable: boolean;
  reason: 'unreachable' | 'not_a_hub' | 'protocol_too_old' | null;
}

export interface PoolRoutingRecord {
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
  /** Which operator pin shaped this decision, if any. Absent on a Hub predating pinning. */
  pin?: { scope: PoolPinScope; mode: 'prefer'; targetKind: PoolPinTargetKind } | null;
}

export interface PoolRoutingLogResponse {
  entries: PoolRoutingRecord[];
  summary: PoolRoutingSummary;
}

// --- API ---

export async function fetchPoolStatus(envFileName: string): Promise<PoolStatusResponse> {
  return hubApiFetch<PoolStatusResponse>(envFileName, '/inference/pool/status', { signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS) });
}

export async function fetchPoolPeers(envFileName: string): Promise<PoolPeerRow[]> {
  return hubApiFetch<PoolPeerRow[]>(envFileName, '/inference/pool/peers', { signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS) });
}

/** One HTTPS probe per tailnet device on the backend, so it gets the mutation budget rather than the GET one. */
export async function fetchDiscoverablePeers(envFileName: string): Promise<DiscoverablePoolPeer[]> {
  return hubApiFetch<DiscoverablePoolPeer[]>(envFileName, '/inference/pool/peers/discoverable', {
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function probePoolAddress(envFileName: string, address: string): Promise<PoolProbeResult> {
  return hubApiFetch<PoolProbeResult>(envFileName, '/inference/pool/peers/probe', {
    method: 'POST',
    body: JSON.stringify({ address }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function fetchPoolRoutingLog(envFileName: string, limit?: number): Promise<PoolRoutingLogResponse> {
  const query = limit === undefined ? '' : `?limit=${limit}`;
  return hubApiFetch<PoolRoutingLogResponse>(envFileName, `/inference/pool/routing-log${query}`, {
    signal: AbortSignal.timeout(POOL_GET_TIMEOUT_MS),
  });
}

/**
 * Send a pairing request, by tailnet name or by LAN address.
 *
 * `address` requires `pin`: the far Hub only discloses its tailnet name — the name the row is keyed
 * on and every later call is addressed to — to a request carrying the PIN minted on its own screen.
 */
export async function pairPoolPeer(
  envFileName: string,
  target: { nodeFqdn: string } | { address: string },
  displayName?: string,
  pin?: string,
): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, '/inference/pool/peers/pair', {
    method: 'POST',
    body: JSON.stringify({ ...target, ...(displayName ? { displayName } : {}), ...(pin ? { pin } : {}) }),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function approvePoolPeer(envFileName: string, id: string): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function rejectPoolPeer(envFileName: string, id: string): Promise<void> {
  await hubApiFetch(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

export async function unpairPoolPeer(envFileName: string, id: string): Promise<void> {
  await hubApiFetch(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/**
 * Set (or replace) a routing pin. Upsert by POST, because `(scope, model)` is the key an operator
 * edits — pins have no ids; they live in the Hub's settings.json, not in a table.
 */
export async function setPoolPin(
  envFileName: string,
  pin: { scope: PoolPinScope; model?: string; targetKind: PoolPinTargetKind; targetPeerId?: string },
): Promise<{ pins: PoolStatusPin[] }> {
  return hubApiFetch(envFileName, '/inference/pool/pins', {
    method: 'POST',
    body: JSON.stringify(pin),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Remove a routing pin. Addressed by query, not path: a model id contains `/` and `:`. */
export async function deletePoolPin(envFileName: string, scope: PoolPinScope, model?: string): Promise<{ pins: PoolStatusPin[] }> {
  const query = scope === 'model' ? `?scope=model&model=${encodeURIComponent(model as string)}` : '?scope=default';
  return hubApiFetch(envFileName, `/inference/pool/pins${query}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Which switch(es) `cihub pool enable|disable` should write. `both` is the default and is today's behaviour. */
export type PoolEnableAxis = 'both' | 'outbound' | 'inbound';

/**
 * PATCHes only the switch(es) the operator named. `both` writes the MASTER switch, not the two
 * directional ones: turning pooling off has always meant the master, and rewriting the directional
 * flags here would silently discard an operator's asymmetric setup on the next `pool enable`.
 */
export async function setPoolEnabledSetting(
  envFileName: string,
  poolEnabled: boolean,
  axis: PoolEnableAxis = 'both',
): Promise<PoolStatusResponse['settings']> {
  const body =
    axis === 'outbound' ? { poolOutboundEnabled: poolEnabled } : axis === 'inbound' ? { poolInboundEnabled: poolEnabled } : { poolEnabled };
  return hubApiFetch(envFileName, '/inference/pool/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

/** Per-peer kill switch. Reversible and symmetric: the pairing and both tokens survive. */
export async function setPoolPeerEnabled(envFileName: string, id: string, enabled: boolean): Promise<PoolPeerRow> {
  return hubApiFetch<PoolPeerRow>(envFileName, `/inference/pool/peers/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(POOL_MUTATION_TIMEOUT_MS),
  });
}

// --- formatting primitives ---

const OK = '✓';
const FAIL = '✗';
const PENDING = '○';

/** Every cell passes through here: `displayName` is free operator text and the rest arrives over HTTP. */
function cell(value: string, width: number): string {
  const clean = sanitizeForBox(value);
  const text = clean.length > width ? `${clean.slice(0, width - 1)}…` : clean;
  return text.padEnd(width);
}

function ruleRow(widths: readonly number[]): string {
  return widths.map((width) => '-'.repeat(width)).join(' ');
}

/** `2026-09-05 10:00:01Z`. Non-ISO input is echoed sanitized rather than rendered as `Invalid Date`. */
export function formatPoolTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return sanitizeForBox(value);
  return parsed
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, 'Z');
}

function formatEngines(backends: PoolBackendCapability[] | undefined): string {
  if (!backends || backends.length === 0) return '-';
  return backends.map((backend) => `${backend.type} ${backend.healthy ? OK : FAIL} ${backend.modelsLoaded?.length ?? 0}`).join('  ');
}

function shortId(id: string): string {
  return sanitizeForBox(id).slice(0, 8);
}

// --- peers ---

const PEER_WIDTHS = [8, 34, 4, 16, 20, 5] as const;

/**
 * Peer table. The ID column is the first 8 characters of the row uuid — enough to hand back to
 * `approve`/`reject`/`unpair`, which resolve a prefix (or the FQDN) against this same list.
 */
export function formatPoolPeerTable(peers: PoolPeerRow[]): string[] {
  if (peers.length === 0) {
    return ['No paired peers. Discover candidates with: cihub pool discover'];
  }

  const lines = [
    `${cell('ID', PEER_WIDTHS[0])} ${cell('NODE', PEER_WIDTHS[1])} ${cell('DIR', PEER_WIDTHS[2])} ${cell('STATUS', PEER_WIDTHS[3])} ${cell('LAST SEEN', PEER_WIDTHS[4])} ${cell('QUEUE', PEER_WIDTHS[5])} ENGINES`,
    ruleRow([...PEER_WIDTHS, 'ENGINES'.length]),
  ];

  for (const peer of peers) {
    // Strikes are what decide whether a peer is still offered as a candidate, so they belong next to
    // the status rather than in a footnote — "connected 2/3" is a peer about to drop out.
    //
    // `disabled` replaces the lifecycle word rather than sitting beside it: a peer the operator
    // switched off exchanges no work whatever its health poll says, and printing "connected" for it
    // is the one thing this table must not do. `!== false` so a Hub predating the column reads as in.
    const lifecycle = peer.enabled === false ? `${peer.status}/off` : peer.status;
    const status = peer.consecutiveFailures > 0 ? `${lifecycle} ${peer.consecutiveFailures}/3` : lifecycle;
    const queue = peer.inFlightRequests ?? peer.lastCapabilities?.inFlightRequests;
    lines.push(
      [
        cell(shortId(peer.id), PEER_WIDTHS[0]),
        cell(peer.nodeFqdn, PEER_WIDTHS[1]),
        cell(peer.direction === 'inbound' ? 'in' : 'out', PEER_WIDTHS[2]),
        cell(status, PEER_WIDTHS[3]),
        cell(formatPoolTimestamp(peer.lastSeenAt), PEER_WIDTHS[4]),
        cell(queue === undefined ? '-' : String(queue), PEER_WIDTHS[5]),
        formatEngines(peer.lastCapabilities?.backends),
      ].join(' '),
    );
  }

  return lines;
}

const MAX_LISTED_MODELS = 8;

/** `cihub pool peers` detail: which models each peer actually holds, which the table only counts. */
export function formatPoolPeerModelLines(peers: PoolPeerRow[]): string[] {
  const lines: string[] = [];
  for (const peer of peers) {
    for (const backend of peer.lastCapabilities?.backends ?? []) {
      const models = backend.modelsLoaded ?? [];
      if (models.length === 0) continue;
      const shown = models.slice(0, MAX_LISTED_MODELS).map(sanitizeForBox).join(', ');
      const overflow = models.length > MAX_LISTED_MODELS ? ` (+${models.length - MAX_LISTED_MODELS} more)` : '';
      lines.push(`  ${shortId(peer.id)}  ${sanitizeForBox(backend.type)}: ${shown}${overflow}`);
    }
  }
  if (lines.length === 0) return [];
  // Disk inventory, not VRAM residency — a peer listing a model may still have to cold-load it.
  return ['', 'Models on each peer (on disk, not necessarily loaded)', ...lines];
}

const PENDING_INBOUND_HINT = 'Pending inbound requests: approve with `cihub pool approve <id>` or reject with `cihub pool reject <id>`.';
const DISABLED_PEER_HINT =
  'Peers marked `/off` exchange no work with this node. The pairing and both tokens are kept — put one back with `cihub pool peer-enable <id>`.';

export function formatPoolPeersLines(peers: PoolPeerRow[]): string[] {
  const lines = [...formatPoolPeerTable(peers), ...formatPoolPeerModelLines(peers)];
  if (peers.some((peer) => peer.direction === 'inbound' && peer.status === 'pending')) {
    lines.push('', PENDING_INBOUND_HINT);
  }
  if (peers.some((peer) => peer.enabled === false)) {
    lines.push('', DISABLED_PEER_HINT);
  }
  // The far side's own decision, not this operator's — worth naming, because such a peer polls
  // healthy while advertising nothing, which otherwise reads as a broken node.
  const notAccepting = peers.filter((peer) => peer.enabled !== false && peer.lastCapabilities?.acceptingWork === false);
  if (notAccepting.length > 0) {
    lines.push('', `Not accepting work from this node: ${notAccepting.map((peer) => sanitizeForBox(peer.nodeFqdn)).join(', ')}`);
  }
  return lines;
}

/**
 * Resolve an operator-typed peer reference to exactly one row. Accepts the full uuid, the 8-character
 * prefix the table prints, or the node FQDN — an ambiguous prefix is an error rather than a guess,
 * because the commands taking one all change pairing state.
 */
export function resolvePoolPeerTarget(peers: PoolPeerRow[], target: string): { peer: PoolPeerRow } | { error: string } {
  const needle = target.trim().toLowerCase();
  if (!needle) return { error: 'Missing peer id.' };

  const exact = peers.filter((peer) => peer.id.toLowerCase() === needle || peer.nodeFqdn.toLowerCase() === needle);
  if (exact.length === 1) return { peer: exact[0] as PoolPeerRow };

  const prefixed = peers.filter((peer) => peer.id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return { peer: prefixed[0] as PoolPeerRow };
  if (prefixed.length > 1) {
    return { error: `"${sanitizeForBox(target)}" matches ${prefixed.length} peers — use the full id.` };
  }
  return { error: `No paired peer matching "${sanitizeForBox(target)}". List them with: cihub pool peers` };
}

// --- status ---

function describePoolReason(status: PoolStatusResponse): string {
  switch (status.reason) {
    case 'active':
      return `${OK} active — apps on this Hub are routed through the pool`;
    case 'no_peers':
      return `${PENDING} enabled, not routing — no connected peers, so this Hub resolves inference locally`;
    case 'partially_disabled':
      return `${PENDING} partly disabled — pooling is on, but a direction is switched off or every peer is disabled (see below)`;
    case 'disabled_by_env':
      return `${FAIL} disabled — HUB_POOL_USER_DISABLED=true in this Hub's .env (the .env wins over the setting)`;
    case 'disabled_by_setting':
      return `${FAIL} disabled — turned off in settings (re-enable with: cihub pool enable)`;
    default:
      return `${PENDING} unknown state`;
  }
}

/**
 * One direction's effective state, naming the switch actually responsible. An operator told to edit
 * the `.env` when the real cause is the stored setting goes looking in the wrong file — the same
 * reason `describeHubPoolDisabled` exists on the backend.
 */
function describeDirection(what: string, state: PoolEnabledState, envVar: string, flag: string): string {
  if (state.enabled) return `${OK} ${what}`;
  if (state.disabledBy === 'env') return `${FAIL} not ${what} — ${envVar}=true in this Hub's .env (the .env wins over the setting)`;
  return `${FAIL} not ${what} — turned off in settings (re-enable with: cihub pool enable ${flag})`;
}

export function formatPoolStatusLines(status: PoolStatusResponse): string[] {
  const counts = status.peerCounts;
  const routing = status.routing;
  const lines = [
    `Pooling      ${describePoolReason(status)}`,
    `Outbound     ${describeDirection('sending work to peers', status.directions.outbound, 'HUB_POOL_OUTBOUND_DISABLED', '--outbound')}`,
    `Inbound      ${describeDirection('serving work for peers', status.directions.inbound, 'HUB_POOL_INBOUND_DISABLED', '--inbound')}`,
    `Peers        ${counts.total} total · ${counts.connected} connected · ${counts.pending} pending · ${counts.unreachable} unreachable · ${counts.disabled} disabled`,
    // Names the one credential `GET status` reports on, and says so. The Tailscale daemon's peer map
    // and the Portal registry also name candidates, need no credential, and are not in this response
    // (the `Tailscale` line below is as close as it gets — that is the daemon leg's precondition, not
    // its result) — so this line must not read as "discovery is on" or "discovery is off".
    `Discovery    ${
      status.tailscaleAdminApiConfigured
        ? 'Tailscale Admin API configured — cihub pool discover can enumerate the whole tailnet'
        : 'no Admin API credential — cihub pool discover still lists visible tailnet peers and any CI account Hubs'
    }`,
    `Settings     poolEnabled=${status.settings.poolEnabled} · outbound=${status.settings.poolOutboundEnabled} · inbound=${status.settings.poolInboundEnabled} · localAffinity=${status.settings.poolLocalAffinity} · healthPoll=${status.settings.poolHealthPollSeconds}s`,
    `Routing log  ${routing.recorded}/${routing.capacity} recorded · ${routing.served} served · ${routing.failed} failed · ${routing.failovers} failover(s)`,
    '',
    'This node',
    `  Node       ${sanitizeForBox(status.localNode.nodeFqdn ?? '(unknown)')}${status.localNode.tailnet ? `  tailnet ${sanitizeForBox(status.localNode.tailnet)}` : ''}`,
    `  Tailscale  ${status.localNode.tailscaleConnected ? `${OK} connected` : `${FAIL} not connected — pooling needs the tailnet`}`,
    `  Hardware   ${sanitizeForBox(status.localNode.hardwareTier ?? '-')}`,
    // A live gauge, process-local and zeroed by a restart. Never a request total.
    `  In flight  ${status.localNode.inFlightRequests} request(s) now`,
    `  Engines    ${formatEngines(status.localNode.backends)}`,
  ];

  // An unreachable backend and a node with no models both show an empty inventory; only this says which.
  if (status.localNode.capabilitiesError) {
    lines.push(`  Engines    ${FAIL} ${sanitizeForBox(status.localNode.capabilitiesError)}`);
  }

  lines.push(...formatPoolPinLines(status.pins));

  lines.push('', 'Peers', ...formatPoolPeerTable(status.peers).map((line) => `  ${line}`));

  if (status.peers.some((peer) => peer.direction === 'inbound' && peer.status === 'pending')) {
    lines.push('', PENDING_INBOUND_HINT);
  }

  return lines;
}

/**
 * The Pins block of `cihub pool status`, and the only place pins are listed — status answers the
 * whole question, so there is no `pool pins` subcommand to keep in step with it.
 *
 * `targetAvailable: false` is called out rather than shown as a flag, because a pin that is quietly
 * doing nothing is the failure mode of the whole feature: `prefer` never errors, so a pin at an
 * unreachable or unpaired node is invisible everywhere else.
 */
export function formatPoolPinLines(pins: PoolStatusPin[] | undefined): string[] {
  if (!pins || pins.length === 0) {
    return [];
  }
  const lines = ['', 'Pins'];
  for (const pin of pins) {
    const target = pin.targetKind === 'local' ? 'this Hub' : (pin.nodeFqdn ?? `peer ${shortId(pin.peerId ?? '')} (no longer paired)`);
    const scope = pin.scope === 'model' ? sanitizeForBox(pin.model ?? '?') : 'all models';
    lines.push(
      `  ${pin.targetAvailable ? OK : FAIL} ${cell(scope, 34)} → ${sanitizeForBox(target)}${pin.targetAvailable ? '' : '  (not usable right now)'}`,
    );
  }
  lines.push(
    '  Pins are a preference, not a rule: if the pinned node cannot serve a request it is ranked',
    '  normally, so a pin can never take inference down. Remove one with: cihub pool unpin',
  );
  return lines;
}

// --- discovery ---

const DISCOVER_WIDTHS = [34, 24] as const;

/**
 * The candidate table, or an empty state that names the sources and what each one needs.
 *
 * The Admin API — reported by `tailscaleAdminApiConfigured`, the one directory `GET status` speaks
 * to — is one of three: the local Tailscale daemon's peer map and the CI Portal device registry also
 * name candidates and need no credential. So the flag only selects a hint here — it is not the difference
 * between discovery having run and not having run, and the copy must not imply that it is. Nor may
 * the empty state claim a directory was consulted: an unregistered Hub never calls Portal, and a
 * Hub off the tailnet never reads a peer map.
 */
export function formatPoolDiscoverLines(devices: DiscoverablePoolPeer[], tailscaleAdminApiConfigured: boolean): string[] {
  if (devices.length === 0) {
    // Manual entry goes first on purpose: it works today, on this Hub, with nothing to go and create
    // in someone else's console.
    return [
      'No unpaired CI-Hub nodes found: no directory this Hub can ask named one.',
      '',
      'Find one by address:  cihub pool probe <address>',
      '  e.g. 192.168.1.42, 192.168.1.42:5002, or a hostname on this LAN. A Hub found that',
      '  way is paired with directly — it never appears in this list, because an address is',
      '  not a name: cihub pool pair <address> --pin <digits>',
      '',
      ...(tailscaleAdminApiConfigured
        ? ['Whole-tailnet enumeration is configured, and found nothing unpaired.']
        : [
            `${PENDING} Whole-tailnet enumeration is off. Set TAILSCALE_OAUTH_CLIENT_ID and`,
            '  TAILSCALE_OAUTH_CLIENT_SECRET (devices:core:read) and restart to list every device',
            '  on the tailnet at once. It is optional — this Hub pools normally without it, and',
            '  already lists the tailnet peers its own daemon can see whenever it is connected.',
          ]),
      '',
      'Already-paired nodes are excluded — see: cihub pool peers',
      'A candidate only appears once its Hub is running and answers /api/inference/pool/identify.',
      'A Hub your CI account knows only by LAN address is not listed: pairing needs a tailnet name.',
    ];
  }

  // "DEVICE ID", not "TAILSCALE DEVICE": the id belongs to whichever directory named the node, so a
  // candidate that came from the CI Portal registry carries its Portal device id here.
  const lines = [
    `${cell('NODE', DISCOVER_WIDTHS[0])} ${cell('HOSTNAME', DISCOVER_WIDTHS[1])} DEVICE ID`,
    ruleRow([...DISCOVER_WIDTHS, 'DEVICE ID'.length]),
  ];
  for (const device of devices) {
    // Every string on this row is authored off-box, and box output is ANSI-injectable.
    lines.push(
      `${cell(device.nodeFqdn, DISCOVER_WIDTHS[0])} ${cell(device.hostname, DISCOVER_WIDTHS[1])} ${sanitizeForBox(device.tailscaleDeviceId || '-')}`,
    );
  }
  lines.push('', 'Pair one with: cihub pool pair <node>');
  return lines;
}

/**
 * A probe result as the operator reads it.
 *
 * Every branch names what to do next, and the success branch is explicit that the node has not been
 * *named* — only found. That is the one thing about this command it would be easy and costly to
 * misunderstand: the address alone can never produce a peer, because the tailnet name a peer row is
 * keyed on is only disclosed to a pairing request carrying that Hub's PIN.
 */
export function formatPoolProbeLines(result: PoolProbeResult): string[] {
  const address = sanitizeForBox(result.address);
  switch (result.reason) {
    case 'unreachable':
      return [
        `${FAIL} Nothing answered at ${address}.`,
        '',
        'Tried the Hub API port (5002, then 3000). If that Hub publishes a different one,',
        'name it: cihub pool probe <address>:<port>',
        'The peer Hub also has to be running.',
      ];
    case 'not_a_hub':
      return [`${FAIL} Something answered at ${address}, but it is not a CI-Hub.`];
    case 'protocol_too_old':
      return [
        `${PENDING} Found a CI-Hub at ${address}, but it speaks an older pool protocol.`,
        '',
        'Pairing by address needs the far Hub to answer a PIN with its tailnet name, which',
        'that build cannot do. Upgrade it, or pair by its MagicDNS name instead:',
        '  cihub pool pair <node-fqdn>',
      ];
    default:
      break;
  }

  return [
    `${OK} There is a CI-Hub at ${address}, speaking pool protocol ${result.poolProtocol ?? '?'}.`,
    '',
    'It is not named here, and that is deliberate: /identify is unauthenticated and reachable',
    'through the public tunnel, so it reports no MagicDNS name. Pair to learn it.',
    '',
    'On THAT Hub:  cihub pool pairing-pin',
    `Then here:    cihub pool pair ${address} --pin <digits>`,
    '',
    'The PIN authenticates the request; the answer carries the tailnet name, and that is what',
    'the peer is stored as. Every pooled request then goes to https://<name> — same TLS, same',
    'credentials. The address was only ever a way to reach the handshake.',
  ];
}

// --- routing log ---

const LOG_WIDTHS = [20, 4, 20, 34, 5, 7] as const;

export function formatPoolRoutingLogLines(log: PoolRoutingLogResponse): string[] {
  const summary = log.summary;
  const header = [
    `${summary.recorded}/${summary.capacity} recorded · ${summary.served} served · ${summary.failed} failed · ${summary.failovers} failover(s)`,
    `Last decision  ${formatPoolTimestamp(summary.lastAt)}`,
    '',
  ];

  if (log.entries.length === 0) {
    return [
      ...header,
      'Nothing routed since the Hub started.',
      '',
      'The log is in-memory and process-local: it is empty after a restart, and it only',
      'records requests that went through the pool proxy. If apps are running and this',
      'stays empty, check `cihub pool status` — with no connected peers nothing is routed.',
    ];
  }

  const lines = [
    ...header,
    `${cell('TIME', LOG_WIDTHS[0])} ${cell('DIR', LOG_WIDTHS[1])} ${cell('MODEL', LOG_WIDTHS[2])} ${cell('NODE', LOG_WIDTHS[3])} ${cell('ATT', LOG_WIDTHS[4])} ${cell('MS', LOG_WIDTHS[5])} OUTCOME`,
    ruleRow([...LOG_WIDTHS, 'OUTCOME'.length]),
  ];

  for (const entry of log.entries) {
    const outcome = entry.outcome === 'served' ? `${OK} served` : `${FAIL} failed`;
    const status = entry.status === null ? '' : ` ${entry.status}`;
    lines.push(
      [
        cell(formatPoolTimestamp(entry.at), LOG_WIDTHS[0]),
        cell(entry.direction === 'inbound' ? 'in' : 'out', LOG_WIDTHS[1]),
        cell(entry.model ?? '-', LOG_WIDTHS[2]),
        cell(entry.node ?? '-', LOG_WIDTHS[3]),
        cell(`${entry.attempt}/${entry.candidates}`, LOG_WIDTHS[4]),
        cell(String(entry.durationMs), LOG_WIDTHS[5]),
        `${outcome}${status}`,
      ].join(' '),
    );
    // Named on the row it shaped: an operator seeing everything land on one node cannot otherwise
    // tell a pin from the ranker having decided the same thing.
    if (entry.pin) {
      lines.push(`  ↳ pinned (${entry.pin.scope === 'model' ? 'this model' : 'all models'} → ${entry.pin.targetKind})`);
    }
    // The chain, not a count: which nodes refused is the whole point of reading this log.
    if (entry.failedOverFrom.length > 0) {
      lines.push(`  ↳ failed over from ${entry.failedOverFrom.map(sanitizeForBox).join(', ')}`);
    }
  }

  lines.push('', 'Duration is time to response headers, not the streamed generation. `in` rows are work a peer sent here.');
  return lines;
}

// --- discover orchestration ---

/**
 * Status alongside the candidate list, so the empty state can name the credential that is missing —
 * from the same boolean the UI uses.
 *
 * `found` is what the caller colours the box on, deliberately *not* `configured`: a credential-free
 * Hub that listed candidates from its daemon peer map or from Portal has nothing wrong with it, and
 * yellow means a problem state everywhere else in this CLI (`pool status` uses it for "not enabled",
 * `pool probe` for "not pairable"). The missing credential stays a line of copy inside the box.
 */
export async function runPoolDiscover(envFileName: string): Promise<{ lines: string[]; configured: boolean; found: boolean }> {
  // The candidate list is fetched unconditionally. It used to be skipped when no Tailscale Admin API
  // credential was configured, back when that credential was the only source; it is now one of
  // three. The local Tailscale daemon's peer map and the CI Portal device registry both name
  // candidates with no credential at all, so short-circuiting on the flag hid real candidates on
  // exactly the Hubs the credential-free paths exist for. `configured` still reports only the
  // credential, which is what the "how do I see the whole tailnet" hint keys on.
  const [status, devices] = await Promise.all([fetchPoolStatus(envFileName), fetchDiscoverablePeers(envFileName)]);
  return {
    lines: formatPoolDiscoverLines(devices, status.tailscaleAdminApiConfigured),
    configured: status.tailscaleAdminApiConfigured,
    found: devices.length > 0,
  };
}
