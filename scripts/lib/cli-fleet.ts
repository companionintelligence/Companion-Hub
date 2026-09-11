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

import { DEVICE_PAIR_SCOPE, loginScope, mintPairingCode, type PortalLogin, readStoredLogin } from './catalog-submit.js';
import { loadFleetRoster, mergeFleetRoster, partitionForRun, saveFleetRoster, fleetRosterPath, type FleetNode } from './fleet-roster.js';
import { probeNode, resolveTailscaleCli, scanLan, summariseNode, tailnetPeers, type DiscoveredNode } from './fleet-discover.js';
import { describeSshFailure } from './fleet-ssh.js';
import { readHostFacts, isTooBusyForMaintenance } from './fleet-hardware.js';
import { executeBackendPlan, planAllBackends, INSTALLABLE_BACKENDS, type InstallableBackend } from './fleet-backends.js';
import { installNode, pullModelScript, updateHubScript } from './fleet-install.js';
import { gatePreflight, PREFLIGHT_CHECKS, type PreflightFinding, type PreflightNodeReport, preflightNode } from './fleet-preflight.js';
import { checkAppOnNode, poolRoutingScript, SUPPORTED_APP_SLUGS, type AppEndpointMode, type AppSlug } from './fleet-apps.js';
import { sshCapture } from './fleet-ssh.js';
import { colorize } from './cli-ui.js';
import { BASE_COMMAND } from './cli-types.js';

export const FLEET_SUBCOMMANDS = ['scan', 'list', 'status', 'preflight', 'backends', 'install', 'update', 'apps'] as const;
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
  /**
   * CI Account address each installed Hub is claimed for, creating its first operator.
   *
   * Absent means the claim step is skipped and reported as skipped — never guessed. A Hub left
   * unclaimed is registered, keyed, and unable to authenticate anybody.
   */
  claimEmail?: string;
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
  /**
   * `install`/`update`: proceed on a node whose preflight said `block`. The finding is still
   * printed, marked as overridden, so the log shows a choice rather than a gap.
   */
  force: boolean;
  /**
   * `preflight`: rate the boot-recovery and grub-customizer findings as they would be rated before
   * an operation that touches the kernel, initramfs or GRUB — `block` rather than `warn`.
   */
  touchesBoot: boolean;
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
    claimEmail: process.env.CIHUB_CLAIM_EMAIL || undefined,
    postgresPassword: process.env.CIHUB_POSTGRES_PASSWORD || undefined,
    joinPool: undefined,
    poolPin: undefined,
    models: [],
    hub: false,
    apps: [],
    // Pool by default: the whole point of installing an agent on a pooled fleet is that it reaches
    // the cluster rather than one box.
    endpoint: 'pool',
    force: false,
    touchesBoot: false,
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
    /**
     * A flag is its exact spelling, or that spelling with `=value`. Never a prefix of a longer word.
     *
     * The chain below matched on `startsWith`, so every misspelling landed on a real flag instead of
     * the unknown-flag error at the end of the chain: `--username bob` set `--user`, and `--codeword
     * xyz` supplied the Portal pairing credential. A flag this CLI does not have must be loud.
     */
    const isFlag = (flag: string): boolean => arg === flag || arg.startsWith(`${flag}=`);

    if (arg === '--json') args.json = true;
    else if (arg === '--lan') args.lan = true;
    else if (arg === '--no-tailnet') args.tailnet = false;
    else if (arg === '--write-roster') args.writeRoster = true;
    else if (arg === '--execute') args.execute = true;
    else if (isFlag('--user')) args.user = readValue('--user');
    else if (isFlag('--data-dir')) args.dataDir = readValue('--data-dir');
    else if (isFlag('--code')) args.code = readValue('--code');
    else if (isFlag('--claim-email')) args.claimEmail = readValue('--claim-email');
    else if (isFlag('--join-pool')) args.joinPool = readValue('--join-pool');
    else if (isFlag('--pool-pin')) args.poolPin = readValue('--pool-pin');
    else if (arg === '--hub') args.hub = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--touches-boot') args.touchesBoot = true;
    else if (isFlag('--endpoint')) {
      const mode = readValue('--endpoint');
      if (mode !== 'pool' && mode !== 'local') throw new FleetArgError("--endpoint must be 'pool' or 'local'.");
      args.endpoint = mode;
    } else if (isFlag('--apps')) {
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
    } else if (isFlag('--models')) {
      args.models = readValue('--models')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else if (isFlag('--backends')) {
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
    } else if (isFlag('--nodes')) {
      args.nodes = readValue('--nodes')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (isFlag('--timeout')) {
      const ms = Number(readValue('--timeout'));
      if (!Number.isFinite(ms) || ms < 250 || ms > 120_000) throw new FleetArgError('--timeout must be between 250 and 120000 ms.');
      args.timeoutMs = ms;
    } else if (isFlag('--concurrency')) {
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

/**
 * Carry the run's outcome in the exit code, not only on screen.
 *
 * `0/14 node(s) installed.` exited 0, so `cihub fleet install --execute && cihub fleet apps` walked
 * straight into the next step and any CI gate around a fleet command passed on a fleet that had
 * failed everywhere. Set rather than exit: the skip list and the `--json` report are printed after
 * the summary and are the part an operator needs most on a bad run.
 */
function recordFleetFailures(failed: number): void {
  if (failed > 0) process.exitCode = 1;
}

/**
 * Say so when `--nodes` names a machine the roster has never heard of.
 *
 * `partitionForRun` drops an unmatched name silently — it lands in neither `run` nor `skipped` — so
 * `--nodes core-l` for `core-1` produced the same empty selection, and the same exit 0, as a roster
 * whose every entry is marked skip. Those are different findings: an empty selection is a state to
 * report, a node that does not exist is the operator's typo, and only the typo belongs in the exit
 * code. The run continues on whatever did match, so a partial selection still does its work.
 */
function reportUnknownNodes(roster: readonly FleetNode[], wanted: readonly string[]): void {
  const known = new Set(roster.flatMap((node) => [node.name, node.ip]));
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length === 0) return;
  console.error(colorize(`No roster entry matches ${unknown.map((name) => `'${name}'`).join(', ')} by name or address.`, 'red'));
  console.error(colorize(`  Run '${BASE_COMMAND} fleet list' to see the roster.`, 'dim'));
  process.exitCode = 1;
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
  reportUnknownNodes(roster.nodes, args.nodes);
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
  reportUnknownNodes(roster.nodes, args.nodes);
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

/** One cell of the preflight table: what the column is about, at a glance; the detail lines carry the rest. */
function preflightCell(finding: PreflightFinding | undefined): string {
  if (!finding) return '—';
  if (finding.ok) return 'ok';
  switch (finding.severity) {
    case 'block':
      return colorize('BLOCK', 'red');
    case 'warn':
      return colorize('warn', 'yellow');
    case 'info':
      return colorize('info', 'dim');
  }
}

/** The per-node lines under the table: every finding that is not a plain pass, with its evidence and fix. */
function printPreflightDetails(reports: readonly PreflightNodeReport[]): void {
  for (const report of reports) {
    const lines = report.error
      ? [`  ${colorize('✗', 'red')} preflight could not run — ${report.error.slice(0, 200)}`]
      : report.findings
          .filter((f) => !f.ok)
          .map((f) => {
            const tone = f.severity === 'block' ? 'red' : f.severity === 'warn' ? 'yellow' : 'dim';
            const fix = f.fix ? `\n      fix: ${f.fix}` : '';
            return `  ${colorize(f.severity.toUpperCase().padEnd(5), tone)} ${f.check} — ${f.value}\n      via: ${f.via}${fix}`;
          });
    if (lines.length === 0) continue;
    console.log(`\n${report.node}`);
    for (const line of lines) console.log(line);
  }
}

/**
 * `cihub fleet preflight` — is each node safe to hand a package transaction?
 *
 * Read-only, no `--execute`: it runs `sudo -n true`, `dpkg --audit`, `apt-get check` and a handful
 * of `ls`/`cat` on each node and changes nothing. `install` and `update` run the same checks per
 * node before touching it; this is the standalone view, for looking before a pass rather than being
 * refused mid-way through one. Exits 1 if any node would be blocked, so it can gate a script.
 */
async function runPreflight(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  reportUnknownNodes(roster.nodes, args.nodes);
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

  if (!args.json) {
    console.log(
      colorize(
        `Preflight on ${run.length} node(s)${args.touchesBoot ? ', rated for an operation that touches boot' : ''}. Reads only; changes nothing.`,
        'dim',
      ),
    );
  }

  // Probes in parallel: each is a few short reads, not a transfer, so the fan-out that is wrong for
  // installs is right here.
  const reports: PreflightNodeReport[] = [];
  const queue = [...run];
  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      reports.push(await preflightNode({ host: node.ip, user: node.user ?? args.user }, node, { touchesBoot: args.touchesBoot }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, run.length) }, worker));
  reports.sort((a, b) => a.node.localeCompare(b.node));

  if (args.json) {
    console.log(
      JSON.stringify({ touchesBoot: args.touchesBoot, nodes: reports, skipped: skipped.map((s) => ({ node: s.node.name, why: s.why })) }, null, 2),
    );
  } else {
    console.log('');
    console.log(
      renderTable(
        reports.map((r) => [
          r.node,
          ...PREFLIGHT_CHECKS.map((check) => (r.error ? colorize('?', 'red') : preflightCell(r.findings.find((f) => f.check === check)))),
          r.error
            ? colorize('unreachable', 'red')
            : r.verdict === 'block'
              ? colorize('BLOCK', 'red')
              : r.verdict === 'warn'
                ? colorize('warn', 'yellow')
                : r.verdict,
        ]),
        ['NODE', ...PREFLIGHT_CHECKS.map((c) => c.toUpperCase()), 'VERDICT'],
      ),
    );
    printPreflightDetails(reports);
    if (skipped.length) {
      console.log('');
      for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    }
  }

  const blocked = reports.filter((r) => r.error || r.verdict === 'block').length;
  if (blocked && !args.json) {
    console.log('');
    console.log(colorize(`${blocked} node(s) would be refused by install/update. Fix the finding, or pass --force to those commands.`, 'yellow'));
  }
  recordFleetFailures(blocked);
}

/**
 * `cihub fleet backends` — install or adopt inference backends across the fleet.
 *
 * Read-only unless `--execute`. The dry run is the useful default: it reports what each machine can
 * run and why, which is most of the value even when nothing is installed.
 */
async function runBackends(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  reportUnknownNodes(roster.nodes, args.nodes);
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
  let failed = 0;

  // Serialised across nodes on purpose. A backend install pulls gigabytes (CUDA wheels, GPU
  // container images); running several at once saturates the link they all share and, measured on
  // this fleet, blocks the nodes' own HTTP listeners long enough to look absent to everything else.
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const { facts, error } = await readHostFacts(target);
    if (!facts) {
      console.log(`${colorize(node.name, 'yellow')}: could not read hardware — ${String(error).slice(0, 120)}`);
      report.push({ node: node.name, error: String(error) });
      failed += 1;
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
      if (result.outcome === 'failed') failed += 1;
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
  recordFleetFailures(failed);
}

/**
 * How this run will get a pairing code, decided before anything is dialled.
 *
 * Its own function because the wrong answer is expensive in a way a dry run
 * does not reveal: one `--code` is one device's credential, so a fleet run that
 * accepted it would enroll the first node and fail every other one on a code
 * Portal has already burned — halfway through installing on real machines.
 */
export type PairingCodeStrategy = { kind: 'mint' } | { kind: 'given' } | { kind: 'refuse'; why: string; fix: string[] };

export function resolvePairingCodeStrategy(input: { code?: string; canMint: boolean; nodeCount: number }): PairingCodeStrategy {
  // An explicit --code wins for the one node it can actually enroll: the
  // operator naming a code means that code, not one this run invents.
  if (input.code && input.nodeCount === 1) {
    return { kind: 'given' };
  }

  if (input.canMint) {
    return { kind: 'mint' };
  }

  if (!input.code) {
    return {
      kind: 'refuse',
      why: 'No way to get a pairing code.',
      fix: [`Run 'cihub login --scope ${DEVICE_PAIR_SCOPE}' to mint one per node,`, 'or pass --code <portal-pairing-code> to enroll a single node.'],
    };
  }

  return {
    kind: 'refuse',
    why: `--code is one device's code, but ${input.nodeCount} nodes are selected.`,
    fix: [`Run 'cihub login --scope ${DEVICE_PAIR_SCOPE}' so each node gets its own.`],
  };
}

/**
 * `cihub fleet install` — stand a Hub up on every selected node.
 *
 * Serialised, and load-gated per node. Both because a fleet-wide pass on this fleet upgraded a
 * machine that was serving live traffic at load 108-116 and left it needing physical recovery.
 */
async function runInstall(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  reportUnknownNodes(roster.nodes, args.nodes);
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  // A stored `device:pair` login mints a code per node, which is the only way a
  // multi-node install is unattended: one `--code` is one device, so passing it
  // for a fleet would enroll the first node and fail the rest on a used code.
  const storedLogin = readStoredLogin();
  const canMint = loginScope(storedLogin) === DEVICE_PAIR_SCOPE;

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be installed. Add --execute to apply.', 'dim'));
    console.log(`  would install on ${run.length} node(s): ${run.map((n) => n.name).join(', ')}`);
    if (args.claimEmail) {
      console.log(`  each would then be claimed for ${args.claimEmail}`);
    } else {
      console.log(colorize('  no --claim-email: each Hub would be left registered but with no operator', 'yellow'));
    }
    if (args.joinPool) console.log(`  each would then pair into ${args.joinPool}`);
    if (canMint) {
      console.log(colorize(`  would mint a pairing code per node as ${storedLogin?.orgSlug ?? storedLogin?.orgId}`, 'dim'));
    } else if (args.code) {
      console.log(colorize('  would use the one --code given, which enrolls a single node', 'dim'));
    } else {
      console.log(colorize(`  needs 'cihub login --scope ${DEVICE_PAIR_SCOPE}', or --code for one node`, 'dim'));
    }
    console.log(colorize('  requires a Postgres password', 'dim'));
    console.log(
      colorize(
        `  each node is preflighted first (sudo, dpkg, grub, boot recovery, apt lock) — '${BASE_COMMAND} fleet preflight' shows it now`,
        'dim',
      ),
    );
    return;
  }

  // Checked here rather than at parse time so a dry run needs neither secret.
  const strategy = resolvePairingCodeStrategy({ code: args.code, canMint, nodeCount: run.length });

  if (strategy.kind === 'refuse') {
    console.error(colorize(strategy.why, 'red'));
    for (const line of strategy.fix) console.error(colorize(`  ${line}`, 'dim'));
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

    let pairingCode: string;

    if (strategy.kind === 'given') {
      pairingCode = args.code as string;
    } else {
      try {
        const minted = await mintPairingCode({ name: node.name, login: storedLogin as PortalLogin });
        pairingCode = minted.pairingCode;
        console.log(`  ${colorize('✓', 'green')} portal device — registered as ${minted.slug}`);
      } catch (error) {
        // Registering is the first step; without a code the rest cannot run, so
        // this node is reported and the fleet continues rather than aborting.
        console.log(`  ${colorize('✗', 'red')} portal device — ${error instanceof Error ? error.message : String(error)}`);
        reports.push({ node: node.name, ok: false, steps: [] });
        continue;
      }
    }

    const report = await installNode(
      node,
      {
        postgresPassword: args.postgresPassword,
        pairingCode,
        claimEmail: args.claimEmail,
        joinPool: args.joinPool,
        poolPin: args.poolPin,
        force: args.force,
        touchesBoot: args.touchesBoot,
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
  recordFleetFailures(reports.length - ok);
}

/**
 * `cihub fleet update` — refresh the Hub image and/or pull models across the fleet.
 *
 * Model pulls are serialised for a measured reason: concurrent cold loads of 20-50 GB blocked the
 * nodes' own HTTP listeners long enough that the tooling reported them absent while they worked.
 */
async function runUpdate(args: FleetArgs): Promise<void> {
  const roster = loadFleetRoster();
  reportUnknownNodes(roster.nodes, args.nodes);
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

  let failed = 0;
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    console.log(`\n${node.name}`);
    // Same gate as install, same place: before the first thing that changes the node.
    const gate = gatePreflight(await preflightNode(target, node, { touchesBoot: args.touchesBoot }), { force: args.force });
    console.log(`  ${gate.proceed ? colorize('✓', 'green') : colorize('·', 'dim')} preflight — ${gate.detail}`);
    if (!gate.proceed) {
      failed += 1;
      continue;
    }
    if (args.hub) {
      const res = await sshCapture(target, `bash <<'EOF'\n${updateHubScript()}\nEOF`, 20 * 60_000);
      const ok = res.ok && res.out.includes('hub-update-complete');
      if (!ok) failed += 1;
      console.log(
        `  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} hub image — ${(res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? ''}`,
      );
    }
    for (const model of args.models) {
      const res = await sshCapture(target, `bash <<'EOF'\n${pullModelScript(model)}\nEOF`, 45 * 60_000);
      const ok = res.ok && res.out.includes('model-pull-complete');
      if (!ok) failed += 1;
      console.log(
        `  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${model} — ${(res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? ''}`,
      );
    }
  }
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  recordFleetFailures(failed);
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
  reportUnknownNodes(roster.nodes, args.nodes);
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
  let failed = 0;
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const pool = await sshCapture(target, `bash <<'EOF'\n${poolRoutingScript()}\nEOF`, 30_000);
    const pooled = pool.out.includes('pool-routes-present');
    console.log(`${node.name} ${colorize(pooled ? 'pool routes present' : 'no pool routes', 'dim')}`);
    for (const slug of slugs) {
      const check = await checkAppOnNode(target, slug, args.endpoint);
      if (!check.ok) failed += 1;
      console.log(`  ${check.ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${slug} — ${check.detail}`);
      report.push({ node: node.name, pooled, ...check });
    }
  }
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  console.log('');
  console.log(colorize('Note: every installed app receives the Hub device key in its environment —', 'yellow'));
  console.log(colorize('installing one grants Hub operator authority. Install from the Hub UI or API.', 'yellow'));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  recordFleetFailures(failed);
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
    case 'preflight':
      await runPreflight(args);
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
