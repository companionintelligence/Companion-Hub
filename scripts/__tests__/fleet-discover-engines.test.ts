import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeNode } from '../lib/fleet-discover.js';

/**
 * The engine probe names what answered. It must only name engines the Hub can front today
 * (ollama, vllm, lemonade, omlx), and must not read a listener on port 8080 as an engine: 8080 is
 * Traefik's dashboard port on every appliance (`docker-compose.prod.yml` publishes it), and the
 * `dspark` engine that once owned the label was retired. Nothing here touches the network; `fetch`
 * is replaced and every URL it is asked for is recorded.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function answerEverything() {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      asked.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return asked;
}

describe('probeNode engine probes', () => {
  it('does not report a retired engine, nor probe the Traefik dashboard port as one', async () => {
    const asked = answerEverything();

    const probe = await probeNode({ name: 'n', ip: '192.0.2.10' } as never, { skipSsh: true, timeoutMs: 200 });

    expect(probe.engines.length).toBeGreaterThan(0);
    expect(probe.engines.filter((e) => /dspark|mtplx/.test(e))).toEqual([]);
    expect(probe.engines.filter((e) => e.endsWith(':8080'))).toEqual([]);
    expect(asked.filter((u) => u.includes(':8080/'))).toEqual([]);
  });

  it('still reports the engines the Hub can front', async () => {
    answerEverything();

    const probe = await probeNode({ name: 'n', ip: '192.0.2.10' } as never, { skipSsh: true, timeoutMs: 200 });

    expect(probe.engines).toEqual(expect.arrayContaining(['ollama:11434', 'lemonade:13305', 'openai-compatible:8000']));
  });
});
