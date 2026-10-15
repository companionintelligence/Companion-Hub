import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { MarketplaceWhoIsService } from '@/core/portal/marketplace-whois.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import type { ApiKeyCapability } from '@/modules/api-keys/api-key.capabilities';
import type { ApiKeyContext } from '@/modules/api-keys/api-key.service';
import { AppLifecycleService } from '@/modules/app-lifecycle/app-lifecycle.service';
import { AppStoreService } from '@/modules/app-stores/app-store.service';
import { CloudFallbackService } from '@/modules/inference/cloud-fallback.service';
import { ModelPullerService } from '@/modules/inference/model-puller.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { RegistrationService } from '@/modules/registration/registration.service';
import { DockerService } from '@/modules/docker/docker.service';
import { SystemService } from '@/modules/system/system.service';
import { SystemUpdateService } from '@/modules/system-update/system-update.service';
import { FederatedIdentityRepository } from '@/modules/user/federated-identity.repository';
import { UserRepository } from '@/modules/user/user.repository';
import { McpService } from '../mcp.service';
import { mcpCallContext } from '../mcp-call-context';
import { McpModernHandlerService } from '../mcp-modern-handler.service';
import { McpServerFactory } from '../mcp-server.factory';
import { McpToolRegistry } from '../mcp-tool-registry.service';
import { McpV2ServerFactory } from '../mcp-v2-server.factory';
import { AppLifecycleTools } from '../tools/app-lifecycle.tools';
import { InferenceTools } from '../tools/inference.tools';
import { MarketplaceTools } from '../tools/marketplace.tools';
import { SystemTools } from '../tools/system.tools';

/*
 * The Hub-wide MCP tools follow HubManagerGuard: driven through a real MCP client, the real tool
 * registrations and the real WhoIs service, with only the Portal, the database reads and the services
 * behind the tools faked. Each kind of key is the person, or nobody, the gate has to ask about.
 */

const CLAIMER = 1;
const OWNER = 2;
const ADMIN = 3;
const MEMBER = 4;
/** A creator whose role the Hub never stored, as after a sign-in while the Portal was down. */
const UNSTORED = 5;

/** The Hub-wide tools a `write` key's capability reaches. */
const HUB_WIDE_WRITE_VISIBLE = [
  'hub_get_hub_logs',
  'hub_load_model',
  'hub_pin_model',
  'hub_pull_app_stores',
  'hub_pull_model',
  'hub_set_auto_updates',
  'hub_set_cloud_provider',
  'hub_unload_model',
  'hub_unpin_model',
];

const textOf = (res: { content: unknown }) => (res.content as Array<{ text: string }>)[0]?.text;

describe('Hub-wide MCP tools', () => {
  let portal: MockProxy<PortalClientService>;
  let federatedIdentities: MockProxy<FederatedIdentityRepository>;
  let registration: MockProxy<RegistrationService>;
  let users: MockProxy<UserRepository>;
  let whois: MarketplaceWhoIsService;
  let registry: McpToolRegistry;
  let cloudFallback: MockProxy<CloudFallbackService>;
  let modelPuller: MockProxy<ModelPullerService>;
  let systemUpdate: MockProxy<SystemUpdateService>;
  let lifecycle: MockProxy<AppLifecycleService>;
  /** What the Portal says each person's role is now; `null` when it can't be reached. */
  let portalRoles: Record<number, string> | null;
  /** The role the Hub stored for each person at sign-in. */
  let storedRoles: Record<number, 'owner' | 'admin' | 'member' | null>;

  const writeKey = (createdByUserId: number | null, overrides: Partial<ApiKeyContext> = {}): ApiKeyContext => ({
    id: 10,
    name: 'agent',
    capability: 'write',
    ownerAppUrn: null,
    createdByUserId,
    ...overrides,
  });
  const managedKey = (capability: ApiKeyCapability = 'write') =>
    writeKey(null, { name: 'ci-hermes', ownerAppUrn: 'ci-hermes:ci-marketplace', capability });

  async function connect(): Promise<Client> {
    const logger = mock<LoggerService>();
    const server = new McpServerFactory(registry, new McpService(registry, logger), logger, whois).create();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'hub-wide-test', version: '1.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  const as = <T>(key: ApiKeyContext, fn: () => Promise<T>): Promise<T> => mcpCallContext.run(key, fn);

  const setCloudProvider = (client: Client) =>
    client.callTool({
      name: 'hub_set_cloud_provider',
      arguments: { provider: 'openai', apiKey: 'sk-test', enabled: true, baseUrl: 'https://example.com/v1' },
    });

  const listedHubWide = async (client: Client, key: ApiKeyContext) => {
    const { tools } = await as(key, () => client.listTools());
    return tools
      .map((tool) => tool.name)
      .filter((name) => registry.getTool(name)?.hubWide)
      .sort();
  };

  beforeEach(() => {
    portal = mock<PortalClientService>();
    federatedIdentities = mock<FederatedIdentityRepository>();
    registration = mock<RegistrationService>();
    users = mock<UserRepository>();
    portalRoles = { [CLAIMER]: 'member', [OWNER]: 'owner', [ADMIN]: 'admin', [MEMBER]: 'member', [UNSTORED]: 'admin' };
    storedRoles = { [CLAIMER]: 'member', [OWNER]: 'owner', [ADMIN]: 'admin', [MEMBER]: 'member', [UNSTORED]: null };

    federatedIdentities.findByUserId.mockImplementation(async (userId) => [{ subject: `portal-${userId}` }] as never);
    registration.getDeviceRegistrationInfo.mockResolvedValue({ id: 'org-hub' } as never);
    users.getFirstOperator.mockResolvedValue({ id: CLAIMER } as never);
    users.getUserDtoById.mockImplementation(async (id) => ({ id, orgRole: storedRoles[id] ?? null }) as never);
    portal.whoisApps.mockImplementation(async ({ subject }) => {
      if (portalRoles === null) {
        throw new Error('ECONNREFUSED');
      }
      const role = portalRoles[Number(subject.replace('portal-', ''))];
      return { status: 200, body: { organizations: [{ organizationId: 'org-hub', version: 1, user: { role }, apps: [] }] } } as never;
    });
    whois = new MarketplaceWhoIsService(portal, mock<DatabaseService>(), mock<LoggerService>(), federatedIdentities, registration, users);

    registry = new McpToolRegistry();
    cloudFallback = mock<CloudFallbackService>();
    modelPuller = mock<ModelPullerService>();
    systemUpdate = mock<SystemUpdateService>();
    lifecycle = mock<AppLifecycleService>();
    const docker = mock<DockerService>();
    docker.getLogsStream.mockRejectedValue(new Error('no docker here'));
    lifecycle.startApp.mockResolvedValue({ requestId: 'start-1' } as never);
    const m = () => mock() as never;
    new SystemTools(mock<SystemService>(), systemUpdate, docker, registry).onModuleInit();
    new InferenceTools(mock<LoggerService>(), registry, m(), m(), m(), modelPuller, m(), cloudFallback, m()).onModuleInit();
    new MarketplaceTools(mock<MarketplaceService>(), mock<AppStoreService>(), registry).onModuleInit();
    new AppLifecycleTools(lifecycle, registry).onModuleInit();
  });

  describe('tools/call, for each kind of key', () => {
    it.each([
      ['the operator who claimed the Hub, though the Portal calls them a member', CLAIMER],
      ['an organization owner', OWNER],
      ['an organization admin', ADMIN],
    ])('runs for a key made by %s', async (_label, creator) => {
      const client = await connect();

      const res = await as(writeKey(creator), () => setCloudProvider(client));

      expect(res.isError).toBeFalsy();
      expect(cloudFallback.setProvider).toHaveBeenCalledTimes(1);
    });

    it("doesn't ask the Portal about the operator who claimed the Hub", async () => {
      const client = await connect();

      await as(writeKey(CLAIMER), () => setCloudProvider(client));

      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it('refuses a key made by the claimer once the Portal removed them and the Hub revoked their access', async () => {
      users.getFirstOperator.mockResolvedValue({ id: CLAIMER, accessStatus: 'revoked' } as never);
      const client = await connect();

      expect(await listedHubWide(client, writeKey(CLAIMER))).toEqual([]);
      const res = await as(writeKey(CLAIMER), () => setCloudProvider(client));

      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
    });

    it("refuses a member's key with the routes' 403 code, and changes nothing", async () => {
      const client = await connect();

      const res = await as(writeKey(MEMBER), () => setCloudProvider(client));

      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
    });

    it("asks about the creator's role now, not the one stored at sign-in", async () => {
      storedRoles[OWNER] = 'owner';
      portalRoles = { [OWNER]: 'member' };
      const client = await connect();

      const res = await as(writeKey(OWNER), () => setCloudProvider(client));

      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
    });

    it("refuses a member's key with the routes' 503 code while the Portal can't be reached", async () => {
      portalRoles = null;
      const client = await connect();

      const res = await as(writeKey(MEMBER), () => setCloudProvider(client));

      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_UNVERIFIED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['a key with no recorded creator', writeKey(null)],
      ['a managed app key (Hermes or OpenClaw)', managedKey()],
    ])('refuses %s with its own code, without asking the Portal', async (_label, key) => {
      const client = await connect();

      const res = await as(key, () => setCloudProvider(client));

      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe('HUB_MANAGE_KEY_REISSUE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it('gives a managed key no creator to ask about, even one recorded on it', async () => {
      const key = writeKey(OWNER, { name: 'ci-hermes', ownerAppUrn: 'ci-hermes:ci-marketplace' });
      const client = await connect();

      expect(await listedHubWide(client, key)).toEqual([]);
      const res = await as(key, () => setCloudProvider(client));

      expect(textOf(res)).toBe('HUB_MANAGE_KEY_REISSUE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it("keeps the Hub log from a member's read key and from a managed key", async () => {
      const client = await connect();

      const member = await as(writeKey(MEMBER, { capability: 'read' }), () =>
        client.callTool({ name: 'hub_get_hub_logs', arguments: { maxLines: 1000 } }),
      );
      const managed = await as(managedKey(), () => client.callTool({ name: 'hub_get_hub_logs', arguments: { maxLines: 1000 } }));
      const owner = await as(writeKey(OWNER, { capability: 'read' }), () =>
        client.callTool({ name: 'hub_get_hub_logs', arguments: { maxLines: 1 } }),
      );

      expect(textOf(member)).toBe('HUB_MANAGE_ROLE_REQUIRED {"tool":"hub_get_hub_logs"}');
      expect(textOf(managed)).toBe('HUB_MANAGE_KEY_REISSUE_REQUIRED {"tool":"hub_get_hub_logs"}');
      expect(owner.isError).toBeFalsy();
      expect(JSON.parse(textOf(owner) ?? '')).toEqual({ lines: [] });
    });

    it.each([
      ['hub_pull_model', { modelId: 'phi-4-mini' }],
      ['hub_set_auto_updates', { enabled: false }],
    ])("refuses %s to a member's key too", async (name, args) => {
      const client = await connect();

      const res = await as(writeKey(MEMBER), () => client.callTool({ name, arguments: args }));

      expect(textOf(res)).toBe(`HUB_MANAGE_ROLE_REQUIRED {"tool":"${name}"}`);
      expect(modelPuller.pullAndWait).not.toHaveBeenCalled();
      expect(systemUpdate.setAutoUpdatesEnabled).not.toHaveBeenCalled();
    });

    it("leaves the per-app tools to the lifecycle service's own rule, for a member's key and a managed key", async () => {
      const client = await connect();

      const member = await as(writeKey(MEMBER), () => client.callTool({ name: 'hub_start_app', arguments: { appUrn: 'immich:ci-marketplace' } }));
      const managed = await as(managedKey(), () => client.callTool({ name: 'hub_start_app', arguments: { appUrn: 'immich:ci-marketplace' } }));

      expect(member.isError).toBeFalsy();
      expect(managed.isError).toBeFalsy();
      expect(lifecycle.startApp).toHaveBeenCalledWith({
        appUrn: 'immich:ci-marketplace',
        actor: { kind: 'mcp', ownerAppUrn: null, createdByUserId: MEMBER, capability: 'write' },
      });
      expect(lifecycle.startApp).toHaveBeenCalledWith({
        appUrn: 'immich:ci-marketplace',
        actor: { kind: 'mcp', ownerAppUrn: 'ci-hermes:ci-marketplace', createdByUserId: null, capability: 'write' },
      });
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });
  });

  describe('tools/list', () => {
    it.each([
      ['the operator who claimed the Hub', CLAIMER],
      ['an owner', OWNER],
      ['an admin', ADMIN],
    ])('lists the Hub-wide tools for a key made by %s', async (_label, creator) => {
      const client = await connect();

      expect(await listedHubWide(client, writeKey(creator))).toEqual(HUB_WIDE_WRITE_VISIBLE);
    });

    it.each([
      ["a member's key", writeKey(MEMBER)],
      ['a key with no recorded creator', writeKey(null)],
      ['a managed app key', managedKey()],
    ])('leaves them out for %s, and keeps the per-app tools', async (_label, key) => {
      const client = await connect();
      const { tools } = await as(key, () => client.listTools());

      expect(await listedHubWide(client, key)).toEqual([]);
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['hub_start_app', 'hub_get_cloud_providers', 'hub_list_models']));
    });

    it('leaves out the Hub log for a read key a member made', async () => {
      const client = await connect();

      expect(await listedHubWide(client, writeKey(MEMBER, { capability: 'read' }))).toEqual([]);
      expect(await listedHubWide(client, writeKey(OWNER, { capability: 'read' }))).toEqual(['hub_get_hub_logs']);
    });

    it("reads the role the Hub stored, so listing never waits on the Portal or fails while it's down", async () => {
      portalRoles = null;
      const client = await connect();

      expect(await listedHubWide(client, writeKey(OWNER))).toEqual(HUB_WIDE_WRITE_VISIBLE);
      expect(await listedHubWide(client, writeKey(MEMBER))).toEqual([]);
      expect(portal.whoisApps).not.toHaveBeenCalled();
    });

    it("lists them when no role is stored, and the call answers 503 if the Portal still can't say", async () => {
      portalRoles = null;
      const client = await connect();

      expect(await listedHubWide(client, writeKey(UNSTORED))).toEqual(HUB_WIDE_WRITE_VISIBLE);
      const res = await as(writeKey(UNSTORED), () => setCloudProvider(client));
      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_UNVERIFIED {"tool":"hub_set_cloud_provider"}');
    });
  });

  // The 2026-07-28 handler builds a server per request with only the tools the key may list, so a
  // left-out tool is unknown to tools/call there as well.
  describe('the per-request (2026-07-28) server', () => {
    async function connectV2(key: ApiKeyContext): Promise<Client> {
      const logger = mock<LoggerService>();
      const server = await as(key, () => new McpV2ServerFactory(registry, new McpService(registry, logger), logger, whois).create({ era: 'legacy' }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport as never);
      const client = new Client({ name: 'hub-wide-test', version: '1.0.0' });
      await client.connect(clientTransport);
      return client;
    }

    it("registers the Hub-wide tools for an owner's key and not for a member's", async () => {
      const ownerClient = await connectV2(writeKey(OWNER));
      const memberClient = await connectV2(writeKey(MEMBER));

      expect(await listedHubWide(ownerClient, writeKey(OWNER))).toEqual(HUB_WIDE_WRITE_VISIBLE);
      expect(await listedHubWide(memberClient, writeKey(MEMBER))).toEqual([]);
    });

    it("still asks about the creator when an owner's key calls one", async () => {
      portalRoles = { [OWNER]: 'member' };
      const client = await connectV2(writeKey(OWNER));

      const res = await as(writeKey(OWNER), () => setCloudProvider(client));

      expect(textOf(res)).toBe('HUB_MANAGE_ROLE_REQUIRED {"tool":"hub_set_cloud_provider"}');
      expect(cloudFallback.setProvider).not.toHaveBeenCalled();
    });
  });

  /*
   * The same through the real 2026-07-28 handler, over a socket, with the key's context set around it as
   * `McpController` sets it: the per-request factory is awaited inside that context.
   */
  describe('the 2026-07-28 HTTP handler', () => {
    const servers: http.Server[] = [];

    afterEach(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    /** The JSON-RPC answer to one 2026-07-28 request, made with `key`. */
    async function modernRequest(key: ApiKeyContext, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const logger = mock<LoggerService>();
      const modern = new McpModernHandlerService(new McpV2ServerFactory(registry, new McpService(registry, logger), logger, whois), logger);
      modern.onModuleInit();
      const server = http.createServer((req, res) => void mcpCallContext.run(key, () => modern.handleRequest(req, res)));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

      const name = typeof params.name === 'string' ? { 'mcp-name': params.name } : {};
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          ...name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'hub-wide-test', version: '1.0.0' },
            },
          },
        }),
      });
      const text = await res.text();
      const data = text.startsWith('{')
        ? text
        : (text
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length) ?? text);
      return JSON.parse(data) as Record<string, unknown>;
    }

    const toolNames = (answer: Record<string, unknown>) =>
      ((answer.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);

    it("lists and runs a Hub-wide tool for an owner's key", async () => {
      expect(toolNames(await modernRequest(writeKey(OWNER), 'tools/list'))).toEqual(expect.arrayContaining(HUB_WIDE_WRITE_VISIBLE));

      const answer = await modernRequest(writeKey(OWNER), 'tools/call', { name: 'hub_set_auto_updates', arguments: { enabled: false } });

      expect((answer.result as { isError?: boolean }).isError).toBeFalsy();
      expect(systemUpdate.setAutoUpdatesEnabled).toHaveBeenCalledWith(false);
    });

    it("leaves them out for a member's key, so a call names an unknown tool and changes nothing", async () => {
      const listed = toolNames(await modernRequest(writeKey(MEMBER), 'tools/list'));
      expect(listed).toEqual(expect.arrayContaining(['hub_start_app', 'hub_get_auto_updates']));
      expect(listed.filter((name) => registry.getTool(name)?.hubWide)).toEqual([]);

      const answer = await modernRequest(writeKey(MEMBER), 'tools/call', { name: 'hub_set_auto_updates', arguments: { enabled: false } });

      expect(answer.error).toMatchObject({ message: expect.stringContaining('Tool hub_set_auto_updates not found') });
      expect(systemUpdate.setAutoUpdatesEnabled).not.toHaveBeenCalled();
    });
  });
});
