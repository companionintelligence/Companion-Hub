import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type Provider = 'ollama' | 'dspark' | 'mtplx' | 'vllm' | 'lucebox' | 'lemonade';

interface ProviderState {
  online: boolean;
  models: string[];
  loadedModels: string[];
  failPull: boolean;
  failLoad: boolean;
  loadDelayMs: number;
  loadingTarget?: string;
}

interface RecordedRequest {
  provider: Provider;
  method: string;
  path: string;
  body: unknown;
  headers: {
    authorization?: string;
  };
  at: string;
}

interface FixtureState {
  providers: Record<Provider, ProviderState>;
  requests: RecordedRequest[];
}

const port = Number(process.env.FTUE_INFERENCE_FIXTURE_PORT ?? 18090);
const host = process.env.FTUE_INFERENCE_FIXTURE_HOST ?? '127.0.0.1';

function createDefaultState(): FixtureState {
  return {
    providers: {
      ollama: {
        online: true,
        models: ['nomic-embed-text:latest'],
        loadedModels: ['nomic-embed-text:latest'],
        failPull: false,
        failLoad: false,
        loadDelayMs: 30,
      },
      dspark: {
        online: true,
        models: [],
        loadedModels: [],
        failPull: false,
        failLoad: false,
        loadDelayMs: 50,
      },
      mtplx: {
        online: true,
        models: ['Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed'],
        loadedModels: ['Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed'],
        failPull: false,
        failLoad: false,
        loadDelayMs: 20,
      },
      vllm: {
        online: true,
        models: ['Qwen/Qwen3-8B'],
        loadedModels: ['Qwen/Qwen3-8B'],
        failPull: false,
        failLoad: false,
        loadDelayMs: 20,
      },
      lucebox: {
        online: true,
        models: ['Qwen/Qwen3-8B'],
        loadedModels: ['Qwen/Qwen3-8B'],
        failPull: false,
        failLoad: false,
        loadDelayMs: 20,
      },
      lemonade: {
        online: true,
        models: ['Qwen3-8B-GGUF'],
        loadedModels: ['Qwen3-8B-GGUF'],
        failPull: false,
        failLoad: false,
        loadDelayMs: 30,
      },
    },
    requests: [],
  };
}

let state = createDefaultState();

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  setCorsHeaders(response);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function modelName(body: unknown): string {
  const record = asRecord(body);
  const candidate = record.model ?? record.name;
  return typeof candidate === 'string' ? candidate : '';
}

function recordRequest(provider: Provider, request: IncomingMessage, pathname: string, body: unknown): void {
  state.requests.push({
    provider,
    method: request.method ?? 'GET',
    path: pathname,
    body,
    headers: {
      authorization: request.headers.authorization,
    },
    at: new Date().toISOString(),
  });
  if (state.requests.length > 1000) state.requests.splice(0, state.requests.length - 1000);
}

function addModel(providerState: ProviderState, model: string, loaded = false): void {
  if (model && !providerState.models.includes(model)) providerState.models.push(model);
  if (loaded && model && !providerState.loadedModels.includes(model)) {
    providerState.loadedModels.push(model);
  }
}

async function handleControl(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/___control')) return false;

  if (request.method === 'GET') {
    sendJson(response, 200, state);
    return true;
  }

  if (request.method === 'POST' && pathname === '/___control/reset') {
    state = createDefaultState();
    sendJson(response, 200, state);
    return true;
  }

  if (request.method === 'POST' && pathname === '/___control/configure') {
    const body = asRecord(await readJson(request));
    const providers = asRecord(body.providers);
    for (const [providerName, update] of Object.entries(providers)) {
      if (!(providerName in state.providers)) continue;
      const provider = providerName as Provider;
      state.providers[provider] = {
        ...state.providers[provider],
        ...asRecord(update),
      } as ProviderState;
    }
    sendJson(response, 200, state);
    return true;
  }

  sendJson(response, 404, { error: 'Unknown fixture control route' });
  return true;
}

async function handleOllama(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  providerState: ProviderState,
  body: unknown,
): Promise<void> {
  if (request.method === 'GET' && pathname === '/ollama/api/version') {
    sendJson(response, 200, { version: '0.11.0-ftue-e2e' });
    return;
  }
  if (request.method === 'GET' && pathname === '/ollama/api/tags') {
    sendJson(response, 200, {
      models: providerState.models.map((name) => ({
        name,
        model: name,
        size: 524_288_000,
        modified_at: '2026-09-04T12:00:00.000Z',
        details: { family: 'qwen3', parameter_size: '8B', quantization_level: 'Q4_K_M' },
      })),
    });
    return;
  }
  if (request.method === 'GET' && pathname === '/ollama/api/ps') {
    sendJson(response, 200, {
      models: providerState.loadedModels.map((name) => ({ name, model: name, size: 524_288_000 })),
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/ollama/api/pull') {
    setCorsHeaders(response);
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (providerState.failPull) {
      response.end(`${JSON.stringify({ error: 'synthetic Ollama pull failure' })}\n`);
      return;
    }
    const model = modelName(body);
    response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
    await delay(providerState.loadDelayMs);
    response.write(`${JSON.stringify({ status: 'downloading', completed: 50, total: 100 })}\n`);
    await delay(providerState.loadDelayMs);
    addModel(providerState, model);
    response.end(`${JSON.stringify({ status: 'success', completed: 100, total: 100 })}\n`);
    return;
  }
  if (request.method === 'POST' && (pathname === '/ollama/api/generate' || pathname === '/ollama/api/embed')) {
    if (providerState.failLoad) {
      sendJson(response, 500, { error: 'synthetic Ollama load failure' });
      return;
    }
    const model = modelName(body);
    addModel(providerState, model, true);
    sendJson(response, 200, pathname.endsWith('/embed') ? { embeddings: [[0.1, 0.2]] } : { done: true });
    return;
  }
  sendJson(response, 404, { error: `Unhandled Ollama route: ${pathname}` });
}

async function handleDspark(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  providerState: ProviderState,
  body: unknown,
): Promise<void> {
  if (request.method === 'GET' && pathname === '/dspark/health') {
    if (providerState.loadingTarget) {
      sendJson(response, 200, {
        status: 'loading',
        model: providerState.loadingTarget.split('/').at(-1),
        target: providerState.loadingTarget,
        download: { repo: providerState.loadingTarget, bytes_done: 50, bytes_total: 100 },
      });
      return;
    }
    const model = providerState.loadedModels[0] ?? providerState.models[0];
    sendJson(
      response,
      200,
      model ? { status: 'ok', model: model.split('/').at(-1), target: model, ready: true } : { status: 'no_model', ready: true },
    );
    return;
  }
  if (request.method === 'POST' && pathname === '/dspark/admin/load') {
    if (providerState.failLoad || providerState.failPull) {
      sendJson(response, 500, { error: 'synthetic mlx-dspark load failure' });
      return;
    }
    const model = modelName(body);
    providerState.loadingTarget = model;
    await delay(providerState.loadDelayMs);
    addModel(providerState, model, true);
    providerState.loadingTarget = undefined;
    sendJson(response, 200, { ready: true, status: 'ok', model });
    return;
  }
  if (request.method === 'POST' && pathname === '/dspark/admin/unload') {
    providerState.loadedModels = [];
    sendJson(response, 200, { ready: true, status: 'no_model' });
    return;
  }
  sendJson(response, 404, { error: `Unhandled mlx-dspark route: ${pathname}` });
}

async function handleLemonade(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  providerState: ProviderState,
  body: unknown,
): Promise<void> {
  if (request.method === 'GET' && pathname === '/lemonade/v1/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && pathname === '/lemonade/v1/system-info') {
    sendJson(response, 200, { platform: 'macOS', accelerator: 'Metal' });
    return;
  }
  if (request.method === 'GET' && pathname === '/lemonade/v1/models') {
    sendJson(response, 200, {
      data: providerState.models.map((id) => ({ id, owned_by: 'ftue-e2e' })),
    });
    return;
  }
  if (request.method === 'POST' && pathname === '/lemonade/v1/pull') {
    if (providerState.failPull) {
      sendJson(response, 500, { error: 'synthetic Lemonade pull failure' });
      return;
    }
    const model = modelName(body);
    await delay(providerState.loadDelayMs);
    addModel(providerState, model);
    sendJson(response, 200, { status: 'success', model });
    return;
  }
  if (request.method === 'POST' && pathname === '/lemonade/v1/load') {
    if (providerState.failLoad) {
      sendJson(response, 500, { error: 'synthetic Lemonade load failure' });
      return;
    }
    const model = modelName(body);
    addModel(providerState, model, true);
    sendJson(response, 200, { status: 'loaded', model });
    return;
  }
  if (request.method === 'POST' && pathname === '/lemonade/v1/unload') {
    providerState.loadedModels = [];
    sendJson(response, 200, { status: 'unloaded' });
    return;
  }
  sendJson(response, 404, { error: `Unhandled Lemonade route: ${pathname}` });
}

async function handleOpenAiCompatible(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  provider: Exclude<Provider, 'ollama' | 'dspark' | 'lemonade'>,
  providerState: ProviderState,
): Promise<void> {
  const routePrefix = `/${provider}`;
  if (request.method === 'GET' && pathname === `${routePrefix}/health`) {
    sendJson(response, 200, { status: 'ok', ready: true });
    return;
  }
  if (request.method === 'GET' && pathname === `${routePrefix}/v1/models`) {
    sendJson(response, 200, {
      object: 'list',
      data: providerState.models.map((id) => ({ id, object: 'model', owned_by: 'ftue-e2e' })),
    });
    return;
  }
  sendJson(response, 404, { error: `Unhandled ${provider} route: ${pathname}` });
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
  if (await handleControl(request, response, url.pathname)) return;

  const providerName = url.pathname.split('/').filter(Boolean)[0];
  if (!providerName || !(providerName in state.providers)) {
    sendJson(response, 404, { error: `Unknown inference provider: ${providerName ?? ''}` });
    return;
  }

  const provider = providerName as Provider;
  const providerState = state.providers[provider];
  const body = request.method === 'POST' ? await readJson(request) : undefined;
  recordRequest(provider, request, url.pathname, body);

  if (!providerState.online) {
    sendJson(response, 503, { error: `${provider} is intentionally offline` });
    return;
  }

  if (provider === 'ollama') {
    await handleOllama(request, response, url.pathname, providerState, body);
    return;
  }
  if (provider === 'dspark') {
    await handleDspark(request, response, url.pathname, providerState, body);
    return;
  }
  if (provider === 'lemonade') {
    await handleLemonade(request, response, url.pathname, providerState, body);
    return;
  }
  await handleOpenAiCompatible(request, response, url.pathname, provider, providerState);
});

server.listen(port, host, () => {
  process.stdout.write(`FTUE inference fixture listening at http://${host}:${port}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
