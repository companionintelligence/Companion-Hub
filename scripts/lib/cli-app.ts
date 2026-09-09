/**
 * The `cihub app` command surface: inspecting and driving the containers the Hub manages.
 *
 * This view of an app is deliberately container-level. The Hub backend owns the richer
 * URN/compose-project/database view over `/api/app-lifecycle`; these subcommands exist so an
 * operator on the box can see and move containers without a running backend.
 */
import { spawnSync } from 'node:child_process';
import { usageAndExit } from './cli-args.js';
import { run, runCapture } from './cli-proc.js';
import { bold, colorize, dim, printMessageBox, STEP_ICONS } from './cli-ui.js';

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

/** `--tail 10` and `--tail=10` both, matching `readValue` in the fleet module. */
function readAppFlagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function appStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith('up')) return colorize(status, 'green');
  if (s.startsWith('exit')) return colorize(status, 'red');
  if (s.startsWith('paus')) return colorize(status, 'yellow');
  return dim(status);
}

function managedAppContainerIds(): string[] {
  const ids = new Set<string>();
  for (const filters of [
    ['label=ci-hub.managed=true', 'label=ci-hub.appurn'],
    ['label=ci-os-hub.managed=true', 'label=ci-os-hub.appurn'],
  ]) {
    const { stdout, ok } = runCapture('docker', ['ps', '-a', '--filter', filters[0], '--filter', filters[1], '--format', '{{.ID}}']);
    if (!ok || !stdout) continue;
    for (const id of stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)) {
      ids.add(id);
    }
  }
  return [...ids];
}

export function runAppCommand(args: string[]) {
  const subcommand = args[0];
  if (!subcommand) usageAndExit('Missing app subcommand');

  // list ??????????????????????????????????????????????????????????????????????
  if (subcommand === 'list') {
    printMessageBox('Managed Docker apps', ['Listing all containers on this machine.'], 'cyan');
    run('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}']);
    return;
  }

  // status ????????????????????????????????????????????????????????????????????
  if (subcommand === 'status') {
    const name = args[1];
    const filterArgs = name
      ? ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}']
      : ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'];
    const { stdout } = runCapture('docker', filterArgs);
    const rows = stdout.split('\n').filter(Boolean);
    if (rows.length === 0) {
      printMessageBox('App status', [name ? `Container "${name}" not found.` : 'No containers running.'], name ? 'red' : 'yellow');
      // A named container that is not there is a failed lookup; a machine with no containers at all
      // is an answer to the question asked.
      if (name) process.exitCode = 1;
      return;
    }
    const lines = rows.map((row) => {
      const [n, s, p] = row.split('\t');
      const isUp = (s || '').toLowerCase().startsWith('up');
      const dot = isUp ? colorize(STEP_ICONS.done, 'green') : colorize(STEP_ICONS.fail, 'red');
      const statusStr = appStatusColor(s || '');
      const portsStr = p ? dim(` \u2192 ${p}`) : '';
      return `${dot} ${bold(n || '')}  ${statusStr}${portsStr}`;
    });
    printMessageBox('App status', lines, 'cyan');
    return;
  }

  // logs ??????????????????????????????????????????????????????????????????????
  if (subcommand === 'logs') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app logs <name> [--tail N]');
    const tail = readAppFlagValue(args, '--tail') || '50';
    printMessageBox('Container logs', [`Container: ${name}`, `Tail: ${tail} lines`], 'dim');
    run('docker', ['logs', '--tail', tail, '--timestamps', name]);
    return;
  }

  if (subcommand === 'stop-managed' || subcommand === 'remove-managed') {
    const ids = managedAppContainerIds();
    if (ids.length === 0) {
      printMessageBox('Managed app cleanup', ['No Hub-managed app containers found.'], 'yellow');
      return;
    }
    const dockerCommand = subcommand === 'stop-managed' ? 'stop' : 'rm';
    const dockerArgs = subcommand === 'stop-managed' ? ['stop', ...ids] : ['rm', '-f', ...ids];
    printMessageBox('Managed app cleanup', [`Action: ${subcommand === 'stop-managed' ? 'stop' : 'remove'}`, `Containers: ${ids.length}`], 'yellow');
    run('docker', dockerArgs);
    printMessageBox('Managed app cleanup', [`Successfully ran docker ${dockerCommand} on ${ids.length} Hub-managed app container(s).`], 'green');
    return;
  }

  // inspect ???????????????????????????????????????????????????????????????????
  if (subcommand === 'inspect') {
    const name = args[1];
    if (!name) usageAndExit('Usage: app inspect <name>');
    const { stdout, ok } = runCapture('docker', ['inspect', name]);
    if (!ok || !stdout) {
      printMessageBox('Inspect', [`Container "${name}" not found.`], 'red');
      process.exitCode = 1;
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
        return host ? `${host} \u2192 ${k}` : k;
      })
      .filter(Boolean);
    if (ports.length > 0) lines.push(`${bold('ports')}   ${ports.join('  ')}`);
    const envVars = (c.Config?.Env || []).filter((e) => !e.startsWith('PATH='));
    if (envVars.length > 0) lines.push(`${bold('env')}     ${envVars.slice(0, 5).join('  ')}`);
    const mounts = (c.Mounts || []).map((m) => `${m.Source} \u2192 ${m.Destination}`);
    if (mounts.length > 0) lines.push(`${bold('mounts')} ${mounts.slice(0, 3).join('  ')}`);
    printMessageBox(`Inspect: ${name}`, lines, 'cyan');
    return;
  }

  // add / edit ????????????????????????????????????????????????????????????????
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

  // start / stop / restart / delete ??????????????????????????????????????????
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
