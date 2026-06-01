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

type Tone = 'green' | 'cyan' | 'yellow' | 'red' | 'dim';

type CommandEntry = {
  command: string;
  description: string;
};

const BASE_COMMAND = 'cihub';
const COMPAT_COMMAND = 'pnpm run hub --';
const CI_CLOUD_DEFAULT = 'https://hub.companionintelligence.com';
const COMPANY_ART = [
  ' __   __         __               __                 ',
  '/  ` /  \\  |\\/| |__)  /\\  |\\ | | /  \\ |\\ |           ',
  '\\__, \\__/  |  | |    /~~\\ | \\| | \\__/ | \\|           ',
  '                                                     ',
  '       ___  ___              __   ___       __   ___ ',
  '| |\\ |  |  |__  |    |    | / _` |__  |\\ | /  ` |__  ',
  '| | \\|  |  |___ |___ |___ | \\__> |___ | \\| \\__, |___ ',
].join('\n');

const envFileMap: Record<HubEnv, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

const commandSections: { title: string; entries: CommandEntry[] }[] = [
  {
    title: 'Core commands',
    entries: [
      { command: `${BASE_COMMAND} wizard [env]`, description: 'Interactive setup and launch wizard' },
      { command: `${BASE_COMMAND} setup [env]`, description: 'Initialize host state, Traefik, and Docker auth config' },
      { command: `${BASE_COMMAND} register [env]`, description: 'Print cloud portal registration details for this device' },
      { command: `${BASE_COMMAND} up [env] [--detached]`, description: 'Start the hub stack' },
      { command: `${BASE_COMMAND} shutdown [env]`, description: 'Stop the hub stack' },
      { command: `${BASE_COMMAND} config [env]`, description: 'Show resolved configuration values' },
    ],
  },
  {
    title: 'Developer workflow',
    entries: [
      { command: `${BASE_COMMAND} hot-reload [env]`, description: 'Run infra plus backend/frontend with hot reload' },
      { command: `${BASE_COMMAND} purge [--yes]`, description: 'Remove Docker state plus CI-Hub caches/configs' },
    ],
  },
  {
    title: 'MCP commands',
    entries: [
      { command: `${BASE_COMMAND} mcp setup [env]`, description: 'Enable MCP and ensure MCP_API_KEY exists' },
      { command: `${BASE_COMMAND} mcp shutdown [env]`, description: 'Disable MCP in the target env file' },
      { command: `${BASE_COMMAND} mcp config [env]`, description: 'Show current MCP settings' },
    ],
  },
  {
    title: 'Container app lifecycle',
    entries: [
      { command: `${BASE_COMMAND} app list`, description: 'List local Docker containers' },
      { command: `${BASE_COMMAND} app add <name> <image>`, description: 'Launch a new local Docker container app' },
      { command: `${BASE_COMMAND} app edit <name> <image>`, description: 'Recreate a local Docker container app' },
      { command: `${BASE_COMMAND} app start|stop|restart|delete <name>`, description: 'Manage a local Docker container app' },
    ],
  },
];

function supportsColor() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1');
}

function colorize(text: string, tone: Tone) {
  if (!supportsColor()) return text;

  const colorMap: Record<Tone, string> = {
    green: '\u001b[32m',
    cyan: '\u001b[36m',
    yellow: '\u001b[33m',
    red: '\u001b[31m',
    dim: '\u001b[2m',
  };

  return `${colorMap[tone]}${text}\u001b[0m`;
}

function bold(text: string) {
  return supportsColor() ? `\u001b[1m${text}\u001b[0m` : text;
}

export function stripAnsi(text: string) {
  const escapeCode = String.fromCharCode(27);
  return text.replace(new RegExp(`${escapeCode}\\[[0-9;]*m`, 'g'), '');
}

function pad(value: string, width: number) {
  return `${value}${' '.repeat(Math.max(width - stripAnsi(value).length, 0))}`;
}

function box(title: string, lines: string[], tone: Tone = 'cyan') {
  const content = lines.length > 0 ? lines : [''];
  const width = Math.max(stripAnsi(title).length, ...content.map((line) => stripAnsi(line).length));
  const top = `┌─ ${title}${'─'.repeat(Math.max(width - stripAnsi(title).length + 1, 1))}┐`;
  const bottom = `└${'─'.repeat(width + 3)}┘`;
  const body = content.map((line) => `│ ${pad(line, width)} │`);
  return [colorize(top, tone), ...body, colorize(bottom, tone)].join('\n');
}

function renderSection(title: string, entries: CommandEntry[]) {
  const width = Math.max(...entries.map((entry) => entry.command.length));
  const lines = entries.map((entry) => `${pad(colorize(entry.command, 'green'), width)}  ${entry.description}`);
  return box(title, lines, 'cyan');
}

export function renderWizardWelcome() {
  return [
    colorize(COMPANY_ART, 'green'),
    '',
    box(
      'CI-Hub Setup Wizard',
      [
        `${bold('Goal')}  Launch, configure, and register your hub from one guided flow.`,
        `${bold('Tip')}   The preferred executable for packaged installs is ${BASE_COMMAND}.`,
        `${bold('Path')}  Global package-manager installs place ${BASE_COMMAND} on your PATH.`,
      ],
      'green',
    ),
  ].join('\n');
}

export function renderHelp() {
  return [
    colorize(COMPANY_ART, 'green'),
    '',
    box(
      'Quick start',
      [
        `${bold('Launch')}  ${BASE_COMMAND} wizard`,
        `${bold('Package')} npm install -g ci-hub`,
        `${bold('NPX')}     npx --package ci-hub ${BASE_COMMAND} --help`,
        `${bold('Compat')}  ${COMPAT_COMMAND} --help`,
      ],
      'green',
    ),
    ...commandSections.map((section) => renderSection(section.title, section.entries)),
    box('Other commands', [
      `${pad(colorize(`${BASE_COMMAND} help`, 'green'), 18)}  Show help output`,
      `${pad(colorize(`${BASE_COMMAND} man`, 'green'), 18)}  Show manual-style reference`,
      `${pad(colorize(`${BASE_COMMAND} --help`, 'green'), 18)}  Help shortcut`,
    ]),
    box('Environments', [allowedEnvs.join(', ')], 'yellow'),
  ].join('\n\n');
}

export function renderManPage() {
  return [
    colorize('CIHUB(1)', 'cyan'),
    '',
    box('Synopsis', [`${BASE_COMMAND} <command> [args]`, `${COMPAT_COMMAND} <command> [args]`]),
    box('Description', [
      'Companion Intelligence Hub CLI for setup, registration, lifecycle control,',
      'developer purge/hot-reload flows, MCP toggles, and local Docker app management.',
    ]),
    ...commandSections.map((section) => renderSection(section.title, section.entries)),
    box(
      'Packaging',
      [
        `npm/pnpm/bun global installs expose ${BASE_COMMAND} on PATH via the package bin entry.`,
        `Homebrew and other package managers should install the same ${BASE_COMMAND} executable.`,
      ],
      'yellow',
    ),
  ].join('\n\n');
}

function printMessageBox(title: string, lines: string[], tone: Tone = 'cyan') {
  console.log(box(title, lines, tone));
}

export function normalizeCliArgs(rawArgs: string[]) {
  return rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
}

function parseEnvFile(envFileName: string): Record<string, string> {
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

function upsertEnvVar(envFileName: string, key: string, value: string) {
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

  const finalContent = `${lines.filter((entry, index, all) => !(index === all.length - 1 && entry === '')).join('\n')}\n`;
  writeFileSync(abs, finalContent, 'utf-8');
}

function formatSpawnOutput(result: ReturnType<typeof spawnSync>): string {
  const stdout = (result.stdout || '').toString().trim();
  const stderr = (result.stderr || '').toString().trim();

  if (!stdout && !stderr) return '';
  if (stdout && stderr) return `stdout: ${stdout} | stderr: ${stderr}`;
  return stdout || stderr;
}

function resolveRootFolderHost(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const configured = process.env.ROOT_FOLDER_HOST || vars.ROOT_FOLDER_HOST || '.internal';
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function ensureRootFolderOwnership(envFileName: string) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid === undefined || gid === undefined) return;

  const rootFolderHost = resolveRootFolderHost(envFileName);
  if (!existsSync(rootFolderHost)) {
    mkdirSync(rootFolderHost, { recursive: true });
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(rootFolderHost);
  } catch (error) {
    throw new Error(`Failed to stat ${rootFolderHost}: ${String(error)}`);
  }

  if (stat.uid === uid && stat.gid === gid) return;

  const desiredOwner = `${uid}:${gid}`;
  printMessageBox(
    'Ownership repair',
    [`Detected ownership mismatch for ${rootFolderHost}.`, `Attempting repair to ${desiredOwner} before continuing...`],
    'yellow',
  );

  const directChown = spawnSync('chown', ['-R', desiredOwner, rootFolderHost], { stdio: 'pipe', encoding: 'utf-8' });
  if (directChown.status === 0) return;

  const dockerChown = spawnSync(
    'docker',
    ['run', '--rm', '--user', '0:0', '-v', `${rootFolderHost}:/target`, 'busybox:1.36', 'sh', '-c', `chown -R ${desiredOwner} /target`],
    { stdio: 'pipe', encoding: 'utf-8' },
  );
  if (dockerChown.status === 0) return;

  const hostErr = formatSpawnOutput(directChown);
  const dockerErr = formatSpawnOutput(dockerChown);
  throw new Error(
    [
      `Failed to repair ownership for ${rootFolderHost}.`,
      hostErr ? `host chown output: ${hostErr}` : '',
      dockerErr ? `docker chown output: ${dockerErr}` : '',
      `Please run: sudo chown -R $USER:$USER ${rootFolderHost}`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

function mergeComposeProfilesFromEnvFile(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const hasEnvFile = Object.keys(vars).length > 0;

  if (!hasEnvFile) {
    const fromProc = (process.env.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const set = new Set(fromProc);
    set.add('private-vpn');
    return [...set].join(',');
  }

  const vpnOn = vars.PRIVATE_VPN_ENABLED !== 'false';
  const fromFile = (vars.COMPOSE_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fromProc = (process.env.COMPOSE_PROFILES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const set = new Set<string>([...fromFile, ...fromProc]);
  if (vpnOn) set.add('private-vpn');
  else set.delete('private-vpn');
  return [...set].join(',');
}

function run(cmd: string, args: string[], extraEnv: Record<string, string | undefined> = {}) {
  console.log(colorize(`▶ ${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`, 'dim'));
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

function getEnvFileOrExit(env: string): string {
  const envFile = envFileMap[env as HubEnv];
  if (!envFile) usageAndExit(`Unknown environment: ${env}`);
  return envFile;
}

function getComposeFiles(env: HubEnv): string[] {
  if (env === 'local') return ['docker-compose.local.yml'];
  if (env === 'staging') return ['docker-compose.prod.yml', 'docker-compose.staging.yml'];
  return ['docker-compose.prod.yml'];
}

export function resolveEnvFromArgs(args: string[], defaultEnv: HubEnv = 'local'): HubEnv {
  const found = args.find((arg) => allowedEnvs.includes(arg as HubEnv));
  const unknown = args.filter((arg) => !allowedEnvs.includes(arg as HubEnv));
  if (unknown.length > 0) usageAndExit(`Unexpected argument: ${unknown[0]}`);
  return (found || defaultEnv) as HubEnv;
}

function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const envOverrides: Record<string, string | undefined> = { ENV_FILE: envFileName };
  if (composeProfiles) envOverrides.COMPOSE_PROFILES = composeProfiles;
  return envOverrides;
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

function startHub(mode: StartMode, env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);

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
    const fileVars = parseEnvFile(envFileName);
    run('pnpm', ['run', 'dev:app'], { ...fileVars, ...envOverrides });
    return;
  }

  if (env !== 'local') {
    run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  }

  const files = getComposeFiles(env);
  const upArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const file of files) upArgs.push('-f', file);
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
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);
  run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  run('tsx', ['scripts/init-docker-config.ts'], envOverrides);
  printMessageBox('Setup complete', [`Prepared host assets for ${env}.`, `You can now run ${BASE_COMMAND} up ${env}`], 'green');
}

function printConfig(env: HubEnv) {
  printMessageBox('CI-Hub configuration', renderConfigLines(env), 'cyan');
}

function registerHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const cloudUrl = process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT;
  const deviceIdResult = spawnSync('tsx', ['scripts/get-device-id.ts'], { encoding: 'utf-8', stdio: 'pipe' });
  if (deviceIdResult.status !== 0) {
    throw new Error(`Failed to resolve device ID. ${formatSpawnOutput(deviceIdResult)}`);
  }

  const deviceId = (deviceIdResult.stdout || '').trim();
  const registrationUrl = `${cloudUrl.replace(/\/$/, '')}/register?deviceId=${encodeURIComponent(deviceId)}`;

  printMessageBox(
    'Device registration',
    [
      `${bold('device id')}  ${deviceId}`,
      `${bold('portal')}     ${registrationUrl}`,
      `Open the URL, finish cloud pairing, then return to ${BASE_COMMAND} wizard.`,
    ],
    'green',
  );
}

function shutdownHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const downArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const file of getComposeFiles(env)) downArgs.push('-f', file);
  downArgs.push('down');
  printMessageBox('Shutting down hub', [`Environment: ${env}`], 'yellow');
  run('docker', downArgs, envOverrides);
}

function hotReloadHub(env: HubEnv) {
  printMessageBox(
    'Starting hot reload',
    [`Environment: ${env}`, 'Launching infra plus backend/frontend from source so CLI and TUI changes reload without a full Docker rebuild.'],
    'green',
  );
  startHub('dev', env);
}

async function confirmPurge(force: boolean) {
  if (force) return true;
  if (!process.stdin.isTTY) {
    usageAndExit(`Purge is destructive. Re-run with ${BASE_COMMAND} purge --yes to skip confirmation.`);
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('Purge Docker state plus CI-Hub caches/configs? [y/N]: ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function purgeHub(args: string[]) {
  const force = args.includes('--yes');
  const unsupportedArgs = args.filter((arg) => arg !== '--yes');
  if (unsupportedArgs.length > 0) usageAndExit(`Unknown purge option: ${unsupportedArgs[0]}`);

  const confirmed = await confirmPurge(force);
  if (!confirmed) {
    printMessageBox('Purge cancelled', ['Left Docker volumes, configs, and caches untouched.'], 'yellow');
    return;
  }

  printMessageBox(
    'Purging developer state',
    [
      'Removing Docker containers, networks, and volumes used by CI-Hub.',
      'Removing .internal plus CI-Hub entries from .local, .config, and .cache for clean-slate testing.',
    ],
    'yellow',
  );
  run('tsx', ['scripts/cleanup.ts']);
}

function setMcpState(env: HubEnv, enabled: boolean) {
  const envFileName = getEnvFileOrExit(env);
  upsertEnvVar(envFileName, 'MCP_ENABLED', enabled ? 'true' : 'false');
  if (enabled) {
    const vars = parseEnvFile(envFileName);
    if (!vars.MCP_API_KEY) {
      upsertEnvVar(envFileName, 'MCP_API_KEY', randomBytes(24).toString('hex'));
    }
  }

  printMessageBox(enabled ? 'MCP enabled' : 'MCP disabled', renderConfigLines(env), enabled ? 'green' : 'yellow');
}

function parseAppRuntimeArgs(args: string[]) {
  const ports: string[] = [];
  const envVars: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port') {
      const value = args[i + 1];
      if (!value) usageAndExit('Missing value for --port');
      ports.push(value);
      i += 1;
      continue;
    }

    if (arg === '--env') {
      const value = args[i + 1];
      if (!value) usageAndExit('Missing value for --env');
      envVars.push(value);
      i += 1;
      continue;
    }

    usageAndExit(`Unknown app option: ${arg}`);
  }

  return { ports, envVars };
}

function runAppCommand(args: string[]) {
  const subcommand = args[0];
  if (!subcommand) usageAndExit('Missing app subcommand');

  if (subcommand === 'list') {
    printMessageBox('Local Docker app lifecycle', ['Listing Docker containers managed on this machine.'], 'cyan');
    run('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}']);
    return;
  }

  if (subcommand === 'add' || subcommand === 'edit') {
    const name = args[1];
    const image = args[2];
    if (!name || !image) usageAndExit(`Usage: app ${subcommand} <name> <image> [--port host:container] [--env KEY=VALUE]`);
    const runtime = parseAppRuntimeArgs(args.slice(3));
    if (subcommand === 'edit') {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }

    const runArgs = ['run', '-d', '--name', name];
    for (const port of runtime.ports) runArgs.push('-p', port);
    for (const envVar of runtime.envVars) runArgs.push('-e', envVar);
    runArgs.push(image);

    printMessageBox(
      subcommand === 'add' ? 'Adding container app' : 'Editing container app',
      [
        `Name: ${name}`,
        `Image: ${image}`,
        `Ports: ${runtime.ports.length > 0 ? runtime.ports.join(', ') : '(none)'}`,
        `Env: ${runtime.envVars.length > 0 ? runtime.envVars.join(', ') : '(none)'}`,
      ],
      'green',
    );

    run('docker', runArgs);
    return;
  }

  const name = args[1];
  if (!name) usageAndExit(`Usage: app ${subcommand} <name>`);

  if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'restart') {
    printMessageBox('Container app lifecycle', [`${subcommand} ${name}`], 'cyan');
    run('docker', [subcommand, name]);
    return;
  }

  if (subcommand === 'delete') {
    printMessageBox('Container app lifecycle', [`delete ${name}`], 'yellow');
    run('docker', ['rm', '-f', name]);
    return;
  }

  usageAndExit(`Unknown app subcommand: ${subcommand}`);
}

export function resolveWizardEnvInput(value: string, fallback: HubEnv = 'local'): HubEnv {
  const normalized = value.trim().toLowerCase();
  const envOptions: Record<string, HubEnv> = {
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

  const env = envOptions[normalized];
  if (!env) usageAndExit(`Unknown env: ${value}`);
  return env;
}

export function resolveWizardActionInput(value: string) {
  const normalized = value.trim().toLowerCase();
  const actionOptions: Record<string, string> = {
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

  const action = actionOptions[normalized];
  if (!action) usageAndExit(`Unknown wizard action: ${value}`);
  return action;
}

async function runWizard(defaultEnv: HubEnv = 'local') {
  if (!process.stdin.isTTY) {
    throw new Error('Wizard requires an interactive TTY terminal');
  }

  console.log(renderWizardWelcome());
  const rl = createInterface({ input, output });

  try {
    printMessageBox(
      'Choose environment',
      [
        '1. local    Local Docker compose stack',
        '2. dev      Shared dev environment',
        '3. staging  Shared staging environment',
        '4. prod     Production environment',
      ],
      'cyan',
    );
    const envAnswer = await rl.question(`Environment [1-4] [${defaultEnv === 'local' ? '1' : defaultEnv}]: `);
    const env = resolveWizardEnvInput(envAnswer, defaultEnv);

    printMessageBox(
      'Choose action',
      [
        '1. setup         Prepare host assets',
        '2. up            Start the hub stack',
        '3. register      Print cloud registration URL',
        '4. config        Show resolved configuration',
        '5. mcp-setup     Enable MCP',
        '6. mcp-shutdown  Disable MCP',
        '7. shutdown      Stop the hub stack',
        '8. app-list      List local Docker apps',
        '9. purge         Reset Docker state, configs, and caches',
        '10. hot-reload   Start backend/frontend with hot reload',
      ],
      'cyan',
    );
    const actionAnswer = await rl.question('Action [1-10] [1]: ');
    const action = resolveWizardActionInput(actionAnswer);

    if (action === 'setup') return setupHub(env);
    if (action === 'up') {
      const detached = (await rl.question('Detached mode? [y/N]: ')).trim().toLowerCase();
      return startHub(detached === 'y' || detached === 'yes' ? 'start:detached' : 'start', env);
    }
    if (action === 'register') return registerHub(env);
    if (action === 'config') return printConfig(env);
    if (action === 'mcp-setup') return setMcpState(env, true);
    if (action === 'mcp-shutdown') return setMcpState(env, false);
    if (action === 'shutdown') return shutdownHub(env);
    if (action === 'app-list') return runAppCommand(['list']);
    if (action === 'purge') {
      const confirmed = (await rl.question('Purge Docker state plus CI-Hub caches/configs? [y/N]: ')).trim().toLowerCase();
      if (confirmed !== 'y' && confirmed !== 'yes') {
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

function usageAndExit(message?: string, code = 2): never {
  if (message) {
    console.error(colorize(message, 'red'));
  }
  console.error(renderHelp());
  process.exit(code);
}

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
    const envArgs = args.slice(1).filter((arg) => arg !== '--detached');
    startHub(detached ? 'start:detached' : 'start', resolveEnvFromArgs(envArgs));
    return;
  }

  if (first === 'shutdown') {
    shutdownHub(resolveEnvFromArgs(args.slice(1)));
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
    const subcommand = args[1];
    const env = resolveEnvFromArgs(args.slice(2));
    if (subcommand === 'setup') return setMcpState(env, true);
    if (subcommand === 'shutdown') return setMcpState(env, false);
    if (subcommand === 'config') return printConfig(env);
    usageAndExit(`Usage: ${BASE_COMMAND} mcp <setup|shutdown|config> [env]`);
  }

  if (first === 'app') {
    runAppCommand(args.slice(1));
    return;
  }

  usageAndExit(`Unknown command: ${first}`);
}
