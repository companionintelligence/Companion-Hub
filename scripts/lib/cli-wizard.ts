/**
 * The guided `cihub wizard` menu.
 *
 * The wizard is a thin front end over the same command functions the dispatcher calls, so a
 * choice made here behaves identically to typing the command.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseEnvFile } from '../env-file.js';
import { usageAndExit } from './cli-args.js';
import { envFileMap, getEnvFileOrExit } from './cli-compose-env.js';
import { printConfig, setupHub, startHub } from './cli-lifecycle.js';
import { runModelsCommand, setMcpState } from './cli-models.js';
import { runAppCommand } from './cli-app.js';
import { runCapture } from './cli-proc.js';
import { checkDockerAvailable } from './cli-repo-context.js';
import { registerHub } from './cli-register.js';
import { downHub, resetHub, restartHub } from './cli-teardown.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { bold, box, cliFail, cliOk, cliWarn, colorize, dim, hr, printMessageBox, renderStep, renderWizardWelcome, STEP_ICONS } from './cli-ui.js';
import { isFirstRun } from './hub-context.js';

// --- wizard ---

function tryResolveWizardEnvInput(value: string, fallback: HubEnv = 'local'): HubEnv | null {
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
  return map[n] ?? null;
}

/**
 * Exit-on-invalid wrapper. Kept because it is the contract callers outside the wizard rely on;
 * inside the wizard, {@link promptUntilValid} re-asks instead, since abandoning a guided flow over
 * one mistyped digit is not a usage error.
 */
export function resolveWizardEnvInput(value: string, fallback: HubEnv = 'local'): HubEnv {
  const env = tryResolveWizardEnvInput(value, fallback);
  if (!env) usageAndExit(`Unknown env: ${value}`);
  return env;
}

function tryResolveWizardActionInput(value: string): string | null {
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
  return map[n] ?? null;
}

/** Exit-on-invalid wrapper — see {@link resolveWizardEnvInput}. */
export function resolveWizardActionInput(value: string) {
  const action = tryResolveWizardActionInput(value);
  if (!action) usageAndExit(`Unknown wizard action: ${value}`);
  return action;
}

/** Answers that abandon the wizard. Quitting a guided flow is a choice, not a usage error. */
const WIZARD_QUIT_ANSWERS = new Set(['q', 'quit', 'exit']);

/**
 * Ask until the answer parses, rather than exiting on the first typo.
 *
 * Both menu prompts used to run their answer straight through the exit-on-invalid resolver, so a
 * single stray keystroke at "Environment [1-4]" ended the guided first-run flow with a usage error
 * and the operator started over. `registerHub` already had the right shape for this — it loops on a
 * bad pairing code — so this follows it.
 *
 * `attempts` is a backstop, not a policy: runWizard refuses a non-TTY stdin up front, but if the
 * stream ends mid-flow `rl.question` resolves empty forever, and an unbounded loop would spin.
 */
export async function promptUntilValid<T>(
  rl: { question: (prompt: string) => Promise<string> },
  label: string,
  parse: (answer: string) => T | null,
  attempts = 5,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const answer = (await rl.question(label)).trim();
    if (WIZARD_QUIT_ANSWERS.has(answer.toLowerCase())) {
      console.log(colorize('  Wizard cancelled.', 'yellow'));
      process.exit(0);
    }
    const parsed = parse(answer);
    if (parsed !== null) return parsed;
    console.log(colorize(`  "${answer}" is not one of the options. Enter a number from the list, or q to quit.`, 'yellow'));
  }
  usageAndExit(`No valid answer for "${label.trim()}" after ${attempts} attempts.`);
}

export async function runWizard(defaultEnv: HubEnv = 'local') {
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
          `No ${envFileMap[defaultEnv]} found \u2014 the wizard will guide you through initial setup.`,
          '',
          renderStep(1, FTUE_STEPS, 'Choose environment', 'pending'),
          renderStep(2, FTUE_STEPS, 'Check prerequisites', 'pending'),
          renderStep(3, FTUE_STEPS, 'Initialize host & Docker config', 'pending'),
          renderStep(4, FTUE_STEPS, 'Start the Hub', 'pending'),
          renderStep(5, FTUE_STEPS, 'Register with CI Cloud', 'pending'),
          renderStep(6, FTUE_STEPS, 'Install initial model (optional)', 'pending'),
        ],
        'yellow',
      ),
    );
    console.log();
  }

  const rl = createInterface({ input, output });

  try {
    // -- Step 1: environment --
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, 'Choose environment', 'active'));
    printMessageBox(
      'Choose environment',
      [
        '1. local    \u2014 Source-based local development  (default)',
        '2. dev      \u2014 Dev appliance environment',
        '3. staging  \u2014 Staging appliance environment',
        '4. prod     \u2014 Production appliance environment',
      ],
      'cyan',
    );
    const env = await promptUntilValid(rl, '  Environment [1-4, default 1]: ', (answer) => tryResolveWizardEnvInput(answer, defaultEnv));
    if (firstRun) console.log(renderStep(1, FTUE_STEPS, `Environment: ${bold(env)}`, 'done'));

    if (firstRun) {
      // -- Step 2: prerequisites --
      console.log();
      console.log(renderStep(2, FTUE_STEPS, 'Checking prerequisites\u2026', 'active'));
      const dockerOk = checkDockerAvailable();
      const { stdout: dcVersion } = runCapture('docker', ['compose', 'version']);
      const { stdout: tsIp } = runCapture('tailscale', ['ip', '--4']);
      console.log(
        box(
          'Prerequisites',
          [
            `Docker:           ${dockerOk ? cliOk('available') : cliFail('not running')}`,
            `Docker Compose:   ${dcVersion ? cliOk('available') : cliFail('not found')}`,
            `Tailscale VPN:    ${tsIp.trim() ? cliOk(tsIp.trim()) : colorize(`${STEP_ICONS.pending} not connected (optional)`, 'dim')}`,
            `Env file:         ${existsSync(join(process.cwd(), envFileMap[env])) ? cliOk('found') : cliWarn('will be created')}`,
          ],
          'cyan',
        ),
      );
      if (!dockerOk) {
        printMessageBox('Docker required', ['Please start Docker Desktop and re-run the wizard.'], 'red');
        return;
      }
      console.log(renderStep(2, FTUE_STEPS, 'Prerequisites checked', 'done'));

      // -- Step 3: setup --
      console.log();
      console.log(renderStep(3, FTUE_STEPS, 'Initializing host assets\u2026', 'active'));
      await setupHub(env);
      console.log(renderStep(3, FTUE_STEPS, 'Host initialized', 'done'));

      // -- Step 4: start --
      console.log();
      console.log(renderStep(4, FTUE_STEPS, 'Starting the Hub\u2026', 'active'));
      const detached = (await rl.question('  Run detached (background)? [y/N]: ')).trim().toLowerCase();
      await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
      console.log(renderStep(4, FTUE_STEPS, 'Hub launched', 'done'));

      // -- Step 5: register --
      console.log();
      console.log(renderStep(5, FTUE_STEPS, 'Pairing with CI Cloud\u2026', 'active'));
      await registerHub(env);
      console.log(renderStep(5, FTUE_STEPS, 'Registration flow complete', 'done'));

      // -- Step 6: optional model --
      console.log();
      console.log(renderStep(6, FTUE_STEPS, 'Install initial AI model (optional)', 'active'));
      printMessageBox(
        'Recommended models',
        [
          'llama3        4.7 GB \u2014 general purpose, fast',
          'mistral       4.1 GB \u2014 good reasoning, efficient',
          'phi3          2.3 GB \u2014 lightweight, great for low VRAM',
          'codestral    18.8 GB \u2014 code-focused',
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
        console.log(renderStep(6, FTUE_STEPS, 'Skipped \u2014 install later with: cihub models install llama3', 'pending'));
      }

      // -- completion --
      const envFileName = getEnvFileOrExit(env);
      const fileVars = parseEnvFile(envFileName);
      const cfDomain = process.env.CF_DOMAIN || fileVars.CF_DOMAIN || fileVars.DOMAIN;
      console.log();
      console.log(hr('dim'));
      console.log(colorize(`  ${STEP_ICONS.done} Setup complete! Your CI Hub is running.`, 'green'));
      console.log(dim(`  Local     http://localhost:${fileVars.FRONTEND_PORT || fileVars.BACKEND_PORT || '5002'}`));
      if (cfDomain) console.log(dim(`  Cloud     https://${cfDomain}`));
      if (tsIp.trim()) console.log(dim(`  Tailscale ${tsIp.trim()}`));
      console.log(dim(`  Manage    ${BASE_COMMAND} status \u2014 ${BASE_COMMAND} models list \u2014 ${BASE_COMMAND} --help`));
      return;
    }

    // -- returning user: action menu --
    printMessageBox(
      'Choose action',
      [
        ' 1. setup         Prepare host assets',
        ' 2. up            Start the hub stack',
        ' 3. register      Pair Hub with CI Cloud (hub must be running)',
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
    const action = await promptUntilValid(rl, '  Action [1-10, default 1]: ', tryResolveWizardActionInput);

    if (action === 'setup') return await setupHub(env);
    if (action === 'up') {
      const detached = (await rl.question('  Detached mode? [y/N]: ')).trim().toLowerCase();
      return await startHub(env === 'local' ? 'local-dev' : detached === 'y' || detached === 'yes' ? 'detached' : 'attached', env);
    }
    if (action === 'register') return await registerHub(env);
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
