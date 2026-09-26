/**
 * Which machines this Hub's operator considers part of their fleet.
 *
 * Stored beside the Hub's other state (`<data-dir>/fleet.json`) rather than in a checkout, because
 * `cihub` is installed on appliances that have no repo. `resolveCanonicalDataDir` already picks the
 * right per-OS location and honours `CI_HUB_DATA_DIR`.
 *
 * TWO RULES, both learned from a roster that already went wrong next door:
 *
 * 1. **`ip` is the identity, `name` is a label.** The existing fleet rosters in CI-Engineering give
 *    the same machine five different names across two files (`core-17`/`bench-1`, `ci`/`core-10`,
 *    `beta-3-glass`/`beta-glass`, …) and one row whose name and IP disagree entirely — its `core-5`
 *    entry is a machine the tailnet calls `core-4-kvm`. Every merge and lookup here keys on `ip`.
 *
 * 2. **A node can be permanently excluded, and say why.** The older roster has no such field, so
 *    four nodes that can never pass — no account, no Docker, an ACL that grants nothing — are
 *    re-attempted on every single run at a 30-second timeout each, and land in the report looking
 *    exactly like a machine that broke this morning. `skip` makes "we know, and here is why"
 *    expressible — in `FLEET_NODE_SKIPS` and nothing else. A value outside it refuses the roster
 *    rather than reading as "attempt it", which is how an operator's `"excluded-tmp"` on 22 rows
 *    became an install on all 23.
 *
 * 3. **The roster is the only source of targets.** No roster means no fleet, not "everyone on the
 *    tailnet". The tailnet is shared with colleagues' laptops, phones and headsets, and a run that
 *    substituted its peer list for a missing file put `Bennett's MacBook Pro` and `Quest 3` in front
 *    of the same SSH loop as the appliances. `loadFleetRoster` reports an absent or unreadable file
 *    as a `problem`, and every operation refuses on it; only `fleet scan --all-tailnet` — the one
 *    explicit way to build the file — reads the tailnet, and what it writes is for the operator to
 *    prune with `skip`. No ACL tag stands in for that judgement.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCanonicalDataDir } from './paths.js';

/**
 * Every `skip` value a fleet command honours. Absent (or `null`) means "attempt it"; anything else
 * is refused at load — see `parseFleetRoster`.
 *
 * - `llm-only` — serves inference and is not administrable, usually a tailnet ACL that grants no SSH.
 * - `unreachable` — known down, awaiting hands-on recovery. Attempting it wastes the budget and
 *   reports nothing new.
 * - `excluded` — deliberately out of scope for fleet operations (someone's workstation, a demo box).
 */
export const FLEET_NODE_SKIPS = ['llm-only', 'unreachable', 'excluded'] as const;

/** Why a node is deliberately not attempted. Absent means "attempt it". */
export type FleetNodeSkip = (typeof FLEET_NODE_SKIPS)[number];

export interface FleetNode {
  /** Display label. Not an identity — see the header. */
  name: string;
  /** The address everything dials. Identity for merges and lookups. */
  ip: string;
  /** MagicDNS name when known; what pool pairing wants, since peers are keyed by FQDN. */
  tailnetName?: string;
  /** Remote user for SSH. Undefined uses the ssh config default. */
  user?: string;
  /** Set for the machine running the CLI. Never dialled over SSH. */
  local?: boolean;
  skip?: FleetNodeSkip;
  /** Free text an operator wrote. Shown in listings; never parsed. */
  note?: string;
  /**
   * Out-of-band console for this machine — an IPMI address, a NanoKVM, a PiKVM, a serial server.
   * Free text; its *presence* is what matters. Preflight treats a node with `GRUB_TIMEOUT=0`, no
   * IPMI and no `oob` as one where a failed boot means a trip, and says so before anything that
   * touches the kernel. The host cannot see an external KVM plugged into it, so only the roster can
   * carry this fact.
   */
  oob?: string;
}

export interface FleetRoster {
  nodes: FleetNode[];
  /** Where this came from, for a listing to cite rather than implying a canonical source. */
  source: string;
}

export const FLEET_ROSTER_FILENAME = 'fleet.json';

export function fleetRosterPath(): string {
  return join(resolveCanonicalDataDir(), FLEET_ROSTER_FILENAME);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Accepts an IPv4 literal or a hostname; both are dialable and both appear in real rosters. */
export function isPlausibleHost(value: string): boolean {
  if (!value || value.length > 253) return false;
  const m = IPV4.exec(value);
  if (m) return m.slice(1).every((octet) => Number(octet) <= 255);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value);
}

/**
 * Parse a roster document, dropping rows that cannot be dialled.
 *
 * Returns the reasons alongside, rather than throwing: one malformed row in a
 * twenty-node file should cost that row, not the whole fleet. A silent drop would be worse than
 * either — the operator would run against nineteen nodes believing it was twenty.
 *
 * A `skip` this code does not recognise is the exception, and lands in `invalid` rather than
 * `dropped`: `loadFleetRoster` refuses the whole file on it. Dropping an undialable row costs that
 * row; misreading a skip costs the rows it was written to protect. On 2026-09-26 an operator marked
 * 22 of 23 rows `"skip": "excluded-tmp"` to narrow an install to one node, the old parser read the
 * unknown value as "attempt it", and `fleet install --execute` ran on all 23. The operator's intent
 * is unknowable from the typo — "skip it" and "not a real skip" are both plausible — so neither
 * guess is safe, and the row is named with the values that are. Such a row is also left out of
 * `nodes`, so a caller that forgets to look at `invalid` still never dials it.
 */
export function parseFleetRoster(raw: unknown): { nodes: FleetNode[]; dropped: string[]; invalid: string[] } {
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { nodes?: unknown })?.nodes) ? (raw as { nodes: unknown[] }).nodes : null;
  if (!rows) return { nodes: [], dropped: ['roster is neither an array nor an object with a `nodes` array'], invalid: [] };

  const nodes: FleetNode[] = [];
  const dropped: string[] = [];
  const invalid: string[] = [];
  const seenIps = new Set<string>();

  for (const [i, row] of rows.entries()) {
    const r = row as Partial<FleetNode> | null;
    if (!r || typeof r !== 'object') {
      dropped.push(`row ${i}: not an object`);
      continue;
    }
    const ip = typeof r.ip === 'string' ? r.ip.trim() : '';
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : ip;
    if (!ip) {
      dropped.push(`row ${i}${r.name ? ` (${r.name})` : ''}: no ip`);
      continue;
    }
    if (!isPlausibleHost(ip)) {
      dropped.push(`row ${i} (${name}): '${ip}' is not a dialable address`);
      continue;
    }
    // Identity is the IP, so a duplicate is a real ambiguity rather than a harmless repeat: two rows
    // would each claim to describe the same machine and a later merge would pick arbitrarily.
    if (seenIps.has(ip)) {
      dropped.push(`row ${i} (${name}): duplicate of an earlier row for ${ip}`);
      continue;
    }
    seenIps.add(ip);
    // `null` is JSON's way to clear a field, so it reads as absent. Nothing else does — not `false`,
    // not `""`, not a near-miss spelling — because every one of those was typed by someone who
    // meant something, and the loader cannot tell what.
    const skip = r.skip ?? undefined;
    if (skip !== undefined && !isFleetNodeSkip(skip)) {
      invalid.push(`row ${i} (${name}, ${ip}): "skip": ${JSON.stringify(skip)}`);
      continue;
    }
    nodes.push({
      name,
      ip,
      tailnetName: typeof r.tailnetName === 'string' ? r.tailnetName : undefined,
      user: typeof r.user === 'string' ? r.user : undefined,
      local: r.local === true ? true : undefined,
      skip,
      note: typeof r.note === 'string' ? r.note : undefined,
      oob: typeof r.oob === 'string' && r.oob.trim() ? r.oob.trim() : undefined,
    });
  }
  return { nodes, dropped, invalid };
}

function isFleetNodeSkip(value: unknown): value is FleetNodeSkip {
  return (FLEET_NODE_SKIPS as readonly unknown[]).includes(value);
}

/**
 * Why a roster could not be loaded. Distinct from a roster that loaded and lists nobody: that is a
 * state an operator chose, this is a file that is not there or cannot be read.
 */
export type FleetRosterProblem =
  /** The file does not exist — the pre-scan state. */
  | { kind: 'absent'; path: string }
  /** The file exists but is not JSON the parser accepts. */
  | { kind: 'unreadable'; path: string; why: string }
  /** Rows carry a `skip` no fleet command honours. Each entry names the row and the value it holds. */
  | { kind: 'invalid-skip'; path: string; rows: string[] };

export interface LoadedFleetRoster extends FleetRoster {
  dropped: string[];
  /** Set when there is no roster to act on. Callers that dial anything must refuse on it. */
  problem?: FleetRosterProblem;
}

/**
 * Read the roster.
 *
 * A missing or unreadable file — or one with a `skip` no command honours — comes back with
 * `nodes: []` AND a `problem`, so a caller that only looks at `nodes` sees an empty fleet and dials
 * nothing — never a fallback list. The `problem` is for the caller to name the file and how to fix it.
 */
export function loadFleetRoster(path: string = fleetRosterPath()): LoadedFleetRoster {
  if (!existsSync(path)) {
    return {
      nodes: [],
      source: `${path} (not created yet — run 'cihub fleet scan --all-tailnet --write-roster')`,
      dropped: [],
      problem: { kind: 'absent', path },
    };
  }
  try {
    const parsed = parseFleetRoster(JSON.parse(readFileSync(path, 'utf-8')));
    // The whole roster, not just the bad rows: a partial fleet is exactly what the operator did not
    // ask for, whichever way the typo is read.
    if (parsed.invalid.length > 0) {
      return {
        nodes: [],
        source: `${path} (${parsed.invalid.length} row(s) with an unrecognised skip)`,
        dropped: parsed.dropped,
        problem: { kind: 'invalid-skip', path, rows: parsed.invalid },
      };
    }
    return { nodes: parsed.nodes, source: path, dropped: parsed.dropped };
  } catch (error) {
    const why = String(error);
    return { nodes: [], source: `${path} (unreadable: ${why})`, dropped: [why], problem: { kind: 'unreadable', path, why } };
  }
}

export function saveFleetRoster(nodes: readonly FleetNode[], path: string = fleetRosterPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(nodes, null, 2)}\n`, 'utf-8');
}

/**
 * Fold freshly discovered nodes into an existing roster.
 *
 * Discovery may not overwrite operator intent. A `skip`, a `note`, an `oob` console or a chosen
 * `name` is a human decision, and a scan that silently cleared it would re-enable a node somebody deliberately
 * excluded — quietly, on the next run. Discovery only fills fields that are absent and may correct
 * `tailnetName`, which is a fact about the network rather than a preference.
 */
/** The exact note earlier scans wrote; never written now, removed on merge. */
export const SCAN_OFFLINE_NOTE = 'tailnet reports offline';

export function mergeFleetRoster(existing: readonly FleetNode[], discovered: readonly FleetNode[]): { nodes: FleetNode[]; added: FleetNode[] } {
  const byIp = new Map(existing.map((n) => [n.ip, { ...n }]));
  const added: FleetNode[] = [];

  for (const found of discovered) {
    const current = byIp.get(found.ip);
    if (!current) {
      byIp.set(found.ip, { ...found });
      added.push(found);
      continue;
    }
    if (found.tailnetName) current.tailnetName = found.tailnetName;
    if (!current.name || current.name === current.ip) current.name = found.name;
    if (current.local === undefined && found.local) current.local = true;
    // Earlier scans wrote their own observation into `note`, where it was then preserved as if an
    // operator had written it — and outlived the outage it described. The scan no longer writes it;
    // this clears the copies it left.
    if (current.note === SCAN_OFFLINE_NOTE) delete current.note;
  }

  return { nodes: [...byIp.values()], added };
}

/** The nodes a fleet operation should actually attempt, and the ones it is skipping with a reason. */
export function partitionForRun(
  nodes: readonly FleetNode[],
  only?: readonly string[],
): { run: FleetNode[]; skipped: { node: FleetNode; why: string }[] } {
  const wanted = only?.length ? new Set(only.map((s) => s.trim()).filter(Boolean)) : null;
  const run: FleetNode[] = [];
  const skipped: { node: FleetNode; why: string }[] = [];

  for (const node of nodes) {
    // `--nodes` matches either identifier, because an operator types whichever they remember.
    if (wanted && !wanted.has(node.name) && !wanted.has(node.ip)) continue;
    if (node.local) {
      skipped.push({ node, why: 'local node — fleet commands act on remote machines' });
      continue;
    }
    if (node.skip === 'llm-only') {
      skipped.push({ node, why: 'marked llm-only: serves inference but grants no SSH, so nothing here can administer it' });
      continue;
    }
    if (node.skip === 'unreachable') {
      skipped.push({ node, why: 'marked unreachable: known down, awaiting hands-on recovery' });
      continue;
    }
    if (node.skip === 'excluded') {
      skipped.push({ node, why: 'marked excluded from fleet operations' });
      continue;
    }
    run.push(node);
  }
  return { run, skipped };
}
