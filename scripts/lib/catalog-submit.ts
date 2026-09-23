import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

import { CI_CLOUD_DEFAULT } from './cli-types.js';
import { printMessageBox } from './cli-ui.js';

const BUNDLE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_CATALOG_ID_LENGTH = 48;
const LOGIN_FILE_NAME = 'portal-login.json';

/** Submitting apps to the marketplace. What `cihub login` has always minted. */
export const CATALOG_WRITE_SCOPE = 'catalog:write';

/** Registering devices into the org, so a fleet install needs no browser per box. */
export const DEVICE_PAIR_SCOPE = 'device:pair';

/**
 * Everything `device:pair` grants, and the rest of a device's life: listing an org's devices,
 * minting a replacement pairing code for one, deleting one. Its own scope so a fleet install that
 * only needs to enrol machines never holds a token that can destroy their records.
 */
export const DEVICE_MANAGE_SCOPE = 'device:manage';

export const CLI_LOGIN_SCOPES = [CATALOG_WRITE_SCOPE, DEVICE_PAIR_SCOPE, DEVICE_MANAGE_SCOPE] as const;

/** Whether a stored login may mint devices — `device:pair`, or the `device:manage` that includes it. */
export function loginCanPairDevices(login: Pick<PortalLogin, 'scope'> | null | undefined): boolean {
  const scope = loginScope(login);
  return scope === DEVICE_PAIR_SCOPE || scope === DEVICE_MANAGE_SCOPE;
}

export type CliLoginScope = (typeof CLI_LOGIN_SCOPES)[number];

export type PortalLogin = {
  token: string;
  tokenId?: string | null;
  orgId: string;
  orgSlug: string | null;
  portalOrigin: string;
  /** Absent on a login stored before scopes existed, which means catalog:write. */
  scope?: CliLoginScope;
};

/** What a stored login can do. An old file has no scope and predates any but catalog:write. */
export function loginScope(login: Pick<PortalLogin, 'scope'> | null | undefined): CliLoginScope | null {
  if (!login) {
    return null;
  }

  return login.scope ?? CATALOG_WRITE_SCOPE;
}

export type CatalogSubmitOptions = {
  dir?: string;
  dryRun?: boolean;
  token?: string;
  orgId?: string;
  portalOrigin?: string;
  skipPush?: boolean;
  fetchImpl?: typeof fetch;
  docker?: (args: string[], options?: { input?: string }) => { status: number; stdout: string; stderr: string };
};

export type CatalogLoginOptions = {
  device?: boolean;
  org?: string;
  scope?: string;
  portalOrigin?: string;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

type ComposeService = {
  name?: string;
  image?: string;
  isMain?: boolean;
};

export function portalOriginFromEnv(env: NodeJS.ProcessEnv = process.env, explicit?: string, stored?: string | null): string {
  const raw = explicit || env.CI_PORTAL_ORIGIN || env.CI_CLOUD_URL || stored || CI_CLOUD_DEFAULT;
  return raw.replace(/\/$/, '');
}

export function registryHostFromOrigin(origin: string): string {
  return new URL(origin).host;
}

export function loopbackStateMatches(received: string | null, expected: string): boolean {
  return received === expected;
}

export function catalogIdFor(bundleId: string, organizationSlug: string): string {
  return `${bundleId}_${organizationSlug}`;
}

export function isValidBundleId(bundleId: string): boolean {
  return BUNDLE_ID.test(bundleId) && !bundleId.includes('--');
}

export function imageTag(image: string): string {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return image.slice(lastColon + 1);
  }
  return 'latest';
}

export function rewriteComposeImages(
  compose: { services?: ComposeService[] },
  catalogId: string,
  registryHost: string,
): { compose: { services?: ComposeService[] }; images: { service: string; source: string; target: string }[] } {
  const services = Array.isArray(compose.services) ? compose.services.map((service) => ({ ...service })) : [];
  const withImages = services.filter((service) => typeof service.image === 'string' && service.image.trim());
  const main = withImages.find((service) => service.isMain) ?? withImages[0];
  const images: { service: string; source: string; target: string }[] = [];

  for (const service of services) {
    if (typeof service.image !== 'string' || !service.image.trim()) {
      continue;
    }
    const source = service.image.trim();
    const tag = imageTag(source);
    const isMain = service === main || (withImages.length === 1 && service.image === main?.image);
    const repo = isMain || withImages.length === 1 ? catalogId : `${catalogId}/${service.name ?? 'service'}`;
    const target = `${registryHost}/${repo}:${tag}`;
    images.push({ service: service.name ?? repo, source, target });
    service.image = target;
  }

  return { compose: { ...compose, services }, images };
}

export function validateSubmitDir(dir: string): {
  config: Record<string, unknown>;
  compose: { services?: ComposeService[] };
  missing: string[];
} {
  const configPath = join(dir, 'config.json');
  const composePath = join(dir, 'docker-compose.json');
  const descriptionPath = join(dir, 'metadata', 'description.md');
  const logoPng = join(dir, 'metadata', 'logo.png');
  const logoJpg = join(dir, 'metadata', 'logo.jpg');
  const missing: string[] = [];

  if (!existsSync(configPath)) missing.push('config.json');
  if (!existsSync(composePath)) missing.push('docker-compose.json');
  if (!existsSync(descriptionPath)) missing.push('metadata/description.md');
  if (!existsSync(logoPng) && !existsSync(logoJpg)) missing.push('metadata/logo.png or metadata/logo.jpg');

  const config = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>) : {};
  const compose = existsSync(composePath) ? (JSON.parse(readFileSync(composePath, 'utf8')) as { services?: ComposeService[] }) : {};

  return { config, compose, missing };
}

export function loginFilePath(home = process.env.HOME || process.env.USERPROFILE || tmpdir()): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return join(xdg, 'cihub', LOGIN_FILE_NAME);
}

export function readStoredLogin(filePath = loginFilePath()): PortalLogin | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PortalLogin;
    if (typeof parsed.token !== 'string' || typeof parsed.orgId !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredLogin(login: PortalLogin, filePath = loginFilePath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
}

export function deleteStoredLogin(filePath = loginFilePath()): void {
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

/**
 * A Portal login taken from the environment, for runs nobody is sitting at — a test harness, CI, a
 * fleet script. `null` when `CI_PORTAL_TOKEN` is unset, so callers fall back to the file `cihub login`
 * writes; set, it wins, because an unattended run must never reach the browser `cihub login` opens.
 *
 * The variables are the ones `cihub submit` already reads, plus `CI_PORTAL_SCOPE`: Portal knows a
 * token's scope but nothing on the wire tells the CLI, which gates on it before calling. Absent means
 * catalog:write, exactly as for a stored login that predates scopes. `CI_PORTAL_ORG` is required
 * rather than borrowed from the stored login — a token is minted for one organization, and pairing
 * under another's id is the kind of mismatch Portal answers with a bare 409.
 *
 * Portal developer tokens do not expire (they are revoked), so one approval in the browser is the
 * last one: mint a `device:manage` token once, put it here, and every later run is headless.
 */
export function portalLoginFromEnv(env: NodeJS.ProcessEnv = process.env): PortalLogin | null {
  const token = env.CI_PORTAL_TOKEN?.trim();
  if (!token) {
    return null;
  }
  const orgId = env.CI_PORTAL_ORG?.trim();
  if (!orgId) {
    throw new Error('CI_PORTAL_TOKEN is set but CI_PORTAL_ORG is not: set it to the id of the organization the token was minted for');
  }
  const scope = env.CI_PORTAL_SCOPE?.trim();
  if (scope && !(CLI_LOGIN_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`CI_PORTAL_SCOPE must be one of ${CLI_LOGIN_SCOPES.join(', ')}; got '${scope}'`);
  }
  return {
    token,
    orgId,
    orgSlug: env.CI_PORTAL_ORG_SLUG?.trim() || null,
    portalOrigin: portalOriginFromEnv(env),
    ...(scope ? { scope: scope as CliLoginScope } : {}),
  };
}

export function resolveSubmitCredentials(args: {
  token?: string;
  orgId?: string;
  orgSlug?: string;
  env?: NodeJS.ProcessEnv;
  stored?: PortalLogin | null;
}): { token: string; orgId: string; orgSlug: string | null } | { error: string } {
  const env = args.env ?? process.env;
  const token = args.token || env.CI_PORTAL_TOKEN || args.stored?.token;
  const orgId = args.orgId || env.CI_PORTAL_ORG || args.stored?.orgId;
  const orgSlug = args.orgSlug || env.CI_PORTAL_ORG_SLUG || args.stored?.orgSlug || null;
  if (!token || !orgId) {
    return {
      error: 'run cihub login (or set --token / CI_PORTAL_TOKEN and --org / CI_PORTAL_ORG)',
    };
  }
  return { token, orgId, orgSlug };
}

export type MintedPairingCode = { deviceId: string; pairingCode: string; name: string; slug: string };

/**
 * Register a device with Portal and return its pairing code, using a stored
 * `device:pair` login instead of a browser.
 *
 * This is the same `POST /api/devices` the Portal UI calls when someone clicks
 * "Add device" — the token stands in for that session, and Portal still checks
 * the token holder is a member of the org. What it removes is the human, not
 * the authorization.
 */
export async function mintPairingCode(params: { name: string; login: PortalLogin; fetchImpl?: typeof fetch }): Promise<MintedPairingCode> {
  if (!loginCanPairDevices(params.login)) {
    throw new Error(`the stored Portal login has scope ${loginScope(params.login) ?? 'none'}; run: cihub login --scope ${DEVICE_PAIR_SCOPE}`);
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(`${params.login.portalOrigin}/api/devices`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.login.token}`,
    },
    body: JSON.stringify({ name: params.name, organization_id: params.login.orgId }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    deviceId?: string;
    pairingCode?: string;
    name?: string;
    slug?: string;
    error?: string;
  };

  if (!response.ok || !body.pairingCode || !body.deviceId) {
    // 409 is the one an operator can act on without reading Portal: the name is
    // taken, which on a fleet run usually means this node was already enrolled.
    const detail = response.status === 409 ? `a device named "${params.name}" already exists in this org` : (body.error ?? `HTTP ${response.status}`);

    throw new Error(detail);
  }

  return {
    deviceId: body.deviceId,
    pairingCode: body.pairingCode,
    name: body.name ?? params.name,
    slug: body.slug ?? params.name,
  };
}

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name), 0);
  header.set(encoder.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  header[156] = 48;
  header.set(encoder.encode('ustar\0'), 257);
  header.set(encoder.encode('00'), 263);
  for (let i = 148; i < 156; i++) header[i] = 32;
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(encoder.encode(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
  return header;
}

export function packBundleTarGz(dir: string, composeJson: string): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: 'config.json', data: encoder.encode(readFileSync(join(dir, 'config.json'), 'utf8')) },
    { name: 'docker-compose.json', data: encoder.encode(composeJson) },
  ];

  const walk = (relative: string) => {
    const full = join(dir, relative);
    if (!existsSync(full)) {
      return;
    }
    for (const name of readdirSync(full)) {
      const childRelative = join(relative, name);
      const childFull = join(dir, childRelative);
      if (statSync(childFull).isDirectory()) {
        walk(childRelative);
        continue;
      }
      files.push({ name: childRelative.replaceAll('\\', '/'), data: new Uint8Array(readFileSync(childFull)) });
    }
  };

  walk('metadata');
  walk('data');

  for (const file of files) {
    const padded = new Uint8Array(Math.ceil(file.data.byteLength / 512) * 512);
    padded.set(file.data);
    parts.push(tarHeader(file.name, file.data.byteLength), padded);
  }
  parts.push(new Uint8Array(1024));
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return gzipSync(output);
}

function defaultDocker(args: string[], options?: { input?: string }) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    input: options?.input,
    stdio: options?.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function prepareSubmitPlan(dir: string, orgSlug: string, registryHost: string) {
  const { config, compose, missing } = validateSubmitDir(dir);
  if (missing.length > 0) {
    return { ok: false as const, error: `Missing ${missing.join(', ')}` };
  }
  const bundleId = typeof config.id === 'string' ? config.id : '';
  if (!isValidBundleId(bundleId)) {
    return { ok: false as const, error: 'Invalid bundle id' };
  }
  const catalogId = catalogIdFor(bundleId, orgSlug);
  if (catalogId.length > MAX_CATALOG_ID_LENGTH) {
    return { ok: false as const, error: `Catalog id exceeds ${MAX_CATALOG_ID_LENGTH} characters` };
  }
  const rewritten = rewriteComposeImages(compose, catalogId, registryHost);
  return { ok: true as const, catalogId, bundleId, rewritten };
}

export async function runCatalogSubmit(rawArgs: string[], options: CatalogSubmitOptions = {}): Promise<void> {
  const args = [...rawArgs];
  const dryRun = options.dryRun || args.includes('--dry-run');
  const skipPush = options.skipPush === true;
  const tokenFlag = takeFlag(args, '--token');
  const orgFlag = takeFlag(args, '--org');
  const portalFlag = takeFlag(args, '--portal');
  const orgSlugFlag = takeFlag(args, '--org-slug');
  args.splice(0, args.length, ...args.filter((arg) => arg !== '--dry-run'));
  const dir = options.dir || args.find((arg) => !arg.startsWith('--'));
  if (!dir) {
    printMessageBox('Usage', ['cihub submit [--dry-run] [--token <cio_>] [--org <orgId>] [--org-slug <slug>] <dir>'], 'red');
    process.exit(2);
  }

  const stored = readStoredLogin();
  const portalOrigin = portalOriginFromEnv(process.env, options.portalOrigin || portalFlag, stored?.portalOrigin);
  const registryHost = registryHostFromOrigin(portalOrigin);
  const credentials = resolveSubmitCredentials({
    token: options.token || tokenFlag,
    orgId: options.orgId || orgFlag,
    orgSlug: orgSlugFlag,
    stored,
  });
  if (!dryRun && 'error' in credentials) {
    printMessageBox('Not logged in', [`${credentials.error}`, `Portal ${portalOrigin}/cli/login`], 'red');
    process.exit(2);
  }

  const orgSlug = orgSlugFlag || ('error' in credentials ? stored?.orgSlug : credentials.orgSlug);
  if (!orgSlug) {
    printMessageBox('Organization slug required', ['Run cihub login, or pass --org-slug so the CLI can form {bundle}_{org} catalog ids.'], 'red');
    process.exit(2);
  }

  const plan = await prepareSubmitPlan(path.resolve(dir), orgSlug, registryHost);
  if (!plan.ok) {
    printMessageBox('Invalid bundle', [plan.error], 'red');
    process.exit(2);
  }

  if (dryRun) {
    printMessageBox(
      'cihub submit --dry-run',
      [
        `Catalog id  ${plan.catalogId}`,
        `Registry    ${registryHost}`,
        ...plan.rewritten.images.map((image) => `${image.service}: ${image.source} → ${image.target}`),
      ],
      'cyan',
    );
    return;
  }

  if ('error' in credentials) {
    process.exit(2);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const docker = options.docker ?? defaultDocker;

  if (!skipPush) {
    const mint = await fetchImpl(
      `${portalOrigin}/api/organizations/${encodeURIComponent(credentials.orgId)}/apps/${encodeURIComponent(plan.catalogId)}/registry-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access: 'push' }),
      },
    );
    if (!mint.ok) {
      printMessageBox('Registry token failed', [await mint.text()], 'red');
      process.exit(1);
    }
    const minted = (await mint.json()) as { token: string };
    const login = docker(['login', registryHost, '--username', 'cio', '--password-stdin'], { input: minted.token });
    if (login.status !== 0) {
      printMessageBox('docker login failed', [login.stderr || login.stdout], 'red');
      process.exit(1);
    }
    for (const image of plan.rewritten.images) {
      const tag = docker(['tag', image.source, image.target]);
      if (tag.status !== 0) {
        printMessageBox('docker tag failed', [`${image.source} → ${image.target}`, tag.stderr || tag.stdout], 'red');
        process.exit(1);
      }
      const pushed = docker(['push', image.target]);
      if (pushed.status !== 0) {
        printMessageBox('docker push failed', [image.target, pushed.stderr || pushed.stdout], 'red');
        process.exit(1);
      }
    }
  }

  const body = packBundleTarGz(path.resolve(dir), JSON.stringify(plan.rewritten.compose, null, 2));
  const ingest = await fetchImpl(`${portalOrigin}/api/organizations/${encodeURIComponent(credentials.orgId)}/apps/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/gzip',
    },
    body,
  });
  if (!ingest.ok) {
    printMessageBox('Ingest failed', [await ingest.text()], 'red');
    process.exit(1);
  }
  const result = (await ingest.json()) as { id: string; status: string };
  printMessageBox('Submitted', [`id ${result.id}`, `status ${result.status}`], 'green');
}

export async function runCatalogLogout(options: { fetchImpl?: typeof fetch; filePath?: string } = {}): Promise<void> {
  const filePath = options.filePath ?? loginFilePath();
  const stored = readStoredLogin(filePath);
  let revoked = false;

  if (stored?.tokenId && stored.orgId && stored.token) {
    const fetchImpl = options.fetchImpl ?? fetch;

    try {
      const response = await fetchImpl(
        `${stored.portalOrigin}/api/organizations/${encodeURIComponent(stored.orgId)}/developer-tokens/${encodeURIComponent(stored.tokenId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${stored.token}` },
        },
      );
      revoked = response.ok;
    } catch {
      revoked = false;
    }
  }

  deleteStoredLogin(filePath);

  if (stored?.tokenId && !revoked) {
    printMessageBox('Logged out locally', ['Portal did not revoke the token. Revoke it from Developer apps if it is still listed.'], 'yellow');
    return;
  }

  printMessageBox('Logged out', ['Removed the stored Portal developer token.'], 'green');
}

export async function runCatalogLogin(rawArgs: string[], options: CatalogLoginOptions = {}): Promise<void> {
  const args = [...rawArgs];
  const device = options.device || args.includes('--device') || Boolean(process.env.SSH_CONNECTION);
  const org = options.org || takeFlag(args, '--org');
  const scopeFlag = options.scope ?? takeFlag(args, '--scope');

  if (scopeFlag && !(CLI_LOGIN_SCOPES as readonly string[]).includes(scopeFlag)) {
    printMessageBox('Unknown scope', [`--scope must be one of: ${CLI_LOGIN_SCOPES.join(', ')}`], 'red');
    process.exit(1);
  }

  const scope = scopeFlag as CliLoginScope | undefined;
  const portalOrigin = portalOriginFromEnv(process.env, options.portalOrigin || takeFlag(args, '--portal'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const openUrl =
    options.openUrl ??
    ((url: string) => {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
      const openArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
      spawnSync(command, openArgs, { stdio: 'ignore' });
    });

  if (device) {
    await deviceCodeLogin({ portalOrigin, org, fetchImpl, sleep, openUrl, scope });
    return;
  }

  try {
    await loopbackLogin({ portalOrigin, org, fetchImpl, sleep, openUrl, scope });
  } catch {
    printMessageBox('Loopback unavailable', ['Falling back to device code.'], 'yellow');
    await deviceCodeLogin({ portalOrigin, org, fetchImpl, sleep, openUrl, scope });
  }
}

async function loopbackLogin(params: {
  portalOrigin: string;
  org?: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  openUrl: (url: string) => void;
  scope?: CliLoginScope;
}): Promise<void> {
  const state = randomBytes(16).toString('hex');
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!loopbackStateMatches(url.searchParams.get('state'), state)) {
        response.writeHead(400);
        response.end('state mismatch');
        return;
      }
      const oneTime = url.searchParams.get('code');
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<html><body>cihub is signed in. You can close this tab.</body></html>');
      server.close();
      if (oneTime) resolve(oneTime);
      else reject(new Error('missing code'));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('loopback bind failed'));
        return;
      }
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      void startAndOpen({ ...params, redirectUri, state }).then((userCode) => {
        const verification = new URL(`${params.portalOrigin}/cli/login`);
        verification.searchParams.set('user_code', userCode);
        if (params.org) verification.searchParams.set('org', params.org);
        printMessageBox('Authorize cihub', [`Open ${verification.toString()}`], 'cyan');
        params.openUrl(verification.toString());
      }, reject);
    });
  });

  await redeemCode(params.portalOrigin, { code }, params.fetchImpl, params.scope);
}

async function startAndOpen(params: {
  portalOrigin: string;
  fetchImpl: typeof fetch;
  redirectUri?: string;
  state?: string;
  scope?: CliLoginScope;
}): Promise<string> {
  const started = await params.fetchImpl(`${params.portalOrigin}/api/cli/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uri: params.redirectUri,
      state: params.state,
      scope: params.scope,
    }),
  });
  if (!started.ok) {
    throw new Error(await started.text());
  }
  const body = (await started.json()) as { user_code: string; device_code: string; verification_uri: string; interval?: number };
  return body.user_code.replace(/\s+/g, '');
}

async function deviceCodeLogin(params: {
  portalOrigin: string;
  org?: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  openUrl: (url: string) => void;
  scope?: CliLoginScope;
}): Promise<void> {
  const started = await params.fetchImpl(`${params.portalOrigin}/api/cli/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: params.scope }),
  });
  if (!started.ok) {
    printMessageBox('Login failed', [await started.text()], 'red');
    process.exit(1);
  }
  const body = (await started.json()) as {
    user_code: string;
    device_code: string;
    verification_uri: string;
    interval?: number;
  };
  const verification = new URL(body.verification_uri, params.portalOrigin);
  verification.searchParams.set('user_code', body.user_code.replace(/\s+/g, ''));
  if (params.org) verification.searchParams.set('org', params.org);
  printMessageBox('Authorize cihub', [`Open ${verification.toString()}`, `User code ${body.user_code}`], 'cyan');
  params.openUrl(verification.toString());

  const interval = Math.max(body.interval ?? 5, 1) * 1000;
  for (;;) {
    await params.sleep(interval);
    const polled = await params.fetchImpl(`${params.portalOrigin}/api/cli/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: body.device_code }),
    });
    const payload = (await polled.json()) as {
      token?: string;
      tokenId?: string;
      orgId?: string;
      orgSlug?: string | null;
      code?: string;
    };
    if (payload.code === 'authorization_pending') {
      continue;
    }
    if (!polled.ok || !payload.token || !payload.orgId) {
      printMessageBox('Login failed', [JSON.stringify(payload)], 'red');
      process.exit(1);
    }
    writeStoredLogin({
      token: payload.token,
      tokenId: payload.tokenId ?? null,
      orgId: payload.orgId,
      orgSlug: payload.orgSlug ?? null,
      portalOrigin: params.portalOrigin,
      scope: params.scope ?? CATALOG_WRITE_SCOPE,
    });
    printMessageBox('Logged in', [`Organization ${payload.orgSlug ?? payload.orgId}`, `Scope ${params.scope ?? CATALOG_WRITE_SCOPE}`], 'green');
    return;
  }
}

async function redeemCode(portalOrigin: string, body: { code?: string; device_code?: string }, fetchImpl: typeof fetch, scope?: CliLoginScope) {
  const polled = await fetchImpl(`${portalOrigin}/api/cli/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await polled.json()) as {
    token?: string;
    tokenId?: string;
    orgId?: string;
    orgSlug?: string | null;
  };
  if (!polled.ok || !payload.token || !payload.orgId) {
    throw new Error('token exchange failed');
  }
  writeStoredLogin({
    token: payload.token,
    tokenId: payload.tokenId ?? null,
    orgId: payload.orgId,
    orgSlug: payload.orgSlug ?? null,
    portalOrigin,
    scope: scope ?? CATALOG_WRITE_SCOPE,
  });
  printMessageBox('Logged in', [`Organization ${payload.orgSlug ?? payload.orgId}`, `Scope ${scope ?? CATALOG_WRITE_SCOPE}`], 'green');
}

function takeFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : undefined;
}
