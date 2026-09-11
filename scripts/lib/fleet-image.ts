/**
 * Which Hub build each fleet node is actually running, and whether they agree.
 *
 * THE PROBLEM THIS FILE EXISTS FOR: every fleet node runs the floating tag `ci-hub:dev`, so `docker
 * ps` shows the same image name on all of them and drift is invisible. Measured on 2026-09-10 by
 * comparing `docker image inspect --format '{{.Id}}'` across the fleet: twelve nodes on one image ID
 * and four outliers on three others — and two of the outliers CHANGED during the evening, meaning
 * something was redeploying under us with nothing recording it. There was no way to say "the fleet
 * runs build X", let alone to hold it there.
 *
 * Two identities matter, and they answer different questions:
 *
 *   · **image ID** (`sha256:…`, the content hash of the image config) — the thing that was measured,
 *     and the drift key here. Two nodes with the same ID run byte-identical software.
 *   · **repo digest** (`ghcr.io/…/ci-hub@sha256:…`, the registry manifest digest recorded at pull
 *     time) — the only identity another node can PULL. An image ID is not addressable in a registry,
 *     which is why pinning happens by digest and `--to-majority` translates the majority's ID into
 *     its digest. A locally built image has no digest, and so cannot be pinned to.
 *
 * Everything here is pure except {@link probeHubImage}, which is the one SSH round trip. `unknown` is
 * its own state with a reason — a node that could not be read is never counted as agreeing with the
 * fleet or as drifting from it, because either would be a fabricated measurement.
 *
 * Caveat, stated rather than hidden: a mixed-architecture fleet will report legitimate drift, since
 * the same multi-arch build yields a different image ID per platform. This fleet is x86_64 throughout;
 * if that changes, the drift key should become the repo digest with the image ID as fallback.
 */

import { classifySshFailure, sshCapture, type SshResult, type SshTarget } from './fleet-ssh.js';

/** Where the published Hub image lives. `--pin-digest sha256:…` without a repo is completed against this. */
export const HUB_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-hub';

/** Container names a Hub has run under: the canonical topology, then the older one. */
export const HUB_CONTAINER_NAMES = ['ci-hub', 'ci-os-hub'] as const;

/**
 * Eight hex characters, as the fleet report prints them. Docker's own short form is twelve; eight is
 * enough to tell eighteen builds apart at a glance and keeps a twenty-node table on one screen.
 */
export const SHORT_IMAGE_ID_LENGTH = 8;

// ─── Parsing docker inspect output ──────────────────────────────────────────

/** The fields of `docker container inspect` this module reads. */
export interface ContainerInspectFacts {
  /** Container name without the leading slash Docker prints. */
  name: string;
  /** `.Image` — the image ID the container was created from. */
  imageId: string;
  /** `.Config.Image` — the reference compose asked for (`ghcr.io/…:dev`, or `repo@sha256:…` when pinned). */
  imageRef: string | null;
  /** `.State.Status` — `running`, `exited`, `restarting`, … */
  status: string | null;
}

/** The fields of `docker image inspect` this module reads. */
export interface ImageInspectFacts {
  imageId: string;
  repoDigests: string[];
  repoTags: string[];
  /** `.Created`, as Docker prints it (RFC 3339 with nanoseconds). */
  created: string | null;
}

/** One node's Hub image, once both inspects have been read. */
export interface HubImageFacts {
  container: string;
  containerStatus: string | null;
  /** Full `sha256:…` image ID. */
  imageId: string;
  /** `repo@sha256:…` — the first registry digest recorded for the image, or null for a locally built one. */
  repoDigest: string | null;
  /** The reference the container runs under — what the node THINKS it is running. */
  tag: string | null;
  created: string | null;
}

function firstObject(text: string): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(doc)) doc = doc[0];
  return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value !== '<no value>' ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : [];
}

/**
 * Parse `docker container inspect` output — the full JSON array Docker prints, or the trimmed object
 * the probe script emits via `--format`. Returns null when the document carries no image ID, which
 * is the one field nothing below can do without.
 */
export function parseContainerInspect(text: string): ContainerInspectFacts | null {
  const doc = firstObject(text);
  if (!doc) return null;
  const imageId = stringField(doc.Image);
  if (!imageId) return null;
  const config = doc.Config && typeof doc.Config === 'object' ? (doc.Config as Record<string, unknown>) : {};
  const state = doc.State && typeof doc.State === 'object' ? (doc.State as Record<string, unknown>) : {};
  return {
    name: (stringField(doc.Name) ?? '').replace(/^\//, ''),
    imageId,
    imageRef: stringField(config.Image),
    status: stringField(state.Status),
  };
}

/** Parse `docker image inspect` output, full or trimmed. Null when there is no `Id`. */
export function parseImageInspect(text: string): ImageInspectFacts | null {
  const doc = firstObject(text);
  if (!doc) return null;
  const imageId = stringField(doc.Id);
  if (!imageId) return null;
  return {
    imageId,
    repoDigests: stringList(doc.RepoDigests),
    repoTags: stringList(doc.RepoTags),
    created: stringField(doc.Created),
  };
}

/** Combine the two inspects. The container's own reference wins for `tag`; RepoTags is the fallback. */
export function hubImageFacts(container: ContainerInspectFacts, image: ImageInspectFacts): HubImageFacts {
  return {
    container: container.name,
    containerStatus: container.status,
    imageId: image.imageId,
    repoDigest: image.repoDigests[0] ?? null,
    tag: container.imageRef ?? image.repoTags[0] ?? null,
    created: image.created,
  };
}

// ─── The remote probe ───────────────────────────────────────────────────────

/**
 * Prefix every line of the probe carries, so the parser can ignore anything else a login shell prints.
 */
const PROBE_PREFIX = 'image-probe';

/**
 * The script one node runs to report its Hub image.
 *
 * `--format` with `{{json .Field}}` rather than the bare inspect JSON, for two reasons: the full
 * container document carries `Config.Env`, which is where every secret on the node lives, and it is
 * tens of kilobytes per node where four fields are needed. The output keeps Docker's own field names
 * so {@link parseContainerInspect} and {@link parseImageInspect} read both forms.
 *
 * Every non-finding exits 0 with a marker naming it: a probe that reports "unreachable" for a node
 * whose Docker is merely missing has told the operator to check the wrong thing.
 */
export function hubImageProbeScript(): string {
  const names = HUB_CONTAINER_NAMES.join(' ');
  const containerFormat =
    '{"Name":{{json .Name}},"Image":{{json .Image}},"State":{"Status":{{json .State.Status}}},"Config":{"Image":{{json .Config.Image}}}}';
  const imageFormat = '{"Id":{{json .Id}},"RepoTags":{{json .RepoTags}},"RepoDigests":{{json .RepoDigests}},"Created":{{json .Created}}}';
  return [
    `if ! command -v docker >/dev/null 2>&1; then echo "${PROBE_PREFIX}: docker=missing"; exit 0; fi`,
    `if ! docker info >/dev/null 2>&1; then echo "${PROBE_PREFIX}: docker=daemon-unreachable"; exit 0; fi`,
    'c=""',
    `for name in ${names}; do`,
    '  if docker container inspect "$name" >/dev/null 2>&1; then c="$name"; break; fi',
    'done',
    `if [ -z "$c" ]; then echo "${PROBE_PREFIX}: container=absent"; exit 0; fi`,
    `echo "${PROBE_PREFIX}: container=$c"`,
    `echo "${PROBE_PREFIX}-container: $(docker container inspect "$c" --format '${containerFormat}')"`,
    'id="$(docker container inspect "$c" --format \'{{.Image}}\')"',
    `echo "${PROBE_PREFIX}-image: $(docker image inspect "$id" --format '${imageFormat}')"`,
    `echo "${PROBE_PREFIX}: complete"`,
  ].join('\n');
}

/** What one node reported, or why it could not. */
export type HubImageProbe = { kind: 'known'; facts: HubImageFacts } | { kind: 'unknown'; reason: string };

/**
 * Turn the probe's output into a finding.
 *
 * Every branch that is not `known` says why, in the operator's words. The reasons are short on
 * purpose — they land inside parentheses in a one-line footer — and distinct on purpose: `unreachable`,
 * `docker missing` and `no ci-hub container` each call for a different next action.
 */
export function parseHubImageProbe(result: Pick<SshResult, 'ok' | 'out' | 'err' | 'code'>): HubImageProbe {
  const lines = result.out.split('\n').map((line) => line.trim());
  const markers = new Map<string, string>();
  let containerJson: string | null = null;
  let imageJson: string | null = null;
  for (const line of lines) {
    if (line.startsWith(`${PROBE_PREFIX}-container: `)) containerJson = line.slice(`${PROBE_PREFIX}-container: `.length);
    else if (line.startsWith(`${PROBE_PREFIX}-image: `)) imageJson = line.slice(`${PROBE_PREFIX}-image: `.length);
    else if (line.startsWith(`${PROBE_PREFIX}: `)) {
      const [key, ...rest] = line.slice(`${PROBE_PREFIX}: `.length).split('=');
      markers.set(key ?? '', rest.join('='));
    }
  }

  if (markers.size === 0) {
    // Nothing of ours came back. The SSH layer knows why better than the output does.
    if (!result.ok) {
      const failure = classifySshFailure({ ...result, ms: 0 });
      return { kind: 'unknown', reason: failure === 'command-failed' ? 'probe failed' : failure };
    }
    return { kind: 'unknown', reason: 'probe returned no image data' };
  }
  if (markers.get('docker') === 'missing') return { kind: 'unknown', reason: 'docker missing' };
  if (markers.get('docker') === 'daemon-unreachable') return { kind: 'unknown', reason: 'docker daemon unreachable' };
  if (markers.get('container') === 'absent') return { kind: 'unknown', reason: 'no ci-hub container' };
  if (!markers.has('complete') || !containerJson || !imageJson) return { kind: 'unknown', reason: 'probe output truncated' };

  const container = parseContainerInspect(containerJson);
  const image = parseImageInspect(imageJson);
  if (!container || !image) return { kind: 'unknown', reason: 'inspect output unparsable' };
  return { kind: 'known', facts: hubImageFacts(container, image) };
}

/** The one SSH round trip. Default budget is generous for a probe because `docker info` on a loaded node can take seconds. */
export async function probeHubImage(target: SshTarget, timeoutMs = 30_000): Promise<HubImageProbe> {
  const result = await sshCapture(target, `bash <<'CIHUB_IMAGE_EOF'\n${hubImageProbeScript()}\nCIHUB_IMAGE_EOF`, timeoutMs);
  return parseHubImageProbe(result);
}

// ─── Majority and drift ─────────────────────────────────────────────────────

export type NodeImageState =
  | { node: string; state: 'same'; imageId: string; facts: HubImageFacts }
  | { node: string; state: 'drifted'; imageId: string; facts: HubImageFacts }
  | { node: string; state: 'unknown'; reason: string };

export interface FleetImageMajority {
  imageId: string;
  /** Nodes on this image. */
  count: number;
  /** The pullable identity of this image, from the first node reporting one. Null when it was never pulled from a registry. */
  repoDigest: string | null;
  /** `count` is more than half of ALL nodes in the report — unknown ones included, since they could be anything. */
  strict: boolean;
}

export interface FleetImageSummary {
  /** Every node passed in, in the order given, each labelled. */
  nodes: NodeImageState[];
  total: number;
  known: number;
  /** Null when no node could be read, or when the top count is shared — see `tie`. */
  majority: FleetImageMajority | null;
  /** Image IDs sharing the top count when there is no single most-common image. Empty otherwise. */
  tie: string[];
}

/**
 * Label every node against the fleet's most common Hub image.
 *
 * Denominator for `strict` is the whole report, not only the nodes that answered. Nine known nodes
 * on one image out of eighteen rostered is a claim about half the fleet, and the half nobody could
 * read is exactly where the surprises were on the evening this was measured.
 *
 * On a tie nothing is canonical, so nothing is `same`: every known node is `drifted` and `tie` names
 * the contenders. That is the honest shape of a fleet split down the middle.
 */
export function summariseFleetImages(probes: readonly { node: string; probe: HubImageProbe }[]): FleetImageSummary {
  const counts = new Map<string, number>();
  for (const { probe } of probes) {
    if (probe.kind !== 'known') continue;
    counts.set(probe.facts.imageId, (counts.get(probe.facts.imageId) ?? 0) + 1);
  }
  const total = probes.length;
  const known = [...counts.values()].reduce((sum, n) => sum + n, 0);

  const top = Math.max(0, ...counts.values());
  const leaders = [...counts.entries()].filter(([, n]) => n === top).map(([id]) => id);
  const tie = leaders.length > 1 ? leaders.sort() : [];
  const majorityId = leaders.length === 1 ? (leaders[0] as string) : null;

  const nodes: NodeImageState[] = probes.map(({ node, probe }) => {
    if (probe.kind !== 'known') return { node, state: 'unknown', reason: probe.reason };
    const state = majorityId !== null && probe.facts.imageId === majorityId ? 'same' : 'drifted';
    return { node, state, imageId: probe.facts.imageId, facts: probe.facts };
  });

  let majority: FleetImageMajority | null = null;
  if (majorityId !== null) {
    const holder = probes.find((p) => p.probe.kind === 'known' && p.probe.facts.imageId === majorityId && p.probe.facts.repoDigest);
    majority = {
      imageId: majorityId,
      count: top,
      repoDigest: holder?.probe.kind === 'known' ? holder.probe.facts.repoDigest : null,
      strict: top * 2 > total,
    };
  }

  return { nodes, total, known, majority, tie };
}

// ─── Pinning ────────────────────────────────────────────────────────────────

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export type PinResolution = { ok: true; ref: string } | { ok: false; why: string };

/**
 * Validate what `--pin-digest` was given and complete it to a pullable reference.
 *
 * Accepts `repo@sha256:…` or a bare `sha256:…` (completed against {@link HUB_IMAGE_REPO}). Refuses a
 * tag outright: `ghcr.io/…:v0.2.70` LOOKS pinned and is not — a tag is re-pointable, which is the
 * whole failure this flag exists to escape.
 */
export function parsePinDigest(value: string): PinResolution {
  const trimmed = value.trim();
  if (DIGEST_RE.test(trimmed)) return { ok: true, ref: `${HUB_IMAGE_REPO}@${trimmed}` };
  const at = trimmed.indexOf('@');
  if (at > 0 && !/\s/.test(trimmed)) {
    const repo = trimmed.slice(0, at);
    const digest = trimmed.slice(at + 1);
    if (DIGEST_RE.test(digest)) return { ok: true, ref: `${repo}@${digest}` };
    return { ok: false, why: `'${digest}' is not a sha256 digest. Expected repo@sha256:<64 hex characters>.` };
  }
  if (/:[A-Za-z0-9_.-]+$/.test(trimmed) && !trimmed.includes('@')) {
    return { ok: false, why: `'${trimmed}' is a tag, and a tag is mutable — pass the digest (repo@sha256:…) from 'fleet status --json' instead.` };
  }
  return { ok: false, why: `'${trimmed}' is not an image digest. Expected repo@sha256:<64 hex characters>, or sha256:<64 hex characters>.` };
}

/**
 * Decide whether the fleet's majority image can be pinned to, and refuse with the reason when not.
 *
 * Three refusals, each a different situation for the operator:
 *   · nothing known — no probe answered, so there is no majority to speak of;
 *   · a tie — the fleet is split and choosing a side would be this tool's decision, not theirs;
 *   · not strict — the most common image is on half the fleet or less. "Majority" would be a lie,
 *     and the flag's promise is to converge the fleet on what MOST of it already runs.
 * And a fourth that is about the image rather than the count: a majority image with no registry
 * digest was built locally, and no other node can pull it.
 */
export function resolveMajorityPin(summary: FleetImageSummary): PinResolution & { majority?: FleetImageMajority } {
  if (summary.known === 0) {
    return { ok: false, why: `No node's Hub image could be read (${summary.total} probed), so there is no majority to pin to.` };
  }
  if (summary.tie.length > 0) {
    const share = nodesOn(summary, summary.tie[0] as string).length;
    return {
      ok: false,
      why: `No majority: the fleet is split ${summary.tie.map(() => share).join('/')} of ${summary.total} between ${summary.tie.map(shortImageId).join(' and ')}. Pin one explicitly with --pin-digest.`,
    };
  }
  const majority = summary.majority as FleetImageMajority;
  if (!majority.strict) {
    const pct = Math.round((majority.count / summary.total) * 100);
    const unknown = summary.total - summary.known;
    return {
      ok: false,
      why:
        `${shortImageId(majority.imageId)} is the most common Hub image, but on only ${majority.count} of ${summary.total} nodes (${pct}%) — not a strict majority` +
        `${unknown > 0 ? `, and ${unknown} node(s) could not be read` : ''}. Refusing to pin the fleet to it; pass --pin-digest to choose deliberately.`,
      majority,
    };
  }
  if (!majority.repoDigest) {
    return {
      ok: false,
      why: `${shortImageId(majority.imageId)} is on ${majority.count} of ${summary.total} nodes but carries no registry digest — it was built locally, and no other node can pull it.`,
      majority,
    };
  }
  return { ok: true, ref: majority.repoDigest, majority };
}

/** Did an update land on the image it was asked for? Compares the digest half only, so `repo@sha` and `mirror@sha` agree. */
export function imageMatchesPin(facts: HubImageFacts, pinnedRef: string): boolean {
  const wanted = pinnedRef.slice(pinnedRef.indexOf('@') + 1);
  return facts.repoDigest?.endsWith(`@${wanted}`) === true;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/** `sha256:d5ff45d90203…` → `d5ff45d9`. Tolerates an ID that already lacks the prefix. */
export function shortImageId(imageId: string): string {
  return imageId.replace(/^sha256:/, '').slice(0, SHORT_IMAGE_ID_LENGTH);
}

/** The IMAGE cell of a status table. Plain text; the caller colours it. */
export function renderImageCell(state: NodeImageState): string {
  if (state.state === 'unknown') return '?';
  return shortImageId(state.imageId);
}

/** Known nodes running this image, in report order. */
function nodesOn(summary: FleetImageSummary, imageId: string): Extract<NodeImageState, { state: 'same' | 'drifted' }>[] {
  return summary.nodes.filter((n): n is Extract<NodeImageState, { state: 'same' | 'drifted' }> => n.state !== 'unknown' && n.imageId === imageId);
}

/**
 * One line for the bottom of a fleet report:
 *
 *   hub image d5ff45d9 on 12/18; drifted: core-3 (9a38714f), core-6 (9a38714f); unknown: core-17 (unreachable)
 *
 * A tie names both contenders and their nodes, since there is no side to call drifted. Unknown nodes
 * are always listed last with their reason, and are never folded into either count.
 */
export function renderImageFooter(summary: FleetImageSummary): string {
  const unknown = summary.nodes.filter((n): n is Extract<NodeImageState, { state: 'unknown' }> => n.state === 'unknown');
  const label = (n: Extract<NodeImageState, { state: 'same' | 'drifted' }>) => `${n.node} (${shortImageId(n.imageId)})`;
  const parts: string[] = [];

  if (summary.known === 0) {
    parts.push(`hub image unknown on all ${summary.total} node(s)`);
  } else if (summary.tie.length > 0) {
    const share = nodesOn(summary, summary.tie[0] as string).length;
    const contenders = summary.tie
      .map(
        (id) =>
          `${shortImageId(id)} (${nodesOn(summary, id)
            .map((n) => n.node)
            .join(', ')})`,
      )
      .join(' and ');
    parts.push(`hub image: no majority — split ${summary.tie.map(() => share).join('/')} of ${summary.total} between ${contenders}`);
    const others = summary.nodes.filter(
      (n): n is Extract<NodeImageState, { state: 'drifted' }> => n.state === 'drifted' && !summary.tie.includes(n.imageId),
    );
    if (others.length) parts.push(`also: ${others.map(label).join(', ')}`);
  } else if (summary.majority) {
    parts.push(`hub image ${shortImageId(summary.majority.imageId)} on ${summary.majority.count}/${summary.total}`);
    const drifted = summary.nodes.filter((n): n is Extract<NodeImageState, { state: 'drifted' }> => n.state === 'drifted');
    if (drifted.length) parts.push(`drifted: ${drifted.map(label).join(', ')}`);
  }
  if (unknown.length) parts.push(`unknown: ${unknown.map((n) => `${n.node} (${n.reason})`).join(', ')}`);
  return parts.join('; ');
}

/** `d5ff45d9 → 7370f6f3`, or the reason a side could not be read. */
export function renderImageTransition(before: HubImageProbe, after: HubImageProbe): string {
  const side = (p: HubImageProbe) => (p.kind === 'known' ? shortImageId(p.facts.imageId) : `? (${p.reason})`);
  if (before.kind === 'known' && after.kind === 'known' && before.facts.imageId === after.facts.imageId) {
    return `${side(before)} → ${side(after)} (unchanged)`;
  }
  return `${side(before)} → ${side(after)}`;
}
