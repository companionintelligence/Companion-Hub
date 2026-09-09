import type { HubStatusReport, StatusModel, StatusWorkload } from './status-report.types';

/**
 * Render {@link HubStatusReport} as the `CI_HUB_STATUS.md` an operator reads.
 *
 * Pure: no clock, no filesystem, no services. Everything it prints comes from the
 * report it is handed, so the file's content is testable without a running Hub.
 *
 * The rule it enforces throughout: **a section that could not be read never
 * renders as an empty one.** `null` prints as "could not be read", `[]` prints as
 * "none installed" — because an auditor reading "no workloads" needs to know
 * whether that means none exist or the Docker socket was unreachable.
 */

const UNKNOWN = '_unknown_';

function gib(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return UNKNOWN;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function duration(seconds: number | null): string {
  if (seconds === null) return UNKNOWN;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Keep a cell from breaking the table when a name or status contains a pipe. */
function cell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function renderConnection(report: HubStatusReport): string[] {
  const lines = ['## Connection details', ''];
  const connection = report.connection;

  if (!connection) {
    lines.push('> Could not be read.', '');
    return lines;
  }

  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Hostname | ${cell(connection.hostname)} |`);
  lines.push(`| Device ID | ${cell(connection.deviceId)} |`);
  lines.push(`| Registered with Portal | ${yesNo(connection.registered)} |`);
  lines.push(`| Organization | ${cell(connection.organization)} |`);
  lines.push(`| Local API | ${connection.apiPort === null ? UNKNOWN : `http://127.0.0.1:${connection.apiPort}`} |`);
  lines.push(`| Public hostname | ${cell(connection.publicHostname)} |`);

  if (connection.tailscale) {
    lines.push(`| Tailscale | ${connection.tailscale.connected ? 'connected' : 'not connected'} |`);
    lines.push(`| Tailnet name | ${cell(connection.tailscale.nodeFqdn)} |`);
    lines.push(`| Tailnet | ${cell(connection.tailscale.tailnet)} |`);
  } else {
    lines.push(`| Tailscale | ${UNKNOWN} |`);
  }

  lines.push(`| Pool node UUID | ${cell(connection.poolNodeUuid)} |`);
  lines.push('');
  return lines;
}

function renderSystem(report: HubStatusReport): string[] {
  const lines = ['## System status', ''];
  const system = report.system;

  if (!system) {
    lines.push('> Could not be read.', '');
    return lines;
  }

  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Platform | ${cell(system.platform)} |`);
  lines.push(`| Uptime | ${duration(system.uptimeSeconds)} |`);

  if (system.cpu) {
    const load = system.cpu.loadPercent === null ? UNKNOWN : `${system.cpu.loadPercent.toFixed(0)}%`;
    lines.push(`| CPU | ${cell(system.cpu.model)} (${system.cpu.cores ?? UNKNOWN} cores), load ${load} |`);
  } else {
    lines.push(`| CPU | ${UNKNOWN} |`);
  }

  if (system.memory) {
    lines.push(`| Memory | ${gib(system.memory.usedBytes)} / ${gib(system.memory.totalBytes)} (${system.memory.percent.toFixed(0)}%) |`);
  } else {
    lines.push(`| Memory | ${UNKNOWN} |`);
  }

  if (system.disk) {
    lines.push(
      `| Disk | ${gib(system.disk.usedBytes)} / ${gib(system.disk.totalBytes)} used, ${gib(system.disk.freeBytes)} free (${system.disk.percent.toFixed(0)}%) |`,
    );
  } else {
    lines.push(`| Disk | ${UNKNOWN} |`);
  }

  if (system.gpu) {
    const vram = system.gpu.vramMb === null ? UNKNOWN : `${(system.gpu.vramMb / 1024).toFixed(1)} GiB VRAM`;
    const driver = system.gpu.driverWorking ? '' : ' — **driver not responding**';
    lines.push(`| GPU | ${cell(system.gpu.vendor)} ${cell(system.gpu.model)}, ${vram}${driver} |`);
  } else {
    lines.push('| GPU | none detected |');
  }

  lines.push(`| Hardware tier | ${cell(system.hardwareTier)} |`);
  lines.push(`| Docker | ${cell(system.dockerVersion)} |`);

  if (system.containerCount) {
    lines.push(
      `| Containers | ${system.containerCount.running} running, ${system.containerCount.stopped} stopped, ${system.containerCount.total} total |`,
    );
  }

  lines.push('');
  return lines;
}

function renderBackends(report: HubStatusReport): string[] {
  const lines = ['## LLM backends running', ''];
  const backends = report.backends;

  if (!backends) {
    lines.push('> Could not be read.', '');
    return lines;
  }

  const live = backends.filter((backend) => backend.running || backend.healthy);

  if (live.length === 0) {
    lines.push('No inference backend is running on this node.', '');
    return lines;
  }

  lines.push('| Backend | Running | Healthy | Endpoint | Models loaded |', '| --- | --- | --- | --- | --- |');
  for (const backend of live) {
    lines.push(
      `| ${cell(backend.type)} | ${yesNo(backend.running)} | ${yesNo(backend.healthy)} | ${cell(backend.url)} | ${backend.modelsLoaded ?? UNKNOWN} |`,
    );
  }

  const idle = backends.filter((backend) => !backend.running && !backend.healthy).map((backend) => backend.type);
  if (idle.length > 0) {
    lines.push('', `Not running: ${idle.map((name) => `\`${name}\``).join(', ')}.`);
  }

  lines.push('');
  return lines;
}

function renderModels(models: StatusModel[] | null): string[] {
  const lines = ['## LLM / AI models installed', ''];

  if (!models) {
    lines.push('> Could not be read.', '');
    return lines;
  }

  if (models.length === 0) {
    lines.push('No models are installed on this node.', '');
    return lines;
  }

  // A column in which every cell is unknown teaches nothing and reads as missing
  // data. Engines that report a size get the column; engines that do not, do not.
  const anySize = models.some((model) => model.sizeBytes !== null);

  if (anySize) {
    lines.push('| Model | Backend | Size | Servable |', '| --- | --- | --- | --- |');
    for (const model of models) {
      lines.push(`| ${cell(model.name)} | ${cell(model.backend)} | ${gib(model.sizeBytes)} | ${model.unservable ? '**no**' : 'yes'} |`);
    }
  } else {
    lines.push('| Model | Backend | Servable |', '| --- | --- | --- |');
    for (const model of models) {
      lines.push(`| ${cell(model.name)} | ${cell(model.backend)} | ${model.unservable ? '**no**' : 'yes'} |`);
    }
  }

  const unservable = models.filter((model) => model.unservable).length;
  if (unservable > 0) {
    lines.push('', `${unservable} model(s) are present on disk but failed to serve. Listing is not serving.`);
  }

  lines.push('');
  return lines;
}

function renderWorkloads(workloads: StatusWorkload[] | null): string[] {
  const lines = ['## Installed containerized workloads', ''];

  if (!workloads) {
    lines.push('> Could not be read.', '');
    return lines;
  }

  if (workloads.length === 0) {
    lines.push('No apps are installed on this node.', '');
    return lines;
  }

  lines.push('| App | Hub state | Containers up | Published ports |', '| --- | --- | --- | --- |');
  for (const workload of workloads) {
    const up = workload.containers.filter((container) => container.state === 'running').length;
    const ports = workload.containers
      .flatMap((container) => container.ports)
      .filter((port) => port.hostPort !== null)
      .map((port) => `${port.hostPort}->${port.containerPort}/${port.protocol}`);
    const uniquePorts = [...new Set(ports)];

    // `Hub state` is the database's belief and `Containers up` is the probe. They
    // are printed side by side precisely so a disagreement is visible.
    lines.push(
      `| ${cell(workload.name)} | ${cell(workload.desiredStatus)} | ${up}/${workload.containers.length} | ${uniquePorts.length > 0 ? uniquePorts.join(', ') : '—'} |`,
    );
  }

  const disagreeing = workloads.filter(
    (workload) => workload.desiredStatus === 'running' && workload.containers.every((container) => container.state !== 'running'),
  );

  if (disagreeing.length > 0) {
    lines.push(
      '',
      `> **${disagreeing.length} app(s) the Hub believes are running have no running container**: ${disagreeing
        .map((workload) => `\`${workload.name}\``)
        .join(', ')}.`,
    );
  }

  lines.push('');
  return lines;
}

export function renderHubStatusMarkdown(report: HubStatusReport): string {
  const lines: string[] = [
    '# CI-Hub node status',
    '',
    `_Generated ${report.generatedAt} by Companion Hub${report.hubVersion ? ` ${report.hubVersion}` : ''}._`,
    '',
    'This file is written by the Hub itself and refreshed periodically. If the timestamp',
    'above is old, the Hub that writes it is not running — the contents below are then a',
    'record of when it last ran, not of what is running now.',
    '',
  ];

  if (report.problems.length > 0) {
    lines.push('> **Some sections could not be read:**');
    for (const problem of report.problems) {
      lines.push(`> - ${problem}`);
    }
    lines.push('');
  }

  lines.push(
    ...renderConnection(report),
    ...renderBackends(report),
    ...renderModels(report.models),
    ...renderWorkloads(report.workloads),
    ...renderSystem(report),
  );

  return `${lines.join('\n').trimEnd()}\n`;
}
