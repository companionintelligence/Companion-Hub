/**
 * Which Hub build each node runs, and whether the fleet agrees.
 *
 * The scenario every case here is drawn from was measured on 2026-09-10: eighteen nodes all running
 * `ci-hub:dev`, `docker ps` identical everywhere, and `docker image inspect --format '{{.Id}}'`
 * showing twelve on one image, two on a second, one each on a third and fourth — with two of the
 * outliers changing during the evening and nothing recording it. The tests pin down what the tool
 * must say about that fleet, and what it must refuse to do to it.
 */

import { describe, expect, it } from 'vitest';
import {
  HUB_IMAGE_REPO,
  hubImageFacts,
  hubImageProbeScript,
  imageMatchesPin,
  parseContainerInspect,
  parseHubImageProbe,
  parseImageInspect,
  parsePinDigest,
  renderImageCell,
  renderImageFooter,
  renderImageTransition,
  resolveMajorityPin,
  shortImageId,
  summariseFleetImages,
  type HubImageProbe,
} from '../lib/fleet-image.js';

/** A full 64-hex image ID from the short prefix an operator would recognise. */
const id = (prefix: string) => `sha256:${prefix.padEnd(64, '0')}`;
const digestOf = (prefix: string) => `${HUB_IMAGE_REPO}@sha256:${`d16e57${prefix}`.padEnd(64, 'a')}`;
const DEV_TAG = `${HUB_IMAGE_REPO}:dev`;

/** What the probe script prints on a node that has a Hub. Shape taken from a real engine's output. */
function probeOutput(imageId: string, repoDigest: string | null, tag = DEV_TAG): string {
  return [
    'image-probe: container=ci-hub',
    `image-probe-container: ${JSON.stringify({ Name: '/ci-hub', Image: imageId, State: { Status: 'running' }, Config: { Image: tag } })}`,
    `image-probe-image: ${JSON.stringify({
      Id: imageId,
      RepoTags: [tag],
      RepoDigests: repoDigest ? [repoDigest] : [],
      Created: '2026-09-08T14:03:11.269437550Z',
    })}`,
    'image-probe: complete',
  ].join('\n');
}

const known = (prefix: string, repoDigest: string | null = digestOf(prefix)): HubImageProbe =>
  parseHubImageProbe({ ok: true, out: probeOutput(id(prefix), repoDigest), err: '', code: 0 });
const unknown = (reason: string): HubImageProbe => ({ kind: 'unknown', reason });

/**
 * The fleet as measured. Twelve on d5ff45d9, core-3 and core-6 on 9a38714f, core-14 on 7370f6f3,
 * beta-1 on 8483e34f, and two nodes that could not be read.
 */
function measuredFleet(): { node: string; probe: HubImageProbe }[] {
  const nodes: { node: string; probe: HubImageProbe }[] = [];
  for (const n of [1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15]) nodes.push({ node: `core-${n}`, probe: known('d5ff45d90203') });
  nodes.push({ node: 'core-3', probe: known('9a38714ff31a') });
  nodes.push({ node: 'core-6', probe: known('9a38714ff31a') });
  nodes.push({ node: 'core-14', probe: known('7370f6f35ab7') });
  nodes.push({ node: 'beta-1', probe: known('8483e34f0de7') });
  nodes.push({ node: 'core-17', probe: unknown('unreachable') });
  nodes.push({ node: 'core-18', probe: unknown('no ci-hub container') });
  return nodes;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** The full document `docker container inspect ci-hub` prints, abridged only in the blocks this module never reads. */
const FULL_CONTAINER_INSPECT = JSON.stringify([
  {
    Id: '3f9b1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
    Created: '2026-09-08T16:20:01.123456789Z',
    Path: 'docker-entrypoint.sh',
    Args: ['node', 'dist/main.js'],
    State: { Status: 'running', Running: true, Paused: false, Restarting: false, Pid: 41231, ExitCode: 0, StartedAt: '2026-09-08T16:20:02.5Z' },
    Image: id('d5ff45d90203'),
    Name: '/ci-hub',
    RestartCount: 0,
    HostConfig: { NetworkMode: 'ci-hub_default', RestartPolicy: { Name: 'unless-stopped' } },
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }],
    Config: {
      Hostname: '3f9b1c2d4e5f',
      Env: ['API_PORT=5002', 'POSTGRES_PASSWORD=never-printed', 'CI_HUB_VERSION=0.2.71'],
      Image: DEV_TAG,
      Labels: { 'com.docker.compose.project': 'ci-hub', 'com.docker.compose.service': 'ci-hub', 'org.opencontainers.image.revision': 'abcd38ec4' },
    },
    NetworkSettings: { Networks: { 'ci-hub_default': { IPAddress: '172.19.0.4' } } },
  },
]);

const FULL_IMAGE_INSPECT = JSON.stringify([
  {
    Id: id('d5ff45d90203'),
    RepoTags: [DEV_TAG, `${HUB_IMAGE_REPO}:0.2.71`],
    RepoDigests: [digestOf('d5ff45d90203')],
    Parent: '',
    Comment: 'buildkit.dockerfile.v0',
    Created: '2026-09-08T14:03:11.269437550Z',
    Config: { Env: ['NODE_ENV=production'], Cmd: ['node', 'dist/main.js'], Labels: { 'org.opencontainers.image.revision': 'abcd38ec4' } },
    Architecture: 'amd64',
    Os: 'linux',
    Size: 521_338_112,
    RootFS: { Type: 'layers', Layers: ['sha256:aaa', 'sha256:bbb'] },
    Metadata: { LastTagTime: '2026-09-08T14:03:12Z' },
  },
]);

describe('parseContainerInspect', () => {
  it('reads the four fields from the full document Docker prints', () => {
    expect(parseContainerInspect(FULL_CONTAINER_INSPECT)).toEqual({
      name: 'ci-hub',
      imageId: id('d5ff45d90203'),
      imageRef: DEV_TAG,
      status: 'running',
    });
  });

  it('reads the same fields from the trimmed object the probe script emits', () => {
    const trimmed =
      '{"Name":"/ci-hub","Image":"sha256:156f0b253fd61366d5fc2107ad45955027d5612f695a8436ce20167f3fa79bff","State":{"Status":"exited"},"Config":{"Image":"ghcr.io/companionintelligence/ci-hub@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}';
    const parsed = parseContainerInspect(trimmed);
    expect(parsed?.status).toBe('exited');
    // A pinned node's container reference IS the digest — that is how a pin becomes visible in status.
    expect(parsed?.imageRef).toMatch(/^ghcr\.io\/companionintelligence\/ci-hub@sha256:/);
  });

  it('returns null for garbage, an empty array, or a document with no image ID', () => {
    expect(parseContainerInspect('')).toBeNull();
    expect(parseContainerInspect('Error response from daemon: No such container: ci-hub')).toBeNull();
    expect(parseContainerInspect('[]')).toBeNull();
    expect(parseContainerInspect('{"Name":"/ci-hub"}')).toBeNull();
  });

  it('treats <no value> as absent rather than as a reference', () => {
    // Older daemons render a missing template field as the literal `<no value>`.
    const parsed = parseContainerInspect('{"Name":"/ci-hub","Image":"sha256:abc","State":{"Status":"running"},"Config":{"Image":"<no value>"}}');
    expect(parsed?.imageRef).toBeNull();
  });
});

describe('parseImageInspect', () => {
  it('reads ID, tags, digests and creation time from the full document', () => {
    expect(parseImageInspect(FULL_IMAGE_INSPECT)).toEqual({
      imageId: id('d5ff45d90203'),
      repoDigests: [digestOf('d5ff45d90203')],
      repoTags: [DEV_TAG, `${HUB_IMAGE_REPO}:0.2.71`],
      created: '2026-09-08T14:03:11.269437550Z',
    });
  });

  it('gives a locally built image an empty digest list, not a fabricated one', () => {
    const parsed = parseImageInspect(
      JSON.stringify({ Id: id('0badbeef'), RepoTags: ['ci-hub:local'], RepoDigests: [], Created: '2026-09-01T00:00:00Z' }),
    );
    expect(parsed?.repoDigests).toEqual([]);
    expect(
      hubImageFacts({ name: 'ci-hub', imageId: id('0badbeef'), imageRef: 'ci-hub:local', status: 'running' }, parsed as NonNullable<typeof parsed>)
        .repoDigest,
    ).toBeNull();
  });

  it('returns null without an Id', () => {
    expect(parseImageInspect('{"RepoTags":["x:y"]}')).toBeNull();
    expect(parseImageInspect('not json')).toBeNull();
  });
});

describe('hubImageFacts', () => {
  it("prefers the container's own reference for the tag, since that is what compose asked for", () => {
    const container = parseContainerInspect(FULL_CONTAINER_INSPECT) as NonNullable<ReturnType<typeof parseContainerInspect>>;
    const image = parseImageInspect(FULL_IMAGE_INSPECT) as NonNullable<ReturnType<typeof parseImageInspect>>;
    expect(hubImageFacts(container, image).tag).toBe(DEV_TAG);
    expect(hubImageFacts({ ...container, imageRef: null }, image).tag).toBe(DEV_TAG);
    expect(hubImageFacts({ ...container, imageRef: null }, { ...image, repoTags: [] }).tag).toBeNull();
  });
});

// ─── The probe script and its output ────────────────────────────────────────

describe('hubImageProbeScript', () => {
  const script = hubImageProbeScript();

  it('looks for the Hub under both names it has run as', () => {
    expect(script).toContain('for name in ci-hub ci-os-hub; do');
  });

  it('reads through --format and never dumps the raw container document', () => {
    // The raw document carries Config.Env, where every secret on the node lives.
    expect(script).not.toMatch(/docker (container )?inspect "\$c"\s*$/m);
    expect(script).not.toMatch(/docker (container )?inspect "\$c"\s*\|/);
    expect(script).toContain('--format');
    expect(script).not.toContain('.Config.Env');
  });

  it('exits 0 with a named marker for every way a node can have no answer', () => {
    // A probe that dies on a node without Docker is indistinguishable from one that could not connect.
    expect(script).toContain('docker=missing"; exit 0');
    expect(script).toContain('docker=daemon-unreachable"; exit 0');
    expect(script).toContain('container=absent"; exit 0');
    expect(script).toContain('image-probe: complete');
  });
});

describe('parseHubImageProbe', () => {
  it('parses the output a real node produces', () => {
    const probe = parseHubImageProbe({ ok: true, out: probeOutput(id('d5ff45d90203'), digestOf('d5ff45d90203')), err: '', code: 0 });
    expect(probe.kind).toBe('known');
    if (probe.kind !== 'known') return;
    expect(probe.facts).toEqual({
      container: 'ci-hub',
      containerStatus: 'running',
      imageId: id('d5ff45d90203'),
      repoDigest: digestOf('d5ff45d90203'),
      tag: DEV_TAG,
      created: '2026-09-08T14:03:11.269437550Z',
    });
  });

  it('ignores login-shell noise around the markers', () => {
    const noisy = `Welcome to Ubuntu\n${probeOutput(id('d5ff45d90203'), digestOf('d5ff45d90203'))}\nbash: warning: something`;
    expect(parseHubImageProbe({ ok: true, out: noisy, err: '', code: 0 }).kind).toBe('known');
  });

  it('reports a node with no ci-hub container as unknown, with that reason', () => {
    // Not "same": a node with no Hub is not running the fleet's build. Not "drifted": it is not
    // running a different one either.
    expect(parseHubImageProbe({ ok: true, out: 'image-probe: container=absent', err: '', code: 0 })).toEqual({
      kind: 'unknown',
      reason: 'no ci-hub container',
    });
  });

  it('tells docker-missing and daemon-down apart, since they need different hands', () => {
    expect(parseHubImageProbe({ ok: true, out: 'image-probe: docker=missing', err: '', code: 0 })).toEqual({
      kind: 'unknown',
      reason: 'docker missing',
    });
    expect(parseHubImageProbe({ ok: true, out: 'image-probe: docker=daemon-unreachable', err: '', code: 0 })).toEqual({
      kind: 'unknown',
      reason: 'docker daemon unreachable',
    });
  });

  it('names the SSH failure when nothing of ours came back', () => {
    expect(parseHubImageProbe({ ok: false, out: '', err: 'ssh: connect to host 100.64.0.9 port 22: No route to host', code: 255 })).toEqual({
      kind: 'unknown',
      reason: 'unreachable',
    });
    expect(parseHubImageProbe({ ok: false, out: '', err: 'tailnet policy does not permit you to SSH to this node', code: 255 })).toEqual({
      kind: 'unknown',
      reason: 'acl-denied',
    });
    expect(parseHubImageProbe({ ok: false, out: '', err: '\nTimed out after 30000ms', code: null })).toEqual({ kind: 'unknown', reason: 'timeout' });
  });

  it('reports truncated output as unknown rather than trusting half a probe', () => {
    const cut = probeOutput(id('d5ff45d90203'), digestOf('d5ff45d90203')).split('\n').slice(0, 2).join('\n');
    expect(parseHubImageProbe({ ok: true, out: cut, err: '', code: 0 })).toEqual({ kind: 'unknown', reason: 'probe output truncated' });
  });

  it('reports unparsable inspect JSON as unknown', () => {
    const bad = ['image-probe: container=ci-hub', 'image-probe-container: {not json', 'image-probe-image: {"Id":"x"}', 'image-probe: complete'].join(
      '\n',
    );
    expect(parseHubImageProbe({ ok: true, out: bad, err: '', code: 0 })).toEqual({ kind: 'unknown', reason: 'inspect output unparsable' });
  });

  it('reports a successful command that printed no markers as unknown', () => {
    expect(parseHubImageProbe({ ok: true, out: 'hub-update-complete', err: '', code: 0 })).toEqual({
      kind: 'unknown',
      reason: 'probe returned no image data',
    });
  });
});

// ─── Majority and drift ─────────────────────────────────────────────────────

describe('summariseFleetImages', () => {
  it('finds the majority on the measured fleet and labels every node', () => {
    const summary = summariseFleetImages(measuredFleet());
    expect(summary.total).toBe(18);
    expect(summary.known).toBe(16);
    expect(summary.majority).toEqual({ imageId: id('d5ff45d90203'), count: 12, repoDigest: digestOf('d5ff45d90203'), strict: true });
    expect(summary.tie).toEqual([]);

    const byState = (state: string) => summary.nodes.filter((n) => n.state === state).map((n) => n.node);
    expect(byState('same')).toHaveLength(12);
    expect(byState('drifted')).toEqual(['core-3', 'core-6', 'core-14', 'beta-1']);
    expect(byState('unknown')).toEqual(['core-17', 'core-18']);
  });

  it('keeps unknown nodes out of both counts but in the denominator', () => {
    // Three nodes agree and five could not be read. That is not a fleet on one build; it is a fleet
    // where most of the machines are unaccounted for.
    const summary = summariseFleetImages([
      { node: 'a', probe: known('d5ff45d90203') },
      { node: 'b', probe: known('d5ff45d90203') },
      { node: 'c', probe: known('d5ff45d90203') },
      ...['d', 'e', 'f', 'g', 'h'].map((node) => ({ node, probe: unknown('unreachable') })),
    ]);
    expect(summary.majority?.count).toBe(3);
    expect(summary.majority?.strict).toBe(false);
    expect(summary.nodes.filter((n) => n.state === 'same')).toHaveLength(3);
    expect(summary.nodes.filter((n) => n.state === 'drifted')).toHaveLength(0);
    expect(summary.nodes.filter((n) => n.state === 'unknown')).toHaveLength(5);
  });

  it('declares a tie rather than picking a side, and calls nothing same', () => {
    const summary = summariseFleetImages([
      { node: 'a', probe: known('9a38714ff31a') },
      { node: 'b', probe: known('d5ff45d90203') },
      { node: 'c', probe: known('9a38714ff31a') },
      { node: 'd', probe: known('d5ff45d90203') },
      { node: 'e', probe: unknown('timeout') },
    ]);
    expect(summary.majority).toBeNull();
    expect(summary.tie).toEqual([id('9a38714ff31a'), id('d5ff45d90203')]);
    expect(summary.nodes.map((n) => n.state)).toEqual(['drifted', 'drifted', 'drifted', 'drifted', 'unknown']);
  });

  it('calls two tied leaders a tie even when a third image trails them', () => {
    const summary = summariseFleetImages([
      { node: 'a', probe: known('aaaa') },
      { node: 'b', probe: known('aaaa') },
      { node: 'c', probe: known('bbbb') },
      { node: 'd', probe: known('bbbb') },
      { node: 'e', probe: known('cccc') },
    ]);
    expect(summary.majority).toBeNull();
    expect(summary.tie).toHaveLength(2);
  });

  it('exactly half is not a strict majority', () => {
    const summary = summariseFleetImages([
      { node: 'a', probe: known('aaaa') },
      { node: 'b', probe: known('aaaa') },
      { node: 'c', probe: known('bbbb') },
      { node: 'd', probe: unknown('unreachable') },
    ]);
    expect(summary.majority?.count).toBe(2);
    expect(summary.majority?.strict).toBe(false);
  });

  it('handles an empty fleet and a fleet nobody could read', () => {
    expect(summariseFleetImages([])).toEqual({ nodes: [], total: 0, known: 0, majority: null, tie: [] });
    const dark = summariseFleetImages([{ node: 'a', probe: unknown('acl-denied') }]);
    expect(dark.majority).toBeNull();
    expect(dark.known).toBe(0);
    expect(dark.nodes[0]?.state).toBe('unknown');
  });

  it('takes the majority digest from whichever holder has one', () => {
    // The first majority node was built locally; the second was pulled. The pin must come from the second.
    const summary = summariseFleetImages([
      { node: 'a', probe: known('aaaa', null) },
      { node: 'b', probe: known('aaaa') },
      { node: 'c', probe: known('aaaa') },
    ]);
    expect(summary.majority?.repoDigest).toBe(digestOf('aaaa'));
  });
});

describe('resolveMajorityPin', () => {
  it('pins to the majority digest on the measured fleet', () => {
    const resolved = resolveMajorityPin(summariseFleetImages(measuredFleet()));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.ref).toBe(digestOf('d5ff45d90203'));
    expect(resolved.majority?.count).toBe(12);
  });

  it('refuses when the most common image is on half the fleet or less, and says the numbers', () => {
    const summary = summariseFleetImages([
      { node: 'core-1', probe: known('9a38714ff31a') },
      { node: 'core-2', probe: known('9a38714ff31a') },
      { node: 'core-3', probe: known('9a38714ff31a') },
      { node: 'core-4', probe: known('d5ff45d90203') },
      { node: 'core-5', probe: known('7370f6f35ab7') },
      { node: 'core-6', probe: unknown('unreachable') },
      { node: 'core-7', probe: unknown('unreachable') },
    ]);
    const resolved = resolveMajorityPin(summary);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.why).toContain('9a38714f');
    expect(resolved.why).toContain('3 of 7 nodes (43%)');
    expect(resolved.why).toContain('not a strict majority');
    expect(resolved.why).toContain('2 node(s) could not be read');
    expect(resolved.why).toContain('--pin-digest');
  });

  it('refuses at exactly 50%', () => {
    const summary = summariseFleetImages([
      { node: 'a', probe: known('aaaa') },
      { node: 'b', probe: known('aaaa') },
      { node: 'c', probe: known('bbbb') },
      { node: 'd', probe: unknown('unreachable') },
    ]);
    const resolved = resolveMajorityPin(summary);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.why).toContain('2 of 4 nodes (50%)');
  });

  it('refuses a tie and names both contenders', () => {
    const resolved = resolveMajorityPin(
      summariseFleetImages([
        { node: 'a', probe: known('9a38714ff31a') },
        { node: 'b', probe: known('d5ff45d90203') },
      ]),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.why).toMatch(/split 1\/1 of 2 between 9a38714f and d5ff45d9/);
  });

  it('refuses when no node could be read', () => {
    const resolved = resolveMajorityPin(summariseFleetImages([{ node: 'a', probe: unknown('unreachable') }]));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.why).toContain('no majority to pin to');
  });

  it('refuses a majority image that has no registry digest, since nothing else can pull it', () => {
    const resolved = resolveMajorityPin(
      summariseFleetImages([
        { node: 'a', probe: known('0badbeef', null) },
        { node: 'b', probe: known('0badbeef', null) },
        { node: 'c', probe: known('d5ff45d90203') },
      ]),
    );
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.why).toContain('built locally');
  });
});

// ─── Pinning by hand ────────────────────────────────────────────────────────

describe('parsePinDigest', () => {
  const sha = `sha256:${'f'.repeat(64)}`;

  it('accepts repo@sha256 and passes it through', () => {
    expect(parsePinDigest(`${HUB_IMAGE_REPO}@${sha}`)).toEqual({ ok: true, ref: `${HUB_IMAGE_REPO}@${sha}` });
  });

  it('completes a bare digest against the Hub image repo', () => {
    expect(parsePinDigest(sha)).toEqual({ ok: true, ref: `${HUB_IMAGE_REPO}@${sha}` });
  });

  it('refuses a tag, which is the mutable thing this flag exists to escape', () => {
    const result = parsePinDigest(`${HUB_IMAGE_REPO}:v0.2.70`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain('mutable');
  });

  it('refuses a short or malformed digest', () => {
    expect(parsePinDigest(`${HUB_IMAGE_REPO}@sha256:d5ff45d9`).ok).toBe(false);
    expect(parsePinDigest(`${HUB_IMAGE_REPO}@md5:${'a'.repeat(32)}`).ok).toBe(false);
    expect(parsePinDigest('d5ff45d90203').ok).toBe(false);
    expect(parsePinDigest('').ok).toBe(false);
  });
});

describe('imageMatchesPin', () => {
  const facts = { container: 'ci-hub', containerStatus: 'running', imageId: id('aaaa'), repoDigest: digestOf('aaaa'), tag: DEV_TAG, created: null };
  it('matches on the digest half, so a mirror of the same manifest counts', () => {
    expect(imageMatchesPin(facts, digestOf('aaaa'))).toBe(true);
    expect(imageMatchesPin(facts, digestOf('aaaa').replace(HUB_IMAGE_REPO, 'mirror.example/ci-hub'))).toBe(true);
  });
  it('does not match a different digest or an image with none', () => {
    expect(imageMatchesPin(facts, digestOf('bbbb'))).toBe(false);
    expect(imageMatchesPin({ ...facts, repoDigest: null }, digestOf('aaaa'))).toBe(false);
  });
});

// ─── Rendering ──────────────────────────────────────────────────────────────

describe('rendering', () => {
  it('shortens an image ID to eight hex characters, with or without the prefix', () => {
    expect(shortImageId(id('d5ff45d90203'))).toBe('d5ff45d9');
    expect(shortImageId('9a38714ff31a')).toBe('9a38714f');
  });

  it('renders the footer for the measured fleet exactly', () => {
    expect(renderImageFooter(summariseFleetImages(measuredFleet()))).toBe(
      'hub image d5ff45d9 on 12/18; drifted: core-3 (9a38714f), core-6 (9a38714f), core-14 (7370f6f3), beta-1 (8483e34f); unknown: core-17 (unreachable), core-18 (no ci-hub container)',
    );
  });

  it('renders a converged fleet without a drifted clause', () => {
    const footer = renderImageFooter(
      summariseFleetImages([
        { node: 'a', probe: known('aaaa') },
        { node: 'b', probe: known('aaaa') },
      ]),
    );
    expect(footer).toBe('hub image aaaa0000 on 2/2');
  });

  it('renders a tie with both sides named and any trailing image listed separately', () => {
    const footer = renderImageFooter(
      summariseFleetImages([
        { node: 'a', probe: known('9a38714ff31a') },
        { node: 'b', probe: known('d5ff45d90203') },
        { node: 'c', probe: known('9a38714ff31a') },
        { node: 'd', probe: known('d5ff45d90203') },
        { node: 'e', probe: known('7370f6f35ab7') },
        { node: 'f', probe: unknown('unreachable') },
      ]),
    );
    expect(footer).toBe(
      'hub image: no majority — split 2/2 of 6 between 9a38714f (a, c) and d5ff45d9 (b, d); also: e (7370f6f3); unknown: f (unreachable)',
    );
  });

  it('renders a three-way tie as one', () => {
    const footer = renderImageFooter(
      summariseFleetImages([
        { node: 'a', probe: known('9a38714ff31a') },
        { node: 'b', probe: known('d5ff45d90203') },
        { node: 'c', probe: known('7370f6f35ab7') },
      ]),
    );
    expect(footer).toBe('hub image: no majority — split 1/1/1 of 3 between 7370f6f3 (c) and 9a38714f (a) and d5ff45d9 (b)');
  });

  it('renders a fleet nobody could read as exactly that', () => {
    const footer = renderImageFooter(
      summariseFleetImages([
        { node: 'a', probe: unknown('acl-denied') },
        { node: 'b', probe: unknown('docker missing') },
      ]),
    );
    expect(footer).toBe('hub image unknown on all 2 node(s); unknown: a (acl-denied), b (docker missing)');
  });

  it('renders the table cell as the short id, or ? when unknown', () => {
    const summary = summariseFleetImages([
      { node: 'a', probe: known('d5ff45d90203') },
      { node: 'b', probe: unknown('unreachable') },
    ]);
    expect(summary.nodes.map(renderImageCell)).toEqual(['d5ff45d9', '?']);
  });

  it('renders a before→after transition, marking the unchanged case and naming an unreadable side', () => {
    expect(renderImageTransition(known('d5ff45d90203'), known('7370f6f35ab7'))).toBe('d5ff45d9 → 7370f6f3');
    expect(renderImageTransition(known('d5ff45d90203'), known('d5ff45d90203'))).toBe('d5ff45d9 → d5ff45d9 (unchanged)');
    expect(renderImageTransition(unknown('no ci-hub container'), known('d5ff45d90203'))).toBe('? (no ci-hub container) → d5ff45d9');
    expect(renderImageTransition(known('d5ff45d90203'), unknown('timeout'))).toBe('d5ff45d9 → ? (timeout)');
  });
});
