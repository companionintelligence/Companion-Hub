import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

export const allowedModes = ['dev', 'start', 'start:detached'] as const;
export const allowedEnvs = ['local', 'dev', 'staging', 'prod'] as const;

export type StartMode = (typeof allowedModes)[number];
export type HubEnv = (typeof allowedEnvs)[number];

type Tone = 'green' | 'cyan' | 'yellow' | 'red' | 'dim' | 'magenta';
type StepStatus = 'pending' | 'active' | 'done' | 'fail';

type CommandEntry = {
  command: string;
  description: string;
};

const BASE_COMMAND = 'cihub';
const COMPAT_COMMAND = 'pnpm run hub --';
const CI_CLOUD_DEFAULT = 'https://hub.companionintelligence.com';

const COMPANY_ART = 'COMPANION HUB\nci.computer';

const envFileMap: Record<HubEnv, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

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
      { command: `${BASE_COMMAND} shutdown [env]`, description: 'Stop the hub stack' },
      { command: `${BASE_COMMAND} status [env]`, description: 'Containers, Cloudflare tunnel, Tailscale VPN, and models' },
      { command: `${BASE_COMMAND} config [env]`, description: 'Show resolved configuration values' },
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
    title: 'MCP',
    entries: [
      { command: `${BASE_COMMAND} mcp setup [env]`, description: 'Enable MCP and provision MCP_API_KEY' },
      { command: `${BASE_COMMAND} mcp shutdown [env]`, description: 'Disable MCP in the target env file' },
      { command: `${BASE_COMMAND} mcp config [env]`, description: 'Show current MCP settings' },
    ],
  },
  {
    title: 'Developer workflow',
    entries: [
      { command: `${BASE_COMMAND} hot-reload [env]`, description: 'Run infra + backend/frontend with hot reload' },
      { command: `${BASE_COMMAND} purge [--yes]`, description: 'Remove Docker state + CI-Hub caches/configs' },
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
  const top = `┌─ ${title} ${'─'.repeat(fill)}┐`;
  const bottom = `└${'─'.repeat(w - 2)}┘`;
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
  const icons: Record<StepStatus, string> = { pending: '○', active: '●', done: '✓', fail: '✗' };
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
        `${bold('Install')}   npm install -g ci-hub`,
        `${bold('NPX')}       npx --package ci-hub ${BASE_COMMAND} --help`,
        `${bold('Dev')}       ${COMPAT_COMMAND} --help`,
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
    box('Synopsis', [`${BASE_COMMAND} <command> [args]`, `${COMPAT_COMMAND} <command> [args]`]),
    box('Description', [
      'Companion Intelligence Hub CLI — setup, registration, Docker lifecycle,',
      'MCP toggles, developer purge/hot-reload flows, and app management.',
      '',
      'All commands accept an optional [env] argument: local (default), dev, staging, prod.',
    ]),
    ...commandSections.map((s) => renderSection(s.title, s.entries)),
    box(
      'Packaging',
      [
        `npm/pnpm/bun global installs expose ${BASE_COMMAND} on PATH via the package bin entry.`,
        `Homebrew and other package managers should install the same ${BASE_COMMAND} executable.`,
        `In-repo compat: ${COMPAT_COMMAND} <command>`,
      ],
      'yellow',
    ),
    box(
      'On-device testing loop',
      [`${BASE_COMMAND} purge --yes`, `${BASE_COMMAND} hot-reload local`, `${BASE_COMMAND} wizard`, 'pnpm run test:cli'],
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
  const abs = join(process.cwd(), envFileName);
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

// ─── spawn helpers ────────────────────────────────────────────────────────────

function formatSpawnOutput(result: ReturnType<typeof spawnSync>): string {
  const out = (result.stdout || '').toString().trim();
  const err = (result.stderr || '').toString().trim();
  if (!out && !err) return '';
  if (out && err) return `stdout: ${out} | stderr: ${err}`;
  return out || err;
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

function resolveRootFolderHost(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const configured = process.env.ROOT_FOLDER_HOST || vars.ROOT_FOLDER_HOST || '.internal';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
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
  return [...set].join(',');
}

function hostContainerUidGid(): { uid: string; gid: string } {
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    return { uid: String(process.getuid()), gid: String(process.getgid()) };
  }
  return { uid: '1000', gid: '1000' };
}

function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const { uid, gid } = hostContainerUidGid();
  const overrides: Record<string, string | undefined> = {
    ENV_FILE: envFileName,
    CI_HUB_CONTAINER_UID: uid,
    CI_HUB_CONTAINER_GID: gid,
  };
  if (composeProfiles) overrides.COMPOSE_PROFILES = composeProfiles;
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

// ─── ownership repair ─────────────────────────────────────────────────────────

function ensureRootFolderOwnership(envFileName: string) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid === undefined || gid === undefined) return;

  const rootFolderHost = resolveRootFolderHost(envFileName);
  if (!existsSync(rootFolderHost)) mkdirSync(rootFolderHost, { recursive: true });

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(rootFolderHost);
  } catch (error) {
    throw new Error(`Failed to stat ${rootFolderHost}: ${String(error)}`);
  }
  if (stat.uid === uid && stat.gid === gid) return;

  const desiredOwner = `${uid}:${gid}`;
  printMessageBox('Ownership repair', [`Ownership mismatch for ${rootFolderHost}.`, `Repairing to ${desiredOwner}…`], 'yellow');
  const direct = spawnSync('chown', ['-R', desiredOwner, rootFolderHost], { stdio: 'pipe', encoding: 'utf-8' });
  if (direct.status === 0) return;

  const via = spawnSync(
    'docker',
    ['run', '--rm', '--user', '0:0', '-v', `${rootFolderHost}:/target`, 'busybox:1.36', 'sh', '-c', `chown -R ${desiredOwner} /target`],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (via.status === 0) return;

  throw new Error(
    [
      `Failed to repair ownership for ${rootFolderHost}.`,
      formatSpawnOutput(direct) ? `host chown: ${formatSpawnOutput(direct)}` : '',
      formatSpawnOutput(via) ? `docker chown: ${formatSpawnOutput(via)}` : '',
      `Fix manually: sudo chown -R $USER:$USER ${rootFolderHost}`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

// ─── hub lifecycle ────────────────────────────────────────────────────────────

function startHub(mode: StartMode, env: HubEnv) {
  requireRepoRoot(mode === 'dev' ? 'cihub dev / hot-reload' : 'cihub up');
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);
  run('tsx', ['scripts/init-gpu-runtime.ts'], envOverrides);

  if (mode === 'dev') {
    printMessageBox(
      'Starting development mode',
      [`Environment: ${env}`, 'Bringing up PostgreSQL and RabbitMQ, then launching backend/frontend locally.'],
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
    const fileVars = parseEnvFile(envFileName);
    run('pnpm', ['run', 'dev:app'], { ...fileVars, ...envOverrides });
    return;
  }

  if (env !== 'local') run('tsx', ['scripts/init-traefik.ts'], envOverrides);

  const files = getComposeFiles(env);
  const upArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) upArgs.push('-f', f);
  upArgs.push('up');
  if (mode === 'start:detached') upArgs.push('-d');
  upArgs.push('--build');

  printMessageBox(
    'Starting hub',
    [`Environment: ${env}`, `Mode: ${mode === 'start:detached' ? 'detached' : 'attached'}`, `Compose files: ${files.join(', ')}`],
    'green',
  );
  run('docker', upArgs, envOverrides);
}

function setupHub(env: HubEnv) {
  requireRepoRoot('cihub setup');
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);
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

function shutdownHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const args = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of getComposeFiles(env)) args.push('-f', f);
  args.push('down');
  printMessageBox('Shutting down hub', [`Environment: ${env}`], 'yellow');
  run('docker', args, envOverrides);
}

function hotReloadHub(env: HubEnv) {
  printMessageBox(
    'Starting hot reload',
    [`Environment: ${env}`, 'Infra + backend/frontend from source — changes reload without a full Docker rebuild.'],
    'green',
  );
  startHub('dev', env);
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

async function confirmPurge(force: boolean) {
  if (force) return true;
  if (!process.stdin.isTTY) {
    console.error(colorize(`  ✗ Purge is destructive — requires an interactive terminal or: ${BASE_COMMAND} purge --yes`, 'red'));
    process.exit(2);
  }
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question('Purge Docker state + CI-Hub caches/configs? [y/N]: ')).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function purgeHub(args: string[]) {
  requireRepoRoot('cihub purge');
  const force = args.includes('--yes');
  const bad = args.filter((a) => a !== '--yes');
  if (bad.length > 0) usageAndExit(`Unknown purge option: ${bad[0]}`);
  const confirmed = await confirmPurge(force);
  if (!confirmed) {
    printMessageBox('Purge cancelled', ['Left Docker volumes, configs, and caches untouched.'], 'yellow');
    return;
  }
  printMessageBox(
    'Purging developer state',
    ['Removing Docker containers, networks, and volumes for CI-Hub.', 'Removing .internal + CI-Hub entries from .local, .config, .cache.'],
    'yellow',
  );
  run('tsx', ['scripts/cleanup.ts']);
}

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
    '7': 'shutdown',
    shutdown: 'shutdown',
    '8': 'app-list',
    'app-list': 'app-list',
    '9': 'purge',
    purge: 'purge',
    '10': 'hot-reload',
    'hot-reload': 'hot-reload',
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
        '1. local    — Local Docker compose stack  (default)',
        '2. dev      — Shared dev environment',
        '3. staging  — Shared staging environment',
        '4. prod     — Production environment',
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
      startHub(detached === 'y' || detached === 'yes' ? 'start:detached' : 'start', env);
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
        ' 7. shutdown      Stop the hub stack',
        ' 8. app-list      List local Docker apps',
        ' 9. purge         Reset Docker state, configs, and caches',
        '10. hot-reload    Start backend/frontend with hot reload',
      ],
      'cyan',
    );
    const actionAnswer = await rl.question('  Action [1-10, default 1]: ');
    const action = resolveWizardActionInput(actionAnswer);

    if (action === 'setup') return setupHub(env);
    if (action === 'up') {
      const detached = (await rl.question('  Detached mode? [y/N]: ')).trim().toLowerCase();
      return startHub(detached === 'y' || detached === 'yes' ? 'start:detached' : 'start', env);
    }
    if (action === 'register') return registerHub(env);
    if (action === 'config') return printConfig(env);
    if (action === 'mcp-setup') return setMcpState(env, true);
    if (action === 'mcp-shutdown') return setMcpState(env, false);
    if (action === 'shutdown') return shutdownHub(env);
    if (action === 'app-list') return runAppCommand(['list']);
    if (action === 'purge') {
      const ans = (await rl.question('  Purge Docker state + CI-Hub caches? [y/N]: ')).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        printMessageBox('Purge cancelled', ['Left Docker volumes, configs, and caches untouched.'], 'yellow');
        return;
      }
      return purgeHub(['--yes']);
    }
    if (action === 'hot-reload') return hotReloadHub(env);
  } finally {
    rl.close();
  }
}

// ─── version ─────────────────────────────────────────────────────────────────

export function renderVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return `${BASE_COMMAND} ${pkg.version ?? '(unknown)'}`;
  } catch {
    return `${BASE_COMMAND} (unknown version)`;
  }
}

// ─── error / usage ────────────────────────────────────────────────────────────

function usageAndExit(message?: string, code = 2): never {
  if (message) console.error(colorize(`  ✗ ${message}`, 'red'));
  console.error(renderHelp());
  process.exit(code);
}

// ─── CLI dispatcher ───────────────────────────────────────────────────────────

export async function runCli(rawArgs: string[]) {
  const args = normalizeCliArgs(rawArgs);
  const first = args[0];

  if (!first) {
    startHub('dev', 'local');
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

  if (allowedModes.includes(first as StartMode)) {
    const mode = first as StartMode;
    const env = (args[1] || 'local') as HubEnv;
    if (!allowedEnvs.includes(env)) usageAndExit(`Unknown env: ${env}`);
    startHub(mode, env);
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
    const detached = args.includes('--detached');
    const envArgs = args.slice(1).filter((a) => a !== '--detached');
    startHub(detached ? 'start:detached' : 'start', resolveEnvFromArgs(envArgs));
    return;
  }

  if (first === 'shutdown') {
    shutdownHub(resolveEnvFromArgs(args.slice(1)));
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

  if (first === 'hot-reload') {
    hotReloadHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'purge') {
    await purgeHub(args.slice(1));
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

  usageAndExit(`Unknown command: ${first}`);
}
