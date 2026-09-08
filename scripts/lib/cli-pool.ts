/**
 * The `cihub pool` command surface: Hub Pool peering and routing over the private VPN.
 *
 * Argument parsing and rendering live here; the HTTP calls stay in `hub-pool-cli.ts` so the
 * two can be tested apart from each other.
 */
import path from 'node:path';
import { parseEnvFile } from '../env-file.js';
import {
  approvePoolPeer,
  cancelPairingPin,
  deletePoolPin,
  fetchPoolPeers,
  fetchPoolRoutingLog,
  fetchPoolStatus,
  formatPoolPeersLines,
  formatPoolProbeLines,
  formatMintedPairingPinLines,
  formatPoolRoutingLogLines,
  formatPoolStatusLines,
  mintPairingPin,
  pairPoolPeer,
  probePoolAddress,
  rejectPoolPeer,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setPoolEnabledSetting,
  setPoolPeerEnabled,
  setPoolPin,
  unpairPoolPeer,
  type PoolEnableAxis,
} from '../hub-pool-cli.js';
import { readHubApiKey, resolveHubApiBase } from '../public-web-cli.js';
import { resolveEnvFromArgs, usageAndExit } from './cli-args.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { printMessageBox, sanitizeForBox, STEP_ICONS } from './cli-ui.js';
import { type HubContext, resolveHubContext } from './hub-context.js';
import { resolveRootFolderHost } from './paths.js';

export const POOL_SUBCOMMANDS = [
  'status',
  'peers',
  'discover',
  'probe',
  'pair',
  'approve',
  'reject',
  'unpair',
  'pairing-pin',
  'log',
  'enable',
  'disable',
  'peer-enable',
  'peer-disable',
  'pin',
  'unpin',
] as const;
export type PoolSubcommand = (typeof POOL_SUBCOMMANDS)[number];

/** Subcommands taking a peer reference before the optional [env], so the env parser never sees it. */
const POOL_TARGET_SUBCOMMANDS: readonly PoolSubcommand[] = ['probe', 'pair', 'approve', 'reject', 'unpair', 'peer-enable', 'peer-disable', 'pin'];

const POOL_USAGE = `Usage: ${BASE_COMMAND} pool <${POOL_SUBCOMMANDS.join('|')}> [env]`;

export interface ParsedPoolArgs {
  subcommand: PoolSubcommand;
  target?: string;
  displayName?: string;
  /** `pairing-pin` only: revoke the outstanding PIN instead of minting a new one. */
  cancel: boolean;
  /** `pair` only: the six digits minted on the OTHER Hub, and the only way to pair by address. */
  pin?: string;
  limit?: number;
  /** Which switch `enable`/`disable` writes. `both` (the default) is the master switch, i.e. today's behaviour. */
  axis: PoolEnableAxis;
  /** `pin`/`unpin` only: which model the pin covers. Absent means the pool-wide default pin. */
  model?: string;
  yes: boolean;
  env: HubEnv;
}

/**
 * Flags are stripped before `resolveEnvFromArgs`, which exits on any token it does not recognise as
 * an environment.
 */
export function parsePoolArgs(args: string[]): ParsedPoolArgs {
  let yes = false;
  let cancel = false;
  let displayName: string | undefined;
  let pin: string | undefined;
  let limit: number | undefined;
  let axis: PoolEnableAxis = 'both';
  let model: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--cancel') {
      cancel = true;
      continue;
    }
    if (arg === '--outbound' || arg === '--inbound') {
      const next: PoolEnableAxis = arg === '--outbound' ? 'outbound' : 'inbound';
      // Naming both would have to mean "the master", which is what passing neither already means —
      // so rather than pick one silently, say so.
      if (axis !== 'both' && axis !== next) {
        usageAndExit('Pass at most one of --outbound / --inbound. Omit both to change the master switch.');
      }
      axis = next;
      continue;
    }
    if (arg === '--name' || arg === '--limit' || arg === '--pin' || arg === '--model') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) usageAndExit(`Missing value for ${arg}. ${POOL_USAGE}`);
      if (arg === '--name') displayName = next;
      else if (arg === '--pin') pin = parsePairingPin(next);
      else if (arg === '--model') model = parsePinnedModel(next);
      else limit = parsePoolLimit(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      model = parsePinnedModel(arg.slice('--model='.length));
      continue;
    }
    if (arg.startsWith('--pin=')) {
      pin = parsePairingPin(arg.slice('--pin='.length));
      continue;
    }
    if (arg.startsWith('--name=')) {
      displayName = arg.slice('--name='.length);
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parsePoolLimit(arg.slice('--limit='.length));
      continue;
    }
    if (arg.startsWith('--')) usageAndExit(`Unknown flag: ${arg}. ${POOL_USAGE}`);
    positional.push(arg);
  }

  const subcommand = (positional[0] || 'status') as PoolSubcommand;
  if (!POOL_SUBCOMMANDS.includes(subcommand)) {
    usageAndExit(`Unknown pool subcommand: ${subcommand}. ${POOL_USAGE}`);
  }

  if (axis !== 'both' && subcommand !== 'enable' && subcommand !== 'disable') {
    usageAndExit(`--${axis} only applies to \`${BASE_COMMAND} pool enable\` and \`${BASE_COMMAND} pool disable\`.`);
  }

  if (pin !== undefined && subcommand !== 'pair') {
    usageAndExit(`--pin only applies to \`${BASE_COMMAND} pool pair\`.`);
  }

  if (model !== undefined && subcommand !== 'pin' && subcommand !== 'unpin') {
    usageAndExit(`--model only applies to \`${BASE_COMMAND} pool pin\` and \`${BASE_COMMAND} pool unpin\`.`);
  }

  if (cancel && subcommand !== 'pairing-pin') {
    usageAndExit(`--cancel only applies to \`${BASE_COMMAND} pool pairing-pin\`.`);
  }

  const takesTarget = POOL_TARGET_SUBCOMMANDS.includes(subcommand);
  const target = takesTarget ? positional[1] : undefined;
  return { subcommand, target, displayName, pin, limit, axis, model, cancel, yes, env: resolveEnvFromArgs(positional.slice(takesTarget ? 2 : 1)) };
}

/**
 * Bounded, never normalized: a model id is compared verbatim and case-sensitively against the
 * engine's inventory on the Hub, so lower-casing a pin here would produce one that looks right and
 * silently never matches. Matches `MAX_PINNED_MODEL_LENGTH` on the backend.
 */
function parsePinnedModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) {
    usageAndExit('--model takes a model id as the engine reports it, e.g. llama3.2:3b (1-200 characters).');
  }
  return trimmed;
}

/** Exactly six digits, checked here so a typo is a usage error rather than a 400 from the Hub. */
function parsePairingPin(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    usageAndExit('A pairing PIN is exactly six digits, as shown by `cihub pool pairing-pin` on the other Hub.');
  }
  return trimmed;
}

/** Matches the backend's `RoutingLogQueryDto` bounds so a bad value fails here rather than as a 400. */
function parsePoolLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    usageAndExit(`--limit must be an integer between 1 and 200 (got "${raw}")`);
  }
  return value;
}

/**
 * Local sanity check mirroring the shape `normalizePeerFqdn` accepts on the backend — a scheme,
 * port, path or IP literal is rejected here so the operator gets an explanation instead of a 400.
 * The backend stays authoritative.
 */
export function isPlausiblePeerFqdn(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/i.test(value.trim().replace(/\.$/, ''));
}

/** Peer rows for a confirmation prompt: identify by FQDN, never by the uuid the operator typed a prefix of. */
function describePoolPeer(peer: { nodeFqdn: string; direction: string; status: string }): string {
  return `${sanitizeForBox(peer.nodeFqdn)} (${peer.direction}, ${peer.status})`;
}

function poolErrorExit(error: unknown, envFileName: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    printMessageBox('Hub unavailable', [`Could not reach Hub at ${resolveHubApiBase(envFileName)}.`, 'Start the Hub first: cihub up'], 'red');
    process.exit(1);
  }
  if (name === 'TimeoutError' || message.includes('timed out') || message.includes('operation was aborted')) {
    printMessageBox(
      'Hub Pool request timed out',
      [
        `No answer from ${resolveHubApiBase(envFileName)} in time.`,
        'Pairing contacts the peer over the tailnet, so an offline peer looks like this.',
      ],
      'red',
    );
    process.exit(1);
  }
  if (message.includes('failed (401)') || message.includes('failed (403)')) {
    printMessageBox('Not authorized', ['The Hub rejected this device key.', 'Re-pair this Hub with Companion Portal: cihub register'], 'red');
    process.exit(1);
  }
  if (message.startsWith('Hub API ')) {
    printMessageBox('Hub Pool request failed', [sanitizeForBox(message)], 'red');
    process.exit(1);
  }
  throw error;
}

export async function runPoolCommand(args: string[]) {
  const parsed = parsePoolArgs(args);
  // resolveHubContext (not getEnvFileOrExit) so a packaged install outside a checkout resolves the
  // canonical data dir instead of silently reading nothing and falling back to port 5002.
  const ctx = resolveHubContext(parsed.env);
  const { env, envFile } = ctx;

  if (!readHubApiKey(envFile)) {
    printMessageBox(
      'Hub not paired',
      [
        'No device key found — every pool route needs one.',
        `Expected ciHubApiKey in ${path.join(resolveRootFolderHost(envFile), 'state', 'settings.json')}.`,
        '',
        'Pair this Hub first: cihub register',
        '(The key from `cihub api-key create` is MCP-scoped and is not accepted here.)',
      ],
      'red',
    );
    process.exit(1);
  }

  try {
    if (parsed.subcommand === 'status') {
      const status = await fetchPoolStatus(envFile);
      printMessageBox(`Hub Pool  [${env}]`, formatPoolStatusLines(status), status.routingActive ? 'green' : status.enabled ? 'cyan' : 'yellow');
      return;
    }

    if (parsed.subcommand === 'peers') {
      printMessageBox(`Hub Pool peers  [${env}]`, formatPoolPeersLines(await fetchPoolPeers(envFile)), 'cyan');
      return;
    }

    if (parsed.subcommand === 'discover') {
      // Coloured on whether anything was found, not on the Admin API credential: two of the three
      // directories need none, so a credential-free Hub listing real candidates is not a warning.
      const { lines, found } = await runPoolDiscover(envFile);
      printMessageBox(`Hub Pool discovery  [${env}]`, lines, found ? 'cyan' : 'yellow');
      return;
    }

    if (parsed.subcommand === 'probe') {
      if (!parsed.target) {
        usageAndExit(`${BASE_COMMAND} pool probe <address> [env] — e.g. ${BASE_COMMAND} pool probe 192.168.1.42`);
      }
      // Deliberately NOT run through `isPlausiblePeerFqdn`: that check exists to reject the shapes
      // this command is for. The backend parses the address, and its errors name the exact problem.
      const result = await probePoolAddress(envFile, parsed.target);
      printMessageBox(`Hub Pool probe  [${env}]`, formatPoolProbeLines(result), result.pairable ? 'green' : result.isCiHub ? 'yellow' : 'red');
      return;
    }

    if (parsed.subcommand === 'pairing-pin') {
      await runPairingPinCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'log') {
      const log = await fetchPoolRoutingLog(envFile, parsed.limit);
      printMessageBox(`Hub Pool routing log  [${env}]`, formatPoolRoutingLogLines(log), log.summary.failed > 0 ? 'yellow' : 'cyan');
      return;
    }

    if (parsed.subcommand === 'enable' || parsed.subcommand === 'disable') {
      await runPoolEnableCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'pin' || parsed.subcommand === 'unpin') {
      await runPoolPinCommand(ctx, parsed);
      return;
    }

    await runPoolPeerMutation(ctx, parsed);
  } catch (error) {
    poolErrorExit(error, envFile);
  }
}

/**
 * `cihub pool pairing-pin` — mint (or revoke) the six digits a peer needs to pair with THIS Hub by
 * address.
 *
 * It runs on the Hub that will receive the request, which is the opposite side from `pool pair`, so
 * the output leads with which machine to type the digits on. Minting replaces any outstanding PIN
 * rather than adding a second, and that is stated rather than left to be discovered: an operator who
 * mints twice has invalidated the digits they are still reading off the first screen.
 *
 * The local node name comes from `GET status`, so the printed `pool pair` line is complete. A status
 * call that fails is not fatal — the digits are the point, and the address can be typed by hand.
 */
async function runPairingPinCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;

  if (parsed.cancel) {
    await cancelPairingPin(envFile);
    printMessageBox(
      `Hub Pool pairing PIN  [${env}]`,
      [
        `${STEP_ICONS.done} Any outstanding pairing PIN is revoked.`,
        '',
        'Pairing by address needs a new one: cihub pool pairing-pin',
        'Peers already paired are unaffected — the PIN only ever authenticated the request.',
      ],
      'yellow',
    );
    return;
  }

  const minted = await mintPairingPin(envFile);
  // Best-effort: the name only makes the printed command copy-pasteable, so a Hub whose status call
  // fails still gets its digits rather than an error.
  const localNodeFqdn = await fetchPoolStatus(envFile)
    .then((status) => status.localNode.nodeFqdn)
    .catch(() => null);

  printMessageBox(`Hub Pool pairing PIN  [${env}]`, formatMintedPairingPinLines(minted, localNodeFqdn), 'green');
}

/** What each axis is called, which env var overrides it, and how `/status` reports its state. */
const POOL_AXES: Record<
  PoolEnableAxis,
  { label: string; envVar: string; describe: (s: Awaited<ReturnType<typeof fetchPoolStatus>>) => { disabledBy: 'env' | 'setting' | null } }
> = {
  both: { label: 'Hub Pool', envVar: 'HUB_POOL_USER_DISABLED', describe: (s) => ({ disabledBy: s.disabledBy }) },
  outbound: { label: 'Hub Pool outbound (sending work to peers)', envVar: 'HUB_POOL_OUTBOUND_DISABLED', describe: (s) => s.directions.outbound },
  inbound: { label: 'Hub Pool inbound (serving work for peers)', envVar: 'HUB_POOL_INBOUND_DISABLED', describe: (s) => s.directions.inbound },
};

async function runPoolEnableCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const enable = parsed.subcommand === 'enable';
  const axis = POOL_AXES[parsed.axis];
  const status = await fetchPoolStatus(ctx.envFile);
  const confirmed = await confirmDestructiveAction(
    `${enable ? 'Enabling' : 'Disabling'} ${axis.label}`,
    parsed.yes,
    `${enable ? 'Enable' : 'Disable'} ${axis.label} on this node? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the Hub Pool setting untouched.'], 'yellow');
    return;
  }

  const settings = await setPoolEnabledSetting(ctx.envFile, enable, parsed.axis);
  const lines = [
    `Stored setting  poolEnabled=${settings.poolEnabled} · outbound=${settings.poolOutboundEnabled} · inbound=${settings.poolInboundEnabled}`,
  ];

  // The env flag wins by design, so a `pool enable` under it must not read as success. Checked per
  // axis, and the master is checked first: with HUB_POOL_USER_DISABLED set, enabling one direction
  // changes nothing either, and naming the directional variable would send the operator to the
  // wrong line of the wrong file.
  const blockedBy = status.disabledBy === 'env' ? POOL_AXES.both : axis.describe(status).disabledBy === 'env' ? axis : null;
  if (blockedBy) {
    const envFileHasFlag = parseEnvFile(ctx.envFile)[blockedBy.envVar] === 'true';
    lines.push(
      '',
      `${STEP_ICONS.fail} ${blockedBy === axis ? axis.label : 'Pooling'} is still off — this changed nothing in effect.`,
      `${blockedBy.envVar}=true${envFileHasFlag ? ` in ${ctx.envFile}` : " in this Hub's environment"} forces it off,`,
      'and the .env override always wins over the stored setting.',
      '',
      `Remove that line, then: ${BASE_COMMAND} restart ${ctx.env}`,
    );
    printMessageBox(enable ? `${axis.label} setting saved (override in force)` : `${axis.label} disabled`, lines, 'yellow');
    return;
  }

  if (enable && status.peerCounts.connected === 0) {
    lines.push('', 'No connected peers yet, so inference still resolves locally.', `Find candidates with: ${BASE_COMMAND} pool discover`);
  }
  if (!enable) {
    lines.push(
      '',
      parsed.axis === 'both'
        ? 'Existing pairings are kept. Peers will mark this node unreachable until it is re-enabled.'
        : parsed.axis === 'outbound'
          ? 'Existing pairings are kept, and peers may still send work here. Requests this node cannot serve now fail locally instead of being sent out.'
          : 'Existing pairings are kept, and this node keeps using its peers. They see it as healthy but not taking work, so they route elsewhere.',
    );
  }
  printMessageBox(enable ? `${axis.label} enabled` : `${axis.label} disabled`, lines, enable ? 'green' : 'yellow');
}

/**
 * `cihub pool pin <node-fqdn|local> [--model M]` / `cihub pool unpin [--model M]`.
 *
 * A pin is a preference, not a rule — the Hub only ever moves the pinned node to the front of a
 * candidate list it already built — so neither verb can take inference down and neither is treated
 * as destructive. What they CAN do is quietly stop applying, which is why both print where the pin
 * ended up and point at `pool status`, the one place `targetAvailable` is reported.
 */
async function runPoolPinCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  const scope = parsed.model === undefined ? 'default' : 'model';
  const covers = parsed.model === undefined ? 'every model' : `model "${sanitizeForBox(parsed.model)}"`;

  if (parsed.subcommand === 'unpin') {
    const { pins } = await deletePoolPin(envFile, scope, parsed.model);
    printMessageBox(
      `Pin removed  [${env}]`,
      [
        `Routing for ${covers} is back to the ranker (least-loaded, with the local head start).`,
        ...(pins.length > 0 ? ['', `${pins.length} other pin(s) remain — see: ${BASE_COMMAND} pool status`] : []),
      ],
      'yellow',
    );
    return;
  }

  if (!parsed.target) {
    usageAndExit(`Usage: ${BASE_COMMAND} pool pin <node-fqdn|local> [--model <model id>] [env] [--yes]`);
  }

  // `local` is a literal, checked BEFORE the FQDN shape test — `isPlausiblePeerFqdn` requires a dot,
  // so "local" would otherwise be read as a malformed peer name and rejected. There is no peer row
  // for this node, which is exactly why a pin cannot be a column on one.
  const toLocal = parsed.target.trim().toLowerCase() === 'local';
  if (!toLocal && !isPlausiblePeerFqdn(parsed.target)) {
    printMessageBox(
      'Not a node name',
      [
        `"${sanitizeForBox(parsed.target)}" is neither \`local\` nor a tailnet hostname.`,
        '',
        `Pin to this Hub:  ${BASE_COMMAND} pool pin local`,
        `Pin to a peer:    ${BASE_COMMAND} pool pin <node-fqdn>   (see: ${BASE_COMMAND} pool peers)`,
      ],
      'red',
    );
    process.exit(2);
  }

  let peer: { id: string; nodeFqdn: string; status: string } | undefined;
  if (!toLocal) {
    const peers = await fetchPoolPeers(envFile);
    const resolved = resolvePoolPeerTarget(peers, parsed.target);
    if ('error' in resolved) {
      printMessageBox('Peer not found', [resolved.error], 'red');
      process.exit(2);
    }
    peer = resolved.peer;
  }

  const label = toLocal ? 'this Hub' : sanitizeForBox(peer?.nodeFqdn ?? '');
  const confirmed = await confirmDestructiveAction(
    `Pinning ${covers} to ${label}`,
    parsed.yes,
    `Prefer ${label} for ${covers}? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left routing untouched.'], 'yellow');
    return;
  }

  await setPoolPin(
    envFile,
    toLocal
      ? { scope, ...(parsed.model === undefined ? {} : { model: parsed.model }), targetKind: 'local' }
      : { scope, ...(parsed.model === undefined ? {} : { model: parsed.model }), targetKind: 'peer', targetPeerId: peer?.id as string },
  );

  printMessageBox(
    `Pinned  [${env}]`,
    [
      `${covers} → ${label}`,
      '',
      'This is a preference, not a rule: when the pinned node cannot serve a request it is ranked',
      'normally and the request still goes somewhere. Nothing restarts — the next pooled request',
      'already uses it.',
      '',
      ...(peer && peer.status !== 'connected'
        ? [`${STEP_ICONS.fail} That peer is ${sanitizeForBox(peer.status)} right now, so the pin does nothing until it recovers.`, '']
        : []),
      `Check it took effect: ${BASE_COMMAND} pool status`,
    ],
    'green',
  );
}

async function runPoolPeerMutation(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  if (!parsed.target) {
    usageAndExit(
      parsed.subcommand === 'pair'
        ? `Usage: ${BASE_COMMAND} pool pair <node-fqdn|address> [env] [--pin <digits>] [--name <label>] [--yes]`
        : `Usage: ${BASE_COMMAND} pool ${parsed.subcommand} <id|node-fqdn> [env] [--yes]`,
    );
  }

  if (parsed.subcommand === 'pair') {
    // Two shapes, told apart by whether the target looks like a MagicDNS name. An address needs a
    // PIN, because the far Hub only discloses its tailnet name — the name the row is keyed on — to a
    // request carrying one; `/identify` reports no name to anybody.
    const byName = isPlausiblePeerFqdn(parsed.target);
    if (!byName && parsed.pin === undefined) {
      printMessageBox(
        'Pairing by address needs a PIN',
        [
          `"${sanitizeForBox(parsed.target)}" is not a MagicDNS name, so it is being read as an address.`,
          '',
          'An address can reach the other Hub but cannot name it: /identify is unauthenticated and',
          'reports no MagicDNS name. The name comes back in the answer to a PIN-authenticated',
          'pairing request, so pairing by address needs the PIN from that Hub:',
          '',
          '  on that Hub:  cihub pool pairing-pin',
          `  then here:    ${BASE_COMMAND} pool pair ${sanitizeForBox(parsed.target)} --pin <digits>`,
          '',
          'Or pass the bare tailnet hostname instead: e.g. hub-b.example-tailnet.ts.net',
        ],
        'red',
      );
      process.exit(2);
    }
    const confirmed = await confirmDestructiveAction(
      `Pairing with ${sanitizeForBox(parsed.target)}`,
      parsed.yes,
      `Send a pairing request to ${sanitizeForBox(parsed.target)}? [y/N]: `,
      'a state change',
    );
    if (!confirmed) {
      printMessageBox('Pairing cancelled', ['No pairing request was sent.'], 'yellow');
      return;
    }
    const peer = await pairPoolPeer(envFile, byName ? { nodeFqdn: parsed.target } : { address: parsed.target }, parsed.displayName, parsed.pin);
    printMessageBox(
      `Pairing requested  [${env}]`,
      [
        `Peer   ${sanitizeForBox(peer.nodeFqdn)}`,
        `Id     ${sanitizeForBox(peer.id)}`,
        `Status ${peer.status}`,
        '',
        'Nothing is pooled until the other Hub approves. The request appears there as an',
        `inbound pending peer — on that Hub run \`${BASE_COMMAND} pool peers\` then`,
        `\`${BASE_COMMAND} pool approve <id>\`, or approve it in Settings → Network → Hub Pool.`,
      ],
      'green',
    );
    return;
  }

  const peers = await fetchPoolPeers(envFile);
  const resolved = resolvePoolPeerTarget(peers, parsed.target);
  if ('error' in resolved) {
    printMessageBox('Peer not found', [resolved.error], 'red');
    process.exit(2);
  }
  const peer = resolved.peer;

  const prompts: Record<
    'approve' | 'reject' | 'unpair' | 'peer-enable' | 'peer-disable',
    { label: string; question: string; noun: string; done: string; lines: string[] }
  > = {
    approve: {
      label: `Approving ${describePoolPeer(peer)}`,
      question: `Approve pairing with ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'a state change',
      done: 'Peer approved',
      lines: ['This node now issues the peer a token and starts offering it as a routing candidate.'],
    },
    reject: {
      label: `Rejecting ${describePoolPeer(peer)}`,
      question: `Reject the pairing request from ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'destructive',
      done: 'Peer rejected',
      lines: ['The request row was deleted and the other Hub was notified.'],
    },
    unpair: {
      label: `Unpairing ${describePoolPeer(peer)}`,
      question: `Unpair ${sanitizeForBox(peer.nodeFqdn)} and revoke both tokens? [y/N]: `,
      noun: 'destructive',
      done: 'Peer unpaired',
      lines: [
        'Both halves of the pairing are gone; re-pairing needs a fresh approval.',
        'A peer that was merely offline recovers on its own — unpairing is not the fix for that.',
      ],
    },
    'peer-enable': {
      label: `Enabling ${describePoolPeer(peer)}`,
      question: `Put ${sanitizeForBox(peer.nodeFqdn)} back in the pool? [y/N]: `,
      noun: 'a state change',
      done: 'Peer enabled',
      lines: ['Work flows both ways with this peer again, from the next request and the next health poll.'],
    },
    'peer-disable': {
      label: `Disabling ${describePoolPeer(peer)}`,
      question: `Stop exchanging work with ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'a state change',
      done: 'Peer disabled',
      lines: [
        'No work moves in either direction with this peer while it is off.',
        'This is NOT a revocation: the pairing and both tokens are kept, so re-enabling is instant',
        `and needs no approval from the other side. To revoke, use \`${BASE_COMMAND} pool unpair <id>\`.`,
      ],
    },
  };
  const plan = prompts[parsed.subcommand as 'approve' | 'reject' | 'unpair' | 'peer-enable' | 'peer-disable'];

  if (!(await confirmDestructiveAction(plan.label, parsed.yes, plan.question, plan.noun))) {
    printMessageBox('Cancelled', ['Left the pairing untouched.'], 'yellow');
    return;
  }

  if (parsed.subcommand === 'approve') await approvePoolPeer(envFile, peer.id);
  else if (parsed.subcommand === 'reject') await rejectPoolPeer(envFile, peer.id);
  else if (parsed.subcommand === 'peer-enable') await setPoolPeerEnabled(envFile, peer.id, true);
  else if (parsed.subcommand === 'peer-disable') await setPoolPeerEnabled(envFile, peer.id, false);
  else await unpairPoolPeer(envFile, peer.id);

  printMessageBox(
    `${plan.done}  [${env}]`,
    [`Peer  ${sanitizeForBox(peer.nodeFqdn)}`, ...plan.lines],
    parsed.subcommand === 'approve' || parsed.subcommand === 'peer-enable' ? 'green' : 'yellow',
  );
}
