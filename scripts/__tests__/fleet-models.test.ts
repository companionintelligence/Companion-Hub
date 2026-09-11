/**
 * Per-node model lists for `cihub fleet update --models recommended`.
 *
 * The flat list drifted this fleet to 2–23 models per node and left one box with no embedder at
 * all. These tests pin the three things that stop that recurring: where a node's list comes from is
 * always named, the platform floor is always on it, and the two ways a Hub refuses a device key
 * (409 unclaimed vs 401 rejected) stay different findings.
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_REQUIRED_MODELS,
  describeHubRecommendationFailure,
  estimatedDownloadMb,
  hubRecommendationScript,
  normaliseModelTag,
  parseHubRecommendationOutput,
  planNodeModels,
  summarisePulls,
  withPlatformFloor,
} from '../lib/fleet-models.js';

/** What a claimed Strix Halo node actually answered on 2026-09-10, trimmed to the fields read. */
const PROFILE = {
  tier: 'high',
  hardware: { gpu: { vendor: 'amd', model: 'Radeon 8060S', vramMb: 124123, unifiedMemory: true }, ram: { totalMb: 124123 } },
  backends: { recommended: 'ollama' },
  recommendedModels: [
    { id: 'qwen3-6-35b', backend: 'ollama', backendModelId: 'qwen3.6:35b', modality: 'llm', requirements: { diskMb: 23142 } },
    { id: 'gemma4-26b', backend: 'ollama', backendModelId: 'gemma4:26b', modality: 'llm', requirements: { diskMb: 18432 } },
    { id: 'qwen3-5-9b', backend: 'ollama', backendModelId: 'qwen3.5:9b', modality: 'llm', requirements: { diskMb: 6758 } },
    {
      id: 'qwen3-coder-30b-lemonade',
      backend: 'lemonade',
      backendModelId: 'Qwen3-Coder-30B-A3B-Instruct-GGUF',
      modality: 'llm',
      requirements: { diskMb: 19046 },
    },
    { id: 'kokoro', backend: 'lemonade', backendModelId: 'kokoro-v1', modality: 'tts', requirements: { diskMb: 300 } },
    { id: 'nomic-embed-text', backend: 'ollama', backendModelId: 'nomic-embed-text', modality: 'embedding', requirements: { diskMb: 300 } },
  ],
  availableModels: [],
  installedCatalogIds: ['gemma4-26b', 'nomic-embed-text'],
};

function scriptOutput(status: number, body: unknown, keyPresent = true): string {
  return [
    `device-key=${keyPresent ? 'present' : 'missing'}`,
    `onboarding-http=${String(status).padStart(3, '0')}`,
    'onboarding-body-begin',
    typeof body === 'string' ? body : JSON.stringify(body),
    'onboarding-body-end',
  ].join('\n');
}

describe('hubRecommendationScript', () => {
  const script = hubRecommendationScript('/srv/hub');

  it('sends the device key as a Bearer header, which is the arm AuthMiddleware accepts', () => {
    // `x-api-key` is not read by the middleware; only `Authorization: Bearer <ciHubApiKey>` installs
    // the first operator as `req.user`, which is all `AuthGuard` checks.
    expect(script).toContain('-H "Authorization: Bearer $key"');
    expect(script).not.toContain('x-api-key');
    expect(script).toContain('/api/inference/onboarding-profile');
  });

  it('never echoes the key, and unsets it before printing anything', () => {
    expect(script).not.toMatch(/echo[^\n]*\$key/);
    expect(script.indexOf('unset key')).toBeLessThan(script.indexOf('echo "onboarding-http='));
    expect(script).toContain('echo "device-key=present"');
  });

  it('reads the key inside the ci-hub container first, then the host data dir it was given', () => {
    expect(script.indexOf('docker exec ci-hub')).toBeLessThan(script.indexOf('/srv/hub/state/settings.json'));
    expect(script).toContain("'/srv/hub/state/settings.json'");
  });

  it('still asks the Hub with no key, so "Hub down" and "no key" stay different findings', () => {
    expect(script).toMatch(/else\n\s+code="\$\(curl[^\n]*onboarding-profile/);
  });

  it('exits 0 regardless, so the caller judges the output rather than the exit status', () => {
    expect(script.trimEnd().endsWith('true')).toBe(true);
  });
});

describe('parseHubRecommendationOutput', () => {
  it('reads the Hub answer into Ollama tags only, best first, with presence from the live tag list', () => {
    const rec = parseHubRecommendationOutput(scriptOutput(200, PROFILE));
    expect(rec.kind).toBe('ok');
    if (rec.kind !== 'ok') return;
    expect(rec.models.map((m) => m.tag)).toEqual(['qwen3.6:35b', 'gemma4:26b', 'qwen3.5:9b', 'nomic-embed-text']);
    expect(rec.models.find((m) => m.tag === 'gemma4:26b')?.installed).toBe(true);
    expect(rec.models.find((m) => m.tag === 'qwen3.6:35b')?.installed).toBe(false);
    expect(rec.models.find((m) => m.tag === 'qwen3.6:35b')?.diskMb).toBe(23142);
    expect(rec.hardware).toContain('tier high');
    expect(rec.hardware).toContain('amd Radeon 8060S');
  });

  it('tells an unclaimed Hub (409) from a rejected key (401) — they need opposite fixes', () => {
    const unclaimed = parseHubRecommendationOutput(scriptOutput(409, { message: 'AUTH_ERROR_HUB_NOT_CLAIMED', statusCode: 409 }));
    const rejected = parseHubRecommendationOutput(scriptOutput(401, { message: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN', statusCode: 401 }));
    expect(unclaimed.kind).toBe('hub-unclaimed');
    expect(rejected.kind).toBe('unauthorized');
    if (unclaimed.kind === 'ok' || rejected.kind === 'ok') throw new Error('unreachable');
    expect(unclaimed.detail).toBe('AUTH_ERROR_HUB_NOT_CLAIMED');
    expect(rejected.detail).toBe('SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN');
    expect(describeHubRecommendationFailure(unclaimed).fix).toContain('cihub claim');
    expect(describeHubRecommendationFailure(unclaimed).reason).toContain('409');
    expect(describeHubRecommendationFailure(rejected).fix).toContain('cihub register');
    expect(describeHubRecommendationFailure(rejected).reason).toContain('401');
  });

  it('reports nothing listening as unreachable, not as an auth failure', () => {
    expect(parseHubRecommendationOutput(scriptOutput(0, '')).kind).toBe('hub-unreachable');
    expect(parseHubRecommendationOutput('').kind).toBe('hub-unreachable');
    // curl prints 000 itself on a refused connection; a script that also echoed 000 doubled it.
    const doubled = parseHubRecommendationOutput(scriptOutput(0, '').replace('onboarding-http=000', 'onboarding-http=000000'));
    expect(doubled.kind).toBe('hub-unreachable');
    expect(doubled.detail).toContain('127.0.0.1:5002');
  });

  it('does not append a second 000 to the status curl already printed', () => {
    expect(hubRecommendationScript()).not.toContain('|| echo 000');
    expect(hubRecommendationScript()).toContain('[ -n "$code" ] || code=000');
  });

  it('reports a missing key as its own finding when the Hub is plainly up', () => {
    const rec = parseHubRecommendationOutput(scriptOutput(401, { message: 'SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN' }, false));
    expect(rec.kind).toBe('no-device-key');
  });

  it('refuses a 200 that is not a profile rather than producing an empty list', () => {
    expect(parseHubRecommendationOutput(scriptOutput(200, '<html>traefik</html>')).kind).toBe('bad-response');
    expect(parseHubRecommendationOutput(scriptOutput(200, { hello: 'world' })).kind).toBe('bad-response');
  });

  it('survives a body that itself contains the marker words', () => {
    const rec = parseHubRecommendationOutput(scriptOutput(200, { ...PROFILE, note: 'onboarding-body-end' }));
    expect(rec.kind).toBe('ok');
  });
});

describe('withPlatformFloor', () => {
  it('appends the embedder CI-Server hard-requires, marked as a requirement', () => {
    const models = withPlatformFloor([{ tag: 'qwen3.5:9b' }]);
    expect(models.map((m) => m.tag)).toEqual(['qwen3.5:9b', ...PLATFORM_REQUIRED_MODELS]);
    expect(models[1]?.required).toBe(true);
    expect(models[0]?.required).toBeUndefined();
  });

  it('does not add a second copy when the list already has it, under either spelling', () => {
    expect(withPlatformFloor([{ tag: 'nomic-embed-text' }]).map((m) => m.tag)).toEqual(['nomic-embed-text']);
    const latest = withPlatformFloor([{ tag: 'nomic-embed-text:latest' }, { tag: 'llama3' }]);
    expect(latest.map((m) => m.tag)).toEqual(['nomic-embed-text:latest', 'llama3']);
    expect(latest[0]?.required).toBe(true);
  });

  it('dedupes the operator list itself', () => {
    expect(withPlatformFloor([{ tag: 'llama3' }, { tag: 'llama3:latest' }, { tag: ' ' }]).map((m) => m.tag)).toEqual(['llama3', 'nomic-embed-text']);
  });

  it('carries presence and size for the floor from the Hub when it knew', () => {
    const known = withPlatformFloor([], new Map([['nomic-embed-text', { installed: true, diskMb: 300 }]]))[0];
    expect(known?.installed).toBe(true);
    expect(known?.diskMb).toBe(300);
    // A Hub that answered but does not list the floor at all has, in effect, said it is absent.
    expect(withPlatformFloor([], new Map())[0]?.installed).toBe(false);
    expect(withPlatformFloor([])[0]?.installed).toBeUndefined();
  });

  it('compares tags on the stripped form', () => {
    expect(normaliseModelTag('a:latest')).toBe('a');
    expect(normaliseModelTag(' qwen3.5:9b ')).toBe('qwen3.5:9b');
  });
});

describe('planNodeModels — provenance', () => {
  it('names the operator as the source for an explicit list and does not consult the Hub', () => {
    const rejected = parseHubRecommendationOutput(scriptOutput(401, {}));
    const plan = planNodeModels('core-1', { kind: 'explicit', models: ['llama3'] }, rejected);
    expect(plan.provenance).toBe('explicit');
    expect(plan.reason).toBeUndefined();
    expect(plan.models.map((m) => m.tag)).toEqual(['llama3', 'nomic-embed-text']);
  });

  it("names the node's Hub as the source when it answered", () => {
    const plan = planNodeModels('core-1', { kind: 'recommended' }, parseHubRecommendationOutput(scriptOutput(200, PROFILE)));
    expect(plan.provenance).toBe('hub-recommended');
    expect(plan.hardware).toContain('tier high');
    expect(plan.models.map((m) => m.tag)).toEqual(['qwen3.6:35b', 'gemma4:26b', 'qwen3.5:9b', 'nomic-embed-text']);
    expect(plan.models.at(-1)?.required).toBe(true);
    expect(plan.models.at(-1)?.installed).toBe(true);
  });

  it('falls back to the floor with the reason when the Hub is unreachable — never an empty list', () => {
    const plan = planNodeModels('core-1', { kind: 'recommended' }, { kind: 'hub-unreachable', detail: 'nothing answered on 127.0.0.1:5002' });
    expect(plan.provenance).toBe('floor-only');
    expect(plan.models.map((m) => m.tag)).toEqual([...PLATFORM_REQUIRED_MODELS]);
    expect(plan.reason).toContain('did not answer');
    expect(plan.fix).toBeTruthy();
  });

  it('falls back the same way when no recommendation was fetched at all', () => {
    const plan = planNodeModels('core-1', { kind: 'recommended' });
    expect(plan.provenance).toBe('floor-only');
    expect(plan.models.length).toBeGreaterThan(0);
  });

  it('keeps 409 and 401 distinct all the way into the plan', () => {
    const unclaimed = planNodeModels('a', { kind: 'recommended' }, { kind: 'hub-unclaimed', httpStatus: 409 });
    const rejected = planNodeModels('b', { kind: 'recommended' }, { kind: 'unauthorized', httpStatus: 401 });
    expect(unclaimed.reason).toContain('no operator');
    expect(rejected.reason).toContain('rejected the device key');
    expect(unclaimed.fix).not.toEqual(rejected.fix);
  });
});

describe('estimates and tallies', () => {
  it('prices only what would actually be fetched', () => {
    const plan = planNodeModels('core-1', { kind: 'recommended' }, parseHubRecommendationOutput(scriptOutput(200, PROFILE)));
    // gemma4:26b and nomic-embed-text are present; the other two are not.
    expect(estimatedDownloadMb(plan)).toBe(23142 + 6758);
  });

  it('gives no estimate when nothing was priced', () => {
    expect(estimatedDownloadMb(planNodeModels('x', { kind: 'explicit', models: ['llama3'] }))).toBeUndefined();
  });

  it('tallies pulled, present and failed separately', () => {
    expect(
      summarisePulls([
        { tag: 'a', outcome: 'pulled' },
        { tag: 'b', outcome: 'already-present' },
        { tag: 'c', outcome: 'failed' },
        { tag: 'd', outcome: 'failed' },
      ]),
    ).toEqual({ pulled: 1, present: 1, failed: 2 });
  });
});
