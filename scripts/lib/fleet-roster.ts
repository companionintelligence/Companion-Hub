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
 *    expressible.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCanonicalDataDir } from './paths.js';

/** Why a node is deliberately not attempted. Absent means "attempt it". */
export type FleetNodeSkip =
  /** Serves inference and is not administrable — usually a tailnet ACL that grants no SSH. */
  | 'llm-only'
  /** Known down, awaiting hands-on recovery. Attempting it wastes the budget and reports nothing new. */
  | 'unreachable'
  /** Deliberately out of scope for fleet operations (someone's workstation, a demo box). */
  | 'excluded';

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
 */
export function parseFleetRoster(raw: unknown): { nodes: FleetNode[]; dropped: string[] } {
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { nodes?: unknown })?.nodes) ? (raw as { nodes: unknown[] }).nodes : null;
  if (!rows) return { nodes: [], dropped: ['roster is neither an array nor an object with a `nodes` array'] };

  const nodes: FleetNode[] = [];
  const dropped: string[] = [];
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
    nodes.push({
      name,
      ip,
      tailnetName: typeof r.tailnetName === 'string' ? r.tailnetName : undefined,
      user: typeof r.user === 'string' ? r.user : undefined,
      local: r.local === true ? true : undefined,
      skip: isFleetNodeSkip(r.skip) ? r.skip : undefined,
      note: typeof r.note === 'string' ? r.note : undefined,
    });
  }
  return { nodes, dropped };
}

function isFleetNodeSkip(value: unknown): value is FleetNodeSkip {
  return value === 'llm-only' || value === 'unreachable' || value === 'excluded';
}

/** Read the roster. A missing file is an empty fleet, not an error — that is the pre-scan state. */
export function loadFleetRoster(path: string = fleetRosterPath()): FleetRoster & { dropped: string[] } {
  if (!existsSync(path)) return { nodes: [], source: `${path} (not created yet — run 'cihub fleet scan --write-roster')`, dropped: [] };
  try {
    const parsed = parseFleetRoster(JSON.parse(readFileSync(path, 'utf-8')));
    return { nodes: parsed.nodes, source: path, dropped: parsed.dropped };
  } catch (error) {
    return { nodes: [], source: `${path} (unreadable: ${String(error)})`, dropped: [String(error)] };
  }
}

export function saveFleetRoster(nodes: readonly FleetNode[], path: string = fleetRosterPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(nodes, null, 2)}\n`, 'utf-8');
}

/**
 * Fold freshly discovered nodes into an existing roster.
 *
 * Discovery may not overwrite operator intent. A `skip`, a `note` or a chosen `name` is a human
 * decision, and a scan that silently cleared it would re-enable a node somebody deliberately
 * excluded — quietly, on the next run. Discovery only fills fields that are absent and may correct
 * `tailnetName`, which is a fact about the network rather than a preference.
 */
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
