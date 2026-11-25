/**
 * Does CI-Marketplace's copy of the Hub's listing rules still decide every case the way the Hub does?
 *
 * The marketplace checks a listing before it ships with copies of the rules the Hub applies at
 * install (`scripts/lib/hub-manifest-rules.ts`, `scripts/lib/hub-compose-rules.ts` in that repo): a
 * listing the Hub would refuse should fail there, not on someone's Hub. A copy that falls behind a
 * Hub change lets such a listing ship. So this runs the Hub's own rules and the marketplace's copies
 * on the same inputs (every listing in the catalog, plus the edge cases below) and lists every input
 * on which they disagree, and every shared constant that differs.
 *
 * Run from BOTH repos: the Hub's `marketplace-rules-parity.test.ts`, and the marketplace's
 * `__tests__/hub-rules-parity.test.ts`, which imports this file from a CI-Hub checkout. So it may
 * import only zod and this package's own schemas: nothing from the backend, nothing that needs a
 * build. Each repo's test config maps `zod` to its own copy, so a checkout of the other repo needs no
 * install.
 *
 * Deliberate differences, not reported: the marketplace's `edge_auth` refuses keys it does not know
 * (the Hub ignores them, so a misspelt key would do nothing), so unknown-key cases are left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentConfigSchema } from '../agent-config.js';
import {
  HUB_OWNED_APP_ENV_VARS,
  hubIntegrationMayWrite,
  hubIntegrationSchema,
  MAX_PUBLIC_PATHS,
  MCP_LAUNCH_MODES,
  MCP_TRANSPORTS,
  marketplaceMcpSchema,
  publicPathSchema,
} from '../app-info.js';
import { type AppSecurityGrants, collectServiceSecurityViolations, TRUSTED_APP_SECURITY_ALLOWLIST } from '../dynamic-compose.js';
import { hostDockerArgvRefusal } from '../mcp-host-docker.js';

/** The marketplace files that hold the copies, relative to its checkout. */
export const MARKETPLACE_RULE_FILES = ['scripts/lib/hub-manifest-rules.ts', 'scripts/lib/hub-compose-rules.ts'] as const;

/** Whether `dir` is a CI-Marketplace checkout that holds the copies. */
export function holdsMarketplaceRuleCopies(dir: string): boolean {
  return MARKETPLACE_RULE_FILES.every((file) => fs.existsSync(path.join(dir, file)));
}

interface SafeParser {
  safeParse(value: unknown): { success: boolean };
}

/** What this check reads from the marketplace's two files. */
interface MarketplaceRules {
  HUB_OWNED_APP_ENV_VARS: ReadonlySet<string>;
  hubIntegrationMayWrite(name: string): boolean;
  MCP_TRANSPORTS: readonly string[];
  MCP_LAUNCH_MODES: readonly string[];
  MAX_PUBLIC_PATHS: number;
  publicPathSchema: SafeParser;
  edgeAuthSchema: SafeParser;
  marketplaceMcpSchema: SafeParser;
  agentConfigSchema: SafeParser;
  hostDockerArgvRefusal(command: readonly string[]): string | null;
  HUB_TRUSTED_APP_GRANTS: Record<string, AppSecurityGrants>;
  listingServiceViolations(service: Record<string, unknown>, grants?: AppSecurityGrants): unknown[];
}

async function loadMarketplaceRules(dir: string): Promise<MarketplaceRules> {
  const modules = await Promise.all(MARKETPLACE_RULE_FILES.map((file) => import(pathToFileURL(path.join(dir, file)).href)));
  return Object.assign({}, ...modules) as MarketplaceRules;
}

interface Listing {
  app: string;
  config: Record<string, unknown>;
  services: Record<string, unknown>[];
}

/** Every listing in the catalog: its config.json and its compose services. */
function readCatalog(dir: string): Listing[] {
  const appsDir = path.join(dir, 'apps');
  return fs
    .readdirSync(appsDir)
    .filter((app) => !app.startsWith('_') && fs.existsSync(path.join(appsDir, app, 'config.json')))
    .sort()
    .map((app) => {
      const config = JSON.parse(fs.readFileSync(path.join(appsDir, app, 'config.json'), 'utf8')) as Record<string, unknown>;
      const composePath = path.join(appsDir, app, 'docker-compose.json');
      const compose = fs.existsSync(composePath) ? (JSON.parse(fs.readFileSync(composePath, 'utf8')) as { services?: unknown }) : {};
      const services = Array.isArray(compose.services) ? (compose.services as Record<string, unknown>[]) : [];
      return { app, config, services };
    });
}

// ── Edge cases, beside whatever the catalog holds ──────────────────────────

const ENV_NAME_CASES = [
  'APP_DATA_DIR',
  'APP_BASE_URL',
  'APP_PORT',
  'MY_TOKEN',
  'lower_case',
  '_UNDER',
  '1LEADING',
  'HAS-DASH',
  'HAS SPACE',
  '',
  'A\nB',
  'A=B',
];

const PUBLIC_PATH_CASES = [
  '/hook',
  '/webhook/',
  '/api/v1/events',
  '/a.b_c~d-e',
  '/',
  'hook',
  '//hook',
  '/hook/../admin',
  '/./hook',
  '/hook%2F..',
  '/hook path',
  '/hook`) || PathPrefix(`/',
  `/${'a'.repeat(127)}`,
  `/${'a'.repeat(128)}`,
];

const EDGE_AUTH_CASES: unknown[] = [
  {},
  { default: true },
  { default: false },
  { default: 'yes' },
  { suggested_public_paths: ['/hook'] },
  { suggested_public_paths: ['/hook/../admin'] },
  { suggested_public_paths: Array.from({ length: MAX_PUBLIC_PATHS }, (_, i) => `/p${i}`) },
  { suggested_public_paths: Array.from({ length: MAX_PUBLIC_PATHS + 1 }, (_, i) => `/p${i}`) },
  { suggested_public_paths: '/hook' },
];

const IMAGE = `ghcr.io/acme/mcp@sha256:${'a'.repeat(64)}`;
const ARGV_CASES: string[][] = [
  ['docker', 'run', '-i', '--rm', IMAGE],
  ['docker', 'run', '--interactive', '--init', '-e', 'TOKEN', '-e', 'MODE=fast', '-p', '8080:8080', IMAGE, '--flag'],
  ['docker', 'run', '--env=TOKEN', '--publish=9000/udp', 'acme/mcp:1.2'],
  ['docker', 'exec', 'x'],
  ['sh', '-c', 'docker run x'],
  ['docker', 'run', '--privileged', IMAGE],
  ['docker', 'run', '-v', '/:/host', IMAGE],
  ['docker', 'run', '--network=host', IMAGE],
  ['docker', 'run', '-e', '../etc', IMAGE],
  ['docker', 'run', '-p', '0.0.0.0:80:80', IMAGE],
  ['docker', 'run', '-e'],
  ['docker', 'run', '--rm=true', IMAGE],
  ['docker', 'run', '-i'],
  ['docker', 'run', 'Not-An-Image'],
];

// The `${...}` strings below are compose expansions a listing writes, taken literally.
const SERVICE_CASES: Record<string, unknown>[] = [
  {},
  { privileged: true },
  { networkMode: 'host' },
  { networkMode: 'container:other' },
  { networkMode: 'bridge' },
  { pid: 'host' },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  { pid: '${PID:-host}' },
  { capAdd: ['CHOWN', 'NET_BIND_SERVICE'] },
  { capAdd: ['SYS_ADMIN'] },
  { capAdd: ['cap_net_admin'] },
  { securityOpt: ['no-new-privileges:true'] },
  { securityOpt: ['apparmor=unconfined'] },
  { securityOpt: ['seccomp=unconfined'] },
  { devices: ['/dev/dri:/dev/dri'] },
  { devices: ['/dev/sg0:/dev/sg0'] },
  { devices: ['/dev/uinput'] },
  { devices: ['/dev/hidraw0'] },
  { devices: ['/dev/input/event0'] },
  { devices: ['/dev/mem'] },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  { volumes: [{ hostPath: '${APP_DATA_DIR}/data' }] },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  { volumes: [{ hostPath: '${APP_DATA_DIR}/../other' }] },
  { volumes: [{ hostPath: '/etc/localtime' }] },
  { volumes: [{ hostPath: '/' }] },
  { volumes: [{ hostPath: '/var/run/docker.sock' }] },
  { volumes: [{ hostPath: '/home/someone/Music' }] },
  { volumes: [{ hostPath: '/mnt/media' }] },
  { volumes: [{ volumeName: 'named' }] },
];

// ── The comparison ────────────────────────────────────────────────────────

const show = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (v instanceof Set ? [...v].sort() : v));

const sortedGrants = (grants: Record<string, AppSecurityGrants>) =>
  Object.fromEntries(
    Object.keys(grants)
      .sort()
      .map((app) => [
        app,
        Object.fromEntries(
          Object.entries(grants[app] ?? {})
            .filter(([key]) => key !== 'reason')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
        ),
      ]),
  );

/**
 * Every disagreement between the Hub's rules and the marketplace checkout at `marketplaceDir`, one
 * line each, naming the rule, the input and both verdicts. Empty when the copies are in step.
 */
export async function marketplaceRuleDifferences(marketplaceDir: string): Promise<string[]> {
  const mkt = await loadMarketplaceRules(marketplaceDir);
  const catalog = readCatalog(marketplaceDir);
  const out: string[] = [];
  const verdict = (ok: boolean) => (ok ? 'accepts' : 'refuses');
  const compare = (rule: string, input: unknown, hub: boolean, marketplace: boolean) => {
    if (hub !== marketplace) out.push(`${rule} ${show(input)}: Hub ${verdict(hub)}, marketplace ${verdict(marketplace)}`);
  };

  // Shared constants.
  const same = (name: string, hub: unknown, marketplace: unknown) => {
    if (show(hub) !== show(marketplace)) out.push(`${name} differs: Hub ${show(hub)}, marketplace ${show(marketplace)}`);
  };
  same('HUB_OWNED_APP_ENV_VARS', HUB_OWNED_APP_ENV_VARS, mkt.HUB_OWNED_APP_ENV_VARS);
  same('MCP_TRANSPORTS', [...MCP_TRANSPORTS].sort(), [...mkt.MCP_TRANSPORTS].sort());
  same('MCP_LAUNCH_MODES', [...MCP_LAUNCH_MODES].sort(), [...mkt.MCP_LAUNCH_MODES].sort());
  same('MAX_PUBLIC_PATHS', MAX_PUBLIC_PATHS, mkt.MAX_PUBLIC_PATHS);
  same('trusted app grants', sortedGrants(TRUSTED_APP_SECURITY_ALLOWLIST), sortedGrants(mkt.HUB_TRUSTED_APP_GRANTS));

  // Env names a Hub integration may make the Hub write.
  const envNames = new Set([...ENV_NAME_CASES, ...HUB_OWNED_APP_ENV_VARS, ...mkt.HUB_OWNED_APP_ENV_VARS]);
  for (const name of envNames) compare('hubIntegrationMayWrite', name, hubIntegrationMayWrite(name), mkt.hubIntegrationMayWrite(name));

  // Public paths and edge_auth.
  const hubEdgeAuth = hubIntegrationSchema.unwrap().shape.edge_auth;
  const catalogEdgeAuth = catalog
    .map((l) => (l.config.hub_integration as { edge_auth?: unknown } | undefined)?.edge_auth)
    .filter((e) => e !== undefined);
  const catalogPaths = catalogEdgeAuth.flatMap((e) =>
    Array.isArray((e as { suggested_public_paths?: unknown }).suggested_public_paths)
      ? (e as { suggested_public_paths: unknown[] }).suggested_public_paths
      : [],
  );
  for (const p of new Set([...PUBLIC_PATH_CASES, ...catalogPaths])) {
    compare('publicPath', p, publicPathSchema.safeParse(p).success, mkt.publicPathSchema.safeParse(p).success);
  }
  for (const e of [...EDGE_AUTH_CASES, ...catalogEdgeAuth]) {
    compare('edge_auth', e, hubEdgeAuth.safeParse(e).success, mkt.edgeAuthSchema.safeParse(e).success);
  }

  // MCP blocks and host_docker command lines: the catalog's, and each with its transport or launch
  // mode swapped for one neither side should take.
  const catalogMcp = catalog.map((l) => l.config.mcp).filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null);
  const mcpCases = catalogMcp.flatMap((m) => [m, { ...m, transport: 'sse' }, { ...m, launch: 'host_shell' }]);
  for (const m of mcpCases) compare('mcp', m, marketplaceMcpSchema.safeParse(m).success, mkt.marketplaceMcpSchema.safeParse(m).success);
  const catalogArgv = catalogMcp.map((m) => m.command).filter((c): c is string[] => Array.isArray(c) && c.every((a) => typeof a === 'string'));
  for (const argv of [...ARGV_CASES, ...catalogArgv]) {
    compare('host_docker argv', argv, hostDockerArgvRefusal(argv) === null, mkt.hostDockerArgvRefusal(argv) === null);
  }

  // agents blocks: the catalog's, and each with its OpenAPI spec pointed outside the app's folder.
  const catalogAgents = catalog.map((l) => l.config.agents).filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null);
  const agentCases = catalogAgents.flatMap((a) => {
    const openapi = a.openapi as Record<string, unknown> | undefined;
    return openapi ? [a, { ...a, openapi: { ...openapi, spec_path: '../../../data/state/settings.json' } }] : [a];
  });
  for (const a of agentCases) compare('agents', a, agentConfigSchema.safeParse(a).success, mkt.agentConfigSchema.safeParse(a).success);

  // Compose services. A store listing's grants are the Hub's own allowlist entry for its name, checked
  // with the listing rule for host binds (`securityGrantsFor` for an official-store app).
  const hubGrants = (app?: string): AppSecurityGrants => ({
    ...(app !== undefined && Object.hasOwn(TRUSTED_APP_SECURITY_ALLOWLIST, app) ? TRUSTED_APP_SECURITY_ALLOWLIST[app] : {}),
    hostBindAuthor: 'listing',
  });
  for (const service of SERVICE_CASES) {
    compare(
      'service',
      service,
      collectServiceSecurityViolations(service, hubGrants()).length === 0,
      mkt.listingServiceViolations(service).length === 0,
    );
  }
  for (const { app, services } of catalog) {
    for (const service of services) {
      compare(
        `service of ${app}`,
        { name: service.name },
        collectServiceSecurityViolations(service, hubGrants(app)).length === 0,
        mkt.listingServiceViolations(service, mkt.HUB_TRUSTED_APP_GRANTS[app]).length === 0,
      );
    }
  }

  return out;
}
