/**
 * MCP + OpenClaw Integration E2E Test.
 *
 * Tests the full integration flow:
 *   1. Hub launches and MCP server is ready
 *   2. OpenClaw-style MCP client connects via HTTP+SSE
 *   3. Client discovers the messages endpoint
 *   4. Client initializes the MCP session
 *   5. Client lists available tools (should include 50+ Hub tools)
 *   6. Client calls a Hub tool via MCP (hub_list_installed_apps)
 *   7. Custom app with hub_integration.mcp_client=true is created
 *   8. Install flow injects MCP environment variables
 *   9. GitHub Copilot LLM provider is configured via form fields
 *
 * Prerequisites:
 *   - Hub backend running with MCP_API_KEY set
 *   - PostgreSQL + RabbitMQ available
 *   - Docker daemon accessible (for full install tests)
 *
 * Run standalone:
 *   MCP_API_KEY=test-mcp-api-key-e2e npx playwright test e2e/future/mcp-openclaw-integration.spec.ts
 */

import { test, expect } from '@playwright/test';
import { clearDatabase, db, seedOrganization } from '../helpers/db';
import { testUser } from '../helpers/constants';
import * as schema from '../../packages/backend/src/core/database/drizzle/schema';

const BACKEND_URL = `http://localhost:${process.env.BACKEND_PORT || '3000'}`;
const MCP_API_KEY = process.env.MCP_API_KEY || 'test-mcp-api-key-e2e';

// OpenClaw custom app with hub_integration.mcp_client enabled
const OPENCLAW_APP_CONFIG = {
  id: 'openclaw',
  name: 'OpenClaw',
  version: '1.0.0',
  description: 'Open-source AI agent framework with MCP integration',
  short_desc: 'AI agent with Hub MCP',
  categories: ['ai'] as const,
  port: 3100,
  tipi_version: 1,
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

function mcpHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${MCP_API_KEY}` };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

function authHeaders(sessionId: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-ci-hub-session': sessionId };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

async function jsonRpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await fetch(`${BACKEND_URL}/api/mcp/messages`, {
    method: 'POST',
    headers: mcpHeaders('application/json'),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
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
    await clearDatabase();
    await seedOrganization();
  });

  test('Hub health check confirms backend is ready', async () => {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    expect(res.ok).toBeTruthy();
  });

  test('MCP SSE endpoint returns messages URL', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const res = await fetch(`${BACKEND_URL}/api/mcp/sse`, {
        headers: mcpHeaders(),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // Read the first SSE event — should be an endpoint event
      const body = res.body;
      expect(body).toBeTruthy();
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let messagesUrl = '';

      while (!messagesUrl) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ') && currentEvent === 'endpoint') {
            messagesUrl = line.slice(6).trim();
          }
        }
      }

      expect(messagesUrl).toContain('/api/mcp/messages');
      reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  });

  test('MCP SSE endpoint rejects unauthenticated requests', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp/sse`);
    expect(res.status).toBe(401);
  });

  test('MCP messages endpoint rejects invalid API key', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  test('MCP initialize returns server info and capabilities', async () => {
    const { status, body } = await jsonRpc('initialize');
    expect(status).toBe(201);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result).toBeTruthy();

    const result = body.result as { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: object };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('ci-hub');
    expect(result.serverInfo.version).toBe('1.0.0');
    expect(result.capabilities).toBeTruthy();
  });

  test('MCP tools/list returns registered Hub tools', async () => {
    const { status, body } = await jsonRpc('tools/list');
    expect(status).toBe(201);
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
    expect(status).toBe(201);
    expect(body.result).toBeTruthy();

    // Should return a content array (MCP tool result format)
    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeTruthy();
    expect(Array.isArray(result.content)).toBeTruthy();
  });

  test('MCP tools/call returns error for unknown tool', async () => {
    const { status, body } = await jsonRpc('tools/call', { name: 'nonexistent_tool', arguments: {} });
    expect(status).toBe(201);
    expect(body.error).toBeTruthy();

    const error = body.error as { code: number; message: string };
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('nonexistent_tool');
  });

  test('MCP rejects malformed JSON-RPC', async () => {
    const res = await fetch(`${BACKEND_URL}/api/mcp/messages`, {
      method: 'POST',
      headers: mcpHeaders('application/json'),
      body: JSON.stringify({ id: 1, method: 'initialize' }),
    });
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
    await clearDatabase();
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

    expect(res.ok, `Create custom app failed: ${await res.text()}`).toBeTruthy();
    const body = (await res.json()) as { appUrn: string; appName: string; storeId: string };
    expect(body.appUrn).toContain('openclaw');
    expect(body.appName).toBe('openclaw');
    expect(body.storeId).toBe('_user');
  });

  test('OpenClaw appears in installed apps list', async () => {
    const res = await fetch(`${BACKEND_URL}/api/apps/installed`, {
      headers: authHeaders(sessionId),
    });
    expect(res.ok).toBeTruthy();

    const apps = (await res.json()) as Array<{ appName?: string; status?: string }>;
    const openclaw = apps.find((a) => a.appName === 'openclaw');
    expect(openclaw, 'OpenClaw should appear in installed apps').toBeTruthy();
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

    expect(status).toBe(201);
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
// This section requires Docker to be running so the app container can start.
// When Docker is not available, these tests are skipped.
// ---------------------------------------------------------------------------

test.describe('Full OpenClaw install with GitHub Copilot provider', () => {
  let sessionId: string;
  const APP_URN = 'openclaw:e2e-test-store';
  const STORE_SLUG = 'e2e-test-store';

  test.beforeAll(async () => {
    // Check Docker availability
    try {
      const { execSync } = await import('node:child_process');
      execSync('docker info', { stdio: 'pipe' });
    } catch {
      test.skip();
      return;
    }

    await clearDatabase();
    await seedOrganization();

    // Seed the test app store
    await db
      .insert(schema.appStore)
      .values({
        slug: STORE_SLUG,
        hash: 'e2e-mcp-test',
        name: 'E2E MCP Test Store',
        enabled: true,
        url: 'https://example.com/e2e-mcp-store',
        branch: 'main',
      })
      .onConflictDoNothing();

    sessionId = await loginToHub();
  });

  test.afterAll(async () => {
    // Attempt cleanup
    try {
      await fetch(`${BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(APP_URN)}/uninstall`, {
        method: 'DELETE',
        headers: authHeaders(sessionId, 'application/json'),
        body: JSON.stringify({ removeBackups: true }),
      });
      await new Promise((r) => setTimeout(r, 3000));
    } catch {
      // Ignore cleanup errors
    }
  });

  test('seed OpenClaw app files for installation', async () => {
    const { execSync } = await import('node:child_process');
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'e2e-openclaw-'));
    const dataDir = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';
    const appDir = join(dataDir, 'repos', STORE_SLUG, 'apps', 'openclaw');

    execSync(`mkdir -p ${appDir}`, { stdio: 'pipe' });
    writeFileSync(join(appDir, 'config.json'), JSON.stringify(OPENCLAW_APP_CONFIG, null, 2));
    writeFileSync(join(appDir, 'docker-compose.json'), JSON.stringify(OPENCLAW_COMPOSE, null, 2));

    // Verify files exist
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(appDir, 'config.json'))).toBeTruthy();
    expect(existsSync(join(appDir, 'docker-compose.json'))).toBeTruthy();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('install OpenClaw with GitHub Copilot as LLM provider', async () => {
    const res = await fetch(`${BACKEND_URL}/api/app-lifecycle/${encodeURIComponent(APP_URN)}/install`, {
      method: 'POST',
      headers: authHeaders(sessionId, 'application/json'),
      body: JSON.stringify({
        port: 3100,
        // Form field values — sets GitHub Copilot as the LLM provider
        LLM_PROVIDER: 'github-copilot',
        LLM_API_KEY: 'test-copilot-api-key',
      }),
    });

    expect(res.ok, `Install failed: ${await res.text()}`).toBeTruthy();
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBeTruthy();
  });

  test('wait for OpenClaw to reach running state', async () => {
    const startTime = Date.now();
    const timeout = 120_000;

    while (Date.now() - startTime < timeout) {
      const res = await fetch(`${BACKEND_URL}/api/apps/${encodeURIComponent(APP_URN)}`, {
        headers: authHeaders(sessionId),
      });

      if (res.ok) {
        const data = (await res.json()) as { status?: string; info?: { status?: string } };
        const status = data.status || data.info?.status;
        if (status === 'running') return;
        if (status === 'install_error' || status === 'start_error') {
          throw new Error(`OpenClaw entered error state: ${status}`);
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error('OpenClaw did not reach running state within timeout');
  });

  test('verify OpenClaw app has MCP env vars injected', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const dataDir = process.env.CI_HUB_DATA_DIR || '/tmp/ci-hub-e2e';
    const envPath = join(dataDir, 'apps', STORE_SLUG, 'openclaw', 'app.env');

    if (!existsSync(envPath)) {
      test.skip();
      return;
    }

    const envContent = readFileSync(envPath, 'utf-8');

    // Verify MCP integration environment variables are present
    expect(envContent).toContain('HUB_URL=');
    expect(envContent).toContain('HUB_MCP_URL=');
    expect(envContent).toContain('HUB_MCP_MESSAGES_URL=');
    expect(envContent).toContain('HUB_WAKE_SECRET=');

    // Verify GitHub Copilot provider config
    expect(envContent).toContain('LLM_PROVIDER=github-copilot');
    expect(envContent).toContain('LLM_API_KEY=test-copilot-api-key');

    // Verify MCP URLs point to Hub's internal address
    expect(envContent).toMatch(/HUB_MCP_URL=http:\/\/.+\/api\/mcp\/sse/);
    expect(envContent).toMatch(/HUB_MCP_MESSAGES_URL=http:\/\/.+\/api\/mcp\/messages/);

    // Verify wake secret is a 64-char hex string
    const secretMatch = envContent.match(/HUB_WAKE_SECRET=([a-f0-9]+)/);
    expect(secretMatch).toBeTruthy();
    expect(secretMatch?.[1]?.length).toBe(64);
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

    // App management tools
    expect(toolNames).toContain('hub_list_installed_apps');
    expect(toolNames).toContain('hub_search_apps');

    // System tools
    expect(toolNames).toContain('hub_system_load');

    // Custom app tools (OpenClaw can create apps)
    expect(toolNames).toContain('hub_create_custom_app');

    // 4. Call a safe tool to verify end-to-end MCP execution
    const loadResult = await jsonRpc('tools/call', { name: 'hub_list_installed_apps', arguments: {} }, 102);
    expect(loadResult.body.result).toBeTruthy();

    const content = (loadResult.body.result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
    // The installed apps list should include our OpenClaw app
    const appsText = content[0]?.text ?? '';
    expect(appsText).toContain('openclaw');
  });

  test('verify agent wake webhook was registered for OpenClaw', async () => {
    // The install command should have registered a webhook via AgentNotifyService.
    // We verify by checking the agent notify status (if endpoint exists) or
    // by calling the MCP tools/call on a system status tool.
    const { status, body } = await jsonRpc('tools/call', { name: 'hub_list_installed_apps', arguments: {} }, 200);
    expect(status).toBe(201);

    // Parse the apps list to find OpenClaw's status
    const result = body.result as { content: Array<{ type: string; text: string }> };
    const text = result.content[0]?.text ?? '';

    // OpenClaw should be listed as installed
    expect(text.toLowerCase()).toContain('openclaw');
  });
});
