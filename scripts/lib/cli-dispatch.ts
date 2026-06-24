/**
 * CLI command dispatcher — keeps `cihub-cli.ts` focused on handlers and UX helpers.
 */
import {
  allowedEnvs,
  BASE_COMMAND,
  cleanHub,
  confirmDestructiveAction,
  doctorHub,
  downHub,
  type HubEnv,
  isApplianceMode,
  logsHub,
  normalizeCliArgs,
  normalizeDetachedFlag,
  resolveUpStartMode,
  printConfig,
  printMessageBox,
  printRemovedCommand,
  recreateHub,
  registerHub,
  renderHelp,
  renderManPage,
  renderVersion,
  resetHub,
  resolveEnvFromArgs,
  restartHub,
  runAppCommand,
  runHostUpdate,
  runModelsCommand,
  runPublicWebCommand,
  runWizard,
  setMcpState,
  setupHub,
  showStatus,
  startHub,
  uninstallHub,
  usageAndExit,
} from '../cihub-cli.js';

export async function runCli(rawArgs: string[]) {
  const args = normalizeCliArgs(rawArgs);
  const first = args[0];

  if (!first) {
    // Outside a checkout there is no source to run; show help instead of auto-starting a stack.
    if (isApplianceMode()) {
      console.log(renderHelp());
      return;
    }
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
    await setupHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'register') {
    await registerHub(resolveEnvFromArgs(args.slice(1)));
    return;
  }

  if (first === 'up') {
    const { detached, attached, remaining } = normalizeDetachedFlag(args.slice(1));
    const env = resolveEnvFromArgs(remaining);
    await startHub(resolveUpStartMode(env, { detached, attached }), env);
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
    const force = remaining.includes('--yes');
    const env = resolveEnvFromArgs(remaining.filter((arg) => arg !== '--yes'));
    await recreateHub(env, detached, force);
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
