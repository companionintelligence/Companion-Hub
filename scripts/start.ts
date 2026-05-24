#!/usr/bin/env tsx
/**
 * CI-Hub CLI.
 *
 * Usage:
 *   pnpm run dev
 *   pnpm run start
 *   pnpm run start:detached
 *   pnpm run hub -- --help
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';

const allowedModes = ['dev', 'start', 'start:detached'];
const allowedEnvs = ['local', 'dev', 'staging', 'prod'];

type StartMode = (typeof allowedModes)[number];
type HubEnv = (typeof allowedEnvs)[number];

function usageAndExit(msg?: string, code = 2) {
  if (msg) console.error(msg);
  console.error(`Usage:
  pnpm run hub -- [command] [args]

Legacy mode (still supported):
  pnpm exec tsx scripts/start.ts <mode> [env]

Modes: ${allowedModes.join(', ')}
Envs:  ${allowedEnvs.join(', ')} (default: local)

Run "pnpm run hub -- --help" for full command list.`);
  process.exit(code);
}

function printHelp() {
  console.log(`CI-Hub CLI

Usage:
  pnpm run hub -- <command> [args]

Core commands:
  wizard [env]                      Interactive setup/start wizard
  setup [env]                       Prepare host state, Traefik, and Docker config
  register [env]                    Print cloud registration URL for this device
  up [env] [--detached]             Start hub containers
  shutdown [env]                    Stop hub containers
  config [env]                      Show resolved configuration values

MCP commands:
  mcp setup [env]                   Enable MCP and generate MCP_API_KEY if missing
  mcp shutdown [env]                Disable MCP
  mcp config [env]                  Show MCP configuration values

Container app lifecycle:
  app list
  app add <name> <image> [--port host:container] [--env KEY=VALUE]
  app edit <name> <image> [--port host:container] [--env KEY=VALUE]
  app start|stop|restart|delete <name>

Documentation:
  help, --help, -h                  Show this help text
  man                               Show manual-style command reference

Environment values:
  ${allowedEnvs.join(', ')}

Compatibility aliases:
  pnpm run dev
  pnpm run start
  pnpm run start:detached`);
}

function printManPage() {
  console.log(`CI-Hub(1)
NAME
  ci-hub - command line management for local CI-Hub operations

SYNOPSIS
  pnpm run hub -- <command> [args]

DESCRIPTION
  The CLI provides guided setup, startup/shutdown lifecycle commands, cloud
  registration helpers, MCP toggles, and basic container app lifecycle commands.

COMMANDS
  wizard          Run guided setup/start prompts.
  setup           Prepare host state and initialize startup dependencies.
  register        Print CI Cloud registration URL using local device ID.
  up              Start the hub stack. Use --detached for background mode.
  shutdown        Stop the hub stack.
  config          Print resolved values from env and current process.
  mcp             setup | shutdown | config for MCP environment values.
  app             list | add | edit | start | stop | restart | delete.

FILES
  .env.local, .env.dev, .env.staging, .env.prod

SEE ALSO
  docs/CLI.md, README.md`);
}

const envFileMap: Record<string, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

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
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
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
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid === undefined || gid === undefined) {
    return;
  }

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

  if (stat.uid === uid && stat.gid === gid) {
    return;
  }

  const desiredOwner = `${uid}:${gid}`;
  console.warn(`Ownership mismatch detected for ${rootFolderHost} (current ${stat.uid}:${stat.gid}, expected ${desiredOwner}). Attempting repair...`);

  const directChown = spawnSync('chown', ['-R', desiredOwner, rootFolderHost], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (directChown.status === 0) {
    return;
  }

  // Fall back to a root container chown so users in the docker group can recover ownership
  // without requiring sudo. This addresses root-owned .internal/ trees created by containers.
  const dockerChown = spawnSync(
    'docker',
    ['run', '--rm', '--user', '0:0', '-v', `${rootFolderHost}:/target`, 'busybox:1.36', 'sh', '-c', `chown -R ${desiredOwner} /target`],
    {
      stdio: 'pipe',
      encoding: 'utf-8',
    },
  );

  if (dockerChown.status === 0) {
    return;
  }

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

/**
 * Merge `private-vpn` into COMPOSE_PROFILES when PRIVATE_VPN_ENABLED is not `false` (default on).
 * Reads PRIVATE_VPN_ENABLED and COMPOSE_PROFILES from the env file and merges with process.env.
 */
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
  console.log(`> ${cmd} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    cwd: process.cwd(),
  });
  if (res.error) {
    console.error('Failed to run', cmd, res.error);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function getEnvFileOrExit(env: string): string {
  const envFile = envFileMap[env];
  if (!envFile) usageAndExit(`Missing env file mapping for env: ${env}`);
  return envFile;
}

function getComposeFiles(env: HubEnv): string[] {
  if (env === 'local') return ['docker-compose.local.yml'];
  if (env === 'staging') return ['docker-compose.prod.yml', 'docker-compose.staging.yml'];
  return ['docker-compose.prod.yml'];
}

function resolveEnvFromArgs(args: string[], defaultEnv: HubEnv = 'local'): HubEnv {
  const found = args.find((arg) => allowedEnvs.includes(arg));
  const env = (found || defaultEnv) as HubEnv;
  if (!allowedEnvs.includes(env)) usageAndExit(`Unknown env: ${env}`);
  return env;
}

function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const envOverrides: Record<string, string | undefined> = { ENV_FILE: envFileName };
  if (composeProfiles) {
    envOverrides.COMPOSE_PROFILES = composeProfiles;
  }
  return envOverrides;
}

function startHub(mode: StartMode, env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);

  const envOverrides = buildEnvOverrides(envFileName);

  if (mode === 'dev') {
    // Start infra (db + queue) using local compose
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

    // Run the app in dev/HMR mode. Use dotenv to load the env file into the process
    // and let the existing dev:app script set POSTGRES_HOST and RABBITMQ_HOST to localhost.
    run('dotenv', ['-e', envFileName, '--', 'pnpm', 'run', 'dev:app'], envOverrides);
    return;
  }

  // start / start:detached
  if (env !== 'local') {
    // initialize traefik first (matches previous behavior)
    run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  }

  const files = getComposeFiles(env);

  const upArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of files) {
    upArgs.push('-f', f);
  }
  upArgs.push('up');
  if (mode === 'start:detached') upArgs.push('-d');
  upArgs.push('--build');

  run('docker', upArgs, envOverrides);
}

function setupHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  ensureRootFolderOwnership(envFileName);
  const envOverrides = buildEnvOverrides(envFileName);
  run('tsx', ['scripts/init-traefik.ts'], envOverrides);
  run('tsx', ['scripts/init-docker-config.ts'], envOverrides);
  console.log(`Setup complete for ${env}.`);
}

function printConfig(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const rootFolder = resolveRootFolderHost(envFileName);
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const mcpEnabled = (process.env.MCP_ENABLED || fileVars.MCP_ENABLED || 'true') !== 'false';
  const mcpApiKey = process.env.MCP_API_KEY || fileVars.MCP_API_KEY;

  console.log('CI-Hub configuration');
  console.log(`  env: ${env}`);
  console.log(`  env file: ${envFileName}`);
  console.log(`  ROOT_FOLDER_HOST: ${rootFolder}`);
  console.log(`  CI_CLOUD_URL: ${process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || 'https://hub.companionintelligence.com'}`);
  console.log(`  COMPOSE_PROFILES: ${composeProfiles || '(none)'}`);
  console.log(`  MCP_ENABLED: ${mcpEnabled}`);
  console.log(`  MCP_API_KEY: ${mcpApiKey ? '<set>' : '<not set>'}`);
}

function registerHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const cloudUrl = process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || 'https://hub.companionintelligence.com';
  const deviceIdResult = spawnSync('tsx', ['scripts/get-device-id.ts'], { encoding: 'utf-8', stdio: 'pipe' });
  if (deviceIdResult.status !== 0) {
    throw new Error(`Failed to resolve device ID. ${formatSpawnOutput(deviceIdResult)}`);
  }
  const deviceId = (deviceIdResult.stdout || '').trim();
  const registrationUrl = `${cloudUrl.replace(/\/$/, '')}/register?deviceId=${encodeURIComponent(deviceId)}`;

  console.log('Device registration helper');
  console.log(`  device id: ${deviceId}`);
  console.log(`  registration url: ${registrationUrl}`);
  console.log('Open the URL, finish cloud pairing, then continue setup in the Hub UI.');
}

function shutdownHub(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const envOverrides = buildEnvOverrides(envFileName);
  const downArgs = ['compose', '--env-file', envFileName, '--project-name', 'ci-hub'];
  for (const f of getComposeFiles(env)) {
    downArgs.push('-f', f);
  }
  downArgs.push('down');
  run('docker', downArgs, envOverrides);
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
  printConfig(env);
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
    run('docker', runArgs);
    return;
  }

  const name = args[1];
  if (!name) usageAndExit(`Usage: app ${subcommand} <name>`);

  if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'restart') {
    run('docker', [subcommand, name]);
    return;
  }

  if (subcommand === 'delete') {
    run('docker', ['rm', '-f', name]);
    return;
  }

  usageAndExit(`Unknown app subcommand: ${subcommand}`);
}

async function runWizard(defaultEnv?: HubEnv) {
  if (!process.stdin.isTTY) {
    throw new Error('Wizard requires an interactive TTY terminal');
  }

  const rl = createInterface({ input, output });

  try {
    const envAnswer = (await rl.question(`Environment (${allowedEnvs.join('/')}) [${defaultEnv || 'local'}]: `)).trim();
    const env = (envAnswer || defaultEnv || 'local') as HubEnv;
    if (!allowedEnvs.includes(env)) usageAndExit(`Unknown env: ${env}`);

    const action = (await rl.question('Action [setup/up/register/config/mcp-setup/mcp-shutdown/shutdown/app-list] [setup]: ')).trim().toLowerCase();
    const resolvedAction = action || 'setup';

    if (resolvedAction === 'setup') {
      setupHub(env);
      return;
    }
    if (resolvedAction === 'up') {
      const detached = (await rl.question('Detached mode? [y/N]: ')).trim().toLowerCase();
      startHub(detached === 'y' || detached === 'yes' ? 'start:detached' : 'start', env);
      return;
    }
    if (resolvedAction === 'register') {
      registerHub(env);
      return;
    }
    if (resolvedAction === 'config') {
      printConfig(env);
      return;
    }
    if (resolvedAction === 'mcp-setup') {
      setMcpState(env, true);
      return;
    }
    if (resolvedAction === 'mcp-shutdown') {
      setMcpState(env, false);
      return;
    }
    if (resolvedAction === 'shutdown') {
      shutdownHub(env);
      return;
    }
    if (resolvedAction === 'app-list') {
      runAppCommand(['list']);
      return;
    }

    usageAndExit(`Unknown wizard action: ${resolvedAction}`);
  } finally {
    rl.close();
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const first = args[0];

  if (!first) {
    startHub('dev', 'local');
    return;
  }

  if (first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return;
  }

  if (first === 'man') {
    printManPage();
    return;
  }

  // Backward-compatible mode invocation:
  // pnpm exec tsx scripts/start.ts <mode> [env]
  if (allowedModes.includes(first)) {
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
    startHub(detached ? 'start:detached' : 'start', resolveEnvFromArgs(args.slice(1)));
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

  if (first === 'mcp') {
    const subcommand = args[1];
    const env = resolveEnvFromArgs(args.slice(2));
    if (subcommand === 'setup') {
      setMcpState(env, true);
      return;
    }
    if (subcommand === 'shutdown') {
      setMcpState(env, false);
      return;
    }
    if (subcommand === 'config') {
      printConfig(env);
      return;
    }
    usageAndExit('Usage: mcp <setup|shutdown|config> [env]');
  }

  if (first === 'app') {
    runAppCommand(args.slice(1));
    return;
  }

  usageAndExit(`Unknown command: ${first}`);
}

main().catch((err) => {
  console.error('ci-hub cli failed', err);
  process.exit(1);
});
