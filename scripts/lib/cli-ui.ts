import { allowedEnvs, BASE_COMMAND } from './cli-types.js';

export type Tone = 'green' | 'cyan' | 'yellow' | 'red' | 'dim' | 'magenta';
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

const COMPANY_ART = 'COMPANION HUB\nci.computer';

const commandSections: { title: string; entries: CommandEntry[] }[] = [
  {
    title: 'Setup & Registration',
    entries: [
      { command: `${BASE_COMMAND} wizard [env]`, description: 'Guided first-time or re-setup wizard' },
      { command: `${BASE_COMMAND} setup [env]`, description: 'Initialize host state, Traefik, and Docker auth config' },
      {
        command: `${BASE_COMMAND} register [env] [--fresh] [--code <code>]`,
        description: 'Pair this Hub with CI Cloud using a portal pairing code (hub must be running)',
      },
      {
        command: `${BASE_COMMAND} device-id [--from-hub]`,
        description: "Print this machine's stable device ID (default: local resolver; --from-hub asks the running Hub API)",
      },
    ],
  },
  {
    title: 'Hub lifecycle',
    entries: [
      { command: `${BASE_COMMAND} up [env] [--detached]`, description: 'Start the hub stack' },
      { command: `${BASE_COMMAND} down [env]`, description: 'Stop the hub stack' },
      { command: `${BASE_COMMAND} restart [env]`, description: 'Restart the hub stack' },
      { command: `${BASE_COMMAND} recreate [env] [--detached] [--yes]`, description: 'Reset the target environment and start it again' },
      { command: `${BASE_COMMAND} status [env]`, description: 'Containers, Cloudflare tunnel, Tailscale VPN, and models' },
      { command: `${BASE_COMMAND} logs [env] [service]`, description: 'Stream compose logs for the target environment' },
      { command: `${BASE_COMMAND} config [env]`, description: 'Show resolved configuration values' },
      { command: `${BASE_COMMAND} update [--check]`, description: 'Check for or install desktop + stack update (requires CI Hub)' },
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
      { command: `${BASE_COMMAND} app stop-managed`, description: 'Stop all Hub-managed app containers' },
      { command: `${BASE_COMMAND} app remove-managed`, description: 'Remove all Hub-managed app containers' },
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
      { command: `${BASE_COMMAND} mcp setup [env]`, description: 'Enable the MCP endpoint in the target env file' },
      { command: `${BASE_COMMAND} mcp shutdown [env]`, description: 'Disable MCP in the target env file' },
      { command: `${BASE_COMMAND} mcp config [env]`, description: 'Show current MCP settings' },
      { command: `${BASE_COMMAND} api-key create --name <label>`, description: "Mint an API key (default scope 'mcp'); shown once" },
      { command: `${BASE_COMMAND} api-key list`, description: 'List API keys (id, name, scopes, prefix)' },
    ],
  },
  {
    title: 'Maintenance',
    entries: [
      {
        command: `${BASE_COMMAND} doctor [env] [--repair-networks]`,
        description: 'Validate Docker, env files, bind mounts, compose inputs, and app network ranges',
      },
      {
        command: `${BASE_COMMAND} clean [env] [--yes]`,
        description: 'Remove generated host-state files (outside a checkout: full wipe of the prod data dir)',
      },
      { command: `${BASE_COMMAND} reset [env] [--yes]`, description: 'Remove runtime state (outside a checkout: full wipe of the prod install)' },
      { command: `${BASE_COMMAND} uninstall [--yes]`, description: 'Full machine cleanup of CI-Hub runtime state' },
    ],
  },
];

// --- colour & text ---

function supportsColor() {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY && process.env.NO_COLOR !== '1');
}

export function colorize(text: string, tone: Tone) {
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

export function bold(text: string) {
  return supportsColor() ? `[1m${text}[0m` : text;
}

export function dim(text: string) {
  return colorize(text, 'dim');
}

export function cliOk(text: string) {
  return colorize(`${STEP_ICONS.done} ${text}`, 'green');
}

export function cliFail(text: string) {
  return colorize(`${STEP_ICONS.fail} ${text}`, 'red');
}

export function cliWarn(text: string) {
  return colorize(`${STEP_ICONS.pending} ${text}`, 'yellow');
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

export function hr(tone: Tone = 'dim') {
  return colorize(BOX_CHARS.horizontal.repeat(termWidth()), tone);
}

// --- boxes ---

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

export function printMessageBox(title: string, lines: string[], tone: Tone = 'cyan') {
  console.log(box(title, lines, tone));
}

// --- step indicator ---

export function renderStep(n: number, total: number, label: string, status: StepStatus = 'active') {
  const icons = STEP_ICONS;
  const tones: Record<StepStatus, Tone> = { pending: 'dim', active: 'cyan', done: 'green', fail: 'red' };
  const icon = colorize(icons[status], tones[status]);
  const counter = dim(`[${n}/${total}]`);
  return `${icon} ${counter} ${label}`;
}

// --- banner ---

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
        `${bold('Docs')}  cihub man \u2014 cihub --help`,
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
    box('Environments', [allowedEnvs.join('  |  ')], 'yellow'),
  ].join('\n\n');
}

export function renderManPage() {
  return [
    colorize('CIHUB(1)', 'cyan'),
    '',
    box('Synopsis', [`${BASE_COMMAND} <command> [args]`]),
    box('Description', [
      'CI Hub CLI \u2014 setup, registration, Docker lifecycle,',
      'MCP toggles, environment resets, and app management.',
      '',
      'All commands accept an optional [env] argument: local (default), dev, staging, prod.',
      'Use local for source-based development and dev/staging/prod for appliance-style compose environments.',
      '',
      'Run outside a CI-Hub checkout (e.g. a packaged install), up/down/reset/clean infer prod and',
      'target the canonical desktop data dir (dirs::data_dir()/companion-hub); any [env] arg is ignored.',
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
