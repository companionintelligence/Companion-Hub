import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// qa-stream.ts cannot be imported (its main body runs on load, and the file is copied to the nodes on its own), so this test
// extracts the one self-contained block between the markers, transpiles it, and runs it against real registry error text.
const source = readFileSync(join(import.meta.dirname, '..', 'qa-stream.ts'), 'utf-8');
const block = /\/\/ <registry-failure>([\s\S]*?)\/\/ <\/registry-failure>/.exec(source);
if (!block) throw new Error('the <registry-failure> block is missing from scripts/qa-stream.ts');
const js = ts.transpileModule(block[1], { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const { registryFailureSignals, headTail } = new Function(`${js}\nreturn { registryFailureSignals, headTail };`)() as {
  registryFailureSignals: (text: string) => { rateLimited: boolean; notFound: boolean; auth: boolean };
  headTail: (text: string, max?: number) => string;
};

const DIGEST_WITH_404 = 'sha256:b1e44f9e647e3e240400eafc914facafbfad2cc87d6c4f02d823226dd9731511'; // ksjaay/lunalytics:0.10.23: "…e3e2404 00ea…"
const DIGEST_WITH_429 = 'sha256:3a429b8c1d0e7f65a4b2c93d8e1f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f';

// The shapes below are the ones a 2026-10-20 full run on 10 nodes produced (compose) and the ones Docker documents (pull).
const COMPOSE_429 =
  'unexpected status from HEAD request to https://registry-1.docker.io/v2/kerrongordon/gibbon/manifests/sha256:1af30b99442dfcb3b05343d03e5665efb563cec4affb7db8a1aa75591be80575: 429 Too Many Requests\n' +
  `Error response from daemon: unknown: failed to resolve reference "docker.io/kerrongordon/gibbon:latest@sha256:1af30b99442dfcb3b05343d03e5665efb563cec4affb7db8a1aa75591be80575"`;
const PULL_429_TOKEN =
  'Command failed: docker pull ghost:latest@sha256:428ce627d581017a534d756eae5e8fa973052dd8ec5f5a0c6cd6a83ab85e94ca\n' +
  `Error response from daemon: unknown: failed to resolve reference "docker.io/library/ghost:latest@sha256:428ce627d581017a534d756eae5e8fa973052dd8ec5f5a0c6cd6a83ab85e94ca": ` +
  'failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://auth.docker.io/token?scope=repository%3Alibrary%2Fghost%3Apull&service=registry.docker.io: 429 Too Many Requests';
const PULL_TOOMANY =
  'Error response from daemon: toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading: https://www.docker.com/increase-rate-limit';

describe('registryFailureSignals', () => {
  it('reads a rate limit as a rate limit, however the daemon words it', () => {
    for (const text of [COMPOSE_429, PULL_429_TOKEN, PULL_TOOMANY]) {
      expect(registryFailureSignals(text).rateLimited, text.slice(0, 60)).toBe(true);
    }
  });

  it('a rate limit also contains "failed to authorize" and a digest, which is why the caller must check it first', () => {
    const s = registryFailureSignals(PULL_429_TOKEN);
    expect(s.rateLimited).toBe(true);
    expect(s.auth).toBe(true);
  });

  it('is not fooled by a digest that contains 404: that was lunalytics, an image that exists, scored a "broken marketplace entry"', () => {
    const text = `Command failed: docker pull ksjaay/lunalytics:0.10.23@${DIGEST_WITH_404}\nError response from daemon: Get "https://registry-1.docker.io/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`;
    expect(registryFailureSignals(text)).toEqual({ rateLimited: false, notFound: false, auth: false });
  });

  it('is not fooled by a digest that contains 429 either', () => {
    const text = `Command failed: docker pull x/y:1@${DIGEST_WITH_429}\nError response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: i/o timeout`;
    expect(registryFailureSignals(text).rateLimited).toBe(false);
  });

  it('still reads a missing image from the words registries use for it', () => {
    const forms = [
      'Error response from daemon: manifest for foo/bar:1.0 not found: manifest unknown: manifest unknown',
      `Error response from daemon: pull access denied for x/y, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`,
      'failed to resolve reference "ghcr.io/o/r:t": ghcr.io/o/r:t: not found',
      'Error response from daemon: unknown: name unknown: repository name not known to registry',
      'Error: no such image: x/y:1',
    ];
    for (const text of forms) expect(registryFailureSignals(text).notFound, text.slice(0, 70)).toBe(true);
  });

  it('still reads missing credentials', () => {
    expect(registryFailureSignals('Error response from daemon: Head "https://ghcr.io/v2/besoeasy/l-town/manifests/20260621": denied')).toEqual({
      rateLimited: false,
      notFound: false,
      auth: true,
    });
    expect(
      registryFailureSignals(
        'failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://ghcr.io/token?scope=x: 401 Unauthorized',
      ).auth,
    ).toBe(true);
  });

  it('says nothing for an ordinary failure', () => {
    expect(
      registryFailureSignals('Error response from daemon: driver failed programming external connectivity: bind: address already in use'),
    ).toEqual({ rateLimited: false, notFound: false, auth: false });
  });
});

describe('headTail', () => {
  it('leaves a short text alone (with whitespace collapsed)', () => {
    expect(headTail('a\n b   c', 50)).toBe('a b c');
  });

  it('keeps the END of a long text, where the HTTP status is', () => {
    const long = `${'x'.repeat(2500)} ${COMPOSE_429} ${'y'.repeat(10)}`;
    const cut = headTail(`${long}\nthe cause: 429 Too Many Requests`, 600);
    expect(cut.length).toBeLessThanOrEqual(620);
    expect(cut.endsWith('429 Too Many Requests')).toBe(true);
    expect(cut).toContain('[…]');
  });

  it('keeps a rate limit visible to the classifier even when the note is cut', () => {
    const notes = headTail(`${'z'.repeat(3000)}\n${COMPOSE_429}`, 600);
    expect(registryFailureSignals(notes).rateLimited).toBe(true);
  });
});

describe('qa-stream.ts uses it, in both places, and the loose regexes are gone', () => {
  it('no bare /404/ or generic "not found" test on a docker error remains', () => {
    expect(source).not.toMatch(/manifest unknown\|not found\|does not exist\|404/);
  });

  it('both the compose-up path and the single pull check the rate limit first and score it skip with failKind rate-limited', () => {
    const uses = [...source.matchAll(/registryFailureSignals\(/g)].length;
    expect(uses).toBe(3); // the definition and the two call sites
    expect([...source.matchAll(/failKind = 'rate-limited'/g)].length).toBe(2);
  });
});
