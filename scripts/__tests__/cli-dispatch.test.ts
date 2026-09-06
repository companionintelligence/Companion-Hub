import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHelp, renderManPage, stripAnsi } from '../lib/cli-ui.js';

/**
 * Only the router is under test. Every command module is replaced with a recorder that appends to a
 * shared, ordered log, so each assertion can say "exactly this handler ran, with exactly these
 * arguments" — a fallthrough into a second handler, or a silent drop, fails the deep-equal.
 *
 * `cli-args` and `cli-ui` stay real: the parsing they do (env resolution, flag stripping, the exit
 * paths) is half of what "routing" means here, and stubbing it would test the stub.
 */
const mocks = vi.hoisted(() => {
  const calls: { handler: string; args: unknown[] }[] = [];
  const state = { appliance: false, confirm: true };
  const versionText = 'cihub 0.0.0-test';
  const record =
    (handler: string) =>
    (...args: unknown[]) => {
      calls.push({ handler, args });
    };

  return {
    calls,
    state,
    versionText,
    startHub: vi.fn(record('startHub')),
    setupHub: vi.fn(record('setupHub')),
    printConfig: vi.fn(record('printConfig')),
    cleanHub: vi.fn(record('cleanHub')),
    downHub: vi.fn(record('downHub')),
    recreateHub: vi.fn(record('recreateHub')),
    resetHub: vi.fn(record('resetHub')),
    restartHub: vi.fn(record('restartHub')),
    doctorHub: vi.fn(record('doctorHub')),
    logsHub: vi.fn(record('logsHub')),
    showStatus: vi.fn(record('showStatus')),
    uninstallHub: vi.fn(record('uninstallHub')),
    registerHub: vi.fn(record('registerHub')),
    showDeviceId: vi.fn(record('showDeviceId')),
    runModelsCommand: vi.fn(record('runModelsCommand')),
    runPublicWebCommand: vi.fn(record('runPublicWebCommand')),
    setMcpState: vi.fn(record('setMcpState')),
    runPoolCommand: vi.fn(record('runPoolCommand')),
    runAppCommand: vi.fn(record('runAppCommand')),
    runApiKeyCommand: vi.fn(record('runApiKeyCommand')),
    runHostUpdate: vi.fn(record('runHostUpdate')),
    runConnectCommand: vi.fn(record('runConnectCommand')),
    runWizard: vi.fn(record('runWizard')),
    runCatalogLogin: vi.fn(record('runCatalogLogin')),
    runCatalogLogout: vi.fn(record('runCatalogLogout')),
    runCatalogSubmit: vi.fn(record('runCatalogSubmit')),
    confirmDestructiveAction: vi.fn(async (...args: unknown[]) => {
      calls.push({ handler: 'confirmDestructiveAction', args });
      return state.confirm;
    }),
    renderVersion: vi.fn(() => versionText),
    isApplianceMode: vi.fn(() => state.appliance),
  };
});

vi.mock('../lib/cli-lifecycle.js', () => ({
  startHub: mocks.startHub,
  setupHub: mocks.setupHub,
  printConfig: mocks.printConfig,
}));

vi.mock('../lib/cli-teardown.js', () => ({
  cleanHub: mocks.cleanHub,
  downHub: mocks.downHub,
  recreateHub: mocks.recreateHub,
  resetHub: mocks.resetHub,
  restartHub: mocks.restartHub,
}));

vi.mock('../lib/cli-doctor.js', () => ({
  doctorHub: mocks.doctorHub,
  logsHub: mocks.logsHub,
  showStatus: mocks.showStatus,
  uninstallHub: mocks.uninstallHub,
}));

vi.mock('../lib/cli-register.js', () => ({
  registerHub: mocks.registerHub,
  showDeviceId: mocks.showDeviceId,
}));

vi.mock('../lib/cli-models.js', () => ({
  runModelsCommand: mocks.runModelsCommand,
  runPublicWebCommand: mocks.runPublicWebCommand,
  setMcpState: mocks.setMcpState,
}));

vi.mock('../lib/cli-pool.js', () => ({ runPoolCommand: mocks.runPoolCommand }));
vi.mock('../lib/cli-app.js', () => ({ runAppCommand: mocks.runAppCommand }));
vi.mock('../lib/cli-api-key.js', () => ({ runApiKeyCommand: mocks.runApiKeyCommand }));
vi.mock('../lib/cli-wizard.js', () => ({ runWizard: mocks.runWizard }));
vi.mock('../lib/cli-prompt.js', () => ({ confirmDestructiveAction: mocks.confirmDestructiveAction }));

vi.mock('../lib/cli-update.js', () => ({
  renderVersion: mocks.renderVersion,
  runConnectCommand: mocks.runConnectCommand,
  runHostUpdate: mocks.runHostUpdate,
}));

vi.mock('../lib/catalog-submit.js', () => ({
  runCatalogLogin: mocks.runCatalogLogin,
  runCatalogLogout: mocks.runCatalogLogout,
  runCatalogSubmit: mocks.runCatalogSubmit,
}));

// Partial: `cli-args.resolveUpStartMode` reads `isApplianceMode` too, and the rest of this module
// (repo-root detection) must stay real so nothing else in the graph loses an export.
vi.mock('../lib/cli-repo-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cli-repo-context.js')>()),
  isApplianceMode: mocks.isApplianceMode,
}));

import { runCli } from '../lib/cli-dispatch.js';

type Dispatch = { handler: string; args: unknown[] };

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const joinSpyOutput = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls as unknown[][]).map((call) => stripAnsi(String(call[0]))).join('\n');
const logText = () => joinSpyOutput(logSpy);
const errorText = () => joinSpyOutput(errorSpy);

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.state.appliance = false;
  mocks.state.confirm = true;
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('runCli with no command', () => {
  it('starts the source stack in a checkout instead of printing help', async () => {
    await runCli([]);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'startHub', args: ['local-dev', 'local'] }]);
    expect(logText()).not.toContain('Quick start');
  });

  it('prints help outside a checkout, where there is no source to run', async () => {
    mocks.state.appliance = true;

    await runCli([]);

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(logSpy).toHaveBeenCalledWith(renderHelp());
  });
});

describe('runCli informational commands', () => {
  it.each(['--help', '-h', 'help'])('%s prints help and dispatches nothing', async (flag) => {
    await runCli([flag]);

    expect(logSpy).toHaveBeenCalledWith(renderHelp());
    expect(mocks.calls).toEqual<Dispatch[]>([]);
  });

  it.each(['--help', '-h', 'help'])('%s is honoured only in first position, not anywhere in argv', async (flag) => {
    // Widening the guard to `args.includes(flag)` would swallow the argument for every command that
    // takes an env, so the trailing form has to stay a usage error rather than a second help screen.
    await expect(runCli(['status', flag])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorText()).toContain(`Unexpected argument: ${flag}`);
  });

  it('man prints the manual page, not the help screen', async () => {
    await runCli(['man']);

    expect(logSpy).toHaveBeenCalledWith(renderManPage());
    expect(logText()).toContain('CIHUB(1)');
    // The help screen leads with Quick start; the man page must not be a rename of it.
    expect(logText()).not.toContain('Quick start');
    expect(mocks.calls).toEqual<Dispatch[]>([]);
  });

  it.each(['version', '--version', '-v'])('%s prints the version and dispatches nothing', async (flag) => {
    await runCli([flag]);

    expect(logSpy).toHaveBeenCalledWith(mocks.versionText);
    expect(mocks.calls).toEqual<Dispatch[]>([]);
  });
});

describe('runCli command routing', () => {
  const cases: { argv: string[]; expected: Dispatch[] }[] = [
    { argv: ['setup', 'staging'], expected: [{ handler: 'setupHub', args: ['staging'] }] },
    { argv: ['wizard', 'prod'], expected: [{ handler: 'runWizard', args: ['prod'] }] },
    { argv: ['wizard'], expected: [{ handler: 'runWizard', args: ['local'] }] },
    {
      argv: ['register', 'dev', '--fresh', '--code', '8XNYEB'],
      expected: [{ handler: 'registerHub', args: ['dev', { fresh: true, code: '8XNYEB' }] }],
    },
    { argv: ['register'], expected: [{ handler: 'registerHub', args: ['local', { fresh: false, code: undefined }] }] },
    { argv: ['device-id'], expected: [{ handler: 'showDeviceId', args: [{ fromHub: false, env: 'local' }] }] },
    {
      argv: ['device-id', '--from-hub', 'dev'],
      expected: [{ handler: 'showDeviceId', args: [{ fromHub: true, env: 'dev' }] }],
    },
    { argv: ['down'], expected: [{ handler: 'downHub', args: ['local'] }] },
    { argv: ['down', 'prod'], expected: [{ handler: 'downHub', args: ['prod'] }] },
    { argv: ['restart'], expected: [{ handler: 'restartHub', args: ['local', false] }] },
    { argv: ['restart', 'dev', '--detached'], expected: [{ handler: 'restartHub', args: ['dev', true] }] },
    { argv: ['recreate'], expected: [{ handler: 'recreateHub', args: ['local', false, false] }] },
    {
      argv: ['recreate', 'staging', '--detached', '--yes'],
      expected: [{ handler: 'recreateHub', args: ['staging', true, true] }],
    },
    // recreate is destructive, so its two booleans must never be interchangeable: the all-on and
    // all-off rows above cannot tell `recreateHub(env, detached, force)` from `(env, force, detached)`.
    { argv: ['recreate', 'dev', '--yes'], expected: [{ handler: 'recreateHub', args: ['dev', false, true] }] },
    { argv: ['recreate', 'prod', '--detached'], expected: [{ handler: 'recreateHub', args: ['prod', true, false] }] },
    { argv: ['status', 'dev'], expected: [{ handler: 'showStatus', args: ['dev'] }] },
    { argv: ['config', 'prod'], expected: [{ handler: 'printConfig', args: ['prod'] }] },
    { argv: ['doctor'], expected: [{ handler: 'doctorHub', args: ['local', { repairNetworks: false }] }] },
    {
      argv: ['doctor', '--repair-networks', 'dev'],
      expected: [{ handler: 'doctorHub', args: ['dev', { repairNetworks: true }] }],
    },
    { argv: ['reset', 'dev', '--yes'], expected: [{ handler: 'resetHub', args: ['dev', true] }] },
    { argv: ['reset'], expected: [{ handler: 'resetHub', args: ['local', false] }] },
    { argv: ['uninstall'], expected: [{ handler: 'uninstallHub', args: [false] }] },
    { argv: ['uninstall', '--yes'], expected: [{ handler: 'uninstallHub', args: [true] }] },
    { argv: ['app', 'list', '--json'], expected: [{ handler: 'runAppCommand', args: [['list', '--json']] }] },
    { argv: ['models', 'pull', 'llama3'], expected: [{ handler: 'runModelsCommand', args: [['pull', 'llama3']] }] },
    { argv: ['pool', 'status', 'dev'], expected: [{ handler: 'runPoolCommand', args: [['status', 'dev']] }] },
    { argv: ['api-key', 'list'], expected: [{ handler: 'runApiKeyCommand', args: [['list']] }] },
    { argv: ['public-web', 'repair'], expected: [{ handler: 'runPublicWebCommand', args: [['repair']] }] },
    { argv: ['connect', '--yes'], expected: [{ handler: 'runConnectCommand', args: [['--yes']] }] },
    { argv: ['update', '--check'], expected: [{ handler: 'runHostUpdate', args: [['--check']] }] },
    { argv: ['login', '--org', 'acme'], expected: [{ handler: 'runCatalogLogin', args: [['--org', 'acme']] }] },
    { argv: ['logout'], expected: [{ handler: 'runCatalogLogout', args: [] }] },
    { argv: ['submit', './bundle'], expected: [{ handler: 'runCatalogSubmit', args: [['./bundle']] }] },
  ];

  it.each(cases)('routes `cihub $argv` to one handler', async ({ argv, expected }) => {
    await runCli(argv);

    expect(mocks.calls).toEqual(expected);
  });

  it('rejects an unrecognised env before reaching the handler', async () => {
    await expect(runCli(['status', 'bogus'])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorText()).toContain('Unexpected argument: bogus');
  });

  it('names the first unrecognised argument, not the last, so the report points at where parsing failed', async () => {
    await expect(runCli(['status', 'bogus', 'worse'])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(errorText()).toContain('Unexpected argument: bogus');
    expect(errorText()).not.toContain('Unexpected argument: worse');
  });

  it('rejects `--code` with no value instead of registering with an empty pairing code', async () => {
    await expect(runCli(['register', 'dev', '--code'])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorText()).toContain('Usage: cihub register [env] [--fresh] [--code <code>]');
  });
});

describe('runCli up start-mode resolution', () => {
  it.each([
    { argv: ['up'], mode: 'local-dev', env: 'local' },
    { argv: ['up', 'local'], mode: 'local-dev', env: 'local' },
    { argv: ['up', 'dev'], mode: 'detached', env: 'dev' },
    { argv: ['up', 'dev', '--attached'], mode: 'attached', env: 'dev' },
    { argv: ['up', 'staging'], mode: 'attached', env: 'staging' },
    { argv: ['up', 'staging', '--detached'], mode: 'detached', env: 'staging' },
  ])('`cihub $argv` starts $env in $mode mode from a checkout', async ({ argv, mode, env }) => {
    await runCli(argv);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'startHub', args: [mode, env] }]);
  });

  it('never starts local-dev outside a checkout, where there is no source tree', async () => {
    mocks.state.appliance = true;

    await runCli(['up']);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'startHub', args: ['detached', 'local'] }]);
  });

  it('honours --attached outside a checkout', async () => {
    mocks.state.appliance = true;

    await runCli(['up', '--attached']);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'startHub', args: ['attached', 'local'] }]);
  });
});

describe('runCli logs argument disambiguation', () => {
  it.each([
    { argv: ['logs'], env: 'local', service: undefined },
    { argv: ['logs', 'dev'], env: 'dev', service: undefined },
    { argv: ['logs', 'prod'], env: 'prod', service: undefined },
    { argv: ['logs', 'backend'], env: 'local', service: 'backend' },
    { argv: ['logs', 'dev', 'backend'], env: 'dev', service: 'backend' },
    // The only way to tail a service whose name collides with an env name is to spell the env out.
    { argv: ['logs', 'local', 'dev'], env: 'local', service: 'dev' },
  ])('`cihub $argv` tails $service on $env', async ({ argv, env, service }) => {
    await runCli(argv);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'logsHub', args: [env, service] }]);
  });

  it.each([
    [['logs', 'backend', 'extra']],
    [['logs', 'dev', 'backend', 'extra']],
    // An empty first element (`cihub logs "" backend`) is the one way to reach the no-service half
    // of the arity guard; without it the service name would be dropped and every service tailed.
    [['logs', '', 'backend']],
  ])('`cihub %s` is a usage error rather than a silently dropped argument', async (argv) => {
    await expect(runCli(argv)).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorText()).toContain('Usage: cihub logs [env] [service]');
  });
});

describe('runCli mcp subcommands', () => {
  it.each([
    { argv: ['mcp', 'setup'], expected: [{ handler: 'setMcpState', args: ['local', true] }] },
    { argv: ['mcp', 'setup', 'dev'], expected: [{ handler: 'setMcpState', args: ['dev', true] }] },
    { argv: ['mcp', 'shutdown', 'prod'], expected: [{ handler: 'setMcpState', args: ['prod', false] }] },
    { argv: ['mcp', 'config', 'staging'], expected: [{ handler: 'printConfig', args: ['staging'] }] },
  ])('routes `cihub $argv`', async ({ argv, expected }) => {
    await runCli(argv);

    expect(mocks.calls).toEqual(expected);
  });

  it.each([[['mcp']], [['mcp', 'bogus']]])('`cihub %s` exits with the subcommand usage', async (argv) => {
    await expect(runCli(argv)).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorText()).toContain('Usage: cihub mcp <setup|shutdown|config> [env]');
  });
});

describe('runCli clean confirmation gate', () => {
  it('cleans only after the confirmation resolves true', async () => {
    await runCli(['clean', 'dev', '--yes']);

    expect(mocks.calls).toEqual<Dispatch[]>([
      { handler: 'confirmDestructiveAction', args: ['Cleaning dev', true, 'Remove generated files for dev? [y/N]: '] },
      { handler: 'cleanHub', args: ['dev'] },
    ]);
  });

  it('leaves generated files untouched when the confirmation is declined', async () => {
    mocks.state.confirm = false;

    await runCli(['clean']);

    expect(mocks.calls.map((call) => call.handler)).toEqual(['confirmDestructiveAction']);
    expect(logText()).toContain('Clean cancelled');
  });
});

describe('runCli removed commands', () => {
  it.each([
    { argv: ['shutdown'], removed: 'cihub shutdown [env]', replacement: 'cihub down [env]' },
    { argv: ['start'], removed: 'cihub start [env]', replacement: 'cihub up [env]' },
    { argv: ['start:detached'], removed: 'cihub start:detached [env]', replacement: 'cihub up [env] --detached' },
    { argv: ['hot-reload'], removed: 'cihub hot-reload [env]', replacement: 'cihub up local' },
    { argv: ['dev'], removed: 'cihub dev [env]', replacement: 'cihub up local' },
    { argv: ['purge'], removed: 'cihub purge --yes', replacement: 'cihub uninstall --yes' },
    { argv: ['catalog', 'publish'], removed: 'cihub catalog publish', replacement: 'cihub submit <dir>' },
    // `catalog` is matched on the verb alone: the bare form must still get guidance, not
    // 'Unknown command: catalog', because that is what someone typing the old command lands on.
    { argv: ['catalog'], removed: 'cihub catalog publish', replacement: 'cihub submit <dir>' },
  ])('`cihub $argv` exits with migration guidance to $replacement', async ({ argv, removed, replacement }) => {
    await expect(runCli(argv)).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(logText()).toContain('Command removed');
    expect(logText()).toContain(`${removed} was removed in this release.`);
    expect(logText()).toContain(`Use ${replacement} instead.`);
  });

  it.each([
    { argv: ['catalog', 'publish'], detail: 'Catalog submit never publishes. Staff approve in CI-App-Review.' },
    { argv: ['hot-reload'], detail: 'Use the local environment for source-based development.' },
    { argv: ['dev'], detail: 'Use the local environment for source-based development.' },
  ])('`cihub $argv` explains why it went away, not just what replaced it', async ({ argv, detail }) => {
    await expect(runCli(argv)).rejects.toThrow('exit');

    expect(logText()).toContain(detail);
  });

  it('does not fall through from a removed command to the unknown-command error', async () => {
    await expect(runCli(['shutdown'])).rejects.toThrow('exit');

    expect(errorText()).not.toContain('Unknown command');
  });
});

describe('runCli unknown commands', () => {
  it('names the offending command and exits non-zero', async () => {
    await expect(runCli(['frobnicate'])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errorText()).toContain('Unknown command: frobnicate');
    // usageAndExit prints help on stderr so a piped stdout is not polluted with it.
    expect(errorText()).toContain('Quick start');
  });
});

describe('runCli -- separator handling', () => {
  it('strips a leading -- so `npm run cihub -- status dev` routes normally', async () => {
    await runCli(['--', 'status', 'dev']);

    expect(mocks.calls).toEqual<Dispatch[]>([{ handler: 'showStatus', args: ['dev'] }]);
  });

  it('strips the leading -- before reading the help flag', async () => {
    await runCli(['--', '--help']);

    expect(logSpy).toHaveBeenCalledWith(renderHelp());
    expect(mocks.calls).toEqual<Dispatch[]>([]);
  });

  it('only strips -- in first position, so a stray -- is still a usage error', async () => {
    await expect(runCli(['status', '--'])).rejects.toThrow('exit');

    expect(mocks.calls).toEqual<Dispatch[]>([]);
    expect(errorText()).toContain('Unexpected argument: --');
  });
});
