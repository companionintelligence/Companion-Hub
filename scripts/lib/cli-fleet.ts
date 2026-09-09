/**
 * `cihub fleet` — operations across many machines.
 *
 * Every other `cihub` command acts on the machine it runs on; `cihub pool` says so explicitly. This
 * is the first group that reaches out, which makes two things non-negotiable:
 *
 *   · **Read-only by default.** `scan` changes nothing anywhere. `install` and `update` require an
 *     explicit `--execute`; without it they print the plan and exit. A tool that can touch fourteen
 *     machines should make the destructive path the one you have to ask for.
 *   · **Every failure names the machine and the reason.** A fleet command that reports "3 failed"
 *     has told the operator nothing they can act on.
 *
 * Arg parsing is hand-rolled to match the rest of this CLI, which deliberately has no parsing
 * library (see `docs/CLI.md`).
 */

import { loadFleetRoster, mergeFleetRoster, partitionForRun, saveFleetRoster, fleetRosterPath, type FleetNode } from './fleet-roster.js';
import { probeNode, resolveTailscaleCli, scanLan, summariseNode, tailnetPeers, type DiscoveredNode } from './fleet-discover.js';
import { describeSshFailure } from './fleet-ssh.js';
import { readHostFacts, isTooBusyForMaintenance } from './fleet-hardware.js';
import { executeBackendPlan, planAllBackends, INSTALLABLE_BACKENDS, type InstallableBackend } from './fleet-backends.js';
import { installNode, pullModelScript, updateHubScript } from './fleet-install.js';
import { checkAppOnNode, poolRoutingScript, SUPPORTED_APP_SLUGS, type AppEndpointMode, type AppSlug } from './fleet-apps.js';
import { sshCapture } from './fleet-ssh.js';
import { colorize } from './cli-ui.js';
import { BASE_COMMAND } from './cli-types.js';

export const FLEET_SUBCOMMANDS = ['scan', 'list', 'status', 'backends', 'install', 'update', 'apps'] as const;
export type FleetSubcommand = (typeof FLEET_SUBCOMMANDS)[number];

export interface FleetArgs {
  subcommand: FleetSubcommand;
  json: boolean;
  lan: boolean;
  tailnet: boolean;
  writeRoster: boolean;
  execute: boolean;
  nodes: string[];
  timeoutMs: number;
  concurrency: number;
  /** Remote account for SSH. The tailnet ACL grants specific users, and it is rarely your local one. */
  user?: string;
  /** Restrict `backends` to these. Empty means every installable backend. */
  backends: InstallableBackend[];
  /** Where the Hub keeps runner venvs and model dirs on the REMOTE machine. */
  dataDir: string;
  /** Portal pairing code for `install`. Six characters. */
  code?: string;
  /** Postgres password for the appliance seed. Never logged. */
  postgresPassword?: string;
  /** Pair each installed node into this Hub's pool. */
  joinPool?: string;
  poolPin?: string;
  /** Models to pull during `update`. */
  models: string[];
  /** Update the Hub image during `update`. */
  hub: boolean;
  /** Agent apps for `apps`. Empty means both supported slugs. */
  apps: AppSlug[];
  /** Where an app should send inference. */
  endpoint: AppEndpointMode;
}

export class FleetArgError extends Error {}

/** Parse `fleet` argv. Throws {@link FleetArgError} with an actionable message rather than exiting. */
export function parseFleetArgs(argv: readonly string[]): FleetArgs {
  const args: FleetArgs = {
    subcommand: 'scan',
    json: false,
    // Default to the tailnet only. A LAN sweep touches every address on the operator's subnet, which
    // is a different and more intrusive act than listing a tailnet they already belong to — it should
    // be asked for.
    lan: false,
    tailnet: true,
    writeRoster: false,
    execute: false,
    nodes: [],
    timeoutMs: 4_000,
    concurrency: 4,
    // No baked-in default. `root` is what this fleet grants and `ci` is what the QA harness assumes,
    // so guessing would be wrong half the time and silently — the scan reports 'acl-wrong-user' and
    // names the flag instead.
    user: process.env.FLEET_SSH_USER || undefined,
    backends: [],
    dataDir: '/var/lib/companion-hub',
    code: undefined,
    postgresPassword: process.env.CIHUB_POSTGRES_PASSWORD || undefined,
    joinPool: undefined,
    poolPin: undefined,
    models: [],
    hub: false,
    apps: [],
    // Pool by default: the whole point of installing an agent on a pooled fleet is that it reaches
    // the cluster rather than one box.
    endpoint: 'pool',
  };

  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (!(FLEET_SUBCOMMANDS as readonly string[]).includes(first)) {
      throw new FleetArgError(`Unknown fleet subcommand '${first}'. Valid: ${FLEET_SUBCOMMANDS.join(', ')}.`);
    }
    args.subcommand = first as FleetSubcommand;
    rest.shift();
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    const readValue = (flag: string): string => {
      const inline = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
      if (inline !== undefined) return inline;
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('-')) throw new FleetArgError(`${flag} needs a value.`);
      i += 1;
      return next;
    };

    if (arg === '--json') args.json = true;
    else if (arg === '--lan') args.lan = true;
    else if (arg === '--no-tailnet') args.tailnet = false;
    else if (arg === '--write-roster') args.writeRoster = true;
    else if (arg === '--execute') args.execute = true;
    else if (arg.startsWith('--user')) args.user = readValue('--user');
    else if (arg.startsWith('--data-dir')) args.dataDir = readValue('--data-dir');
    else if (arg.startsWith('--code')) args.code = readValue('--code');
    else if (arg.startsWith('--join-pool')) args.joinPool = readValue('--join-pool');
    else if (arg.startsWith('--pool-pin')) args.poolPin = readValue('--pool-pin');
    else if (arg === '--hub') args.hub = true;
    else if (arg.startsWith('--endpoint')) {
      const mode = readValue('--endpoint');
      if (mode !== 'pool' && mode !== 'local') throw new FleetArgError("--endpoint must be 'pool' or 'local'.");
      args.endpoint = mode;
    } else if (arg.startsWith('--apps')) {
      const names = readValue('--apps')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      for (const name of names) {
        if (!(SUPPORTED_APP_SLUGS as readonly string[]).includes(name)) {
          throw new FleetArgError(`Unknown app '${name}'. CI-Hub serves inference credentials to: ${SUPPORTED_APP_SLUGS.join(', ')}.`);
        }
      }
      args.apps = names as AppSlug[];
    } else if (arg.startsWith('--models')) {
      args.models = readValue('--models')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--backends')) {
      const names = readValue('--backends')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const name of names) {
        if (!(INSTALLABLE_BACKENDS as readonly string[]).includes(name)) {
          throw new FleetArgError(`Unknown backend '${name}'. Valid: ${INSTALLABLE_BACKENDS.join(', ')}.`);
        }
      }
      args.backends = names as InstallableBackend[];
    } else if (arg.startsWith('--nodes')) {
      args.nodes = readValue('--nodes')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--timeout')) {
      const ms = Number(readValue('--timeout'));
      if (!Number.isFinite(ms) || ms < 250 || ms > 120_000) throw new FleetArgError('--timeout must be between 250 and 120000 ms.');
      args.timeoutMs = ms;
    } else if (arg.startsWith('--concurrency')) {
      const n = Number(readValue('--concurrency'));
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new FleetArgError('--concurrency must be an integer between 1 and 32.');
      args.concurrency = n;
    } else if (arg.startsWith('-')) {
      throw new FleetArgError(`Unknown flag '${arg}' for ${BASE_COMMAND} fleet.`);
    } else {
      throw new FleetArgError(`Unexpected argument '${arg}'.`);
    }
  }

  return args;
}

/** Fixed-width table, so a 20-node listing is scannable rather than a wall of prose. */
function renderTable(rows: string[][], headers: string[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [colorize(line(headers), 'dim'), ...rows.map(line)].join('\n');
}

async function probeAll(nodes: readonly FleetNode[], args: FleetArgs, source: DiscoveredNode['source']): Promise<DiscoveredNode[]> {
  const out: DiscoveredNode[] = [];
  const queue = [...nodes];
  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      out.push({ ...node, source, probe: await probeNode(node, { timeoutMs: args.timeoutMs, skipSsh: node.local === true, user: args.user }) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(nodes.length, 1)) }, worker));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function runScan(args: FleetArgs): Promise<void> {
  const candidates = new Map<string, FleetNode>();
  const notes: string[] = [];

  const roster = loadFleetRoster();
  for (const node of roster.nodes) candidates.set(node.ip, node);
  for (const dropped of roster.dropped) notes.push(`roster: ${dropped}`);

  if (args.tailnet) {
    const cli = resolveTailscaleCli();
    if (cli) {
      const { peers, error } = tailnetPeers(cli);
      if (error) notes.push(`tailnet: ${error}`);
      for (const peer of peers) {
        const existing = candidates.get(peer.ip);
        candidates.set(peer.ip, {
          name: existing?.name ?? peer.name,
          ip: peer.ip,
          tailnetName: peer.dnsName ?? existing?.tailnetName,
          user: existing?.user,
          local: existing?.local,
          skip: existing?.skip,
          note: existing?.note ?? (peer.online ? undefined : 'tailnet reports offline'),
        });
      }
      notes.push(`tailnet: ${peers.length} peer(s) enumerated`);
    } else {
      notes.push('tailscale CLI not found — skipping tailnet enumeration (set TAILSCALE_CLI to override)');
    }
  }

  if (args.lan) {
    const hits = await scanLan(new Set(candidates.keys()));
    for (const ip of hits) candidates.set(ip, { name: ip, ip });
    notes.push(`lan: ${hits.length} additional address(es) answering an engine or Hub port`);
  }

  const all = [...candidates.values()];
  if (all.length === 0) {
    console.log('No candidates found. Is Tailscale running? Try --lan to sweep the local subnet.');
    for (const note of notes) console.log(colorize(`  ${note}`, 'dim'));
    return;
  }

  const probed = await probeAll(all, args, 'tailnet');

  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rosterPath: fleetRosterPath(), notes, nodes: probed }, null, 2));
    return;
  }

  // The three axes stay three columns. Collapsing them is the blind spot this command exists to close.
  const rows = probed.map((n) => [
    n.name,
    n.ip,
    n.probe.ssh ? 'yes' : colorize('no', 'yellow'),
    n.probe.hub ? 'yes' : '—',
    n.probe.engines.length ? String(n.probe.engines.length) : '—',
    summariseNode(n),
  ]);
  console.log(renderTable(rows, ['NODE', 'ADDRESS', 'SSH', 'HUB', 'ENGINES', 'VERDICT']));
  console.log('');

  const wrongUser = probed.filter((n) => n.probe.sshFailure === 'acl-wrong-user');
  if (wrongUser.length) {
    console.log(
      colorize(
        `${wrongUser.length} node(s) permit SSH, but not as the user tried${args.user ? ` ('${args.user}')` : ' (your local username)'}:`,
        'yellow',
      ),
    );
    console.log(`  Re-run with --user <account>, e.g. '${BASE_COMMAND} fleet scan --user root'.`);
    console.log('');
  }
  const unadministrable = probed.filter((n) => n.probe.sshFailure === 'acl-denied' && (n.probe.engines.length > 0 || n.probe.hub));
  if (unadministrable.length) {
    console.log(colorize(`${unadministrable.length} node(s) serve inference and grant no SSH at all:`, 'yellow'));
    for (const n of unadministrable) console.log(`  ${describeSshFailure(n.probe.sshFailure, n.name)}`);
    console.log('');
  }
  for (const note of notes) console.log(colorize(`  ${note}`, 'dim'));

  if (args.writeRoster) {
    const merged = mergeFleetRoster(
      roster.nodes,
      probed.map(({ probe: _probe, source: _source, ...node }) => node),
    );
    saveFleetRoster(merged.nodes);
    console.log('');
    console.log(`Roster written to ${fleetRosterPath()} (${merged.nodes.length} node(s), ${merged.added.length} new).`);
    console.log(colorize('Existing names, notes and skip markers were preserved.', 'dim'));
  } else {
    console.log(colorize(`Nothing was written. Re-run with --write-roster to save this to ${fleetRosterPath()}.`, 'dim'));
  }
}

function runList(args: FleetArgs): void {
  const roster = loadFleetRoster();
  if (args.json) {
    console.log(JSON.stringify({ source: roster.source, nodes: roster.nodes, dropped: roster.dropped }, null, 2));
    return;
  }
  if (roster.nodes.length === 0) {
    console.log(`No roster yet. Run '${BASE_COMMAND} fleet scan --write-roster' to create one.`);
    console.log(colorize(`  looked in ${roster.source}`, 'dim'));
    return;
  }
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  console.log(
    renderTable(
      run.map((n) => [n.name, n.ip, n.tailnetName ?? '—', n.note ?? '']),
      ['NODE', 'ADDRESS', 'TAILNET NAME', 'NOTE'],
    ),
  );
  if (skipped.length) {
    console.log('');
    console.log(colorize('Not attempted by fleet operations:', 'dim'));
    for (const s of skipped) console.log(colorize(`  ${s.node.name}: ${s.why}`, 'dim'));
  }
  for (const dropped of roster.dropped) console.log(colorize(`  dropped: ${dropped}`, 'yellow'));
}

async function runStatus(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  if (roster.nodes.length === 0) {
    console.log(`No roster yet. Run '${BASE_COMMAND} fleet scan --write-roster' first.`);
    return;
  }
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  const probed = await probeAll(run, args, 'roster');

  if (args.json) {
    console.log(JSON.stringify({ nodes: probed, skipped: skipped.map((s) => ({ node: s.node.name, why: s.why })) }, null, 2));
    return;
  }
  console.log(
    renderTable(
      probed.map((n) => [
        n.name,
        n.probe.ssh ? 'yes' : colorize('no', 'yellow'),
        n.probe.hub ? (n.probe.hubDetail ?? 'yes') : '—',
        n.probe.engines.join(' ') || '—',
      ]),
      ['NODE', 'SSH', 'HUB', 'ENGINES'],
    ),
  );
  if (skipped.length) {
    console.log('');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  }
}

/**
 * `cihub fleet backends` — install or adopt inference backends across the fleet.
 *
 * Read-only unless `--execute`. The dry run is the useful default: it reports what each machine can
 * run and why, which is most of the value even when nothing is installed.
 */
async function runBackends(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  if (roster.nodes.length === 0) {
    console.log(`No roster yet. Run '${BASE_COMMAND} fleet scan --write-roster' first.`);
    return;
  }
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be installed. Add --execute to apply.', 'dim'));
    console.log('');
  }

  const report: Record<string, unknown>[] = [];

  // Serialised across nodes on purpose. A backend install pulls gigabytes (CUDA wheels, GPU
  // container images); running several at once saturates the link they all share and, measured on
  // this fleet, blocks the nodes' own HTTP listeners long enough to look absent to everything else.
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const { facts, error } = await readHostFacts(target);
    if (!facts) {
      console.log(`${colorize(node.name, 'yellow')}: could not read hardware — ${String(error).slice(0, 120)}`);
      report.push({ node: node.name, error: String(error) });
      continue;
    }

    const busy = isTooBusyForMaintenance(facts);
    const plans = planAllBackends(facts, args.dataDir, args.backends.length ? args.backends : undefined);
    const gpu = facts.gpus.map((g) => `${g.vendor}${g.gfx ? `/${g.gfx}` : ''}${g.driverWorking ? '' : ' [driver dead]'}`).join(', ') || 'no gpu';
    console.log(`${node.name}  ${colorize(`${facts.os}/${facts.arch} · ${gpu} · load ${facts.load1 ?? '?'}`, 'dim')}`);
    for (const note of facts.notes) console.log(colorize(`  ! ${note}`, 'yellow'));

    if (busy.busy && args.execute) {
      // The reason this gate exists: a fleet-wide upgrade pass on this fleet caught one node
      // mid-inference at load 108-116 and left it needing physical recovery. Nothing checked first.
      console.log(colorize(`  refusing to install: ${busy.why}`, 'yellow'));
      report.push({ node: node.name, skipped: busy.why });
      console.log('');
      continue;
    }

    for (const plan of plans) {
      if (!args.execute) {
        const tag = plan.action === 'install' ? colorize('would install', 'green') : plan.action;
        console.log(`  ${plan.backend.padEnd(9)} ${tag} — ${plan.why}`);
        report.push({ node: node.name, backend: plan.backend, action: plan.action, why: plan.why });
        continue;
      }
      const result = await executeBackendPlan(target, plan);
      const tone = result.outcome === 'failed' ? 'red' : result.outcome === 'installed' ? 'green' : 'dim';
      const took = result.ms ? ` (${Math.round(result.ms / 1000)}s)` : '';
      console.log(`  ${plan.backend.padEnd(9)} ${colorize(result.outcome, tone)}${took} — ${result.why}`);
      if (result.detail && result.outcome === 'failed') console.log(colorize(`    ${result.detail}`, 'dim'));
      report.push({ node: node.name, ...result });
    }
    console.log('');
  }

  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (args.json) console.log(JSON.stringify(report, null, 2));
}

/**
 * `cihub fleet install` — stand a Hub up on every selected node.
 *
 * Serialised, and load-gated per node. Both because a fleet-wide pass on this fleet upgraded a
 * machine that was serving live traffic at load 108-116 and left it needing physical recovery.
 */
async function runInstall(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be installed. Add --execute to apply.', 'dim'));
    console.log(`  would install on ${run.length} node(s): ${run.map((n) => n.name).join(', ')}`);
    if (args.joinPool) console.log(`  each would then pair into ${args.joinPool}`);
    console.log(colorize('  requires --code <portal-pairing-code> and a Postgres password', 'dim'));
    return;
  }

  // Checked here rather than at parse time so a dry run needs neither secret.
  if (!args.code) {
    console.error(colorize('--code <portal-pairing-code> is required. Get one from Companion Portal.', 'red'));
    process.exit(2);
  }
  if (!args.postgresPassword || args.postgresPassword.length < 8) {
    console.error(colorize('A Postgres password of at least 8 characters is required.', 'red'));
    console.error(colorize('  Set CIHUB_POSTGRES_PASSWORD in your environment; it is never passed on a command line.', 'dim'));
    process.exit(2);
  }

  const reports = [];
  for (const node of run) {
    console.log(`\n${node.name}`);
    const report = await installNode(
      node,
      {
        postgresPassword: args.postgresPassword,
        pairingCode: args.code,
        joinPool: args.joinPool,
        poolPin: args.poolPin,
      },
      args.user,
    );
    for (const st of report.steps) {
      const icon = st.skipped ? colorize('·', 'dim') : st.ok ? colorize('✓', 'green') : colorize('✗', 'red');
      const took = st.ms ? colorize(` (${Math.round(st.ms / 1000)}s)`, 'dim') : '';
      console.log(`  ${icon} ${st.name}${took} — ${st.detail}`);
    }
    reports.push(report);
  }

  const ok = reports.filter((r) => r.ok).length;
  console.log(`\n${ok}/${reports.length} node(s) installed.`);
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (args.json) console.log(JSON.stringify(reports, null, 2));
}

/**
 * `cihub fleet update` — refresh the Hub image and/or pull models across the fleet.
 *
 * Model pulls are serialised for a measured reason: concurrent cold loads of 20-50 GB blocked the
 * nodes' own HTTP listeners long enough that the tooling reported them absent while they worked.
 */
async function runUpdate(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    return;
  }
  if (!args.hub && args.models.length === 0) {
    console.log('Nothing to do. Pass --hub to update the Hub image, --models a,b to pull models, or both.');
    return;
  }
  if (!args.execute) {
    console.log(colorize('Dry run — nothing will change. Add --execute to apply.', 'dim'));
    console.log(`  ${run.length} node(s): ${run.map((n) => n.name).join(', ')}`);
    if (args.hub) console.log('  would run: cihub pool update');
    for (const m of args.models) console.log(`  would pull: ${m}`);
    return;
  }

  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    console.log(`\n${node.name}`);
    if (args.hub) {
      const res = await sshCapture(target, `bash <<'EOF'\n${updateHubScript()}\nEOF`, 20 * 60_000);
      const ok = res.ok && res.out.includes('hub-update-complete');
      console.log(
        `  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} hub image — ${(res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? ''}`,
      );
    }
    for (const model of args.models) {
      const res = await sshCapture(target, `bash <<'EOF'\n${pullModelScript(model)}\nEOF`, 45 * 60_000);
      const ok = res.ok && res.out.includes('model-pull-complete');
      console.log(
        `  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${model} — ${(res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? ''}`,
      );
    }
  }
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
}

/**
 * `cihub fleet apps` — check that the agent apps can actually get inference from each node.
 *
 * Deliberately a CHECK, not an installer. Marketplace install runs through entitlement checks and a
 * compose pipeline that belong on the Hub, and driving it blind across a fleet would distribute the
 * device key to every node's containers — the repo's own warning is that installing an app grants
 * Hub operator authority. What is genuinely missing and safe is the pre-flight: does the Hub serve
 * this slug credentials, and does an inference base URL resolve.
 */
async function runApps(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    return;
  }
  const slugs = args.apps.length ? args.apps : [...SUPPORTED_APP_SLUGS];
  console.log(colorize(`Checking ${slugs.join(', ')} against the ${args.endpoint} endpoint on ${run.length} node(s).`, 'dim'));
  console.log(colorize('This reads credentials; it installs nothing.', 'dim'));
  console.log('');

  const report: Record<string, unknown>[] = [];
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const pool = await sshCapture(target, `bash <<'EOF'\n${poolRoutingScript()}\nEOF`, 30_000);
    const pooled = pool.out.includes('pool-routes-present');
    console.log(`${node.name} ${colorize(pooled ? 'pool routes present' : 'no pool routes', 'dim')}`);
    for (const slug of slugs) {
      const check = await checkAppOnNode(target, slug, args.endpoint);
      console.log(`  ${check.ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${slug} — ${check.detail}`);
      report.push({ node: node.name, pooled, ...check });
    }
  }
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  console.log('');
  console.log(colorize('Note: every installed app receives the Hub device key in its environment —', 'yellow'));
  console.log(colorize('installing one grants Hub operator authority. Install from the Hub UI or API.', 'yellow'));
  if (args.json) console.log(JSON.stringify(report, null, 2));
}

export async function runFleetCommand(argv: readonly string[]): Promise<void> {
  let args: FleetArgs;
  try {
    args = parseFleetArgs(argv);
  } catch (error) {
    if (error instanceof FleetArgError) {
      console.error(colorize(error.message, 'red'));
      process.exit(1);
    }
    throw error;
  }

  switch (args.subcommand) {
    case 'scan':
      await runScan(args);
      return;
    case 'list':
      runList(args);
      return;
    case 'status':
      await runStatus(args);
      return;
    case 'backends':
      await runBackends(args);
      return;
    case 'install':
      await runInstall(args);
      return;
    case 'update':
      await runUpdate(args);
      return;
    case 'apps':
      await runApps(args);
      return;
  }
}
