import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { CloudProviderConfig } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { CloudFallbackService } from '../cloud-fallback.service';
import { abortWhenClientCloses, CLIENT_CLOSED_MESSAGE, postStreamUnderHeaderDeadline, relayStream } from '../upstream-stream';

/**
 * What happens to the upstream request when the client it was made for goes away, over real sockets
 * at every hop: a fake upstream, a stand-in for the Hub's controller, and a client that hangs up.
 * Real on purpose. The defect this pins lives in how axios, `pipe` and Node's HTTP stack tear a
 * connection down, which no mocked `axios.post` can show: with `pipe` and no signal, an upstream whose
 * client left after one frame was still connected seconds later.
 */

/** Long enough that a pass cannot be the header deadline doing the work. */
const BUDGET_MS = 60_000;
/** How long a teardown gets to reach the other end. It takes milliseconds; this only bounds a failure. */
const TEARDOWN_MS = 3_000;

const OPENAI_FRAME = 'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';
const ANTHROPIC_FRAME = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';

type UpstreamBehaviour =
  /** Reads the request and never answers: an engine still reading a long prompt, a provider still thinking. */
  | 'silent'
  /** Answers 200 and one frame, then holds the stream open: a generation in progress. */
  | 'one-frame'
  /** Answers 200 and one frame, then drops the connection: an engine that died mid-generation. */
  | 'one-frame-then-drop';

interface FakeUpstream {
  url: string;
  /** Resolves when the upstream's end of each connection closes, in arrival order. */
  closed: Array<Promise<void>>;
  /** Resolves when the first request has arrived. */
  arrived: Promise<void>;
}

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startUpstream(behaviour: UpstreamBehaviour, frame = OPENAI_FRAME): Promise<FakeUpstream> {
  const closed: Array<Promise<void>> = [];
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const server = http.createServer((req, res) => {
    closed.push(new Promise<void>((resolve) => req.socket.once('close', () => resolve())));
    req.resume();
    req.on('end', () => {
      arrive();
      if (behaviour === 'silent') return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frame);
      if (behaviour === 'one-frame-then-drop') {
        setTimeout(() => req.socket.destroy(), 50);
      }
    });
  });
  return { url: await listen(server), closed, arrived };
}

/** A stand-in for the controller: `handle` gets each request's response, as a `@Res()` handler does. */
async function startHub(handle: (res: http.ServerResponse) => Promise<void>): Promise<string> {
  return listen(
    http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        void handle(res);
      });
    }),
  );
}

/** A client that posts, can read the first chunk of the answer, and can hang up at any point. */
function connect(url: string): { firstChunk: Promise<string>; ended: Promise<{ complete: boolean }>; hangUp: () => void } {
  let resolveFirst!: (chunk: string) => void;
  let resolveEnded!: (outcome: { complete: boolean }) => void;
  const firstChunk = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  const ended = new Promise<{ complete: boolean }>((resolve) => {
    resolveEnded = resolve;
  });
  const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    res.once('data', (chunk: Buffer) => resolveFirst(chunk.toString()));
    res.on('close', () => resolveEnded({ complete: res.complete }));
    res.resume();
  });
  // A hang-up before the answer surfaces here as "socket hang up"; that is the point of it.
  req.on('error', () => undefined);
  req.end('{}');
  return { firstChunk, ended, hangUp: () => req.destroy() };
}

async function within<T>(promise: Promise<T> | undefined, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise ?? Promise.reject(new Error(`${what}: nothing to wait on`)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('postStreamUnderHeaderDeadline with a client-closed signal', () => {
  it('releases the upstream connection when the client hangs up mid-stream — the signal alone, even through a bare pipe()', async () => {
    const upstream = await startUpstream('one-frame');
    const hub = await startHub(async (res) => {
      const response = await postStreamUnderHeaderDeadline(
        upstream.url,
        {},
        {},
        { budgetMs: BUDGET_MS, upstream: 'ollama' },
        abortWhenClientCloses(res),
      );
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Deliberately the old relay, which never destroys its source: this test is about the signal.
      response.data.pipe(res);
    });

    const client = connect(hub);
    await expect(within(client.firstChunk, TEARDOWN_MS, 'the first frame')).resolves.toBe(OPENAI_FRAME);
    client.hangUp();

    await within(upstream.closed[0], TEARDOWN_MS, "the upstream's connection closing");
  });

  it('stops waiting for headers when the client leaves first, and says so rather than blaming the deadline', async () => {
    const upstream = await startUpstream('silent');
    const outcomes: Array<Promise<unknown>> = [];
    const hub = await startHub(async (res) => {
      const outcome = postStreamUnderHeaderDeadline(
        upstream.url,
        {},
        {},
        { budgetMs: BUDGET_MS, upstream: 'cloud provider openai' },
        abortWhenClientCloses(res),
      ).catch((e: unknown) => e);
      outcomes.push(outcome);
      await outcome;
    });

    const client = connect(hub);
    await within(upstream.arrived, TEARDOWN_MS, 'the request reaching the upstream');
    client.hangUp();

    await within(upstream.closed[0], TEARDOWN_MS, "the upstream's connection closing");
    const err = await within(outcomes[0], TEARDOWN_MS, 'the post settling');
    expect((err as Error).message).toBe(`${CLIENT_CLOSED_MESSAGE}; the request to cloud provider openai was abandoned before it answered`);
  });
});

describe('abortWhenClientCloses', () => {
  it('stays quiet for a response that finished normally, which closes too', async () => {
    const signals: AbortSignal[] = [];
    const closed: Array<Promise<unknown>> = [];
    const hub = await startHub(async (res) => {
      signals.push(abortWhenClientCloses(res));
      closed.push(once(res, 'close'));
      res.end('ok');
    });

    const res = await fetch(hub, { method: 'POST', body: '{}' });
    await expect(res.text()).resolves.toBe('ok');
    await within(closed[0], TEARDOWN_MS, 'the response closing');
    expect(signals[0]?.aborted).toBe(false);
  });

  it('is aborted at once for a response whose client already left, as when routing outlasted the client', async () => {
    const signals: AbortSignal[] = [];
    let arrive!: () => void;
    let handled!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const done = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const hub = await startHub(async (res) => {
      arrive();
      await once(res, 'close');
      signals.push(abortWhenClientCloses(res));
      handled();
    });

    const client = connect(hub);
    await within(arrived, TEARDOWN_MS, 'the request reaching the handler');
    client.hangUp();
    await within(done, TEARDOWN_MS, 'the handler seeing the close');
    expect(signals[0]?.aborted).toBe(true);
    expect((signals[0]?.reason as Error | undefined)?.message).toBe(CLIENT_CLOSED_MESSAGE);
  });
});

describe('relayStream', () => {
  const relayWithoutSignal = (upstream: FakeUpstream) =>
    startHub(async (res) => {
      const response = await postStreamUnderHeaderDeadline(upstream.url, {}, {}, { budgetMs: BUDGET_MS, upstream: 'ollama' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      relayStream(response.data, res);
    });

  it('releases the upstream connection when the client hangs up, with no signal at all', async () => {
    const upstream = await startUpstream('one-frame');
    const client = connect(await relayWithoutSignal(upstream));
    await within(client.firstChunk, TEARDOWN_MS, 'the first frame');
    client.hangUp();

    await within(upstream.closed[0], TEARDOWN_MS, "the upstream's connection closing");
  });

  it('cuts the client off when the upstream drops mid-stream, where pipe() left its response open for good', async () => {
    const upstream = await startUpstream('one-frame-then-drop');
    const client = connect(await relayWithoutSignal(upstream));
    await within(client.firstChunk, TEARDOWN_MS, 'the first frame');

    // Not complete: the client learns the answer was cut instead of mistaking it for a whole one.
    await expect(within(client.ended, TEARDOWN_MS, "the client's response ending")).resolves.toEqual({ complete: false });
  });
});

describe('CloudFallbackService — a client that leaves releases the provider', () => {
  const service = () => {
    const configuration = mock<ConfigurationService>();
    configuration.getInferenceCloudProviders.mockReturnValue([]);
    return new CloudFallbackService(mock<LoggerService>(), configuration);
  };
  const providerAt = (provider: CloudProviderConfig['provider'], url: string): CloudProviderConfig => ({
    provider,
    apiKey: 'sk-test',
    enabled: true,
    baseUrl: `${url}/v1`,
    defaultModel: 'm',
  });
  const streamedTurn = { model: 'm', stream: true, messages: [{ role: 'user', content: 'think hard' }] };

  it.each([
    ['an OpenAI-compatible provider', 'openai', OPENAI_FRAME, '"content":"hi"'],
    ['Anthropic, through its SSE translation', 'anthropic', ANTHROPIC_FRAME, '"content":"hi"'],
  ] as const)(
    'closes the connection to %s when the client hangs up mid-stream, as the controller wires it',
    async (_label, kind, frame, expected) => {
      const provider = await startUpstream('one-frame', frame);
      const cloud = service();
      const hub = await startHub(async (res) => {
        const result = await cloud.proxyChatCompletion(providerAt(kind, provider.url), streamedTurn, abortWhenClientCloses(res));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        relayStream(result.stream as NodeJS.ReadableStream, res);
      });

      const client = connect(hub);
      await expect(within(client.firstChunk, TEARDOWN_MS, 'the first frame')).resolves.toContain(expected);
      client.hangUp();

      await within(provider.closed[0], TEARDOWN_MS, "the provider's connection closing");
    },
  );

  it('stops waiting on a provider that has not answered yet when the client leaves', async () => {
    const provider = await startUpstream('silent');
    const cloud = service();
    const hub = await startHub(async (res) => {
      await cloud.proxyChatCompletion(providerAt('openai', provider.url), streamedTurn, abortWhenClientCloses(res)).catch(() => undefined);
    });

    const client = connect(hub);
    await within(provider.arrived, TEARDOWN_MS, 'the request reaching the provider');
    client.hangUp();

    await within(provider.closed[0], TEARDOWN_MS, "the provider's connection closing");
  });

  it("passes a destroy of Anthropic's translated stream through to the provider's socket", async () => {
    // The controller only ever holds the translating Transform. With `pipe` between them, destroying
    // it left the provider's response flowing into nothing.
    const provider = await startUpstream('one-frame', ANTHROPIC_FRAME);
    const result = await service().proxyChatCompletion(providerAt('anthropic', provider.url), streamedTurn);
    const translated = result.stream as Readable;
    await within(once(translated, 'data'), TEARDOWN_MS, 'the first translated frame');

    translated.destroy();

    await within(provider.closed[0], TEARDOWN_MS, "the provider's connection closing");
  });
});
