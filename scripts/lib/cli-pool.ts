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
  fetchPoolPeers,
  fetchPoolRoutingLog,
  fetchPoolStatus,
  formatPoolPeersLines,
  formatPoolRoutingLogLines,
  formatPoolStatusLines,
  pairPoolPeer,
  rejectPoolPeer,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setPoolEnabledSetting,
  unpairPoolPeer,
} from '../hub-pool-cli.js';
import { readHubApiKey, resolveHubApiBase } from '../public-web-cli.js';
import { resolveEnvFromArgs, usageAndExit } from './cli-args.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { printMessageBox, sanitizeForBox, STEP_ICONS } from './cli-ui.js';
import { type HubContext, resolveHubContext } from './hub-context.js';
import { resolveRootFolderHost } from './paths.js';

export const POOL_SUBCOMMANDS = ['status', 'peers', 'discover', 'pair', 'approve', 'reject', 'unpair', 'log', 'enable', 'disable'] as const;
export type PoolSubcommand = (typeof POOL_SUBCOMMANDS)[number];

/** Subcommands taking a peer reference before the optional [env], so the env parser never sees it. */
const POOL_TARGET_SUBCOMMANDS: readonly PoolSubcommand[] = ['pair', 'approve', 'reject', 'unpair'];

const POOL_USAGE = `Usage: ${BASE_COMMAND} pool <${POOL_SUBCOMMANDS.join('|')}> [env]`;

export interface ParsedPoolArgs {
  subcommand: PoolSubcommand;
  target?: string;
  displayName?: string;
  limit?: number;
  yes: boolean;
  env: HubEnv;
}

/**
 * Flags are stripped before `resolveEnvFromArgs`, which exits on any token it does not recognise as
 * an environment.
 */
export function parsePoolArgs(args: string[]): ParsedPoolArgs {
  let yes = false;
  let displayName: string | undefined;
  let limit: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--name' || arg === '--limit') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) usageAndExit(`Missing value for ${arg}. ${POOL_USAGE}`);
      if (arg === '--name') displayName = next;
      else limit = parsePoolLimit(next);
      i += 1;
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

  const takesTarget = POOL_TARGET_SUBCOMMANDS.includes(subcommand);
  const target = takesTarget ? positional[1] : undefined;
  return { subcommand, target, displayName, limit, yes, env: resolveEnvFromArgs(positional.slice(takesTarget ? 2 : 1)) };
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
      const { lines, configured } = await runPoolDiscover(envFile);
      printMessageBox(`Hub Pool discovery  [${env}]`, lines, configured ? 'cyan' : 'yellow');
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

    await runPoolPeerMutation(ctx, parsed);
  } catch (error) {
    poolErrorExit(error, envFile);
  }
}

async function runPoolEnableCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const enable = parsed.subcommand === 'enable';
  const status = await fetchPoolStatus(ctx.envFile);
  const confirmed = await confirmDestructiveAction(
    `${enable ? 'Enabling' : 'Disabling'} Hub Pool`,
    parsed.yes,
    `${enable ? 'Enable' : 'Disable'} Hub Pool routing on this node? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the Hub Pool setting untouched.'], 'yellow');
    return;
  }

  const settings = await setPoolEnabledSetting(ctx.envFile, enable);
  const lines = [`Stored setting  poolEnabled=${settings.poolEnabled}`];

  // The env flag wins by design, so a `pool enable` under it must not read as success.
  if (status.disabledBy === 'env') {
    const envFileHasFlag = parseEnvFile(ctx.envFile).HUB_POOL_USER_DISABLED === 'true';
    lines.push(
      '',
      `${STEP_ICONS.fail} Pooling is still off — this changed nothing in effect.`,
      `HUB_POOL_USER_DISABLED=true${envFileHasFlag ? ` in ${ctx.envFile}` : " in this Hub's environment"} forces pooling off,`,
      'and the .env override always wins over the stored setting.',
      '',
      `Remove that line, then: ${BASE_COMMAND} restart ${ctx.env}`,
    );
    printMessageBox(enable ? 'Hub Pool setting saved (override in force)' : 'Hub Pool disabled', lines, 'yellow');
    return;
  }

  if (enable && status.peerCounts.connected === 0) {
    lines.push('', 'No connected peers yet, so inference still resolves locally.', `Find candidates with: ${BASE_COMMAND} pool discover`);
  }
  if (!enable) {
    lines.push('', 'Existing pairings are kept. Peers will mark this node unreachable until it is re-enabled.');
  }
  printMessageBox(enable ? 'Hub Pool enabled' : 'Hub Pool disabled', lines, enable ? 'green' : 'yellow');
}

async function runPoolPeerMutation(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  if (!parsed.target) {
    usageAndExit(
      parsed.subcommand === 'pair'
        ? `Usage: ${BASE_COMMAND} pool pair <node-fqdn> [env] [--name <label>] [--yes]`
        : `Usage: ${BASE_COMMAND} pool ${parsed.subcommand} <id|node-fqdn> [env] [--yes]`,
    );
  }

  if (parsed.subcommand === 'pair') {
    if (!isPlausiblePeerFqdn(parsed.target)) {
      printMessageBox(
        'Not a peer hostname',
        [
          `"${sanitizeForBox(parsed.target)}" is not a MagicDNS name.`,
          'Pass the bare hostname a peer publishes on the tailnet — no scheme, port or path,',
          'and not an IP address: e.g. hub-b.example-tailnet.ts.net',
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
    const peer = await pairPoolPeer(envFile, parsed.target, parsed.displayName);
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

  const prompts: Record<'approve' | 'reject' | 'unpair', { label: string; question: string; noun: string; done: string; lines: string[] }> = {
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
  };
  const plan = prompts[parsed.subcommand as 'approve' | 'reject' | 'unpair'];

  if (!(await confirmDestructiveAction(plan.label, parsed.yes, plan.question, plan.noun))) {
    printMessageBox('Cancelled', ['Left the pairing untouched.'], 'yellow');
    return;
  }

  if (parsed.subcommand === 'approve') await approvePoolPeer(envFile, peer.id);
  else if (parsed.subcommand === 'reject') await rejectPoolPeer(envFile, peer.id);
  else await unpairPoolPeer(envFile, peer.id);

  printMessageBox(
    `${plan.done}  [${env}]`,
    [`Peer  ${sanitizeForBox(peer.nodeFqdn)}`, ...plan.lines],
    parsed.subcommand === 'approve' ? 'green' : 'yellow',
  );
}
