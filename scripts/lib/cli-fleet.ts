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
 *   · **The roster is the only list of targets.** No `fleet.json` is a refusal, never a fallback to
 *     the tailnet's peer list — that list is colleagues' laptops and phones alongside the appliances.
 *     `scan` re-probes the roster; enumerating the tailnet is `--all-tailnet`, asked for by name.
 *
 * Arg parsing is hand-rolled to match the rest of this CLI, which deliberately has no parsing
 * library (see `docs/CLI.md`).
 */

import { DEVICE_MANAGE_SCOPE, DEVICE_PAIR_SCOPE, loginScope, mintPairingCode, type PortalLogin, readStoredLogin } from './catalog-submit.js';
import {
  loadFleetRoster,
  mergeFleetRoster,
  partitionForRun,
  saveFleetRoster,
  fleetRosterPath,
  type FleetNode,
  type LoadedFleetRoster,
} from './fleet-roster.js';
import {
  HUB_SUMMARY_TIMEOUT_FLOOR_MS,
  portalStanding,
  probeNode,
  renderHubCell,
  renderPortalCell,
  resolveTailscaleCli,
  scanLan,
  summariseNode,
  tailnetPeers,
  type DiscoveredNode,
} from './fleet-discover.js';
import { classifySshFailure, describeSshFailure, sshCapture, type SshTarget } from './fleet-ssh.js';
import { isTooBusyForMaintenance, readHostFacts, type HostFacts } from './fleet-hardware.js';
import {
  applyOllamaBindPolicy,
  DEFAULT_OLLAMA_BIND,
  describeBind,
  executeBackendPlan,
  INSTALLABLE_BACKENDS,
  ollamaManagedEnvironment,
  planAllBackends,
  type InstallableBackend,
} from './fleet-backends.js';
import {
  assessOllamaBind,
  bindAddressFor,
  CANONICAL_BIND_DROPIN,
  OLLAMA_BIND_MODES,
  type OllamaBindAssessment,
  type OllamaBindMode,
  ollamaBindProbeScript,
  parseOllamaBindProbe,
  planBindConsolidation,
} from './fleet-ollama-bind.js';
import { installNode, pullModelScript, updateHubScript } from './fleet-install.js';
import { type CihubBinarySource, parseCihubVersionOutput, resolveCihubBinarySource } from './fleet-cihub-binary.js';
import { clearPendingPairingCode, describeDeviceNameConflict, readPendingPairingCode, savePendingPairingCode } from './fleet-pairing-codes.js';
import {
  deletePortalDevice,
  findPortalDevice,
  listPortalDevices,
  type PortalDevice,
  reRegisterPortalDevice,
  requireManageLogin,
} from './fleet-devices.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { execFileSync } from 'node:child_process';
import { gatePreflight, PREFLIGHT_CHECKS, type PreflightFinding, type PreflightNodeReport, preflightNode } from './fleet-preflight.js';
import { checkAppOnNode, poolRoutingScript, SUPPORTED_APP_SLUGS, type AppEndpointMode, type AppSlug } from './fleet-apps.js';
import { applyBootParams, assessNode, decideGttTarget, readBootParamState, type NodeBootParamAssessment } from './fleet-boot-params.js';
import {
  describeCertFinding,
  ensureTailscaleCert,
  probeTailscaleCert,
  renderCertCell,
  unmeasuredCert,
  type CertFinding,
} from './fleet-tailscale-cert.js';
import {
  type FleetImageSummary,
  type HubImageProbe,
  imageMatchesPin,
  type NodeImageState,
  parsePinDigest,
  probeHubImage,
  renderImageCell,
  renderImageFooter,
  renderImageTransition,
  resolveMajorityPin,
  shortImageId,
  summariseFleetImages,
} from './fleet-image.js';
import {
  RECOMMENDED_MODELS_KEYWORD,
  estimatedDownloadMb,
  formatMb,
  hubRecommendationScript,
  parseHubRecommendationOutput,
  planNodeModels,
  summarisePulls,
  type HubRecommendation,
  type ModelPullResult,
  type ModelRequest,
  type NodeModelPlan,
} from './fleet-models.js';
import {
  OllamaVersionError,
  readOllamaVersions,
  renderOllamaCell,
  resolveOllamaVersion,
  summariseOllamaVersions,
  upgradeOllamaOnNode,
} from './fleet-ollama-version.js';
import { colorize, stripAnsi } from './cli-ui.js';
import { BASE_COMMAND } from './cli-types.js';

export const FLEET_SUBCOMMANDS = [
  'scan',
  'list',
  'status',
  'backends',
  'install',
  'update',
  'apps',
  'boot-params',
  'preflight',
  'cert',
  'rdp',
  'devices',
] as const;

import { describeBind as describeRdpBind, runRdpOnNode, type RdpNodeReport } from './fleet-rdp.js';

export type FleetSubcommand = (typeof FLEET_SUBCOMMANDS)[number];

export interface FleetArgs {
  subcommand: FleetSubcommand;
  json: boolean;
  lan: boolean;
  /**
   * `scan` only: enumerate every tailnet peer as a candidate.
   *
   * Off by default because the tailnet is shared — colleagues' laptops, phones and headsets are
   * peers too, and probing them means an SSH attempt in each one's auth log. A default scan
   * re-probes the roster and nothing else; this is the one way a machine gets into the roster, and
   * it says so loudly when it writes, because what it writes is targets.
   */
  allTailnet: boolean;
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
  /** `devices <action> [target]`: list, release (delete) or re-register a Portal device. */
  devicesAction?: 'list' | 'release' | 're-register';
  devicesTarget?: string;
  /** Portal organization id to act in; default: the stored login's. */
  org?: string;
  /** Skip the confirmation on `devices release`. */
  yes: boolean;
  /** A cihub-linux-* release asset on this machine, streamed to every node that needs one. */
  cihubBinary?: string;
  /** Release tag to fetch with GH_TOKEN when no --cihub-binary is given. Default: latest. */
  cihubVersion?: string;
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
  /** Models to pull during `update`. Empty when `recommendModels` is set. */
  models: string[];
  /**
   * `--models recommended`: ask each node's own Hub for its hardware-fitted list instead of applying
   * one list to every machine. Mutually exclusive with naming models, and the parser says so.
   */
  recommendModels: boolean;
  /** Update the Hub image during `update`. */
  hub: boolean;
  /**
   * `update --hub` only: the exact image to deploy, `repo@sha256:…`, instead of whatever the floating
   * tag resolves to at pull time. Validated at parse time so a typo is refused before anything dials.
   */
  pinDigest?: string;
  /** `update --hub` only: pin every targeted node to the image most of the fleet already runs. */
  toMajority: boolean;
  /** Bring each node's Ollama to the pinned (or `--ollama-version`) release during `update`. */
  ollama: boolean;
  /**
   * Exact Ollama release for `backends` and `update --ollama`, already validated. Absent means the
   * pin in `fleet-ollama-version.ts`; there is deliberately no way to ask for "latest".
   */
  ollamaVersion?: string;
  /** Agent apps for `apps`. Empty means both supported slugs. */
  apps: AppSlug[];
  /** Where an app should send inference. */
  endpoint: AppEndpointMode;
  /**
   * `boot-params` only: the operator asserts they can reach a console on every node this run stages.
   * Lifts the refusal on a node with a hidden zero-timeout GRUB menu and no roster console.
   */
  iHaveConsole: boolean;
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
  /**
   * Where Ollama listens, for `backends`. One policy per run: `all` by default — 0.0.0.0 behind
   * `ollama-tailnet-guard.service`, because the Hub container reaches the daemon over the Docker
   * bridge, which a tailnet-only bind does not serve — or `tailnet` / `local` when asked. Whatever
   * is chosen is written to one file and read back after the restart; `fleet status` shows the
   * result, the file that set it, and EXPOSED for a 0.0.0.0 whose guard is not active.
   */
  bind: OllamaBindMode;
}

export class FleetArgError extends Error {}

/** Parse `fleet` argv. Throws {@link FleetArgError} with an actionable message rather than exiting. */
export function parseFleetArgs(argv: readonly string[]): FleetArgs {
  const args: FleetArgs = {
    subcommand: 'scan',
    json: false,
    // Neither discovery source is on by default: a LAN sweep touches every address on the operator's
    // subnet, and the tailnet is shared with people who are not the fleet. Both must be asked for.
    lan: false,
    allTailnet: false,
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
    devicesAction: undefined,
    devicesTarget: undefined,
    org: undefined,
    yes: false,
    cihubBinary: process.env.CIHUB_BINARY || undefined,
    cihubVersion: undefined,
    claimEmail: process.env.CIHUB_CLAIM_EMAIL || undefined,
    postgresPassword: process.env.CIHUB_POSTGRES_PASSWORD || undefined,
    joinPool: undefined,
    poolPin: undefined,
    models: [],
    recommendModels: false,
    hub: false,
    pinDigest: undefined,
    toMajority: false,
    ollama: false,
    ollamaVersion: undefined,
    apps: [],
    // Pool by default: the whole point of installing an agent on a pooled fleet is that it reaches
    // the cluster rather than one box.
    endpoint: 'pool',
    iHaveConsole: false,
    force: false,
    touchesBoot: false,
    bind: DEFAULT_OLLAMA_BIND,
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

  // `devices` takes positionals — an action and, for release/re-register, the device — before
  // its flags. Nothing else in `fleet` does, so it is read here and not in the flag chain.
  if (args.subcommand === 'devices') {
    const action = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
    if (action !== 'list' && action !== 'release' && action !== 're-register') {
      throw new FleetArgError(`fleet devices needs an action: list, release <device>, or re-register <device>${action ? ` (got '${action}')` : ''}.`);
    }
    args.devicesAction = action;
    if (action !== 'list') {
      const target = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
      if (!target) throw new FleetArgError(`fleet devices ${action} needs a device: its name, slug or Portal id.`);
      args.devicesTarget = target;
    }
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
    else if (arg === '--all-tailnet') args.allTailnet = true;
    else if (arg === '--write-roster') args.writeRoster = true;
    else if (arg === '--execute') args.execute = true;
    else if (isFlag('--user')) args.user = readValue('--user');
    else if (isFlag('--data-dir')) args.dataDir = readValue('--data-dir');
    else if (isFlag('--code')) args.code = readValue('--code');
    else if (isFlag('--org')) args.org = readValue('--org');
    else if (arg === '--yes') args.yes = true;
    else if (isFlag('--cihub-binary')) args.cihubBinary = readValue('--cihub-binary');
    else if (isFlag('--cihub-version')) args.cihubVersion = readValue('--cihub-version');
    else if (isFlag('--claim-email')) args.claimEmail = readValue('--claim-email');
    else if (isFlag('--join-pool')) args.joinPool = readValue('--join-pool');
    else if (isFlag('--pool-pin')) args.poolPin = readValue('--pool-pin');
    else if (arg === '--hub') args.hub = true;
    else if (arg === '--i-have-console') args.iHaveConsole = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--touches-boot') args.touchesBoot = true;
    else if (isFlag('--pin-digest')) {
      const pin = parsePinDigest(readValue('--pin-digest'));
      if (!pin.ok) throw new FleetArgError(`--pin-digest: ${pin.why}`);
      args.pinDigest = pin.ref;
    } else if (arg === '--to-majority') args.toMajority = true;
    else if (arg === '--ollama') args.ollama = true;
    else if (isFlag('--ollama-version')) {
      // Validated here so a typo fails before any machine is dialled, and so 'latest' is refused in
      // words rather than handed to the installer, which would honour it.
      try {
        args.ollamaVersion = resolveOllamaVersion(readValue('--ollama-version'));
      } catch (error) {
        if (error instanceof OllamaVersionError) throw new FleetArgError(error.message);
        throw error;
      }
    } else if (isFlag('--endpoint')) {
      const mode = readValue('--endpoint');
      if (mode !== 'pool' && mode !== 'local') throw new FleetArgError("--endpoint must be 'pool' or 'local'.");
      args.endpoint = mode;
    } else if (isFlag('--bind')) {
      const mode = readValue('--bind');
      if (!(OLLAMA_BIND_MODES as readonly string[]).includes(mode)) {
        throw new FleetArgError(`--bind must be one of ${OLLAMA_BIND_MODES.join(', ')}: the node's tailnet address, all interfaces, or loopback.`);
      }
      args.bind = mode as OllamaBindMode;
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
      const names = readValue('--models')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
      // `recommended` is a mode, not a model. Mixed with names it would be ambiguous in both
      // directions — is the named model on top of each node's list, or instead of it? — so refuse.
      if (names.includes(RECOMMENDED_MODELS_KEYWORD)) {
        if (names.length > 1) {
          throw new FleetArgError(
            `--models ${RECOMMENDED_MODELS_KEYWORD} asks each node's Hub for its own list and cannot be combined with model names.`,
          );
        }
        args.recommendModels = true;
        args.models = [];
      } else {
        args.models = names;
      }
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

  // Both pin flags only mean something on the Hub-image path, and they contradict each other: one
  // names the build, the other asks the fleet which build. Refuse the combination rather than pick.
  if ((args.pinDigest || args.toMajority) && !args.hub) {
    throw new FleetArgError('--pin-digest and --to-majority only apply to `fleet update --hub`.');
  }
  if (args.pinDigest && args.toMajority) {
    throw new FleetArgError('--pin-digest names an image and --to-majority asks the fleet for one. Pass one or the other.');
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

/**
 * The roster a fleet operation runs on, or `null` with the refusal already printed.
 *
 * Every subcommand that dials a machine starts here, and the rule is that no roster means no
 * targets. The alternative — falling back to the tailnet's peer list — was how a roster of 57 rows
 * came to hold `Aine`, `Beam Pro` and `Bennett's MacBook Pro`: once a scan had seeded the file with
 * everyone, every later command inherited them, read-only or not. So an absent file is a refusal
 * that names the path and the one command that creates it, and exits 1 so a script wrapped around
 * `preflight` cannot read "nothing to check" as a pass.
 *
 * A roster that exists and lists nobody is different: that is a state the operator arrived at, and
 * it is reported without an error exit. `list` and `scan` do not come through here — reading an
 * absent roster is their job.
 */
function loadRosterForRun(args: FleetArgs): LoadedFleetRoster | null {
  const roster = loadFleetRoster();
  if (roster.problem) {
    const { path } = roster.problem;
    if (roster.problem.kind === 'absent') console.error(colorize(`No fleet roster at ${path}.`, 'red'));
    else console.error(colorize(`The fleet roster at ${path} could not be read: ${roster.problem.why}`, 'red'));
    console.error(
      `  Create one with '${BASE_COMMAND} fleet scan --all-tailnet --write-roster', then mark the rows that are not yours "skip": "excluded".`,
    );
    console.error(colorize('  Fleet commands act on the roster and nothing else; without one, no machine is dialled.', 'dim'));
    process.exitCode = 1;
    return null;
  }
  reportUnknownNodes(roster.nodes, args.nodes);
  if (roster.nodes.length === 0) {
    console.log(`The roster at ${roster.source} lists no nodes.`);
    for (const dropped of roster.dropped) console.log(colorize(`  dropped: ${dropped}`, 'yellow'));
    console.log(colorize(`  Run '${BASE_COMMAND} fleet scan --all-tailnet --write-roster' to enumerate the tailnet into it.`, 'dim'));
    return null;
  }
  return roster;
}

/**
 * Fixed-width table, so a 20-node listing is scannable rather than a wall of prose. Widths are
 * measured on the visible text, so a coloured cell in a middle column does not shove the columns
 * after it.
 */
function renderTable(rows: string[][], headers: string[]): string {
  const visible = (c: string) => stripAnsi(c ?? '').length;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => visible(r[i] ?? ''))));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => `${c ?? ''}${' '.repeat(Math.max((widths[i] ?? 0) - visible(c), 0))}`)
      .join('  ')
      .trimEnd();
  return [colorize(line(headers), 'dim'), ...rows.map(line)].join('\n');
}

/** The HUB cell, coloured when the probe did not get a plain answer. */
function hubCell(probe: Parameters<typeof renderHubCell>[0]): string {
  const cell = renderHubCell(probe);
  return cell.tone ? colorize(cell.text, cell.tone) : cell.text;
}

/**
 * Name the nodes whose HUB cell is a probe outcome rather than a verdict. `timeout` and `yes, slow`
 * are both the budget running out, and the flag that changes them is the same one.
 */
function printHubProbeFooter(probed: readonly DiscoveredNode[], args: FleetArgs): void {
  const timedOut = probed.filter((n) => n.probe.hubProbe === 'timeout');
  const slow = probed.filter((n) => n.probe.hubProbe === 'slow');
  if (!timedOut.length && !slow.length) return;
  if (timedOut.length) {
    console.log(
      colorize(`${timedOut.length} node(s) answered nothing on the Hub port within ${args.timeoutMs} ms — not the same as no Hub:`, 'yellow'),
    );
    console.log(`  ${timedOut.map((n) => n.name).join(', ')}`);
  }
  const summaryBudget = Math.max(args.timeoutMs, HUB_SUMMARY_TIMEOUT_FLOOR_MS);
  if (slow.length) {
    console.log(
      colorize(
        `${slow.length} Hub(s) answered their phase route but not their backend summary within ${summaryBudget} ms — usually inference load:`,
        'yellow',
      ),
    );
    console.log(`  ${slow.map((n) => n.name).join(', ')}`);
  }
  console.log(
    colorize(
      `  Re-run with a longer --timeout (phase route: ${args.timeoutMs} ms, summary: ${summaryBudget} ms) to tell a busy Hub from an absent one.`,
      'dim',
    ),
  );
  console.log('');
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
  // `excluded` means "not ours" — someone's workstation, a KVM dongle, a demo box. Re-probing it on
  // every scan is the SSH attempt in a colleague's auth log the roster exists to stop, so it is
  // shelved unless `--all-tailnet` asks for everything. The other skips still get a probe: an
  // `unreachable` node may have recovered, and `llm-only` is a verdict the scan can confirm.
  const shelved = new Map<string, FleetNode>();
  for (const node of roster.nodes) {
    if (node.skip === 'excluded' && !args.allTailnet) shelved.set(node.ip, node);
    else candidates.set(node.ip, node);
  }
  for (const dropped of roster.dropped) notes.push(`roster: ${dropped}`);
  if (shelved.size > 0) notes.push(`roster: ${shelved.size} node(s) marked excluded not probed — pass --all-tailnet to include them`);

  // Which candidates the tailnet contributed and the roster did not know. Named at the end, because
  // with `--write-roster` they become targets, and the operator should see that list as a list.
  const fromTailnet: string[] = [];
  if (args.allTailnet) {
    const cli = resolveTailscaleCli();
    if (cli) {
      const { peers, error } = tailnetPeers(cli);
      if (error) notes.push(`tailnet: ${error}`);
      const hostnameOf = new Map(peers.map((peer) => [peer.ip, peer.name]));
      const ipOfHostname = new Map(peers.map((peer) => [peer.name, peer.ip]));
      const renamed: string[] = [];
      for (const peer of peers) {
        const existing = candidates.get(peer.ip);
        if (!existing) fromTailnet.push(peer.name);
        // A roster name is the operator's label and is kept; but when the machine now answers to a
        // different hostname — and worse, when the roster's name is what a DIFFERENT machine is now
        // called — `--nodes <name>` dials the wrong box. Say so, every scan, until the roster is fixed.
        if (existing && existing.name !== peer.name) {
          const collides = ipOfHostname.get(existing.name);
          renamed.push(
            `${existing.name} (${peer.ip}) is now ${peer.name}${collides && collides !== peer.ip ? ` — and ${existing.name} is what ${collides} is called now` : ''}`,
          );
        }
        candidates.set(peer.ip, {
          name: existing?.name ?? peer.name,
          ip: peer.ip,
          tailnetName: peer.dnsName ?? existing?.tailnetName,
          user: existing?.user,
          local: existing?.local,
          skip: existing?.skip,
          oob: existing?.oob,
          // Operator notes only. The scan's own observation ("offline right now") goes in the
          // report, not the roster: written there once, it outlived the outage on thirty rows.
          note: existing?.note,
        });
      }
      const gone = roster.nodes.filter((n) => !n.local && !hostnameOf.has(n.ip));
      notes.push(
        `tailnet: ${peers.length} peer(s) enumerated, ${fromTailnet.length} not in the roster${gone.length ? `, ${gone.length} roster row(s) no longer on the tailnet: ${gone.map((n) => n.name).join(', ')}` : ''}`,
      );
      if (renamed.length) notes.push(`tailnet: ${renamed.length} roster name(s) no longer match the peer's hostname — ${renamed.join('; ')}`);
    } else {
      notes.push('tailscale CLI not found — skipping tailnet enumeration (set TAILSCALE_CLI to override)');
    }
  }

  if (args.lan) {
    const hits = await scanLan(new Set([...candidates.keys(), ...shelved.keys()]));
    for (const ip of hits) candidates.set(ip, { name: ip, ip });
    notes.push(`lan: ${hits.length} additional address(es) answering an engine or Hub port`);
  }

  const all = [...candidates.values()];
  if (all.length === 0) {
    if (roster.problem || roster.nodes.length === 0) {
      console.log(`No roster at ${fleetRosterPath()} and no discovery asked for, so there is nothing to probe.`);
      console.log("  --all-tailnet enumerates every tailnet peer — colleagues' devices included — and --lan sweeps the local subnet.");
      console.log(
        `  '${BASE_COMMAND} fleet scan --all-tailnet --write-roster' creates the roster; then mark the rows that are not yours "skip": "excluded".`,
      );
    } else {
      console.log('Nothing to probe: every rostered node is marked excluded. Pass --all-tailnet to include them.');
    }
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
    hubCell({ hub: n.probe.hub, hubProbe: n.probe.hubProbe }),
    n.probe.engines.length ? String(n.probe.engines.length) : '—',
    summariseNode(n),
  ]);
  console.log(renderTable(rows, ['NODE', 'ADDRESS', 'SSH', 'HUB', 'ENGINES', 'VERDICT']));
  console.log('');
  printHubProbeFooter(probed, args);

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
  // The tailnet is shared, so what `--all-tailnet` found is not a fleet until somebody says so. With
  // `--write-roster` every one of these becomes a target of the next `--execute`; without it, this
  // is the list to read before adding that flag.
  if (fromTailnet.length) {
    console.log(
      colorize(`${fromTailnet.length} tailnet peer(s) are not in the roster${args.writeRoster ? ' and are being added as targets' : ''}:`, 'yellow'),
    );
    console.log(`  ${[...fromTailnet].sort((a, b) => a.localeCompare(b)).join(', ')}`);
    console.log(
      colorize(`  Mark any that are not fleet machines "skip": "excluded" in ${fleetRosterPath()} — a fleet command never dials those.`, 'dim'),
    );
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
    console.log(`No roster yet. Run '${BASE_COMMAND} fleet scan --all-tailnet --write-roster' to create one.`);
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
  const roster = loadRosterForRun(args);
  if (!roster) return;
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  const probed = await probeAll(run, args, 'roster');
  const binds = await assessBindsAll(probed, args);
  const certs = await probeCertsAll(probed, args);

  // The image column. Every node runs the same floating tag, so `docker ps` cannot show drift; the
  // image ID can. Nodes SSH could not reach are `unknown` with that reason, not re-dialled.
  const unreachable = new Map(probed.filter((n) => !n.probe.ssh).map((n) => [n.name, n.probe.sshFailure === 'ok' ? 'no ssh' : n.probe.sshFailure]));
  const images = await probeImages(probed, args, unreachable);
  const summary = summariseFleetImages(images);
  const imageOf = new Map(summary.nodes.map((state) => [state.node, state]));

  // Which Ollama each node is serving, read at the bind the node resolves for itself. The version
  // spread this column exists to expose (0.12.11 → 0.33.3 across eighteen nodes) went unnoticed
  // precisely because nothing printed it. `--ollama-version` sets the pin the fleet is measured against.
  const pin = resolveOllamaVersion(args.ollamaVersion);
  const versions = await readOllamaVersions(
    probed.map((n) => ({ node: n, sshOk: n.local ? undefined : n.probe.ssh, sshFailure: n.probe.sshFailure })),
    { user: args.user, timeoutMs: args.timeoutMs, concurrency: args.concurrency },
  );
  const ollamaSummary = summariseOllamaVersions(versions, pin);
  const rows = probed.map((n, i) => ({ n, v: versions[i] ?? { node: n.name, reason: 'no reading was taken' } }));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          nodes: rows.map(({ n, v }) => ({
            ...n,
            ollamaBind: binds.get(n.ip) ?? null,
            tailscaleCert: certs.get(n.name),
            image: imageOf.get(n.name) ?? null,
            ollama: { ...v, pin, standing: renderOllamaCell(v, pin).standing },
          })),
          image: { majority: summary.majority, tie: summary.tie, known: summary.known, total: summary.total },
          ollama: { pin, summary: ollamaSummary },
          skipped: skipped.map((s) => ({ node: s.node.name, why: s.why })),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    renderTable(
      rows.map(({ n, v }) => {
        const cert = renderCertCell(certs.get(n.name) ?? unmeasuredCert('not probed'));
        const image = imageOf.get(n.name);
        const cell = renderOllamaCell(v, pin);
        const tone = cell.standing === 'behind' ? 'yellow' : cell.standing === 'at-pin' ? 'green' : 'dim';
        const portal = renderPortalCell(n.probe.portal);
        return [
          n.name,
          n.probe.ssh ? 'yes' : colorize('no', 'yellow'),
          // `—` only when the port refused the connection. A probe that ran out of budget under
          // inference load says `timeout` or `yes, slow`, because it looked identical to no Hub once.
          hubCell(n.probe),
          // A Hub that answers its health route and a Hub Portal will talk to are different things;
          // this column is the difference.
          colorize(portal.text, portal.tone),
          image ? colorImageCell(image) : colorize('?', 'dim'),
          n.probe.engines.join(' ') || '—',
          describeBindCell(binds.get(n.ip), n),
          colorize(cert.text, cert.tone),
          colorize(cell.text, tone),
        ];
      }),
      ['NODE', 'SSH', 'HUB', 'PORTAL', 'IMAGE', 'ENGINES', 'OLLAMA BIND', 'TLS CERT', 'OLLAMA'],
    ),
  );
  const conflicts = probed.filter((n) => binds.get(n.ip)?.status === 'conflict');
  if (conflicts.length) {
    console.log('');
    console.log(
      colorize(
        `${conflicts.length} node(s) have more than one drop-in setting OLLAMA_HOST, and the winner is not ${CANONICAL_BIND_DROPIN}:`,
        'yellow',
      ),
    );
    for (const n of conflicts) {
      const a = binds.get(n.ip);
      if (a) console.log(colorize(`  ${n.name}: ${a.resolution.setters.join(' < ')} — ${a.resolution.setBy} wins by name`, 'dim'));
    }
    console.log(
      colorize(
        `  '${BASE_COMMAND} fleet backends --backends ollama --bind <tailnet|all|local>' shows the consolidation; add --execute to apply it.`,
        'dim',
      ),
    );
  }
  console.log('');
  printHubProbeFooter(probed, args);
  printImageFooter(summary);
  const notOk = probed.filter((n) => n.probe.hub && portalStanding(n.probe.portal) !== 'ok');
  if (notOk.length) {
    console.log('');
    console.log(colorize(`Portal: ${notOk.length} Hub(s) answer their health route but are not in good standing with Portal:`, 'yellow'));
    for (const n of notOk) {
      const p = n.probe.portal;
      console.log(colorize(`  ${n.name}: ${renderPortalCell(p).text}${p?.error ? ` — ${p.error}` : ''}`, 'dim'));
    }
  }
  const unmeasured = versions.filter((v) => !v.version);
  if (unmeasured.length) {
    console.log('');
    for (const v of unmeasured) console.log(colorize(`  ${v.node}: ollama version unmeasured — ${v.reason}`, 'dim'));
  }
  console.log('');
  console.log(`Ollama: ${ollamaSummary}`);
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
  const roster = loadRosterForRun(args);
  if (!roster) return;
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
 * Read each administrable node's Ollama bind, in parallel with the same bound as the probes.
 *
 * Read-only: the probe script dumps the drop-in directory and `systemctl show`. Nodes without SSH
 * cannot be read and are reported as such rather than as a default bind.
 */
async function assessBindsAll(nodes: readonly DiscoveredNode[], args: FleetArgs): Promise<Map<string, OllamaBindAssessment>> {
  const out = new Map<string, OllamaBindAssessment>();
  const queue = nodes.filter((n) => n.probe.ssh);
  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      const res = await sshCapture({ host: node.ip, user: node.user ?? args.user }, ollamaBindProbeScript(), Math.max(args.timeoutMs, 15_000));
      out.set(node.ip, assessOllamaBind(parseOllamaBindProbe(res.out)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(queue.length, 1)) }, worker));
  return out;
}

function describeBindCell(assessment: OllamaBindAssessment | undefined, node: DiscoveredNode): string {
  if (!assessment) return node.probe.ssh ? 'not probed' : colorize(node.local ? 'local node — not probed' : 'n/a (no SSH)', 'dim');
  switch (assessment.status) {
    case 'conflict':
      return colorize(assessment.summary, 'yellow');
    case 'user-scope':
    case 'foreign-owner':
      return colorize(assessment.summary, 'yellow');
    case 'managed':
      return assessment.exposed ? colorize(assessment.summary, 'yellow') : assessment.summary;
    default:
      return colorize(assessment.summary, assessment.exposed ? 'yellow' : 'dim');
  }
}

interface OllamaBindPlanOnNode {
  lines: string[];
  tone: 'dim' | 'yellow' | 'green';
  /** Nothing would change: canonical file present with this bind, no other setter. */
  noop: boolean;
  /** The one-sentence reason the system-unit path must not be taken here, when it must not. */
  refused?: string;
  effective: string;
  json: Record<string, unknown>;
}

/**
 * What the bind step would do on this node, from a read-only probe.
 *
 * Printed under the ollama line of a dry run so the operator sees the files that would move — by
 * name, with their new names — before anything moves. Also what decides, on `--execute`, whether an
 * adopted Ollama needs touching at all.
 */
async function planOllamaBindOnNode(target: { host: string; user?: string }, bind: OllamaBindMode, facts: HostFacts): Promise<OllamaBindPlanOnNode> {
  const res = await sshCapture(target, ollamaBindProbeScript(), 20_000);
  const probe = parseOllamaBindProbe(res.out);
  const assessment = assessOllamaBind(probe);
  const current = `${assessment.summary}`;
  if (!probe.present) {
    return {
      lines: ['bind: could not read the node (probe produced no output)'],
      tone: 'yellow',
      noop: false,
      effective: 'unknown',
      json: { readable: false },
    };
  }
  if (assessment.ownership.refuse) {
    return {
      lines: [`bind: now ${current}`, `bind: would refuse — ${assessment.ownership.reason}`],
      tone: 'yellow',
      noop: false,
      refused: assessment.ownership.reason,
      effective: assessment.resolution.effective.address,
      json: { now: assessment.summary, refused: assessment.ownership.reason },
    };
  }
  const target_ = bindAddressFor(bind, probe.tailscaleIp);
  if (!target_) {
    return {
      lines: [
        `bind: now ${current}`,
        `bind: would fail — ${describeBind(bind)} requested and 'tailscale ip -4' returned nothing on this node; pass --bind all or --bind local`,
      ],
      tone: 'yellow',
      noop: false,
      effective: assessment.resolution.effective.address,
      json: { now: assessment.summary, error: 'no tailnet address' },
    };
  }
  const plan = planBindConsolidation(
    [...probe.dropins, ...probe.dirEntries.filter((n) => !probe.dropins.some((d) => d.name === n)).map((n) => ({ name: n, content: '' }))],
    target_,
    { date: new Date().toISOString().slice(0, 10), extraEnv: ollamaManagedEnvironment(facts), guardUnit: probe.guard.unit },
  );
  const lines = [`bind: now ${current}`];
  if (plan.noop) {
    // For `all`, "nothing to change" includes the guard: the plan only reads as a no-op when it is up.
    const guard = plan.guard.action === 'install' ? `, ${plan.guard.unit} active` : '';
    lines.push(`bind: already ${target_.address} ← ${CANONICAL_BIND_DROPIN}${guard}; nothing to change`);
  } else {
    lines.push(`bind: would set OLLAMA_HOST=${target_.address} (${bind}) and verify it after restart`);
    for (const line of plan.summary) lines.push(`bind:   ${line}`);
  }
  return {
    lines,
    tone: plan.unfixable.length || assessment.status === 'conflict' ? 'yellow' : plan.noop ? 'dim' : 'green',
    noop: plan.noop,
    effective: assessment.resolution.effective.address,
    json: {
      now: assessment.summary,
      target: target_.address,
      noop: plan.noop,
      disable: plan.disable,
      shadowed: plan.shadowed,
      unfixable: plan.unfixable,
      guard: plan.guard,
    },
  };
}

/**
 * Why a node's hardware could not be read, with the one fact the raw refusal leaves out.
 *
 * Tailscale's `does not permit you to SSH as user "liam"` names the account but not what chose it.
 * On this fleet that account is usually the local username, picked because the roster row has no
 * `user` and no `--user` was given — and the operator, looking at a roster they believe says `ci`,
 * concludes the flag is being ignored. Say where the name came from, and where to make it stick.
 */
function describeHostFactsFailure(node: FleetNode, target: SshTarget, error: unknown): string {
  const text = String(error);
  const kind = classifySshFailure({ ok: false, out: '', err: text, code: 255, ms: 0 });
  if (kind !== 'acl-wrong-user') return `could not read hardware — ${text.slice(0, 120)}`;
  const tried = /as user\s+"([^"]+)"/i.exec(text)?.[1] ?? target.user ?? 'your local username';
  const chosenBy = node.user
    ? `the roster row's "user"`
    : target.user
      ? '--user'
      : `your local username — this roster row has no "user" and --user was not given`;
  return `could not read hardware — the tailnet permits SSH here, but not as "${tried}" (${chosenBy}). Pass --user, or set "user" on ${node.name}'s row in ${fleetRosterPath()}.`;
}

/**
 * `cihub fleet backends` — install or adopt inference backends across the fleet.
 *
 * Read-only unless `--execute`. The dry run is the useful default: it reports what each machine can
 * run and why, which is most of the value even when nothing is installed.
 */
async function runBackends(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
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
      console.log(`${colorize(node.name, 'yellow')}: ${describeHostFactsFailure(node, target, error)}`);
      report.push({ node: node.name, error: String(error) });
      failed += 1;
      continue;
    }

    const busy = isTooBusyForMaintenance(facts);
    const plans = planAllBackends(facts, args.dataDir, args.backends.length ? args.backends : undefined, {
      ollamaBind: args.bind,
      ollamaVersion: args.ollamaVersion,
    });
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
      // Ollama's bind is part of its plan, install or adopt: the same policy, read from the node
      // first so the dry run names the files it would move and the adopt path knows when there is
      // nothing to do.
      const bindPlan = plan.backend === 'ollama' && plan.action !== 'skip' ? await planOllamaBindOnNode(target, args.bind, facts) : undefined;

      if (!args.execute) {
        const tag = plan.action === 'install' ? colorize('would install', 'green') : plan.action;
        console.log(`  ${plan.backend.padEnd(9)} ${tag} — ${plan.why}`);
        if (bindPlan) for (const line of bindPlan.lines) console.log(colorize(`            ${line}`, bindPlan.tone));
        report.push({ node: node.name, backend: plan.backend, action: plan.action, why: plan.why, ...(bindPlan ? { bind: bindPlan.json } : {}) });
        continue;
      }

      let result = await executeBackendPlan(target, plan);
      // An adopted Ollama never runs the install script, so its bind is converged here — unless the
      // node already reads back as managed for this bind, in which case nothing is touched.
      if (plan.backend === 'ollama' && result.outcome === 'adopted' && bindPlan) {
        if (bindPlan.refused) {
          result = { ...result, outcome: 'skipped', why: bindPlan.refused };
        } else if (bindPlan.noop) {
          result = { ...result, why: `${result.why}; bind already ${bindPlan.effective} ← ${CANONICAL_BIND_DROPIN}` };
        } else {
          const applied = await applyOllamaBindPolicy(target, args.bind, facts);
          result = { ...applied, outcome: applied.outcome === 'installed' ? 'adopted' : applied.outcome, why: `${result.why}; ${applied.why}` };
        }
      }
      if (result.outcome === 'failed') failed += 1;
      const tone = result.outcome === 'failed' ? 'red' : result.outcome === 'installed' ? 'green' : 'dim';
      const took = result.ms ? ` (${Math.round(result.ms / 1000)}s)` : '';
      console.log(`  ${plan.backend.padEnd(9)} ${colorize(result.outcome, tone)}${took} — ${result.why}`);
      if (result.detail && (result.outcome === 'failed' || plan.backend === 'ollama')) console.log(colorize(`    ${result.detail}`, 'dim'));
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

/** Version of a local cihub asset, when this machine can run it (same OS and architecture). */
function readLocalCihubVersion(binaryPath: string): string | undefined {
  try {
    return parseCihubVersionOutput(execFileSync(binaryPath, ['version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return undefined;
  }
}

function describeBinarySource(source: CihubBinarySource): string {
  switch (source.kind) {
    case 'local':
      return `cihub binary: ${source.path}${source.version ? ` (${source.version})` : ''}, streamed to nodes that need one`;
    case 'release':
      return `cihub binary: release ${source.version}, fetched here with the GitHub token and streamed to nodes that need one`;
    case 'unavailable':
      return `${source.why} — nodes that already have a cihub are adopted; the rest fail at 'install cihub'. ${source.fix.join(' ')}`;
  }
}

/**
 * `cihub fleet install` — stand a Hub up on every selected node.
 *
 * Serialised, and load-gated per node. Both because a fleet-wide pass on this fleet upgraded a
 * machine that was serving live traffic at load 108-116 and left it needing physical recovery.
 */
async function runInstall(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
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
  const storedScope = loginScope(storedLogin);
  const canMint = storedScope === DEVICE_PAIR_SCOPE || storedScope === DEVICE_MANAGE_SCOPE;

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be installed. Add --execute to apply.', 'dim'));
    console.log(`  would install on ${run.length} node(s): ${run.map((n) => n.name).join(', ')}`);
    if (args.claimEmail) {
      console.log(`  each would then be claimed for ${args.claimEmail}`);
    } else {
      console.log(colorize('  no --claim-email: each Hub would be left registered but with no operator', 'yellow'));
    }
    console.log('  each would then get a `sudo tailscale cert <its MagicDNS name>`, skipped with a reason where HTTPS is off or tailscale is absent');
    if (args.joinPool) console.log(`  each would then pair into ${args.joinPool}`);
    if (canMint) {
      console.log(colorize(`  would mint a pairing code per node as ${storedLogin?.orgSlug ?? storedLogin?.orgId}`, 'dim'));
    } else if (args.code) {
      console.log(colorize('  would use the one --code given, which enrolls a single node', 'dim'));
    } else {
      console.log(colorize(`  needs 'cihub login --scope ${DEVICE_PAIR_SCOPE}', or --code for one node`, 'dim'));
    }
    console.log(colorize('  requires a Postgres password', 'dim'));
    const binarySource = resolveCihubBinarySource({ binaryPath: args.cihubBinary, version: args.cihubVersion, readVersion: readLocalCihubVersion });
    console.log(colorize(`  ${describeBinarySource(binarySource)}`, binarySource.kind === 'unavailable' ? 'yellow' : 'dim'));
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

  // Where a node that has no `cihub` gets one. Decided once, here, so a run with no way to get the
  // binary says so on its first node rather than after that node's Portal device exists.
  const binarySource = resolveCihubBinarySource({ binaryPath: args.cihubBinary, version: args.cihubVersion, readVersion: readLocalCihubVersion });
  console.log(colorize(`  ${describeBinarySource(binarySource)}`, binarySource.kind === 'unavailable' ? 'yellow' : 'dim'));
  const binaryCache = new Map<string, { path: string; sha256: string; label: string }>();

  const reports = [];
  for (const node of run) {
    console.log(`\n${node.name}`);

    // The code is minted (or reused) INSIDE installNode, after every gate and after the binary is on
    // the node — the last step before `register`. A kept code survives a failed attempt; a spent one
    // is forgotten once the Hub reports registered.
    const orgId = storedLogin?.orgId ?? '';
    const mint =
      strategy.kind === 'given'
        ? undefined
        : async () => {
            const pending = readPendingPairingCode(node.ip, orgId);
            if (pending) return { code: pending.pairingCode, detail: `reusing the code minted ${pending.mintedAt.slice(0, 16)} for ${pending.slug}` };
            try {
              const minted = await mintPairingCode({ name: node.name, login: storedLogin as PortalLogin });
              savePendingPairingCode({
                ip: node.ip,
                name: node.name,
                slug: minted.slug,
                deviceId: minted.deviceId,
                pairingCode: minted.pairingCode,
                orgId,
                mintedAt: new Date().toISOString(),
              });
              return { code: minted.pairingCode, detail: `registered as ${minted.slug}` };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(/already exists/.test(message) ? describeDeviceNameConflict(node.name) : message);
            }
          };

    const report = await installNode(
      node,
      {
        postgresPassword: args.postgresPassword,
        pairingCode: strategy.kind === 'given' ? args.code : undefined,
        mintPairingCode: mint,
        onRegistered: () => clearPendingPairingCode(node.ip),
        cihubBinary: binarySource,
        binaryCache,
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
 *
 * `--models recommended` asks each node's own Hub for its list (see `fleet-models.ts` for why the
 * flat list drifted this fleet to 2–23 models per node), so its dry run reads from every node —
 * read-only, but not offline. An explicit list still needs no Hub at all. Either way the platform
 * floor is appended, and every node reports pulled / already-present / failed per model.
 */
async function runUpdate(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    return;
  }
  const modelRequest: ModelRequest | undefined = args.recommendModels
    ? { kind: 'recommended' }
    : args.models.length > 0
      ? { kind: 'explicit', models: args.models }
      : undefined;
  if (!args.hub && !args.ollama && !modelRequest) {
    console.log(
      `Nothing to do. Pass --hub to update the Hub image, --ollama to bring Ollama to the pinned release, --models a,b or --models ${RECOMMENDED_MODELS_KEYWORD} to pull models, or any combination.`,
    );
    return;
  }

  const { pin, refused } = args.hub ? await resolveHubPin(args, roster.nodes) : {};
  if (refused) {
    // Refused before anything was dialled for a write, same as install's pre-flight: exit 2, not 1.
    console.error(colorize(`Refusing --to-majority: ${refused}`, 'red'));
    process.exitCode = 2;
    return;
  }

  const ollamaVersion = resolveOllamaVersion(args.ollamaVersion);

  // Only the recommended path needs the Hub. An explicit list is the operator's decision and must
  // keep working on a node whose Hub is down — that is often why they are pulling by hand.
  const planFor = async (node: FleetNode, target: { host: string; user?: string }): Promise<NodeModelPlan | undefined> => {
    if (!modelRequest) return undefined;
    const recommendation = modelRequest.kind === 'recommended' ? await fetchHubRecommendation(target, args.dataDir) : undefined;
    return planNodeModels(node.name, modelRequest, recommendation);
  };

  const report: Record<string, unknown>[] = [];
  if (!args.execute) {
    console.log(colorize('Dry run — nothing will change. Add --execute to apply.', 'dim'));
    console.log(`  ${run.length} node(s): ${run.map((n) => n.name).join(', ')}`);
    if (args.hub) {
      console.log(
        pin
          ? `  would run: CI_HUB_IMAGE=${pin} cihub pool update`
          : '  would run: cihub pool update (floating tag — each node gets whatever the tag resolves to when its turn comes)',
      );
    }
    if (args.ollama) {
      console.log(
        `  would bring ollama to ${ollamaVersion} (${args.ollamaVersion ? '--ollama-version' : 'pinned'}) via ollama.com/install.sh, then confirm it at the node's own bind`,
      );
      console.log(colorize('    nodes already serving that version are left alone; nodes with no Ollama are reported, not installed', 'dim'));
    }
    if (modelRequest?.kind === 'recommended') console.log(colorize("  asking each node's Hub for its list — reads only, changes nothing", 'dim'));
    for (const node of run) {
      const plan = await planFor(node, { host: node.ip, user: node.user ?? args.user });
      if (!plan) break;
      console.log(`\n${node.name}`);
      printModelPlan(plan, false);
      report.push({ node: node.name, provenance: plan.provenance, reason: plan.reason, models: plan.models });
    }
    if (args.json && modelRequest) console.log(JSON.stringify(report, null, 2));
    return;
  }

  let failed = 0;
  const afterImages: { node: string; probe: HubImageProbe }[] = [];
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
    if (args.ollama) {
      // Before any model pull on the same node: a pull against a daemon that is about to be
      // restarted is a pull that dies half-way.
      const res = await upgradeOllamaOnNode(target, ollamaVersion);
      if (res.outcome === 'failed') failed += 1;
      const icon = res.outcome === 'failed' ? colorize('✗', 'red') : res.outcome === 'skipped' ? colorize('·', 'dim') : colorize('✓', 'green');
      const took = res.ms ? colorize(` (${Math.round(res.ms / 1000)}s)`, 'dim') : '';
      console.log(`  ${icon} ollama ${res.outcome}${took} — ${res.why}`);
    }
    if (args.hub) {
      const { ok, after } = await updateHubImageOnNode(target, pin);
      if (!ok) failed += 1;
      afterImages.push({ node: node.name, probe: after });
    }
    const plan = await planFor(node, target);
    if (!plan) continue;
    printModelPlan(plan, true);

    const results: ModelPullResult[] = [];
    for (const model of plan.models) {
      if (model.installed === true) {
        // The Hub's live tag list said so seconds ago. Skipping saves a manifest round trip per
        // model per node, which on a fleet of fourteen with five models each is not nothing.
        results.push({ tag: model.tag, outcome: 'already-present' });
        console.log(`  ${colorize('·', 'dim')} ${model.tag} — already present`);
        continue;
      }
      const started = Date.now();
      const res = await sshCapture(target, `bash <<'EOF'\n${pullModelScript(model.tag)}\nEOF`, 45 * 60_000);
      const ok = res.ok && res.out.includes('model-pull-complete');
      const detail = (res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? '';
      const ms = Date.now() - started;
      results.push({ tag: model.tag, outcome: ok ? 'pulled' : 'failed', detail, ms });
      const took = colorize(` (${Math.round(ms / 1000)}s)`, 'dim');
      console.log(`  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${model.tag}${took} — ${detail}`);
    }
    const tally = summarisePulls(results);
    failed += tally.failed;
    const fetched = plan.models
      .filter((m) => results.find((r) => r.tag === m.tag)?.outcome === 'pulled')
      .reduce((sum, m) => sum + (m.diskMb ?? 0), 0);
    console.log(
      colorize(
        `  ${tally.pulled} pulled · ${tally.present} already present · ${tally.failed} failed${fetched ? ` · ≈ ${formatMb(fetched)} fetched (catalog estimate)` : ''}`,
        tally.failed ? 'yellow' : 'dim',
      ),
    );
    report.push({ node: node.name, provenance: plan.provenance, reason: plan.reason, results });
  }
  if (afterImages.length) {
    console.log('');
    printImageFooter(summariseFleetImages(afterImages));
    if (pin) {
      console.log(colorize(`  pinned to ${pin} for this run only — a later 'cihub pool update' without CI_HUB_IMAGE floats back to the tag`, 'dim'));
    }
  }
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (args.json && modelRequest) console.log(JSON.stringify(report, null, 2));
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
  const roster = loadRosterForRun(args);
  if (!roster) return;
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

/**
 * `cihub fleet boot-params` — bring gfx1151 nodes up to the GTT boot parameters CI-OS now sets at
 * first boot.
 *
 * Dry run by default, per node: live (`/proc/cmdline`) and staged (`/etc/default/grub`) state, the
 * target from RAM, and the planned one-line diff. `--execute` writes the file with a backup beside
 * it and runs `update-grub`. It NEVER reboots: two of the twelve gfx1151 nodes have a hidden
 * zero-timeout GRUB menu and no out-of-band console, and a boot that fails there is recovered at the
 * machine. Those nodes are refused outright unless the roster records a console or the operator
 * passes `--i-have-console`; every other node ends in a "reboot required" list the operator works
 * through one at a time.
 *
 * Serialised across nodes, like the rest of the mutating subcommands here.
 */
async function runBootParams(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be written. Add --execute to stage the parameters (a reboot is still yours to do).', 'dim'));
    console.log('');
  }

  const report: Record<string, unknown>[] = [];
  const rebootRequired: string[] = [];
  const refused: string[] = [];
  let failed = 0;

  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const { facts, error } = await readHostFacts(target);
    if (!facts) {
      console.log(`${colorize(node.name, 'yellow')}: ${describeHostFactsFailure(node, target, error)}`);
      report.push({ node: node.name, error: String(error) });
      failed += 1;
      continue;
    }

    // gfx1151 only, decided from KFD topology rather than a card name. Every other machine is
    // reported and left alone — these parameters mean nothing to a discrete GPU.
    const gfx = facts.gpus.find((g) => g.vendor === 'amd' && g.gfx === 'gfx1151');
    if (!gfx) {
      const what = facts.gpus.map((g) => `${g.vendor}${g.gfx ? `/${g.gfx}` : ''}`).join(', ') || 'no gpu';
      console.log(`${node.name}  ${colorize(`${what} — not gfx1151, nothing to set`, 'dim')}`);
      report.push({ node: node.name, skipped: `not gfx1151 (${what})` });
      continue;
    }

    const decision = decideGttTarget(facts.totalRamMib);
    if (decision.kind === 'skip') {
      console.log(`${node.name}  ${colorize(`gfx1151 — ${decision.why}`, 'yellow')}`);
      report.push({ node: node.name, skipped: decision.why });
      continue;
    }

    const { probe, error: probeError } = await readBootParamState(target);
    if (!probe) {
      console.log(
        `${colorize(node.name, 'yellow')}: gfx1151, but could not read /proc/cmdline and /etc/default/grub — ${String(probeError).slice(0, 120)}`,
      );
      report.push({ node: node.name, error: String(probeError) });
      failed += 1;
      continue;
    }

    const assessment = assessNode({
      node: node.name,
      cmdline: probe.cmdline,
      grubText: probe.grubText,
      overriddenBy: probe.overriddenBy,
      target: decision.target,
      oob: node.oob,
      iHaveConsole: args.iHaveConsole,
    });
    printBootParamAssessment(assessment, facts.totalRamMib ?? 0);

    const entry: Record<string, unknown> = {
      node: node.name,
      totalRamMib: facts.totalRamMib,
      target: decision.target.values,
      live: assessment.live,
      staged: assessment.staged,
      menu: assessment.menu,
      plan: assessment.plan.kind === 'edit' ? { kind: 'edit', before: assessment.plan.before, after: assessment.plan.after } : assessment.plan,
      gate: assessment.gate,
      oob: node.oob,
    };

    // Set only when this run actually wrote the file; decides whether the node joins the reboot list.
    let stagedByThisRun = false;

    // A refusal is work the run did not do, so under --execute it is a failure a chain must see.
    // On a dry run nothing was asked for; it is reported and the exit stays 0, like the other plans.
    if (assessment.plan.kind === 'refuse') {
      refused.push(`${node.name}: ${assessment.plan.why}`);
      if (args.execute) failed += 1;
    } else if (assessment.plan.kind === 'edit' && !assessment.gate.allowed) {
      refused.push(assessment.gate.why);
      if (args.execute) failed += 1;
    } else if (assessment.plan.kind === 'edit' && args.execute) {
      const busy = isTooBusyForMaintenance(facts);
      if (busy.busy) {
        console.log(colorize(`  refusing to write: ${busy.why}`, 'yellow'));
        entry.skipped = busy.why;
        failed += 1;
      } else if (probe.grubSha256) {
        const result = await applyBootParams(target, assessment.plan, probe.grubSha256);
        stagedByThisRun = result.outcome === 'staged';
        if (!stagedByThisRun) failed += 1;
        const tone = stagedByThisRun ? 'green' : result.outcome === 'written-no-update-grub' ? 'yellow' : 'red';
        console.log(`  ${colorize(result.outcome, tone)} (${Math.round(result.ms / 1000)}s) — ${result.detail}`);
        entry.apply = result;
      } else {
        console.log(
          colorize(
            '  refusing to write: the probe returned no SHA-256 for /etc/default/grub, so the write cannot verify it is editing the file the plan was computed on',
            'yellow',
          ),
        );
        entry.skipped = 'no sha256 from probe';
        failed += 1;
      }
    }

    // Listed only when the parameters will be there on the next boot: already staged, or written by
    // this run. A dry run lists a planned edit too, labelled "after --execute" in the summary.
    const willBeStaged = assessment.plan.kind !== 'edit' || !args.execute || stagedByThisRun;
    if (assessment.rebootRequired && willBeStaged) rebootRequired.push(node.name);
    report.push(entry);
    console.log('');
  }

  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (refused.length) {
    console.log('');
    console.log(colorize('Refused — nothing was or would be written on:', 'yellow'));
    for (const line of refused) console.log(colorize(`  ${line}`, 'yellow'));
  }
  if (rebootRequired.length) {
    console.log('');
    console.log(colorize(`Reboot required${args.execute ? '' : ' (after --execute)'} on: ${rebootRequired.join(', ')}`, 'yellow'));
    console.log(
      colorize('  This command never reboots. Do each one yourself, one at a time, when it is idle and you can watch it come back.', 'dim'),
    );
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  recordFleetFailures(failed);
}

function printBootParamAssessment(a: NodeBootParamAssessment, totalRamMib: number): void {
  const tone = (state: string) => (state === 'full' ? 'green' : state === 'absent' ? 'red' : 'yellow');
  console.log(`${a.node}  ${colorize(`gfx1151 · ${totalRamMib} MiB RAM`, 'dim')}`);
  console.log(`  live    ${colorize(a.live.detail, tone(a.live.state))}`);
  if (a.staged.kind === 'parsed') console.log(`  staged  ${colorize(a.staged.presence.detail, tone(a.staged.presence.state))}`);
  else console.log(`  staged  ${colorize(`unreadable — ${a.staged.why}`, 'red')}`);
  console.log(`  target  ${a.target.tokens.join(' ')}  ${colorize(`(reserve ${a.target.reserveMib} MiB)`, 'dim')}`);
  if (a.menu?.hiddenZeroTimeout) console.log(`  grub    ${colorize('GRUB_TIMEOUT=0, GRUB_TIMEOUT_STYLE=hidden — no menu on boot', 'yellow')}`);
  switch (a.plan.kind) {
    case 'noop':
      console.log(`  plan    ${colorize('no change', 'dim')} — ${a.plan.why}`);
      break;
    case 'refuse':
      console.log(`  plan    ${colorize('refused', 'red')} — ${a.plan.why}`);
      break;
    case 'edit':
      console.log(`  plan    ${colorize('- ', 'red')}${a.plan.before}`);
      console.log(`          ${colorize('+ ', 'green')}${a.plan.after}`);
      if (!a.gate.allowed) console.log(`  gate    ${colorize(a.gate.why, 'red')}`);
      else if (a.gate.note) console.log(`  gate    ${colorize(a.gate.note, 'yellow')}`);
      break;
  }
}

/**
 * The certificate column for `status`, one SSH round trip per administrable node.
 *
 * A node this run could not SSH to is reported as not measured, with the SSH verdict as the reason
 * — never as anything that could be read as "no certificate", which misreading is the whole reason
 * the column carries a why. (The local node never reaches here: `partitionForRun` skips it.)
 */
async function probeCertsAll(nodes: readonly DiscoveredNode[], args: FleetArgs): Promise<Map<string, CertFinding>> {
  const out = new Map<string, CertFinding>();
  const queue = [...nodes];
  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      if (node.probe.ssh) out.set(node.name, await probeTailscaleCert({ host: node.ip, user: node.user ?? args.user }));
      else out.set(node.name, unmeasuredCert(`ssh failed (${node.probe.sshFailure})`));
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(nodes.length, 1)) }, worker));
  return out;
}

/**
 * `cihub fleet cert` — the `tailscale cert` every pool node needs, provisioned and verified.
 *
 * Read-only unless `--execute`: the dry run probes each node and prints the exact command it would
 * run, or the reason it would not, which is most of the value — it is the list of nodes that cannot
 * pool yet. With `--execute` it issues and then re-reads the store, because the exit code of
 * `tailscale cert` says what the command believed and the store says what the Hub will find.
 *
 * Serialised across nodes: a first issue is an ACME exchange through Tailscale's CA and the fleet
 * shares one rate limit there.
 */
async function runCert(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be issued. Add --execute to run `sudo tailscale cert` where it is needed.', 'dim'));
    console.log('');
  }

  const report: Record<string, unknown>[] = [];
  let failed = 0;
  // The local node is in `skipped`, never `run`: fleet commands do not dial the machine they are on.
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const result = await ensureTailscaleCert(target, { execute: args.execute });
    const state = result.final.cert.value;
    if (state === 'unknown' || (result.issue && !result.ok)) failed += 1;

    const cell = renderCertCell(result.final);
    const tone = result.issue ? (result.ok ? 'green' : 'red') : cell.tone;
    const icon = result.issue ? (result.ok ? '✓' : '✗') : state === 'present' ? '✓' : state === 'absent' ? '✗' : '·';
    const took = result.issue ? colorize(` (${Math.round(result.issue.ms / 1000)}s)`, 'dim') : '';
    console.log(`${colorize(icon, tone)} ${node.name}${took}  ${colorize(cell.text, cell.tone)}`);
    console.log(colorize(`    ${result.issue ? result.detail : describeCertFinding(result.final)}`, 'dim'));
    if (!args.execute) console.log(colorize(`    ${result.plan}`, state === 'absent' ? 'yellow' : 'dim'));
    report.push({ node: node.name, ...result });
  }

  console.log('');
  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  recordFleetFailures(failed);
}

/**
 * Read each node's Hub image, bounded like {@link probeAll}.
 *
 * `skip` names nodes not worth dialling and why — a node whose SSH probe just failed would fail the
 * same way after another timeout, and the reason is already in hand. Those are reported `unknown`
 * with that reason rather than re-attempted, and never counted on either side of the drift line.
 */
async function probeImages(
  nodes: readonly FleetNode[],
  args: FleetArgs,
  skip: ReadonlyMap<string, string> = new Map(),
): Promise<{ node: string; probe: HubImageProbe }[]> {
  const out: { node: string; probe: HubImageProbe }[] = [];
  const queue = [...nodes];
  const worker = async () => {
    for (;;) {
      const node = queue.shift();
      if (!node) return;
      const why = skip.get(node.name);
      if (why !== undefined) {
        out.push({ node: node.name, probe: { kind: 'unknown', reason: why } });
        continue;
      }
      out.push({ node: node.name, probe: await probeHubImage({ host: node.ip, user: node.user ?? args.user }, Math.max(args.timeoutMs, 30_000)) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, Math.max(nodes.length, 1)) }, worker));
  const order = new Map(nodes.map((n, i) => [n.name, i]));
  out.sort((a, b) => (order.get(a.node) ?? 0) - (order.get(b.node) ?? 0));
  return out;
}

/** The footer line, toned by what it says: drift is the finding this column exists to surface. */
function printImageFooter(summary: FleetImageSummary): void {
  const drifted = summary.nodes.some((n) => n.state === 'drifted');
  console.log(colorize(renderImageFooter(summary), drifted || summary.tie.length > 0 ? 'yellow' : 'dim'));
}

function colorImageCell(state: NodeImageState): string {
  const cell = renderImageCell(state);
  if (state.state === 'drifted') return colorize(cell, 'yellow');
  if (state.state === 'unknown') return colorize(cell, 'dim');
  return cell;
}

/**
 * Decide, before anything is dialled for a write, which image `update --hub` deploys.
 *
 * `--to-majority` measures the WHOLE roster — every node a fleet command would run on — not only the
 * `--nodes` selection: the point is to bring the selected nodes to what the fleet runs, and asking two
 * drifted nodes what their own majority is answers nothing. The read is SSH-only and changes nothing,
 * so it runs in a dry run too: the plan should name the image it would pin, and refuse now if it
 * cannot, rather than discovering that after `--execute`.
 */
async function resolveHubPin(
  args: FleetArgs,
  roster: readonly FleetNode[],
): Promise<{ pin?: string; summary?: FleetImageSummary; refused?: string }> {
  if (args.pinDigest) return { pin: args.pinDigest };
  if (!args.toMajority) return {};
  const fleet = partitionForRun(roster, []).run;
  console.log(colorize(`Reading the Hub image on ${fleet.length} rostered node(s) to find the majority.`, 'dim'));
  const summary = summariseFleetImages(await probeImages(fleet, args));
  printImageFooter(summary);
  const resolved = resolveMajorityPin(summary);
  if (!resolved.ok) return { summary, refused: resolved.why };
  console.log(colorize(`  majority ${shortImageId(resolved.majority?.imageId ?? '')} is ${resolved.ref}`, 'dim'));
  return { pin: resolved.ref, summary };
}

/**
 * `cihub pool update` on one node, bracketed by an image read on each side so the run records what
 * it changed. The measured failure this answers: nodes redeploying with nothing writing down what
 * they moved from or to. A pinned update that completes but is not running the pinned image is a
 * failure, whatever `pool update` said — the operator asked for that build by digest.
 */
async function updateHubImageOnNode(target: SshTarget, pin: string | undefined): Promise<{ ok: boolean; after: HubImageProbe }> {
  const before = await probeHubImage(target);
  if (before.kind === 'unknown' && before.reason === 'no ci-hub container') {
    // Nothing to update. `status` already says "no ci-hub container" for this node; running
    // `pool update` here would only fail more slowly and count as a fleet failure.
    console.log(`  ${colorize('·', 'dim')} hub image — no Hub on this node; nothing to update (${BASE_COMMAND} fleet install puts one here)`);
    return { ok: true, after: before };
  }
  const res = await sshCapture(target, `bash <<'EOF'\n${updateHubScript(pin)}\nEOF`, 20 * 60_000);
  const after = await probeHubImage(target);
  let ok = res.ok && res.out.includes('hub-update-complete');
  let note = '';
  if (ok && pin && after.kind === 'known' && !imageMatchesPin(after.facts, pin)) {
    ok = false;
    note = ` — not on the pinned image; running ${after.facts.repoDigest ?? after.facts.tag ?? after.facts.imageId}`;
  }
  const last = (res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) ?? '';
  console.log(
    `  ${ok ? colorize('✓', 'green') : colorize('✗', 'red')} hub image — ${renderImageTransition(before, after)}${note}${ok ? '' : ` — ${last}`}`,
  );
  return { ok, after };
}

/**
 * Ask one node's Hub what it recommends for the machine it runs on.
 *
 * Runs on the node over SSH so the device key is read and used there and never crosses the wire.
 * Never throws: a node whose Hub cannot be asked becomes a named failure in its plan, and the
 * fleet run continues.
 */
async function fetchHubRecommendation(target: { host: string; user?: string }, dataDir: string): Promise<HubRecommendation> {
  const res = await sshCapture(target, `bash <<'EOF'\n${hubRecommendationScript(dataDir)}\nEOF`, 90_000);
  // The script ends in `true`, so a non-zero exit with no status line is SSH itself failing — and
  // that failure has a vocabulary already; use it rather than a generic "no output".
  if (!res.ok && !res.out.includes('onboarding-http=')) {
    return { kind: 'ssh-failed', detail: describeSshFailure(classifySshFailure(res), target.host) };
  }
  return parseHubRecommendationOutput(res.out);
}

function printModelPlan(plan: NodeModelPlan, execute: boolean): void {
  const tone = plan.provenance === 'floor-only' ? 'yellow' : 'dim';
  const source =
    plan.provenance === 'hub-recommended'
      ? "this node's Hub recommended"
      : plan.provenance === 'explicit'
        ? 'named on the command line'
        : 'floor only';
  console.log(`  ${colorize(`models: ${source}${plan.hardware ? ` · ${plan.hardware}` : ''}`, tone)}`);
  if (plan.reason) {
    console.log(colorize(`  ! ${plan.reason}`, 'yellow'));
    if (plan.fix) console.log(colorize(`    ${plan.fix}`, 'dim'));
  }
  if (execute) return;
  for (const model of plan.models) {
    const flags = [
      model.required ? 'platform requirement' : '',
      model.installed === true ? 'present' : '',
      model.diskMb ? formatMb(model.diskMb) : '',
    ]
      .filter(Boolean)
      .join(', ');
    const verb = model.installed === true ? colorize('would keep', 'dim') : colorize('would pull', 'green');
    console.log(`  ${verb} ${model.tag}${flags ? colorize(` (${flags})`, 'dim') : ''}`);
  }
  const estimate = estimatedDownloadMb(plan);
  if (estimate !== undefined) console.log(colorize(`  ≈ ${formatMb(estimate)} to download (catalog estimate)`, 'dim'));
}

/**
 * `cihub fleet rdp` — remote desktop on each Linux node, reachable from the tailnet only.
 *
 * Dry run prints, per node, who owns tcp/3389, what it is bound to, and the plan; `--execute`
 * applies it and then re-reads `ss` — the node fails if anything off the tailnet can still reach
 * 3389. There is deliberately no flag to bind `*:3389`. Logic lives in `fleet-rdp.ts`; this is
 * roster, loop and print.
 */
async function runRdp(args: FleetArgs): Promise<void> {
  const roster = loadRosterForRun(args);
  if (!roster) return;
  const { run, skipped } = partitionForRun(roster.nodes, args.nodes);
  if (run.length === 0) {
    console.log('No nodes selected.');
    for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
    return;
  }

  if (!args.execute) {
    console.log(colorize('Dry run — nothing will be installed. Add --execute to apply.', 'dim'));
    console.log(colorize('RDP is bound to the tailnet address only; there is no option to expose it on the LAN.', 'dim'));
    console.log('');
  }

  const reports: RdpNodeReport[] = [];
  // Serialised: the xrdp plan pulls xfce4 over apt, and parallel package pulls have blocked this
  // fleet's own listeners long enough to look like outages.
  for (const node of run) {
    const target = { host: node.ip, user: node.user ?? args.user };
    const report = await runRdpOnNode(node, target, { execute: args.execute });
    reports.push(report);
    const before = report.before;
    const owner = before ? before.owner : 'unprobed';
    const bind = before ? describeRdpBind(before) : '—';
    const tone = report.ok ? (report.decision?.kind === 'refuse' ? 'yellow' : 'green') : 'red';
    console.log(`${node.name}  ${colorize(`owner ${owner} · bind ${bind}`, 'dim')}`);
    if (report.decision) {
      const label = args.execute
        ? report.decision.kind
        : report.decision.kind === 'refuse'
          ? 'would refuse'
          : report.decision.kind === 'ok'
            ? 'nothing to do'
            : `would ${report.decision.kind === 'xrdp' ? 'install/bind xrdp' : 'install guard'}`;
      console.log(`  ${colorize(label, tone)} — ${report.decision.why}`);
      if (report.decision.kind === 'refuse' && report.decision.fix) console.log(colorize(`    ${report.decision.fix}`, 'dim'));
    }
    for (const st of report.steps) {
      const took = st.ms ? colorize(` (${Math.round(st.ms / 1000)}s)`, 'dim') : '';
      console.log(`  ${st.ok ? colorize('✓', 'green') : colorize('✗', 'red')} ${st.name}${took} — ${st.detail}`);
    }
    // The summary line carries what the lines above did not: a probe that never answered, or a plan
    // that was gated before its first step (the load gate). A refusal already printed itself.
    if (!report.decision || (args.execute && report.steps.length === 0 && report.decision.kind !== 'refuse'))
      console.log(`  ${colorize(report.ok ? '·' : '✗', report.ok ? 'dim' : 'red')} ${report.summary}`);
    console.log('');
  }

  for (const s of skipped) console.log(colorize(`  skipped ${s.node.name}: ${s.why}`, 'dim'));
  if (args.json) console.log(JSON.stringify(reports, null, 2));
  // A dry run reports a plan and exits 0, like every other fleet dry run; a probe failure is still a failure.
  recordFleetFailures(reports.filter((r) => !r.ok).length);
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
    case 'boot-params':
      await runBootParams(args);
      return;
    case 'cert':
      await runCert(args);
      return;
    case 'rdp':
      await runRdp(args);
      return;
    case 'devices':
      await runDevices(args);
      return;
  }
}

/**
 * `cihub fleet devices` — what Portal knows about this org's devices, and the two changes to it a
 * fleet operator needs without a browser.
 *
 * `release` deletes the Portal record, and with it the device's tunnel, DNS, apps and OAuth client
 * — the same thing the browser's delete does. It is for a device this org no longer owns (a node
 * reinstalled into another org, an orphan from a failed install), so it asks first. `re-register`
 * keeps the record and mints a replacement pairing code, for a node that is staying but has lost
 * its key. Neither dials a node.
 */
async function runDevices(args: FleetArgs): Promise<void> {
  const login = readStoredLogin();
  let resolved: PortalLogin;
  try {
    resolved = requireManageLogin(login);
  } catch (error) {
    console.error(colorize(error instanceof Error ? error.message : String(error), 'red'));
    process.exit(2);
  }
  const organizationId = args.org ?? resolved.orgId;
  const orgLabel = args.org ?? resolved.orgSlug ?? resolved.orgId;

  let devices: PortalDevice[];
  try {
    devices = await listPortalDevices({ login: resolved, organizationId });
  } catch (error) {
    console.error(colorize(`Could not list devices in ${orgLabel}: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    process.exitCode = 1;
    return;
  }

  if (args.devicesAction === 'list') {
    if (args.json) {
      console.log(JSON.stringify({ organization: organizationId, devices }, null, 2));
      return;
    }
    console.log(colorize(`${devices.length} device(s) in ${orgLabel} (${resolved.portalOrigin})`, 'dim'));
    if (devices.length) {
      console.log(
        renderTable(
          devices.map((d) => [d.name, d.slug ?? '—', d.status ?? '—', d.id, d.lastSeenAt ?? '—']),
          ['NAME', 'SLUG', 'STATUS', 'PORTAL ID', 'LAST SEEN'],
        ),
      );
    }
    return;
  }

  const found = findPortalDevice(devices, args.devicesTarget as string);
  if (!found.device) {
    console.error(colorize(found.why ?? 'not found', 'red'));
    process.exitCode = 1;
    return;
  }
  const device = found.device;

  if (args.devicesAction === 're-register') {
    try {
      const minted = await reRegisterPortalDevice({ login: resolved, deviceId: device.id });
      console.log(`${colorize('✓', 'green')} ${device.name} — replacement pairing code minted; the device is inactive until it pairs again`);
      console.log(colorize(`  on the node: cihub register --code ${minted.pairingCode}`, 'dim'));
      if (args.json) console.log(JSON.stringify({ device: device.id, pairingCode: minted.pairingCode }, null, 2));
    } catch (error) {
      console.error(colorize(`${device.name}: ${error instanceof Error ? error.message : String(error)}`, 'red'));
      process.exitCode = 1;
    }
    return;
  }

  const confirmed = await confirmDestructiveAction(
    `Releasing ${device.name} (${device.id}) from ${orgLabel}`,
    args.yes,
    `Release ${device.name} from ${orgLabel}? This deletes the Portal record and everything under it — tunnel, DNS, installed apps' registrations, OAuth client. [y/N] `,
    'irreversible',
  );
  if (!confirmed) {
    console.log(colorize('Not released.', 'dim'));
    process.exitCode = 1;
    return;
  }
  try {
    const result = await deletePortalDevice({ login: resolved, deviceId: device.id });
    console.log(
      `${colorize('✓', 'green')} ${device.name} — released from ${orgLabel}${result.warnings?.length ? ` (${result.warnings.join('; ')})` : ''}`,
    );
    console.log(
      colorize(`  a fresh '${BASE_COMMAND} fleet install --nodes ${device.name}' can now enrol it into the org this login belongs to`, 'dim'),
    );
  } catch (error) {
    console.error(colorize(`${device.name}: ${error instanceof Error ? error.message : String(error)}`, 'red'));
    process.exitCode = 1;
  }
}
