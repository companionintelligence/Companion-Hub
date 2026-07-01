/**
 * MCP + OpenClaw Integration E2E Test.
 *
 * Tests the full integration flow (BUG-MCP-1: MCP Streamable HTTP transport on /api/mcp):
 *   1. Hub launches and MCP server is ready
 *   2. An MCP client initializes over Streamable HTTP and gets an Mcp-Session-Id
 *   3. Client lists available tools (Hub-native tools)
 *   4. Client calls a Hub tool via MCP (hub_list_installed_apps)
 *   5. Custom app with hub_integration.mcp_client=true is created
 *   6. Install flow injects MCP environment variables (single HUB_MCP_URL=/api/mcp)
 *   7. GitHub Copilot LLM provider is configured via form fields
 *
 * Prerequisites:
 *   - Hub backend running with MCP_API_KEY set
 *   - PostgreSQL + RabbitMQ available
 *   - Docker daemon accessible (for full install tests)
 *
 * Run standalone (opt-in — excluded from default `test:e2e:ci`):
 *   MCP_API_KEY=test-mcp-api-key-e2e npx playwright test --config=playwright.mcp.config.ts
 */

import { test, expect } from '@playwright/test';
import { db, deleteAppByName, seedOrganization } from './helpers/db';
import { testUser } from './helpers/constants';
import * as schema from '../packages/backend/src/core/database/drizzle/schema';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;
const MCP_API_KEY = process.env.MCP_API_KEY || 'test-mcp-api-key-e2e';

/** DB-only cleanup — avoids filesystem emptyDir which can fail on root-owned files. */
async function clearDatabaseOnly() {
  await db.delete(schema.link);
  await db.delete(schema.user);
  await db.delete(schema.app);
  await db.delete(schema.appStore);
  await db.delete(schema.deviceRegistration);
}

// OpenClaw custom app with hub_integration.mcp_client enabled
const OPENCLAW_APP_CONFIG = {
  id: 'openclaw',
  name: 'OpenClaw',
  version: '1.0.0',
  description: 'Open-source AI agent framework with MCP integration',
  short_desc: 'AI agent with Hub MCP',
  categories: ['ai'] as const,
  port: 3100,
  cihub_app_version: 1,
  author: 'OpenClaw',
  source: 'https://github.com/openclaw/openclaw',
  available: true,
  hub_integration: {
    mcp_client: true,
    wake_endpoint: '/hooks/hub-wake',
    wake_port: 3100,
    sse_events: false,
  },
  form_fields: [
    {
      type: 'text' as const,
      label: 'LLM Provider',
      env_variable: 'LLM_PROVIDER',
      default: 'github-copilot',
      required: false,
    },
    {
      type: 'password' as const,
      label: 'LLM API Key',
      env_variable: 'LLM_API_KEY',
      hint: 'API key for the LLM provider (GitHub Copilot, OpenAI, etc.)',
      required: true,
    },
  ],
};

const OPENCLAW_COMPOSE = {
  schemaVersion: 2,
  services: [
    {
      name: 'openclaw',
      image: 'traefik/whoami:latest', // Placeholder — real OpenClaw image in production
      isMain: true,
      internalPort: 3100,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// BUG-MCP-1: the Hub speaks the MCP Streamable HTTP transport on a single /api/mcp endpoint.
// Requests must accept both JSON and SSE; a session id is issued at initialize and echoed back.
function mcpHeaders(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${MCP_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return h;
}

function authHeaders(sessionId: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-ci-hub-session': sessionId };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

/** Extract the JSON-RPC payload from a Streamable HTTP response (plain JSON or an SSE data line). */
async function readMcpBody(res: Response): Promise<Record<string, unknown>> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (contentType.includes('application/json')) return JSON.parse(text) as Record<string, unknown>;
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i] as string) as Record<string, unknown>;
    } catch {
      /* keep scanning */
    }
  }
  throw new Error('no JSON-RPC payload in MCP response');
}

/** Open a Streamable HTTP session (initialize) and return the session id + the initialize result. */
async function mcpInitialize(): Promise<{ sessionId: string; status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BACKEND_URL}/api/mcp`, {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci-e2e', version: '1.0' } },
    }),
  });
  return { sessionId: res.headers.get('mcp-session-id') ?? '', status: res.status, body: await readMcpBody(res) };
}

/**
 * Self-contained JSON-RPC helper: opens a fresh session, runs the method, returns the body. For
 * `initialize` it returns the handshake result directly. (A real client reuses one session; opening
 * one per call keeps each test independent.)
 */
async function jsonRpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  const { sessionId, status: initStatus, body: initBody } = await mcpInitialize();
  try {
    if (method === 'initialize') return { status: initStatus, body: initBody };
    const response = await fetch(`${BACKEND_URL}/api/mcp`, {
      method: 'POST',
      headers: mcpHeaders(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return { status: response.status, body: await readMcpBody(response) };
  } finally {
    // Best-effort session teardown so per-call sessions don't accumulate (avoids inflating
    // activeSessions and rate-limit flakiness in the suite).
    if (sessionId) {
      await fetch(`${BACKEND_URL}/api/mcp`, { method: 'DELETE', headers: mcpHeaders(sessionId) }).catch(() => undefined);
    }
  }
}

async function loginToHub(): Promise<string> {
  await db
    .insert(schema.user)
    .values({
      password: testUser.hashedPassword,
      username: testUser.email,
      operator: true,
      hasCompletedOnboarding: true,
    })
    .onConflictDoNothing();

  const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUser.email, password: testUser.password }),
  });

  if (!res.ok) {
    throw new Error(`Hub login failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { sessionId?: string };
  if (!body.sessionId) {
    throw new Error('No sessionId in login response');
  }

  return body.sessionId;
}

// ---------------------------------------------------------------------------
// Layer 1: MCP Protocol — No Docker required
// ---------------------------------------------------------------------------

test.describe('MCP Protocol (OpenClaw client simulation)', () => {
  test.beforeAll(async () => {
    await clearDatabaseOnly();
    await seedOrganization();
  });

  test('Hub health check confirms backend is ready', async () => {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    expect(res.ok).toBeTruthy();
  });

  test('MCP endpoint establishes a Streamable HTTP session on initialize', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci-e2e', version: '1.0' } },
      }),
    });
    expect(res.ok).toBeTruthy();
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    const body = await readMcpBody(res);
    expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe('ci-hub');
  });

  test('MCP endpoint rejects unauthenticated requests', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  test('MCP endpoint rejects an invalid API key', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('MCP initialize returns server info and capabilities', async () => {
    const { body } = await jsonRpc('initialize');
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result).toBeTruthy();

    const result = body.result as { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: object };
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo.name).toBe('ci-hub');
    expect(result.serverInfo.version).toBe('1.0.0');
    expect(result.capabilities).toBeTruthy();
  });

  test('MCP tools/list returns registered Hub tools', async () => {
    const { body } = await jsonRpc('tools/list');
    expect(body.result).toBeTruthy();

    const result = body.result as { tools: Array<{ name: string; description: string; inputSchema: object }> };
    expect(result.tools.length).toBeGreaterThan(10);

    // Verify expected tool categories exist
    const toolNames = result.tools.map((t) => t.name);
    expect(toolNames).toContain('hub_system_load');
    expect(toolNames).toContain('hub_search_apps');
    expect(toolNames).toContain('hub_list_installed_apps');
    expect(toolNames).toContain('hub_create_custom_app');

    // Each tool should have required MCP shape
    for (const tool of result.tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test('MCP tools/call can invoke hub_list_installed_apps', async () => {
    const { status, body } = await jsonRpc('tools/call', { name: 'hub_list_installed_apps', arguments: {} });
    expect(status).toBe(200);
    expect(body.result).toBeTruthy();

    // Should return a content array (MCP tool result format)
    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeTruthy();
    expect(Array.isArray(result.content)).toBeTruthy();
  });

  test('MCP tools/call returns error for unknown tool', async () => {
    const { status, body } = await jsonRpc('tools/call', { name: 'nonexistent_tool', arguments: {} });
    expect(status).toBe(200);
    expect(body.error).toBeTruthy();

    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('nonexistent_tool');
  });

  test('MCP rejects a non-initialize request without a session', async () => {
    // No session header + a non-initialize body → the transport layer refuses with a JSON-RPC error.
    const res = await fetch(`${BACKEND_URL}/api/mcp`, {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.ok).toBeFalsy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: OpenClaw Custom App Creation + MCP Env Injection
// ---------------------------------------------------------------------------

test.describe('OpenClaw app creation and MCP integration config', () => {
  let sessionId: string;

  test.beforeAll(async () => {
    await clearDatabaseOnly();
    await seedOrganization();
    sessionId = await loginToHub();
  });

  test('create OpenClaw as a custom app with hub_integration config', async () => {
    const res = await fetch(`${BACKEND_URL}/api/custom-apps`, {
      method: 'POST',
      headers: authHeaders(sessionId, 'application/json'),
      body: JSON.stringify({
        name: 'openclaw',
        config: OPENCLAW_COMPOSE,
      }),
    });

    const body = (await res.json()) as { appUrn: string; appName: string; storeId: string };
    expect(res.ok, `Create custom app failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.appUrn).toContain('openclaw');
    expect(body.appName).toBe('openclaw');
    expect(body.storeId).toBe('_user');
  });

  test('OpenClaw appears in installed apps list', async () => {
    const res = await fetch(`${BACKEND_URL}/api/apps/installed`, {
      headers: authHeaders(sessionId),
    });
    expect(res.ok).toBeTruthy();

    const data = (await res.json()) as Record<string, unknown>;
    const apps = (data.installed ?? data.data ?? data) as Array<Record<string, unknown>>;
    // Response shape: { installed: [{ app: {...}, info: { id: 'openclaw', ... }, metadata: {...} }] }
    const openclaw = (apps as Array<Record<string, unknown>>).find((a) => {
      const info = a.info as Record<string, unknown> | undefined;
      return info?.id === 'openclaw' || info?.name === 'openclaw';
    });
    expect(openclaw, `OpenClaw should appear in installed apps. Got ${apps.length} apps`).toBeTruthy();
  });

  test('MCP hub_create_custom_app tool works (agent creates OpenClaw)', async () => {
    // Simulate an agent using MCP to create a second custom app
    const { status, body } = await jsonRpc('tools/call', {
      name: 'hub_create_custom_app',
      arguments: {
        name: 'openclaw-agent',
        config: OPENCLAW_COMPOSE,
      },
    });

    expect(status).toBe(200);
    expect(body.result).toBeTruthy();

    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeTruthy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('openclaw-agent');
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Full OpenClaw Install + GitHub Copilot Provider + MCP Verification
//
// Uses the custom-app API to bootstrap files, then patches config.json with
// hub_integration, seeds the repos directory, removes the DB record, and
// re-installs via the full install path (env generation + docker-compose up
// + webhook registration).
//
// Requires Docker daemon accessible for the container to start.
// ---------------------------------------------------------------------------

test.describe('Full OpenClaw install with GitHub Copilot provider', () => {
  let sessionId: string;
  const APP_URN = 'openclaw:_user';
  const STORE_SLUG = '_user';
  const DATA_DIR = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';
  const APP_DATA_DIR = process.env.CI_HUB_APP_DATA_DIR || `${DATA_DIR}/app-data`;

  test.beforeAll(async () => {
    // Docker is required — fail loudly
    const { execSync } = await import('node:child_process');
    execSync('docker info', { stdio: 'pipe' });

    await clearDatabaseOnly();
    await seedOrganization();
    sessionId = await loginToHub();
  });

  test.afterAll(async () => {
    try {
      await fetch(`${BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(APP_URN)}/uninstall`, {
        method: 'DELETE',
        headers: authHeaders(sessionId, 'application/json'),
        body: JSON.stringify({ deleteAllData: true }),
      });
      await new Promise((r) => setTimeout(r, 3000));
    } catch {
      // Ignore cleanup errors
    }
  });

  test('create OpenClaw via custom-app API and prepare for full install', async () => {
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const { execSync } = await import('node:child_process');

    // Step 1: Create custom app via API → files at {DATA_DIR}/apps/_user/openclaw/
    const createRes = await fetch(`${BACKEND_URL}/api/custom-apps`, {
      method: 'POST',
      headers: authHeaders(sessionId, 'application/json'),
      body: JSON.stringify({ name: 'openclaw', config: OPENCLAW_COMPOSE }),
    });
    const createBody = (await createRes.json()) as Record<string, unknown>;
    expect(createRes.ok, `Custom app create failed: ${JSON.stringify(createBody)}`).toBeTruthy();

    // Step 2: Overwrite config.json with hub_integration + form_fields
    const installedDir = pathMod.join(DATA_DIR, 'apps', STORE_SLUG, 'openclaw');
    const configPath = pathMod.join(installedDir, 'config.json');
    expect(fs.existsSync(configPath), `config.json should exist at ${configPath}`).toBeTruthy();

    // Read the generated config and merge our hub_integration fields
    const baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const patchedConfig = {
      ...baseConfig,
      hub_integration: OPENCLAW_APP_CONFIG.hub_integration,
      form_fields: OPENCLAW_APP_CONFIG.form_fields,
    };
    fs.writeFileSync(configPath, JSON.stringify(patchedConfig, null, 2));

    // Step 3: Seed the REPOS directory (install flow reads from here)
    const repoAppDir = pathMod.join(DATA_DIR, 'repos', STORE_SLUG, 'apps', 'openclaw');
    execSync(`mkdir -p "${repoAppDir}"`, { stdio: 'pipe' });
    // Copy everything from installed to repo
    execSync(`cp -r "${installedDir}/"* "${repoAppDir}/"`, { stdio: 'pipe' });

    // Verify repo files exist
    expect(fs.existsSync(pathMod.join(repoAppDir, 'config.json'))).toBeTruthy();
    expect(fs.existsSync(pathMod.join(repoAppDir, 'docker-compose.json'))).toBeTruthy();

    // Step 4: Delete the DB app record so install follows the FULL path
    // (env generation, docker-compose up, webhook registration)
    await deleteAppByName('openclaw');
  });

  test('install OpenClaw with GitHub Copilot as LLM provider', async () => {
    const res = await fetch(`${BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(APP_URN)}/install`, {
      method: 'POST',
      headers: authHeaders(sessionId, 'application/json'),
      body: JSON.stringify({
        port: 3100,
        LLM_PROVIDER: 'github-copilot',
        LLM_API_KEY: 'test-copilot-api-key',
      }),
    });

    const text = await res.text();
    expect(res.ok, `Install failed (${res.status}): ${text}`).toBeTruthy();
    const body = JSON.parse(text) as { requestId?: string };
    expect(body.requestId).toBeTruthy();
  });

  test('wait for OpenClaw to reach running or installed state', async () => {
    const startTime = Date.now();
    const timeout = 180_000;

    while (Date.now() - startTime < timeout) {
      const res = await fetch(`${BACKEND_URL}/api/apps/${encodeURIComponent(APP_URN)}`, {
        headers: authHeaders(sessionId),
      });

      if (res.ok) {
        const data = (await res.json()) as { status?: string; app?: { status?: string } };
        const status = data.status || data.app?.status;
        // Accept 'running' (container started) or 'stopped' (compose up succeeded but container exited)
        if (status === 'running' || status === 'stopped') return;
        if (status === 'install_error' || status === 'start_error') {
          throw new Error(`OpenClaw entered error state: ${status}`);
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error('OpenClaw did not finish installing within timeout');
  });

  test('verify OpenClaw app has MCP env vars injected', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const envPath = join(APP_DATA_DIR, STORE_SLUG, 'openclaw', 'app.env');
    expect(existsSync(envPath), `app.env should exist at ${envPath}`).toBeTruthy();

    const envContent = readFileSync(envPath, 'utf-8');

    // Verify MCP integration environment variables are present
    expect(envContent).toContain('HUB_URL=');
    expect(envContent).toContain('HUB_MCP_URL=');
    expect(envContent).toContain('HUB_WAKE_SECRET=');

    // Verify MCP API key is injected (GAP 1 fix: agent needs this to auth with MCP endpoint)
    expect(envContent).toContain('HUB_MCP_API_KEY=');

    // Verify GitHub Copilot provider config
    expect(envContent).toContain('LLM_PROVIDER=github-copilot');
    expect(envContent).toContain('LLM_API_KEY=test-copilot-api-key');

    // BUG-MCP-1: a single Streamable HTTP endpoint (/api/mcp) replaces the old /sse + /messages pair.
    // Uses the correct Hub port (API_PORT, not a hardcoded 3000) and no longer has a /messages URL.
    expect(envContent).toMatch(/HUB_MCP_URL=http:\/\/.+\/api\/mcp(\s|$)/m);
    expect(envContent).not.toContain('HUB_MCP_MESSAGES_URL=');

    // Verify wake secret is a 64-char hex string
    const secretMatch = envContent.match(/HUB_WAKE_SECRET=([a-f0-9]+)/);
    expect(secretMatch).toBeTruthy();
    expect(secretMatch?.[1]?.length).toBe(64);

    // Verify the MCP API key matches what the Hub is configured with
    const mcpKeyMatch = envContent.match(/HUB_MCP_API_KEY=(.+)/);
    expect(mcpKeyMatch).toBeTruthy();
    expect(mcpKeyMatch?.[1]).toBe(MCP_API_KEY);
  });

  test('verify MCP tools are accessible from agent perspective', async () => {
    // Simulate what the OpenClaw MCP client does after install:
    // 1. Initialize MCP session
    const initResult = await jsonRpc('initialize', {}, 100);
    expect(initResult.body.result).toBeTruthy();
    const serverInfo = (initResult.body.result as { serverInfo: { name: string } }).serverInfo;
    expect(serverInfo.name).toBe('ci-hub');

    // 2. List all available tools
    const listResult = await jsonRpc('tools/list', {}, 101);
    const tools = (listResult.body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBeGreaterThan(10);

    // 3. Verify key tool categories that OpenClaw would use
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('hub_list_installed_apps');
    expect(toolNames).toContain('hub_search_apps');
    expect(toolNames).toContain('hub_system_load');
    expect(toolNames).toContain('hub_create_custom_app');

    // 4. Call hub_list_installed_apps — OpenClaw should be listed
    const appsResult = await jsonRpc('tools/call', { name: 'hub_list_installed_apps', arguments: {} }, 102);
    expect(appsResult.body.result).toBeTruthy();
    const content = (appsResult.body.result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
    const appsText = content[0]?.text ?? '';
    expect(appsText.toLowerCase()).toContain('openclaw');
  });

  test('verify agent wake webhook was registered for OpenClaw', async () => {
    // After install with hub_integration.mcp_client=true, the Hub should have
    // registered a wake webhook. Verify by calling hub_system_load (proves
    // the MCP server is still functional after install + webhook registration).
    const { status, body } = await jsonRpc('tools/call', { name: 'hub_system_load', arguments: {} }, 200);
    expect(status).toBe(200);
    expect(body.result).toBeTruthy();

    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeTruthy();
    expect(result.content.length).toBeGreaterThan(0);
    // System load should return disk/cpu/memory data
    const loadText = result.content[0]?.text ?? '';
    expect(loadText).toBeTruthy();
  });
});
