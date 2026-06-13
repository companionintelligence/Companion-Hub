import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { isHostPortBindConflict, runDockerComposeUpOnce } from './compose-up';
import { ensureHubBindMountsWritable } from './heal-hub-bind-mounts';
import { healHubPortBindConflict, healHubPortsBeforeStartup } from './heal-hub-ports';
import { runHubCleanup } from './hub-cleanup-lib';
import { runPublicWebRepair, runPublicWebStatus, resolveHubApiBase } from './public-web-cli';

declare const CIHUB_BUILD_VERSION: string | undefined;

export const allowedEnvs = ['local', 'dev', 'staging', 'prod'] as const;

export type HubEnv = (typeof allowedEnvs)[number];
type StartMode = 'local-dev' | 'attached' | 'detached';

type Tone = 'green' | 'cyan' | 'yellow' | 'red' | 'dim' | 'magenta';
export type StepStatus = 'pending' | 'active' | 'done' | 'fail';

/** Step icons (Unicode). Exported for tests so assertions stay encoding-safe in CI. */
export const STEP_ICONS: Record<StepStatus, string> = {
  pending: '\u25CB',
  active: '\u25CF',
  done: '\u2713',
  fail: '\u2717',
};

/** Box-drawing characters used by `box()`. Exported for tests. */
export const BOX_CHARS = {
  topLeft: '\u250C',
  horizontal: '\u2500',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
} as const;

type CommandEntry = {
  command: string;
  description: string;
};

const BASE_COMMAND = 'cihub';
const CI_CLOUD_DEFAULT = 'https://hub.companionintelligence.com';
const LOCAL_DEV_BACKEND_PORT = '5004';
const LOCAL_DEV_FRONTEND_PORT = '5005';

const COMPANY_ART = 'COMPANION HUB\nci.computer';

const envFileMap: Record<HubEnv, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

function packageVersion(): string {
  const buildVersion = typeof CIHUB_BUILD_VERSION === 'string' ? CIHUB_BUILD_VERSION.trim() : '';
  const runtimeOverride = process.env.CIHUB_BUILD_VERSION?.trim() || '';
  if (buildVersion) return buildVersion;
  if (runtimeOverride) return runtimeOverride;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const commandSections: { title: string; entries: CommandEntry[] }[] = [
  {
    title: 'Setup & Registration',
    entries: [
      { command: `${BASE_COMMAND} wizard [env]`, description: 'Guided first-time or re-setup wizard' },
      { command: `${BASE_COMMAND} setup [env]`, description: 'Initialize host state, Traefik, and Docker auth config' },
      { command: `${BASE_COMMAND} register [env]`, description: 'Print cloud portal registration URL for this device' },
    ],
  },
  {
    title: 'Hub lifecycle',
    entries: [
      { command: `${BASE_COMMAND} up [env] [--detached]`, description: 'Start the hub stack' },
      { command: `${BASE_COMMAND} down [env]`, description: 'Stop the hub stack' },
      { command: `${BASE_COMMAND} restart [env]`, description: 'Restart the hub stack' },
      { command: `${BASE_COMMAND} recreate [env]`, description: 'Reset the target environment and start it again' },
      { command: `${BASE_COMMAND} status [env]`, description: 'Containers, Cloudflare tunnel, Tailscale VPN, and models' },
      { command: `${BASE_COMMAND} logs [env] [service]`, description: 'Stream compose logs for the target environment' },
      { command: `${BASE_COMMAND} config [env]`, description: 'Show resolved configuration values' },
      { command: `${BASE_COMMAND} update [--check]`, description: 'Check for or install desktop + stack update (requires Companion Hub)' },
    ],
  },
  {
    title: 'Models',
    entries: [
      { command: `${BASE_COMMAND} models list`, description: 'List installed Ollama models' },
      { command: `${BASE_COMMAND} models install <name>`, description: 'Pull an Ollama model (e.g. llama3, mistral)' },
      { command: `${BASE_COMMAND} models rm <name>`, description: 'Remove an installed Ollama model' },
    ],
  },
  {
    title: 'App lifecycle',
    entries: [
      { command: `${BASE_COMMAND} app list`, description: 'List managed Docker containers' },
      { command: `${BASE_COMMAND} app status [name]`, description: 'Show container status with ports (color-coded)' },
      { command: `${BASE_COMMAND} app logs <name> [--tail N]`, description: 'Stream container logs' },
      { command: `${BASE_COMMAND} app add <name> <image>`, description: 'Launch a new Docker container app' },
      { command: `${BASE_COMMAND} app edit <name> <image>`, description: 'Recreate a Docker container app' },
      { command: `${BASE_COMMAND} app start|stop|restart|delete <name>`, description: 'Container lifecycle controls' },
      { command: `${BASE_COMMAND} app inspect <name>`, description: 'Show container ports, env, and mounts' },
    ],
  },
  {
    title: 'Public Web',
    entries: [
      { command: `${BASE_COMMAND} public-web status [env]`, description: 'Public Web hostname diagnostics for cloudflare apps' },
      { command: `${BASE_COMMAND} public-web repair [env] [--app <name>]`, description: 'Repair env, Traefik labels, and tunnel sync' },
    ],
  },
  {
    title: 'MCP',
    entries: [
      { command: `${BASE_COMMAND} mcp setup [env]`, description: 'Enable MCP and provision MCP_API_KEY' },
      { command: `${BASE_COMMAND} mcp shutdown [env]`, description: 'Disable MCP in the target env file' },
      { command: `${BASE_COMMAND} mcp config [env]`, description: 'Show current MCP settings' },
    ],
  },
  {
    title: 'Maintenance',
    entries: [
      { command: `${BASE_COMMAND} doctor [env]`, description: 'Validate Docker, env files, bind mounts, and compose inputs' },
      { command: `${BASE_COMMAND} clean [env] [--yes]`, description: 'Remove generated host-state files for the target environment' },
      { command: `${BASE_COMMAND} reset [env] [--yes]`, description: 'Remove runtime state for the target environment' },
      { command: `${BASE_COMMAND} uninstall [--yes]`, description: 'Full machine cleanup of CI-Hub runtime state' },
    ],
  },
];

// ─── colour & text ────────────────────────────────────────────────────────────

function supportsColor() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1');
}

function colorize(text: string, tone: Tone) {
  if (!supportsColor()) return text;
  const map: Record<Tone, string> = {
    green: '[32m',
    cyan: '[36m',
    yellow: '[33m',
    red: '[31m',
    dim: '[2m',
    magenta: '[35m',
  };
  return `${map[tone]}${text}[0m`;
}

function bold(text: string) {
  return supportsColor() ? `[1m${text}[0m` : text;
}

function dim(text: string) {
  return colorize(text, 'dim');
}

export function stripAnsi(text: string) {
  const esc = String.fromCharCode(27);
  return text.replace(new RegExp(`${esc}\\[[0-9;]*m`, 'g'), '');
}

function pad(value: string, width: number) {
  return `${value}${' '.repeat(Math.max(width - stripAnsi(value).length, 0))}`;
}

function termWidth() {
  return process.stdout.columns || 80;
}

function hr(tone: Tone = 'dim') {
  return colorize('─'.repeat(termWidth()), tone);
}

// ─── boxes ───────────────────────────────────────────────────────────────────

export function box(title: string, lines: string[], tone: Tone = 'cyan') {
  const w = termWidth();
  const titleLen = stripAnsi(title).length;
  const fill = Math.max(w - titleLen - 5, 1);
  const top = `${BOX_CHARS.topLeft}${BOX_CHARS.horizontal} ${title} ${BOX_CHARS.horizontal.repeat(fill)}${BOX_CHARS.topRight}`;
  const bottom = `${BOX_CHARS.bottomLeft}${BOX_CHARS.horizontal.repeat(w - 2)}${BOX_CHARS.bottomRight}`;
  const body = (lines.length > 0 ? lines : ['']).map((l) => `  ${l}`);
  return [colorize(top, tone), ...body, colorize(bottom, tone)].join('\n');
}

function renderSection(title: string, entries: CommandEntry[]) {
  const width = Math.max(...entries.map((e) => e.command.length));
  const lines = entries.map((e) => `${pad(colorize(e.command, 'green'), width)}  ${e.description}`);
  return box(title, lines, 'cyan');
}

function printMessageBox(title: string, lines: string[], tone: Tone = 'cyan') {
  console.log(box(title, lines, tone));
}

// ─── step indicator ──────────────────────────────────────────────────────────

export function renderStep(n: number, total: number, label: string, status: StepStatus = 'active') {
  const icons = STEP_ICONS;
  const tones: Record<StepStatus, Tone> = { pending: 'dim', active: 'cyan', done: 'green', fail: 'red' };
  const icon = colorize(icons[status], tones[status]);
  const counter = dim(`[${n}/${total}]`);
  return `${icon} ${counter} ${label}`;
}

// ─── banner ───────────────────────────────────────────────────────────────────

export function renderBanner() {
  return colorize(COMPANY_ART, 'green');
}

export function renderWizardWelcome() {
  return [
    renderBanner(),
    '',
    box(
      'Setup Wizard',
      [
        `${bold('Goal')}  Launch, configure, and register your Hub in one guided flow.`,
        `${bold('Tip')}   Press Enter to accept the shown default for each prompt.`,
        `${bold('Docs')}  cihub man  ·  cihub --help`,
      ],
      'green',
    ),
  ].join('\n');
}

export function renderHelp() {
  return [
    renderBanner(),
    '',
    box(
      'Quick start',
      [
        `${bold('First run')}  ${BASE_COMMAND} wizard`,
        `${bold('Local dev')}  ${BASE_COMMAND} up local`,
        `${bold('Install')}   npm install -g ci-hub`,
        `${bold('NPX')}       npx --package ci-hub ${BASE_COMMAND} --help`,
      ],
      'green',
    ),
    ...commandSections.map((s) => renderSection(s.title, s.entries)),
    box('Help & docs', [
      `${pad(colorize(`${BASE_COMMAND} man`, 'green'), 20)}  Manual-style command reference`,
      `${pad(colorize(`${BASE_COMMAND} --help`, 'green'), 20)}  This help output`,
      `${pad(colorize(`${BASE_COMMAND} version`, 'green'), 20)}  Show version`,
    ]),
    box('Environments', [allowedEnvs.join('  ·  ')], 'yellow'),
  ].join('\n\n');
}

export function renderManPage() {
  return [
    colorize('CIHUB(1)', 'cyan'),
    '',
    box('Synopsis', [`${BASE_COMMAND} <command> [args]`]),
    box('Description', [
      'Companion Intelligence Hub CLI — setup, registration, Docker lifecycle,',
      'MCP toggles, environment resets, and app management.',
      '',
      'All commands accept an optional [env] argument: local (default), dev, staging, prod.',
      'Use local for source-based development and dev/staging/prod for appliance-style compose environments.',
    ]),
    ...commandSections.map((s) => renderSection(s.title, s.entries)),
    box(
      'Packaging',
      [
        `npm/pnpm/bun global installs expose ${BASE_COMMAND} on PATH via the package bin entry.`,
        `Homebrew and other package managers should install the same ${BASE_COMMAND} executable.`,
      ],
      'yellow',
    ),
    box(
      'On-device testing loop',
      [`${BASE_COMMAND} reset local --yes`, `${BASE_COMMAND} up local`, `${BASE_COMMAND} wizard`, 'pnpm run test:cli'],
      'dim',
    ),
  ].join('\n\n');
}

// ─── arg helpers ─────────────────────────────────────────────────────────────

export function normalizeCliArgs(rawArgs: string[]) {
  return rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
}

export function resolveEnvFromArgs(args: string[], defaultEnv: HubEnv = 'local'): HubEnv {
  const found = args.find((a) => allowedEnvs.includes(a as HubEnv));
  const unknown = args.filter((a) => !allowedEnvs.includes(a as HubEnv));
  if (unknown.length > 0) usageAndExit(`Unexpected argument: ${unknown[0]}`);
  return (found || defaultEnv) as HubEnv;
}

// ─── env file parsing ─────────────────────────────────────────────────────────

export function parseEnvFile(envFileName: string): Record<string, string> {
  const abs = join(process.cwd(), envFileName);
  const vars: Record<string, string> = {};
  let fileContent = '';
  try {
    fileContent = readFileSync(abs, 'utf-8');
  } catch {
    return vars;
  }
  for (const line of fileContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export function upsertEnvVar(envFileName: string, key: string, value: string) {
  const abs = envFileName.startsWith('/') ? envFileName : join(process.cwd(), envFileName);
  const line = `${key}=${value}`;
  const current = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
  const lines = current.length > 0 ? current.split(/\r?\n/) : [];
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trimStart().startsWith(`${key}=`)) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(line);
  const finalContent = `${lines.filter((e, i, all) => !(i === all.length - 1 && e === '')).join('\n')}\n`;
  writeFileSync(abs, finalContent, 'utf-8');
}

function run(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}) {
  console.log(colorize(`▶ ${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`, 'dim'));
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    cwd: process.cwd(),
  });
  if (result.error) {
    console.error(colorize(`Failed to run ${cmd}: ${String(result.error)}`, 'red'));
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(cmd: string, args: string[]): { stdout: string; ok: boolean } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe' });
  return { stdout: (result.stdout || '').trim(), ok: result.status === 0 };
}

function commandExists(cmd: string): boolean {
  return runCapture(process.platform === 'win32' ? 'where' : 'which', [cmd]).ok;
}

function listeningPidsForPort(port: number): number[] {
  if (process.platform === 'win32' || !commandExists('lsof')) return [];
  const { stdout, ok } = runCapture('lsof', ['-t', '-n', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!ok || !stdout) return [];
  return stdout
    .split('\n')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function commandLineForPid(pid: number): string {
  if (process.platform === 'win32') return '';
  const { stdout, ok } = runCapture('ps', ['-p', String(pid), '-o', 'command=']);
  return ok ? stdout.trim() : '';
}

function sleepMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Intentional short synchronous wait for local-dev port cleanup.
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Best effort: if the process already exited we do not need to fail startup.
  }
}

function ensureLocalDevPortsAvailable(): void {
  const frontendPort = Number.parseInt(LOCAL_DEV_FRONTEND_PORT, 10);
  const backendPort = Number.parseInt(LOCAL_DEV_BACKEND_PORT, 10);
  const frontendPids = listeningPidsForPort(frontendPort);
  const backendPids = listeningPidsForPort(backendPort);
  const repoRoot = process.cwd();

  const staleFrontend = frontendPids.filter((pid) => {
    const command = commandLineForPid(pid);
    return command.includes(repoRoot) && command.includes('@react-router/dev/bin.js dev');
  });
  const staleBackend = backendPids.filter((pid) => {
    const command = commandLineForPid(pid);
    return (
      command.includes(repoRoot) &&
      (command.includes('nest start --watch --preserveWatchOutput') ||
        command.includes('/packages/backend/') ||
        command.includes('packages/backend/dist/src/main.js'))
    );
  });

  for (const pid of [...staleFrontend, ...staleBackend]) {
    killPid(pid);
  }

  if (staleFrontend.length > 0 || staleBackend.length > 0) {
    sleepMs(1500);
  }

  const remainingFrontend = listeningPidsForPort(frontendPort).filter((pid) => !staleFrontend.includes(pid));
  if (remainingFrontend.length > 0) {
    printMessageBox(
      'Local development port conflict',
      [`Port ${LOCAL_DEV_FRONTEND_PORT} is already in use by another process. Stop it before running ${BASE_COMMAND} up local.`],
      'red',
    );
    process.exit(2);
  }

  const remainingBackend = listeningPidsForPort(backendPort).filter((pid) => !staleBackend.includes(pid));
  if (remainingBackend.length > 0) {
    printMessageBox(
      'Local development port conflict',
      [`Port ${LOCAL_DEV_BACKEND_PORT} is already in use by another process. Stop it before running ${BASE_COMMAND} up local.`],
      'red',
    );
    process.exit(2);
  }
}

function printRemovedCommand(oldUsage: string, replacement: string, detail?: string): never {
  const lines = [`${oldUsage} was removed in this release.`, `Use ${bold(replacement)} instead.`];
  if (detail) lines.push(detail);
  printMessageBox('Command removed', lines, 'red');
  process.exit(2);
}

// ─── env / compose helpers ───────────────────────────────────────────────────

function getEnvFileOrExit(env: string): string {
  const f = envFileMap[env as HubEnv];
  if (!f) usageAndExit(`Unknown environment: ${env}`);
  return f;
}

export function getComposeFiles(env: HubEnv): string[] {
  if (env === 'local') return ['docker-compose.local.yml'];
  if (env === 'staging') return ['docker-compose.prod.yml', 'docker-compose.staging.yml'];
  return ['docker-compose.prod.yml'];
}

export function resolveRootFolderHost(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const configured = process.env.ROOT_FOLDER_HOST || vars.ROOT_FOLDER_HOST || '.internal';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function tunnelTokenPath(envFileName: string): string {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  return path.resolve(rootFolderHost, '..', 'tunnel', 'token');
}

function hasCloudflareTunnelToken(envFileName: string): boolean {
  try {
    const tokenPath = tunnelTokenPath(envFileName);
    return existsSync(tokenPath) && statSync(tokenPath).isFile() && statSync(tokenPath).size > 0;
  } catch {
    return false;
  }
}

export function mergeComposeProfilesFromEnvFile(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const hasEnvFile = Object.keys(vars).length > 0;
  if (!hasEnvFile) {
    const set = new Set(
      (process.env.COMPOSE_PROFILES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    set.add('private-vpn');
    if (hasCloudflareTunnelToken(envFileName)) set.add('cloudflare');
    return [...set].join(',');
  }
  const vpnOn = vars.PRIVATE_VPN_USER_DISABLED !== 'true';
  const set = new Set<string>([
    ...(vars.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(process.env.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  if (vpnOn) set.add('private-vpn');
  else set.delete('private-vpn');
  if (hasCloudflareTunnelToken(envFileName)) set.add('cloudflare');
  return [...set].join(',');
}

export function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const fileVars = parseEnvFile(envFileName);
  const overrides: Record<string, string | undefined> = {
    ENV_FILE: envFileName,
  };
  if (composeProfiles) overrides.COMPOSE_PROFILES = composeProfiles;

  // Identity comes from init:host / the env file (e.g. UID 0 on Docker Desktop). Never
  // replace with getuid() here — shell env wins over --env-file for compose interpolation.
  if (fileVars.CI_HUB_CONTAINER_UID) overrides.CI_HUB_CONTAINER_UID = fileVars.CI_HUB_CONTAINER_UID;
  if (fileVars.CI_HUB_CONTAINER_GID) overrides.CI_HUB_CONTAINER_GID = fileVars.CI_HUB_CONTAINER_GID;

  return overrides;
}

function renderConfigLines(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const rootFolder = resolveRootFolderHost(envFileName);
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const mcpEnabled = (process.env.MCP_ENABLED || fileVars.MCP_ENABLED || 'true') !== 'false';
  const mcpApiKey = process.env.MCP_API_KEY || fileVars.MCP_API_KEY;
  return [
    `${bold('environment')}      ${env}`,
    `${bold('env file')}         ${envFileName}`,
    `${bold('root folder')}      ${rootFolder}`,
    `${bold('cloud url')}        ${process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT}`,
    `${bold('compose profiles')} ${composeProfiles || '(none)'}`,
    `${bold('mcp enabled')}      ${mcpEnabled}`,
    `${bold('mcp api key')}      ${mcpApiKey ? '<set>' : '<not set>'}`,
  ];
}

function normalizeDetachedFlag(args: string[]): { detached: boolean; remaining: string[] } {
  return {
    detached: args.includes('--detached'),
    remaining: args.filter((arg) => arg !== '--detached'),
  };
}

// ─── docker availability ──────────────────────────────────────────────────────

function checkDockerAvailable(): boolean {
  return runCapture('docker', ['info']).ok;
}

/**
 * Commands that drive setup/lifecycle shell out to the repo's helper scripts
 * (tsx scripts/*.ts) and Docker Compose files, all resolved from process.cwd().
 * A global/npm install of cihub run outside a CI-Hub checkout has none of these,
 * so fail early with an actionable message instead of a cryptic tsx/docker error.
 */
export function isHubRepoRoot(cwd: string = process.cwd()): boolean {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath) || !existsSync(join(cwd, 'scripts'))) return false;
  try {
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string }).name === 'ci-hub';
  } catch {
    return false;
  }
}

function requireRepoRoot(action: string): void {
  if (isHubRepoRoot()) return;
  printMessageBox(
    'Run from a CI-Hub checkout',
    [
      `${action} runs CI-Hub's setup scripts and Docker Compose files,`,
      'so it must be run from a CI-Hub repository directory (the one containing',
      'package.json and docker-compose.local.yml).',
      '',
      'Packaged/global installs support: --help, man, version, status,',
      'config, and the app/models Docker passthrough commands.',
    ],
    'red',
  );
  process.exit(2);
}

export function isFirstRun(envFile = '.env.local'): boolean {
  return !existsSync(join(process.cwd(), envFile));
}

function prepareHubDataDirectory(envFileName: string): void {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  try {
    const identity = ensureHubBindMountsWritable(rootFolderHost, { envFile: join(process.cwd(), envFileName) });
    printMessageBox(
      'Data directory ready',
      [
        `Prepared ${rootFolderHost} for Hub container UID/GID ${identity.uid}:${identity.gid} (${identity.source}).`,
        'Bind mounts verified writable before startup.',
      ],
      'green',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Data directory permissions', [message], 'red');
    throw error;
  }
}

function ensureLocalDevRuntimeEnv(envFileName: string): Record<string, string> {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const runtimeEnvPath = join(rootFolderHost, '.env');
  const appDataDir = join(rootFolderHost, 'app-data');
  const sourceVars = parseEnvFile(envFileName);
  const runtimeVars = {
    ...sourceVars,
    ENV_FILE: envFileName,
    ROOT_FOLDER_HOST: rootFolderHost,
    API_PORT: sourceVars.API_PORT || LOCAL_DEV_BACKEND_PORT,
    FRONTEND_PORT: sourceVars.FRONTEND_PORT || LOCAL_DEV_FRONTEND_PORT,
    CI_HUB_DATA_DIR: sourceVars.CI_HUB_DATA_DIR || rootFolderHost,
    CI_HUB_APP_DATA_DIR: sourceVars.CI_HUB_APP_DATA_DIR || appDataDir,
    CI_HUB_APP_DATA_PATH: sourceVars.CI_HUB_APP_DATA_PATH || rootFolderHost,
    CI_HUB_VERSION: sourceVars.CI_HUB_VERSION || process.env.CI_HUB_VERSION || packageVersion(),
  };
  const content = Object.entries(runtimeVars)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(runtimeEnvPath, `${content}\n`, 'utf-8');
  return runtimeVars;
}

// ─── hub lifecycle ────────────────────────────────────────────────────────────

async function runDockerComposeUp(envFileName: string, files: string[], detached: boolean, envOverrides: Record<string, string>): Promise<void> {
  const upArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) upArgs.push('-f', f);
  upArgs.push('up');
  if (detached) upArgs.push('-d');
  upArgs.push('--build');

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runDockerComposeUpOnce(upArgs, { detached, envOverrides });
    if (result.status === 0) return;

    const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    if (attempt < maxAttempts && isHostPortBindConflict(combined)) {
      const healed = healHubPortBindConflict(envFileName, combined, (message) => {
        printMessageBox('Port self-heal', [message], 'yellow');
      });
      if (healed.info.length > 0) {
        printMessageBox('Port self-heal', healed.info, 'yellow');
      }
      continue;
    }

    if (combined) {
      printMessageBox('Docker compose failed', combined.split('\n').slice(-8), 'red');
    }
    process.exit(result.status ?? 1);
  }
}

async function startHub(mode: StartMode, env: HubEnv) {
  requireRepoRoot(mode === 'local-dev' ? 'cihub up local' : 'cihub up');
  if (mode === 'local-dev' && env !== 'local') {
    usageAndExit('Source-based local development only supports the local environment. Use "cihub up <env>" for appliance environments.');
  }
  const envFileName = getEnvFileOrExit(env);
  prepareHubDataDirectory(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);
  run('tsx', ['scripts/init-gpu-runtime.ts'], envOverrides);

  if (mode === 'local-dev') {
    ensureLocalDevPortsAvailable();
    const runtimeVars = ensureLocalDevRuntimeEnv(envFileName);
    printMessageBox(
      'Starting local development',
      ['Environment: local', 'Bringing up PostgreSQL and RabbitMQ, then launching backend/frontend from source.'],
      'green',
    );
    run(
      'docker',
      [
        'compose',
        '--env-file',
        envFileName,
        '--project-name',
        'ci-hub',
        '-f',
        'docker-compose.local.yml',
        'up',
        '-d',
        'ci-os-hub-queue',
        'ci-hub-db',
      ],
      envOverrides,
    );
    run('tsx', ['scripts/sync-postgres-password.ts', envFileName], envOverrides);
    run('pnpm', ['run', 'dev:app'], { ...runtimeVars, ...envOverrides });
    return;
  }

  if (env !== 'local') run('tsx', ['scripts/init-traefik.ts'], envOverrides);

  try {
    const portHeal = healHubPortsBeforeStartup(envFileName, (message) => {
      printMessageBox('Port preparation', [message], 'yellow');
    });
    if (portHeal.info.length > 0) {
      printMessageBox('Port preparation', portHeal.info, 'yellow');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printMessageBox('Port preparation failed', [message], 'red');
    throw error;
  }

  const files = getComposeFiles(env);
  const detached = mode === 'detached';

  printMessageBox(
    'Starting hub',
    [`Environment: ${env}`, `Mode: ${detached ? 'detached' : 'attached'}`, `Compose files: ${files.join(', ')}`],
    'green',
  );
  await runDockerComposeUp(envFileName, files, detached, envOverrides);
}

function setupHub(env: HubEnv) {
  requireRepoRoot('cihub setup');
  const envFileName = getEnvFileOrExit(env);
  prepareHubDataDirectory(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);
  run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  run('tsx', ['scripts/init-docker-config.ts'], envOverrides);
  printMessageBox('Setup complete', [`Host assets prepared for ${env}.`, `Next: ${BASE_COMMAND} register ${env}`], 'green');
}

function printConfig(env: HubEnv) {
  printMessageBox('CI-Hub configuration', renderConfigLines(env), 'cyan');
}

function registerHub(env: HubEnv) {
  requireRepoRoot('cihub register');
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const cloudUrl = process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT;
  const result = spawnSync('tsx', ['scripts/get-device-id.ts'], { encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) {
    printMessageBox(
      'Device ID unavailable',
      [
        'Could not resolve a hardware device ID on this machine.',
        'On Linux: ensure dmidecode is available, or check /etc/machine-id.',
        'On macOS: ioreg should work automatically — check scripts/get-device-id.ts.',
        '',
        'You can register manually at:',
        `  ${colorize(cloudUrl, 'cyan')}`,
      ],
      'red',
    );
    return;
  }
  const deviceId = (result.stdout || '').trim();
  const registrationUrl = `${cloudUrl.replace(/\/$/, '')}/register?deviceId=${encodeURIComponent(deviceId)}`;
  printMessageBox(
    'Device registration',
    [
      `${bold('device id')}  ${deviceId}`,
      `${bold('portal')}     ${registrationUrl}`,
      '',
      `Open the URL above to pair this device, then run: ${BASE_COMMAND} up ${env}`,
    ],
    'green',
  );
}

function composeBaseArgs(env: HubEnv): string[] {
  const envFileName = getEnvFileOrExit(env);
  const args = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of getComposeFiles(env)) args.push('-f', f);
  return args;
}

function removeLeftoverProjectContainers(): void {
  const { stdout, ok } = runCapture('docker', ['ps', '-a', '--filter', 'label=com.docker.compose.project=ci-hub', '--format', '{{.ID}}']);
  if (!ok || !stdout) return;
  const ids = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return;
  run('docker', ['rm', '-f', ...ids]);
}

function downHub(env: HubEnv, options?: { volumes?: boolean }) {
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const args = composeBaseArgs(env);
  args.push('down');
  if (options?.volumes) args.push('-v', '--remove-orphans');
  printMessageBox(options?.volumes ? 'Resetting hub runtime' : 'Stopping hub', [`Environment: ${env}`], 'yellow');
  run('docker', args, envOverrides);
  removeLeftoverProjectContainers();
}

async function restartHub(env: HubEnv, detached = false) {
  downHub(env);
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}

function pathIsWithin(base: string, target: string): boolean {
  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
}

function removeDirectoryTarget(targetPath: string, label: string, removed: string[], skipped: string[]) {
  if (!existsSync(targetPath)) {
    skipped.push(`${label}: ${targetPath}`);
    return;
  }
  const repoRoot = process.cwd();
  const homeDir = process.env.HOME || process.env.USERPROFILE || repoRoot;
  if (!pathIsWithin(repoRoot, targetPath) && !pathIsWithin(homeDir, targetPath)) {
    throw new Error(`Refusing to remove ${targetPath}; it is outside the repository and user home directory.`);
  }
  rmSync(targetPath, { recursive: true, force: true });
  removed.push(`${label}: ${targetPath}`);
}

function cleanHub(env: HubEnv) {
  requireRepoRoot('cihub clean');
  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const tunnelDir = path.resolve(rootFolderHost, '..', 'tunnel');
  const removed: string[] = [];
  const skipped: string[] = [];
  removeDirectoryTarget(rootFolderHost, 'root folder', removed, skipped);
  removeDirectoryTarget(tunnelDir, 'tunnel dir', removed, skipped);
  printMessageBox('Environment files cleaned', [...removed, ...skipped.map((line) => dim(`skipped ${line}`))], 'yellow');
}

function confirmDestructive(actionLabel: string, force: boolean) {
  if (force) return true;
  if (!process.stdin.isTTY) {
    console.error(colorize(`  ✗ ${actionLabel} is destructive — requires an interactive terminal or --yes`, 'red'));
    process.exit(2);
  }
  return false;
}

async function confirmDestructiveAction(actionLabel: string, force: boolean, prompt: string) {
  if (confirmDestructive(actionLabel, force)) return true;
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(prompt)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function resetHub(env: HubEnv, force: boolean) {
  requireRepoRoot('cihub reset');
  const confirmed = await confirmDestructiveAction(
    `Resetting ${env}`,
    force,
    `Reset ${env} runtime state (containers, volumes, and host files)? [y/N]: `,
  );
  if (!confirmed) {
    printMessageBox('Reset cancelled', ['Left runtime state untouched.'], 'yellow');
    return;
  }
  downHub(env, { volumes: true });
  cleanHub(env);
}

async function recreateHub(env: HubEnv, detached = false) {
  await resetHub(env, true);
  await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
}

function logsHub(env: HubEnv, service?: string) {
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const args = composeBaseArgs(env);
  args.push('logs', '-f');
  if (service) args.push(service);
  run('docker', args, envOverrides);
}

function doctorHub(env: HubEnv) {
  requireRepoRoot('cihub doctor');
  const envFileName = getEnvFileOrExit(env);
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const composeFiles = getComposeFiles(env);
  const lines = [
    `Docker               ${checkDockerAvailable() ? colorize('● available', 'green') : colorize('✗ unavailable', 'red')}`,
    `Docker Compose       ${runCapture('docker', ['compose', 'version']).ok ? colorize('● available', 'green') : colorize('✗ unavailable', 'red')}`,
    `Env file             ${existsSync(join(process.cwd(), envFileName)) ? colorize('● found', 'green') : colorize('○ missing', 'yellow')}  ${envFileName}`,
    `Root folder          ${existsSync(rootFolderHost) ? colorize('● present', 'green') : colorize('○ missing', 'yellow')}  ${rootFolderHost}`,
    `Compose files        ${composeFiles.every((file) => existsSync(join(process.cwd(), file))) ? colorize('● found', 'green') : colorize('✗ missing', 'red')}  ${composeFiles.join(', ')}`,
    `Tunnel token         ${hasCloudflareTunnelToken(envFileName) ? colorize('● present', 'green') : colorize('○ absent', 'dim')}`,
  ];
  printMessageBox(`Hub doctor  [${env}]`, lines, 'cyan');
}

async function uninstallHub(force: boolean) {
  requireRepoRoot('cihub uninstall');
  const confirmed = await confirmDestructiveAction('Uninstalling CI-Hub', force, 'Remove CI-Hub runtime state from this machine? [y/N]: ');
  if (!confirmed) {
    printMessageBox('Uninstall cancelled', ['Left Docker volumes, configs, and caches untouched.'], 'yellow');
    return;
  }
  const summary = runHubCleanup();
  printMessageBox(
    'Uninstall complete',
    [
      `removed directories: ${summary.removedDirs}`,
      `skipped directories: ${summary.skippedDirs}`,
      `directory failures: ${summary.failedDirs}`,
      `commands attempted: ${summary.attemptedCommands}`,
      `command failures: ${summary.failedCommands}`,
    ],
    summary.failedDirs > 0 || summary.failedCommands > 0 ? 'yellow' : 'green',
  );
}

function findComposeName(keyword: string): string {
  const { stdout } = runCapture('docker', [
    'ps',
    '--filter',
    'label=com.docker.compose.project=ci-hub',
    '--filter',
    `name=${keyword}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.split('\n').find(Boolean) || '';
}

function showStatus(env: HubEnv) {
  if (!checkDockerAvailable()) {
    printMessageBox('Hub status', ['Docker is not running or not reachable.'], 'red');
    return;
  }

  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const lines: string[] = [];

  // ── containers ────────────────────────────────────────────────────────────
  const { stdout: psOut } = runCapture('docker', [
    'ps',
    '-a',
    '--filter',
    'label=com.docker.compose.project=ci-hub',
    '--format',
    '{{.Names}}\t{{.Status}}\t{{.Ports}}',
  ]);
  lines.push(dim('Containers'));
  if (psOut) {
    for (const row of psOut.split('\n').filter(Boolean)) {
      const [name, status, ports] = row.split('\t');
      const isUp = (status || '').toLowerCase().startsWith('up');
      const dot = isUp ? colorize('●', 'green') : colorize('✗', 'red');
      const portsStr = ports ? dim(`  ${ports}`) : '';
      lines.push(`  ${dot} ${bold(name || '')}  ${dim(status || '')}${portsStr}`);
    }
  } else {
    lines.push(`  ${dim('No CI-Hub containers — run: cihub up')}`);
  }

  // ── network / access URLs ─────────────────────────────────────────────────
  lines.push('');
  lines.push(dim('Network'));
  const localPort = fileVars.FRONTEND_PORT || fileVars.BACKEND_PORT || '5002';
  lines.push(`  Dashboard      ${colorize(`http://localhost:${localPort}`, 'cyan')}`);

  const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN || fileVars.CLOUDFLARE_DOMAIN;
  const tunnelContainer = findComposeName('tunnel') || findComposeName('cloudflared');
  const tunnelUp = tunnelContainer.length > 0;
  if (cfDomain) {
    const cfStatus = tunnelUp ? colorize('● active', 'green') : colorize('○ tunnel down', 'yellow');
    lines.push(`  Cloudflare     ${cfStatus}  ${colorize(`https://${cfDomain}`, 'cyan')}`);
  } else {
    lines.push(`  Cloudflare     ${tunnelUp ? colorize('● active', 'green') : colorize('○ not configured', 'dim')}`);
  }

  const headscaleContainer = findComposeName('headscale');
  const { stdout: tsIp } = runCapture('tailscale', ['ip', '--4']);
  const tsIpClean = tsIp.trim();
  const tailscaleActive = tsIpClean.length > 0 || headscaleContainer.length > 0;
  if (tailscaleActive) {
    lines.push(`  Tailscale VPN  ${colorize('● active', 'green')}  ${tsIpClean ? colorize(tsIpClean, 'cyan') : dim('(headscale)')}`);
  } else {
    lines.push(`  Tailscale VPN  ${colorize('○ inactive', 'dim')}`);
  }

  // ── ollama models ─────────────────────────────────────────────────────────
  const ollamaContainer = findComposeName('ollama');
  if (ollamaContainer) {
    lines.push('');
    lines.push(dim('Models (Ollama)'));
    const { stdout: modelOut, ok } = runCapture('docker', ['exec', ollamaContainer, 'ollama', 'list']);
    const models = ok ? modelOut.split('\n').filter(Boolean).slice(1) : [];
    if (models.length > 0) {
      for (const m of models) lines.push(`  ${dim(m)}`);
    } else {
      lines.push(`  ${dim('None installed — run: cihub models install llama3')}`);
    }
  }

  printMessageBox(`Hub status  [${env}]`, lines, 'cyan');
}

// ─── models ───────────────────────────────────────────────────────────────────

function runModelsCommand(args: string[]) {
  const subcommand = args[0] || 'list';

  const ollamaContainer = findComposeName('ollama');
  if (!ollamaContainer) {
    printMessageBox('Models', ['Ollama container not running. Start the hub first: cihub up'], 'yellow');
    return;
  }

  if (subcommand === 'list') {
    printMessageBox('Installed models', [`Container: ${ollamaContainer}`], 'cyan');
    run('docker', ['exec', ollamaContainer, 'ollama', 'list']);
    return;
  }

  if (subcommand === 'install' || subcommand === 'pull') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models install <model-name>  (e.g. llama3, mistral, phi3)');
    printMessageBox('Installing model', [`Pulling ${bold(name)} via Ollama — this may take a few minutes…`], 'green');
    run('docker', ['exec', '-it', ollamaContainer, 'ollama', 'pull', name]);
    return;
  }

  if (subcommand === 'rm' || subcommand === 'remove') {
    const name = args[1];
    if (!name) usageAndExit('Usage: models rm <model-name>');
    printMessageBox('Removing model', [`Removing ${bold(name)} from Ollama…`], 'yellow');
    run('docker', ['exec', ollamaContainer, 'ollama', 'rm', name]);
    return;
  }

  usageAndExit(`Unknown models subcommand: ${subcommand}. Use: list, install, rm`);
}

// ─── purge ────────────────────────────────────────────────────────────────────

// ─── MCP ─────────────────────────────────────────────────────────────────────

function setMcpState(env: HubEnv, enabled: boolean) {
  const envFileName = getEnvFileOrExit(env);
  upsertEnvVar(envFileName, 'MCP_ENABLED', enabled ? 'true' : 'false');
  if (enabled) {
    const vars = parseEnvFile(envFileName);
    if (!vars.MCP_API_KEY) upsertEnvVar(envFileName, 'MCP_API_KEY', randomBytes(24).toString('hex'));
  }
  printMessageBox(enabled ? 'MCP enabled' : 'MCP disabled', renderConfigLines(env), enabled ? 'green' : 'yellow');
}

// ─── public web ──────────────────────────────────────────────────────────────

async function runPublicWebCommand(args: string[]) {
  requireRepoRoot('cihub public-web');
  const appFlagIndex = args.indexOf('--app');
  const appName = appFlagIndex >= 0 ? args[appFlagIndex + 1] : undefined;
  const positional = args.filter((_, index) => index !== appFlagIndex && (appFlagIndex < 0 || index !== appFlagIndex + 1));
  const subcommand = positional[0] || 'status';
  const env = resolveEnvFromArgs(positional.slice(1));
  const envFileName = getEnvFileOrExit(env);

  try {
    if (subcommand === 'status') {
      const lines = await runPublicWebStatus(envFileName);
      printMessageBox(`Public Web status  [${env}]`, lines, 'cyan');
      return;
    }

    if (subcommand === 'repair') {
      const lines = await runPublicWebRepair(envFileName, appName);
      printMessageBox(`Public Web repair  [${env}]`, lines, lines.some((line) => line.startsWith('✗')) ? 'yellow' : 'green');
      return;
    }

    usageAndExit(`Usage: ${BASE_COMMAND} public-web <status|repair> [env] [--app <name>]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
      printMessageBox('Hub unavailable', [`Could not reach Hub at ${resolveHubApiBase(envFileName)}.`, 'Start the Hub first: cihub up'], 'red');
      process.exit(1);
    }
    throw error;
  }
}

// ─── app lifecycle ────────────────────────────────────────────────────────────

export function parseAppRuntimeArgs(args: string[]) {
  const ports: string[] = [];
  const envVars: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port') {
      const v = args[i + 1];
      if (!v) usageAndExit('Missing value for --port');
      ports.push(v);
      i += 1;
    } else if (arg === '--env') {
      const v = args[i + 1];
      if (!v) usageAndExit('Missing value for --env');
      envVars.push(v);
      i += 1;
    } else {
      usageAndExit(`Unknown app option: ${arg}`);
    }
  }
  return { ports, envVars };
}

export function appStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith('up')) return colorize(status, 'green');
  if (s.startsWith('exit')) return colorize(status, 'red');
  if (s.startsWith('paus')) return colorize(status, 'yellow');
  return dim(status);
}

function runAppCommand(args: string[]) {
  const subcommand = args[0];
  if (!subcommand) usageAndExit('Missing app subcommand');

  // list ──────────────────────────────────────────────────────────────────────
  if (subcommand === 'list') {
    printMessageBox('Managed Docker apps', ['Listing all containers on this machine.'], 'cyan');
    run('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    return;
  }

  // status ────────────────────────────────────────────────────────────────────
  if (subcommand === 'status') {
    const name = args[1];
    const filterArgs = name
      ? ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}']
      : ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'];
    const { stdout } = runCapture('docker', filterArgs);
    const rows = stdout.split('\n').filter(Boolean);
    if (rows.length === 0) {
      printMessageBox('App status', [name ? `Container "${name}" not found.` : 'No containers running.'], 'yellow');
      return;
    }
    const lines = rows.map((row) => {
      const [n, s, p] = row.split('\t');
      const isUp = (s || '').toLowerCase().startsWith('up');
      const dot = isUp ? colorize('●', 'green') : colorize('✗', 'red');
      const statusStr = appStatusColor(s || '');
      const portsStr = p ? dim(` → ${p}`) : '';
      return `${dot} ${bold(n || '')}  ${statusStr}${portsStr}`;
    });
    printMessageBox('App status', lines, 'cyan');
    return;
  }

  // logs ──────────────────────────────────────────────────────────────────────
  if (subcommand === 'logs') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app logs <name> [--tail N]');
    const tailIdx = args.indexOf('--tail');
    const tail = tailIdx !== -1 && args[tailIdx + 1] ? args[tailIdx + 1] : '50';
    printMessageBox('Container logs', [`Container: ${name}`, `Tail: ${tail} lines`], 'dim');
    run('docker', ['logs', '--tail', tail, '--timestamps', name]);
    return;
  }

  // inspect ───────────────────────────────────────────────────────────────────
  if (subcommand === 'inspect') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app inspect <name>');
    const { stdout, ok } = runCapture('docker', ['inspect', name]);
    if (!ok || !stdout) {
      printMessageBox('Inspect', [`Container "${name}" not found.`], 'red');
      return;
    }
    let info: Record<string, unknown>[];
    try {
      info = JSON.parse(stdout) as Record<string, unknown>[];
    } catch {
      printMessageBox('Inspect', [stdout], 'dim');
      return;
    }
    const c = info[0] as {
      State?: { Status?: string };
      NetworkSettings?: { Ports?: Record<string, unknown> };
      Config?: { Env?: string[]; Image?: string };
      Mounts?: Array<{ Source?: string; Destination?: string }>;
    };
    const lines: string[] = [`${bold('image')}   ${c.Config?.Image || '?'}`, `${bold('status')}  ${appStatusColor(c.State?.Status || '?')}`];
    const ports = Object.entries(c.NetworkSettings?.Ports || {})
      .map(([k, v]) => {
        const binds = v as Array<{ HostPort?: string }> | null;
        const host = binds?.[0]?.HostPort;
        return host ? `${host} → ${k}` : k;
      })
      .filter(Boolean);
    if (ports.length > 0) lines.push(`${bold('ports')}   ${ports.join('  ')}`);
    const envVars = (c.Config?.Env || []).filter((e) => !e.startsWith('PATH='));
    if (envVars.length > 0) lines.push(`${bold('env')}     ${envVars.slice(0, 5).join('  ')}`);
    const mounts = (c.Mounts || []).map((m) => `${m.Source} → ${m.Destination}`);
    if (mounts.length > 0) lines.push(`${bold('mounts')} ${mounts.slice(0, 3).join('  ')}`);
    printMessageBox(`Inspect: ${name}`, lines, 'cyan');
    return;
  }

  // add / edit ────────────────────────────────────────────────────────────────
  if (subcommand === 'add' || subcommand === 'edit') {
    const name = args[1];
    const image = args[2];
    if (!name || !image) usageAndExit(`Usage: app ${subcommand} <name> <image> [--port host:container] [--env KEY=VALUE]`);
    const runtime = parseAppRuntimeArgs(args.slice(3));
    if (subcommand === 'edit') spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const runArgs = ['run', '-d', '--name', name];
    for (const p of runtime.ports) runArgs.push('-p', p);
    for (const e of runtime.envVars) runArgs.push('-e', e);
    runArgs.push(image);
    printMessageBox(
      subcommand === 'add' ? 'Adding container app' : 'Editing container app',
      [
        `${bold('name')}   ${name}`,
        `${bold('image')}  ${image}`,
        `${bold('ports')}  ${runtime.ports.length > 0 ? runtime.ports.join(', ') : '(none)'}`,
        `${bold('env')}    ${runtime.envVars.length > 0 ? runtime.envVars.join(', ') : '(none)'}`,
      ],
      'green',
    );
    run('docker', runArgs);
    return;
  }

  // start / stop / restart / delete ──────────────────────────────────────────
  const name = args[1];
  if (!name) usageAndExit(`Usage: app ${subcommand} <name>`);

  if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'restart') {
    printMessageBox('Container app lifecycle', [`${subcommand} ${name}`], 'cyan');
    run('docker', [subcommand, name]);
    return;
  }

  if (subcommand === 'delete') {
    printMessageBox('Container app lifecycle', [`Removing container: ${name}`], 'yellow');
    run('docker', ['rm', '-f', name]);
    return;
  }

  usageAndExit(`Unknown app subcommand: ${subcommand}`);
}

// ─── wizard ───────────────────────────────────────────────────────────────────

export function resolveWizardEnvInput(value: string, fallback: HubEnv = 'local'): HubEnv {
  const n = value.trim().toLowerCase();
  const map: Record<string, HubEnv> = {
    '': fallback,
    '1': 'local',
    local: 'local',
    '2': 'dev',
    dev: 'dev',
    '3': 'staging',
    staging: 'staging',
    '4': 'prod',
    prod: 'prod',
  };
  const env = map[n];
  if (!env) usageAndExit(`Unknown env: ${value}`);
  return env;
}

export function resolveWizardActionInput(value: string) {
  const n = value.trim().toLowerCase();
  const map: Record<string, string> = {
    '': 'setup',
    '1': 'setup',
    setup: 'setup',
    '2': 'up',
    up: 'up',
    '3': 'register',
    register: 'register',
    '4': 'config',
    config: 'config',
    '5': 'mcp-setup',
    'mcp-setup': 'mcp-setup',
    '6': 'mcp-shutdown',
    'mcp-shutdown': 'mcp-shutdown',
    '7': 'down',
    down: 'down',
    '8': 'app-list',
    'app-list': 'app-list',
    '9': 'reset',
    reset: 'reset',
    '10': 'restart',
    restart: 'restart',
  };
  const action = map[n];
  if (!action) usageAndExit(`Unknown wizard action: ${value}`);
  return action;
}

async function runWizard(defaultEnv: HubEnv = 'local') {
  if (!process.stdin.isTTY) throw new Error('Wizard requires an interactive TTY terminal');

  const firstRun = isFirstRun(envFileMap[defaultEnv]);
  console.log(renderWizardWelcome());

  const FTUE_STEPS = 6;

  if (firstRun) {
    console.log();
    console.log(
      box(
        'First-time setup detected',
        [
          `No ${envFileMap[defaultEnv]} found — the wizard will guide you through initial setup.`,
          '',
          renderStep(1, FTUE_STEPS, 'Choose environment', 'pending'),
          renderStep(2, FTUE_STEPS, 'Check prerequisites', 'pending'),
          renderStep(3, FTUE_STEPS, 'Initialize host & Docker config', 'pending'),
          renderStep(4, FTUE_STEPS, 'Register with CI Cloud', 'pending'),
          renderStep(5, FTUE_STEPS, 'Start the Hub', 'pending'),
          renderStep(6, FTUE_STEPS, 'Install initial model (optional)', 'pending'),
        ],
        'yellow',
      ),
    );
    console.log();
  }

  const rl = createInterface({ input, output });

  try {
    // ── Step 1: environment ────────────────────────────────────────────────
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, 'Choose environment', 'active'));
    printMessageBox(
      'Choose environment',
      [
        '1. local    — Source-based local development  (default)',
        '2. dev      — Dev appliance environment',
        '3. staging  — Staging appliance environment',
        '4. prod     — Production appliance environment',
      ],
      'cyan',
    );
    const envAnswer = await rl.question('  Environment [1-4, default 1]: ');
    const env = resolveWizardEnvInput(envAnswer, defaultEnv);
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, `Environment: ${bold(env)}`, 'done'));

    if (firstRun) {
      // ── Step 2: prerequisites ──────────────────────────────────────────
      console.log();
      console.log(renderStep(2, FTUE_STEPS, 'Checking prerequisites…', 'active'));
      const dockerOk = checkDockerAvailable();
      const { stdout: dcVersion } = runCapture('docker', ['compose', 'version']);
      const { stdout: tsIp } = runCapture('tailscale', ['ip', '--4']);
      console.log(
        box(
          'Prerequisites',
          [
            `Docker:           ${dockerOk ? colorize('● available', 'green') : colorize('✗ not running', 'red')}`,
            `Docker Compose:   ${dcVersion ? colorize('● available', 'green') : colorize('✗ not found', 'red')}`,
            `Tailscale VPN:    ${tsIp.trim() ? colorize(`● ${tsIp.trim()}`, 'green') : colorize('○ not connected (optional)', 'dim')}`,
            `Env file:         ${existsSync(join(process.cwd(), envFileMap[env])) ? colorize('● found', 'green') : colorize('○ will be created', 'yellow')}`,
          ],
          'cyan',
        ),
      );
      if (!dockerOk) {
        printMessageBox('Docker required', ['Please start Docker Desktop and re-run the wizard.'], 'red');
        return;
      }
      console.log(renderStep(2, FTUE_STEPS, 'Prerequisites checked', 'done'));

      // ── Step 3: setup ──────────────────────────────────────────────────
      console.log();
      console.log(renderStep(3, FTUE_STEPS, 'Initializing host assets…', 'active'));
      setupHub(env);
      console.log(renderStep(3, FTUE_STEPS, 'Host initialized', 'done'));

      // ── Step 4: register ──────────────────────────────────────────────
      console.log();
      console.log(renderStep(4, FTUE_STEPS, 'Registering with CI Cloud…', 'active'));
      registerHub(env);
      console.log(renderStep(4, FTUE_STEPS, 'Open the URL above to pair this device, then continue', 'done'));
      const cont = await rl.question('  Press Enter once you have registered, or Ctrl+C to exit: ');
      void cont;

      // ── Step 5: start ─────────────────────────────────────────────────
      console.log();
      console.log(renderStep(5, FTUE_STEPS, 'Starting the Hub…', 'active'));
      const detached = (await rl.question('  Run detached (background)? [y/N]: ')).trim().toLowerCase();
      await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
      console.log(renderStep(5, FTUE_STEPS, 'Hub launched', 'done'));

      // ── Step 6: optional model ────────────────────────────────────────
      console.log();
      console.log(renderStep(6, FTUE_STEPS, 'Install initial AI model (optional)', 'active'));
      printMessageBox(
        'Recommended models',
        [
          'llama3        4.7 GB — general purpose, fast',
          'mistral       4.1 GB — good reasoning, efficient',
          'phi3          2.3 GB — lightweight, great for low VRAM',
          'codestral    18.8 GB — code-focused',
          '',
          'Press Enter to skip model installation.',
        ],
        'cyan',
      );
      const modelAnswer = (await rl.question('  Model to install [llama3 / name / Enter to skip]: ')).trim();
      if (modelAnswer) {
        runModelsCommand(['install', modelAnswer]);
        console.log(renderStep(6, FTUE_STEPS, `Model ${bold(modelAnswer)} installed`, 'done'));
      } else {
        console.log(renderStep(6, FTUE_STEPS, 'Skipped — install later with: cihub models install llama3', 'pending'));
      }

      // ── completion ────────────────────────────────────────────────────
      const envFileName = getEnvFileOrExit(env);
      const fileVars = parseEnvFile(envFileName);
      const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN;
      console.log();
      console.log(hr('dim'));
      console.log(colorize('  ✓ Setup complete! Your Companion Intelligence Hub is running.', 'green'));
      console.log(dim(`  Local     http://localhost:${fileVars.FRONTEND_PORT || fileVars.BACKEND_PORT || '5002'}`));
      if (cfDomain) console.log(dim(`  Cloud     https://${cfDomain}`));
      if (tsIp.trim()) console.log(dim(`  Tailscale ${tsIp.trim()}`));
      console.log(dim(`  Manage    ${BASE_COMMAND} status · ${BASE_COMMAND} models list · ${BASE_COMMAND} --help`));
      return;
    }

    // ── returning user: action menu ────────────────────────────────────────
    printMessageBox(
      'Choose action',
      [
        ' 1. setup         Prepare host assets',
        ' 2. up            Start the hub stack',
        ' 3. register      Print cloud registration URL',
        ' 4. config        Show resolved configuration',
        ' 5. mcp-setup     Enable MCP',
        ' 6. mcp-shutdown  Disable MCP',
        ' 7. down          Stop the hub stack',
        ' 8. app-list      List local Docker apps',
        ' 9. reset         Remove runtime state for this environment',
        '10. restart       Restart the selected environment',
      ],
      'cyan',
    );
    const actionAnswer = await rl.question('  Action [1-10, default 1]: ');
    const action = resolveWizardActionInput(actionAnswer);

    if (action === 'setup') return setupHub(env);
    if (action === 'up') {
      const detached = (await rl.question('  Detached mode? [y/N]: ')).trim().toLowerCase();
      return await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
    }
    if (action === 'register') return registerHub(env);
    if (action === 'config') return printConfig(env);
    if (action === 'mcp-setup') return setMcpState(env, true);
    if (action === 'mcp-shutdown') return setMcpState(env, false);
    if (action === 'down') return downHub(env);
    if (action === 'app-list') return runAppCommand(['list']);
    if (action === 'reset') return await resetHub(env, false);
    if (action === 'restart') return await restartHub(env);
  } finally {
    rl.close();
  }
}

// ─── version ─────────────────────────────────────────────────────────────────

export function renderVersion(): string {
  return `${BASE_COMMAND} ${packageVersion()}`;
}

// ─── error / usage ────────────────────────────────────────────────────────────

function usageAndExit(message?: string, code = 2): never {
  if (message) console.error(colorize(`  ✗ ${message}`, 'red'));
  console.error(renderHelp());
  process.exit(code);
}

// ─── Host update (delegates to companion-hub binary) ─────────────────────────

/** First non-empty line from `where`/`which` stdout (Windows `where` may return multiple paths). */
export function firstPathFromLookupOutput(output: string): string | undefined {
  const line = output
    .trim()
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line || undefined;
}

function resolveExecutableOnPath(name: string): string | undefined {
  const isWindows = process.platform === 'win32';
  const result = isWindows ? spawnSync('where', [name], { encoding: 'utf8', shell: true }) : spawnSync('which', [name], { encoding: 'utf8' });
  if (result.status !== 0) {
    return undefined;
  }
  return firstPathFromLookupOutput(result.stdout);
}

export function resolveCompanionHubBinary(): string {
  const candidates = ['companion-hub', 'Companion Hub'];
  for (const name of candidates) {
    const resolved = resolveExecutableOnPath(name);
    if (resolved) {
      return resolved;
    }
  }
  return 'companion-hub';
}

export function runHostUpdate(args: string[]) {
  const checkOnly = args.includes('--check');
  const binary = resolveCompanionHubBinary();
  const cliArgs = checkOnly ? ['update', '--check'] : ['update'];
  const result = spawnSync(binary, cliArgs, { stdio: 'inherit' });
  if (result.error) {
    console.error(`${colorize('Error', 'red')}: Could not run ${binary}. Install Companion Hub desktop or run from the app Settings.`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// ─── CLI dispatcher ───────────────────────────────────────────────────────────

export async function runCli(rawArgs: string[]) {
  const args = normalizeCliArgs(rawArgs);
  const first = args[0];

  if (!first) {
    await startHub('local-dev', 'local');
    return;
  }

  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(renderHelp());
    return;
  }

  if (first === 'man') {
    console.log(renderManPage());
    return;
  }

  if (first === 'version' || first === '--version' || first === '-v') {
    console.log(renderVersion());
    return;
  }

  if (first === 'wizard') {
    await runWizard(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'setup') {
    setupHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'register') {
    registerHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'up') {
    const { detached, remaining } = normalizeDetachedFlag(args.slice(1));
    const env = resolveEnvFromArgs(remaining);
    await startHub(env === 'local' ? 'local-dev' : detached ? 'detached' : 'attached', env);
    return;
  }

  if (first === 'down') {
    downHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'restart') {
    const { detached, remaining } = normalizeDetachedFlag(args.slice(1));
    await restartHub(resolveEnvFromArgs(remaining), detached);
    return;
  }

  if (first === 'recreate') {
    const { detached, remaining } = normalizeDetachedFlag(args.slice(1));
    await recreateHub(resolveEnvFromArgs(remaining), detached);
    return;
  }

  if (first === 'logs') {
    const positional = args.slice(1);
    const env = positional[0] && allowedEnvs.includes(positional[0] as HubEnv) ? (positional[0] as HubEnv) : 'local';
    const service = positional[0] && allowedEnvs.includes(positional[0] as HubEnv) ? positional[1] : positional[0];
    if ((service && positional.length > (allowedEnvs.includes(positional[0] as HubEnv) ? 2 : 1)) || (!service && positional.length > 1)) {
      usageAndExit(`Usage: ${BASE_COMMAND} logs [env] [service]`);
    }
    logsHub(env, service);
    return;
  }

  if (first === 'status') {
    showStatus(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'config') {
    printConfig(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'doctor') {
    doctorHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'clean') {
    const force = args.includes('--yes');
    const env = resolveEnvFromArgs(args.slice(1).filter((arg) => arg !== '--yes'));
    if (await confirmDestructiveAction(`Cleaning ${env}`, force, `Remove generated files for ${env}? [y/N]: `)) {
      cleanHub(env);
    } else {
      printMessageBox('Clean cancelled', ['Left generated files untouched.'], 'yellow');
    }
    return;
  }

  if (first === 'reset') {
    const force = args.includes('--yes');
    const env = resolveEnvFromArgs(args.slice(1).filter((arg) => arg !== '--yes'));
    await resetHub(env, force);
    return;
  }

  if (first === 'uninstall') {
    const force = args.includes('--yes');
    await uninstallHub(force);
    return;
  }

  if (first === 'mcp') {
    const sub = args[1];
    const env = resolveEnvFromArgs(args.slice(2));
    if (sub === 'setup') return setMcpState(env, true);
    if (sub === 'shutdown') return setMcpState(env, false);
    if (sub === 'config') return printConfig(env);
    usageAndExit(`Usage: ${BASE_COMMAND} mcp <setup|shutdown|config> [env]`);
  }

  if (first === 'app') {
    runAppCommand(args.slice(1));
    return;
  }

  if (first === 'models') {
    runModelsCommand(args.slice(1));
    return;
  }

  if (first === 'public-web') {
    await runPublicWebCommand(args.slice(1));
    return;
  }

  if (first === 'update') {
    runHostUpdate(args.slice(1));
    return;
  }

  if (first === 'shutdown') {
    printRemovedCommand('cihub shutdown [env]', 'cihub down [env]');
  }

  if (first === 'hot-reload' || first === 'dev') {
    printRemovedCommand(`cihub ${first} [env]`, 'cihub up local', 'Use the local environment for source-based development.');
  }

  if (first === 'start') {
    printRemovedCommand('cihub start [env]', 'cihub up [env]');
  }

  if (first === 'start:detached') {
    printRemovedCommand('cihub start:detached [env]', 'cihub up [env] --detached');
  }

  if (first === 'purge') {
    printRemovedCommand('cihub purge --yes', 'cihub uninstall --yes');
  }

  usageAndExit(`Unknown command: ${first}`);
}
