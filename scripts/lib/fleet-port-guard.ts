/**
 * A firewall guard for one TCP port: accept from named interfaces, reject everything else with a
 * TCP reset, installed as a systemd oneshot so it survives a reboot and can be torn down cleanly.
 *
 * Why this exists as a general thing: two daemons on this fleet need to listen wider than the
 * tailnet and still be reachable only from it. gnome-remote-desktop cannot bind an address at all
 * (`fleet-rdp.ts`). Ollama *can*, but the Hub container on the same node reaches it at
 * `host.docker.internal:11434` — the Docker bridge gateway — which a tailnet-only bind does not
 * serve, so a `0.0.0.0` bind plus a guard that also admits the bridges is the arrangement that
 * keeps both the Hub and the tailnet working and the LAN out (`fleet-ollama-bind.ts`).
 *
 * Two rules learned on the machines, both encoded here so they cannot be forgotten:
 *   · **`--reject-with tcp-reset` requires `-p tcp`.** iptables refuses the rule otherwise, and the
 *     first hand-written guard failed on exactly that.
 *   · **Reject, don't drop.** A reset makes a LAN client see "connection refused" immediately, the
 *     same thing it would see from an xrdp bound to one address; a drop makes it hang and look like
 *     a network fault.
 *
 * Interfaces are matched by name; iptables treats a trailing `+` as a wildcard, which is how the
 * Docker bridges (`br-<network-id>`, one per compose network) are admitted without enumerating them.
 */

export interface PortGuardSpec {
  port: number;
  /** iptables chain name — upper case by convention, unique per guard. */
  chain: string;
  /** systemd unit name, with the `.service` suffix. */
  unitName: string;
  /** One line for the unit's `Description=`. */
  description: string;
  /** Interfaces whose traffic to `port` is accepted; anything else is reset. `lo` almost always belongs here. */
  acceptInterfaces: readonly string[];
  /** Units this guard must be up before — the daemon it protects, so no window exists where it listens unguarded. */
  before?: readonly string[];
}

type Tool = 'iptables' | 'ip6tables';

export const GUARD_UNIT_DIR = '/etc/systemd/system';

/** Where the unit lands. Shell-side it honours `CIHUB_GUARD_UNIT_DIR`, so the apply script can be run under a sandbox. */
export function guardUnitPath(spec: PortGuardSpec): string {
  return `${GUARD_UNIT_DIR}/${spec.unitName}`;
}
const unitPathShell = (spec: PortGuardSpec) => `"\${CIHUB_GUARD_UNIT_DIR:-${GUARD_UNIT_DIR}}/${spec.unitName}"`;

/** The rules, idempotently: create-or-flush the chain, fill it, ensure exactly one jump from INPUT. */
export function guardRules(spec: PortGuardSpec, tool: Tool): string[] {
  const t = tool;
  return [
    `${t} -N ${spec.chain} 2>/dev/null || true`,
    `${t} -F ${spec.chain}`,
    ...spec.acceptInterfaces.map((iface) => `${t} -A ${spec.chain} -i ${iface} -p tcp --dport ${spec.port} -j ACCEPT`),
    `${t} -A ${spec.chain} -p tcp --dport ${spec.port} -j REJECT --reject-with tcp-reset`,
    `while ${t} -D INPUT -p tcp --dport ${spec.port} -j ${spec.chain} 2>/dev/null; do :; done`,
    `${t} -I INPUT 1 -p tcp --dport ${spec.port} -j ${spec.chain}`,
  ];
}

export function guardTeardown(spec: PortGuardSpec, tool: Tool): string[] {
  const t = tool;
  return [
    `while ${t} -D INPUT -p tcp --dport ${spec.port} -j ${spec.chain} 2>/dev/null; do :; done`,
    `${t} -F ${spec.chain} 2>/dev/null || true`,
    `${t} -X ${spec.chain} 2>/dev/null || true`,
  ];
}

/**
 * The unit. `ExecStart` applies v4 and, where an `ip6tables` binary exists, v6; `ExecStop` removes
 * both, so `systemctl stop` is a complete undo. No `$` anywhere in the commands: systemd would
 * expand it before the shell saw it.
 */
export function guardUnitText(spec: PortGuardSpec): string {
  const sh = (cmds: string[]) => `/bin/sh -c '${cmds.join('; ')}'`;
  const before = ['network.target', ...(spec.before ?? [])].join(' ');
  return [
    '[Unit]',
    `Description=${spec.description}`,
    'Documentation=https://github.com/companionintelligence/CI-Hub/blob/dev/docs/fleet-setup.md',
    'After=network-pre.target',
    'Wants=network-pre.target',
    `Before=${before}`,
    '',
    '[Service]',
    'Type=oneshot',
    'RemainAfterExit=yes',
    `ExecStart=${sh(guardRules(spec, 'iptables'))}`,
    `ExecStart=${sh(['command -v ip6tables >/dev/null 2>&1 || exit 0', ...guardRules(spec, 'ip6tables')])}`,
    `ExecStop=${sh(guardTeardown(spec, 'iptables'))}`,
    `ExecStop=${sh(['command -v ip6tables >/dev/null 2>&1 || exit 0', ...guardTeardown(spec, 'ip6tables')])}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Shell (root) that writes the unit, enables it now, and proves the jump is in INPUT before saying
 * so. `heredocTag` must be unique within whatever script embeds this.
 */
export function guardInstallShell(spec: PortGuardSpec, opts: { heredocTag: string; okMarker: string; failMarker: string }): string[] {
  return [
    `cat > ${unitPathShell(spec)} <<'${opts.heredocTag}'`,
    guardUnitText(spec).trimEnd(),
    opts.heredocTag,
    'systemctl daemon-reload',
    `systemctl enable ${spec.unitName} >/dev/null 2>&1`,
    `systemctl restart ${spec.unitName}`,
    `if iptables -C INPUT -p tcp --dport ${spec.port} -j ${spec.chain} >/dev/null 2>&1; then echo "${opts.okMarker} ${spec.unitName} active; tcp/${spec.port} accepted from ${spec.acceptInterfaces.join(',')}, reset elsewhere"; else echo "${opts.failMarker} ${spec.unitName} did not install its INPUT jump for tcp/${spec.port}" >&2; exit 1; fi`,
  ];
}

/** Shell (root) that removes the guard if it is there, and says nothing if it is not. */
export function guardRemoveShell(spec: PortGuardSpec, opts: { marker: string }): string[] {
  return [
    `if [ -f ${unitPathShell(spec)} ]; then`,
    `  systemctl disable --now ${spec.unitName} >/dev/null 2>&1 || true`,
    `  rm -f ${unitPathShell(spec)}`,
    '  systemctl daemon-reload',
    `  echo "${opts.marker} ${spec.unitName} removed (the bind no longer needs it)"`,
    'fi',
  ];
}

/** Is a dumped chain (`iptables -S <chain>`) doing its job, given whether INPUT jumps to it? */
export function isGuardChainEffective(spec: PortGuardSpec, dump: string, jumped: boolean): boolean {
  const lines = dump.split('\n');
  const accepts = spec.acceptInterfaces.every((iface) =>
    lines.some((l) => l.includes(`-A ${spec.chain}`) && l.includes(`-i ${iface}`) && l.includes('-j ACCEPT')),
  );
  const reject = lines.some((l) => l.includes(`-A ${spec.chain}`) && l.includes('--reject-with tcp-reset'));
  return jumped && accepts && reject;
}

/**
 * Ollama listens on 0.0.0.0 so the Hub container can reach it over the Docker bridge; this is what
 * keeps that bind tailnet-only in practice. `docker0` is the default bridge, `br-+` every
 * user-defined one (compose creates one per network). A node with no Docker simply has no such
 * interfaces, and the rules referring to them match nothing.
 */
export const OLLAMA_PORT_GUARD: PortGuardSpec = {
  port: 11434,
  chain: 'OLLAMA_TAILNET_GUARD',
  unitName: 'ollama-tailnet-guard.service',
  description: 'Restrict Ollama (tcp/11434) to the tailnet, loopback and Docker bridges — it binds 0.0.0.0 so the Hub container can reach it',
  acceptInterfaces: ['lo', 'tailscale0', 'docker0', 'br-+'],
  before: ['ollama.service'],
};
