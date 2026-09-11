import { z } from 'zod';
import { dynamicComposeSchemaV1 } from './utils/converters/v1.js';

const DENIED_CUSTOM_APP_HOST_PATHS = [
  '/',
  '/var/run/docker.sock',
  // On every systemd distro `/var/run` is a symlink to `/run`. The kernel follows the link at mount
  // time and this list is compared as strings, so the directory is denied under BOTH names: `/run`
  // alone left `/var/run/containerd/containerd.sock` open under the other one. It holds the Docker,
  // containerd and dbus sockets, each of them a host escape by itself.
  '/run',
  '/var/run',
  // Docker's data-root: every container's volumes, and with the classic storage drivers its
  // filesystem and image layers as well.
  '/var/lib/docker',
  // containerd's root, where Docker 29's default image store keeps image layers and every
  // container's filesystem instead.
  '/var/lib/containerd',
  '/proc',
  '/sys',
  '/dev',
  '/etc',
  '/root',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
];

/** Docker's own constraint on volume names (see `docker volume create`). */
const DOCKER_VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * A volume mounts either a host path or a named volume — never both, never neither.
 * `requiresPosixPermissions` describes how a bind mount must behave, so it only applies to `hostPath`.
 */
function assertVolumeSource(volume: { hostPath?: string; volumeName?: string; requiresPosixPermissions?: boolean }, ctx: z.RefinementCtx) {
  const hasHostPath = volume.hostPath !== undefined;
  const hasVolumeName = volume.volumeName !== undefined;

  if (hasHostPath && hasVolumeName) {
    ctx.addIssue({ code: 'custom', message: 'CUSTOM_APP_ERROR_VOLUME_SOURCE_AMBIGUOUS', path: ['volumeName'] });
  } else if (!hasHostPath && !hasVolumeName) {
    // Not HOST_PATH_REQUIRED: either source satisfies the volume, so naming only the bind mount
    // would send an author who meant to declare a named volume looking for the wrong field.
    ctx.addIssue({ code: 'custom', message: 'CUSTOM_APP_ERROR_VOLUME_SOURCE_REQUIRED', path: ['hostPath'] });
  }

  if (volume.requiresPosixPermissions && !hasHostPath) {
    ctx.addIssue({ code: 'custom', message: 'CUSTOM_APP_ERROR_POSIX_PERMISSIONS_REQUIRES_HOST_PATH', path: ['requiresPosixPermissions'] });
  }
}

/**
 * The one expansion a manifest may legitimately use: the Hub substitutes it with the app's own data
 * directory, which is never a denied path.
 *
 * Both alternatives match a COMPLETE reference, so a longer variable that merely starts with the
 * same characters (`${APP_DATA_DIR_EXTRA}`, `$APP_DATA_DIR_HOME`) is left intact and rejected below
 * as an unknown expansion. Prefix-matching it would substitute the leading half, hide the `$`, and
 * let compose expand the whole thing to `/etc` at up time.
 */
const APP_DATA_DIR_EXPANSION = /\$\{APP_DATA_DIR\}|\$APP_DATA_DIR(?![A-Za-z0-9_])/g;

/** A stand-in for the app's own data directory: absolute, and on no reject-list. */
const APP_DATA_DIR_PLACEHOLDER = '/app-data/__app__';

/**
 * Whether a host path cannot be canonicalized, and so cannot be cleared by the reject-list below.
 *
 * The reject-list is a string comparison, so a dot segment (`/etc/../etc`, `/./etc`) or an unknown
 * `${...}` expansion mounts a denied directory under a spelling the comparison never sees. Both are
 * rejected rather than resolved: a manifest has no legitimate need for either, and resolving them
 * would mean guessing at intent on the one input where guessing wrong is a host escape.
 */
function hasUnresolvableHostPathSyntax(hostPath: string): boolean {
  const substituted = hostPath.replace(APP_DATA_DIR_EXPANSION, APP_DATA_DIR_PLACEHOLDER);

  // Any OTHER expansion: the string checked here is not the string
  // docker-compose eventually resolves, so there is nothing to check.
  if (substituted.includes('$')) {
    return true;
  }

  return substituted
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

function normalizeCustomAppHostPath(hostPath: string): string {
  const normalized = hostPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized || '/';
}

/**
 * Host paths that are safe to bind even though they sit under a denied root: single,
 * well-known timezone files. Binding these grants no meaningful host access and many
 * apps rely on them, so they are never treated as a sandbox escape.
 */
const ALLOWED_CUSTOM_APP_HOST_PATHS = new Set(['/etc/localtime', '/etc/timezone']);

function isDeniedCustomAppHostPath(hostPath: string): boolean {
  // Unresolvable first: a path we cannot canonicalize is one we cannot clear.
  if (hasUnresolvableHostPathSyntax(hostPath)) {
    return true;
  }

  const normalized = normalizeCustomAppHostPath(hostPath.replace(APP_DATA_DIR_EXPANSION, APP_DATA_DIR_PLACEHOLDER));

  if (ALLOWED_CUSTOM_APP_HOST_PATHS.has(normalized)) {
    return false;
  }

  // A denied path is denied by its ANCESTORS too. `/var/lib/docker` is on the list, so binding
  // `/var/lib` — or `/var` — hands over the same data under a path the equality and prefix tests
  // never see. The third clause denies any directory that contains a denied path.
  return DENIED_CUSTOM_APP_HOST_PATHS.some(
    (denied) => normalized === denied || normalized.startsWith(`${denied}/`) || denied.startsWith(`${normalized}/`),
  );
}

function assertCustomAppServiceSecurity(service: { privileged?: boolean; volumes?: { hostPath?: string }[] }, ctx: z.RefinementCtx) {
  if (service.privileged === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED',
      path: ['privileged'],
    });
  }
  for (const [index, volume] of (service.volumes ?? []).entries()) {
    // Named volumes are docker-managed and expose no host path, so they cannot escape the sandbox.
    if (volume.hostPath !== undefined && isDeniedCustomAppHostPath(volume.hostPath)) {
      ctx.addIssue({
        code: 'custom',
        message: 'CUSTOM_APP_ERROR_HOST_PATH_DENIED',
        path: ['volumes', index, 'hostPath'],
      });
    }
  }
}

/**
 * Per-app grants for host-privileged compose features. First-party / marketplace apps
 * that legitimately require host access are listed here; every other app is rejected at
 * install time by the compose builder (see collectServiceSecurityViolations).
 *
 * Keep this list MINIMAL and AUDITED — each entry is an explicit hole in the app sandbox.
 * Grants are per-field and per-path: e.g. granting netdata `/proc` does NOT grant it
 * `privileged`.
 */
export interface AppSecurityGrants {
  privileged?: boolean;
  networkModeHost?: boolean;
  pidHost?: boolean;
  /** Denied host paths this app is explicitly permitted to bind. */
  hostPaths?: string[];
  /** Linux capabilities beyond the safe set this app may add. */
  capAdd?: string[];
  /** Host devices this app may pass through, as the host half of `devices`. */
  devices?: string[];
  /** Confinement this app may switch off, as the literal `securityOpt` entry. */
  securityOpt?: string[];
}

export const TRUSTED_APP_SECURITY_ALLOWLIST: Record<string, AppSecurityGrants> = {
  'home-assistant': { privileged: true, networkModeHost: true },
  'steam-headless': { privileged: true },
  coolify: { hostPaths: ['/root/.ssh', '/var/run/docker.sock'] },
  netdata: { hostPaths: ['/proc', '/sys', '/var/run/docker.sock'] },
  // System-design lab that orchestrates sibling containers via dockerode.
  torollo: { hostPaths: ['/var/run/docker.sock'] },
  // Self-hosted developer-workspace platform; needs the host docker socket to
  // reach the Docker daemon, per upstream's own install docs.
  coder: { hostPaths: ['/var/run/docker.sock'] },
  // Digital-human video synthesis: two of three services run privileged per
  // upstream's own reference docker-compose.yml.
  'duix-avatar': { privileged: true },
  // Cloud-native runtime security tool that hooks host syscalls; reads the
  // host docker socket, /proc, /etc, and kernel tracing, matching Falco's own
  // official docker quickstart.
  // BPF/PERFMON read the kernel tracepoints it hooks; SYS_PTRACE/SYS_RESOURCE match upstream.
  falco: {
    hostPaths: ['/var/run/docker.sock', '/proc', '/etc', '/sys/kernel/tracing'],
    capAdd: ['BPF', 'PERFMON', 'SYS_PTRACE', 'SYS_RESOURCE'],
  },
  // Agentic workspace's code-execution sandbox service needs privileged mode
  // to isolate arbitrary AI-agent-generated code, matching upstream's own
  // docker-compose.yml.
  refly: { privileged: true },
  // Host file explorer: bind-mounts Hub root so the UI can browse/edit device files.
  'filebrowser-quantum': { hostPaths: ['/'] },

  /*
   * NET_ADMIN for apps whose whole function is the network stack: a VPN or tunnel endpoint
   * configuring its own interface and routes, or a DNS/monitoring app that needs raw sockets. The
   * capability is confined to the container's own network namespace unless `networkModeHost` is
   * also granted, which none of these have.
   */
  dnsmasq: { capAdd: ['NET_ADMIN'] },
  gluetun: { capAdd: ['NET_ADMIN'] },
  librenms: { capAdd: ['NET_ADMIN'] },
  netalertx: { capAdd: ['NET_ADMIN'] },
  'pi-hole': { capAdd: ['NET_ADMIN'] },
  strix: { capAdd: ['NET_ADMIN'] },
  wireguard: { capAdd: ['NET_ADMIN'] },
  // QEMU/KVM appliances: NET_ADMIN builds the guest's bridge and TAP interface.
  macos: { capAdd: ['NET_ADMIN'] },
  windows: { capAdd: ['NET_ADMIN'] },
  'windows-arm': { capAdd: ['NET_ADMIN'] },

  /*
   * ⚠ SYS_ADMIN IS TREATED AS PRIVILEGED-EQUIVALENT and SYS_MODULE loads kernel modules. These
   * entries record what these apps already ship with rather than newly granting it, so that adding
   * the capability check does not break installs that work today. Each deserves an audit of its
   * own: the browser sandboxes below want SYS_ADMIN only for Chromium's user namespaces, which
   * `--no-sandbox` or a seccomp profile can replace.
   */
  'anything-llm': { capAdd: ['SYS_ADMIN'] },
  changedetection: { capAdd: ['SYS_ADMIN'] },
  'proxmox-backup': { capAdd: ['SYS_ADMIN'] },
  maxun: { capAdd: ['SYS_ADMIN'], securityOpt: ['seccomp=unconfined'] },
  // gerbil, the WireGuard data-plane sidecar, loads the kernel wireguard module.
  pangolin: { capAdd: ['NET_ADMIN', 'SYS_MODULE'] },
  // SDN overlay: NET_ADMIN for its TUN interface, SYS_ADMIN per upstream's compose.
  'zerotier-one': { capAdd: ['NET_ADMIN', 'SYS_ADMIN'] },
  // Secret-sharing vault: IPC_LOCK keeps decrypted secrets off swap.
  sup3rs3cretmes5age: { capAdd: ['IPC_LOCK'] },

  /*
   * ⚠ `seccomp=unconfined` REMOVES THE SYSCALL FILTER. Granted only for the GPU inference stacks
   * that need it: ROCm's userspace queues issue ioctls the default profile blocks. Recorded to
   * match what these apps ship with; a targeted profile would be the better long-term answer.
   */
  comfyui: { securityOpt: ['seccomp=unconfined'] },
  'hunyuan3d-rocm': { securityOpt: ['seccomp=unconfined'] },

  /*
   * Host paths and devices the DEVICE OWNER supplies through the install form, not the manifest.
   * The Hub builds the compose `.env` from `config.form_fields`, so these expansions resolve to a
   * value typed by the person who owns the Hub — the grant is for the app's declared field, and the
   * reject-list still holds for every path the manifest writes itself. The literal spelling has to
   * match the manifest exactly, because an expansion cannot be canonicalized before compose
   * resolves it.
   */
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  zigbee2mqtt: { devices: ['${ZIGBEE2MQTT_DEVICE}'] },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  'zwave-js-ui': { devices: ['${ZWAVE_DEVICE_PATH}'] },
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  navidrome: { hostPaths: ['${NAVIDROME_MUSIC_FOLDER:-${APP_DATA_DIR}/music}'] },
};

export interface ServiceSecurityViolation {
  path: (string | number)[];
  message: string;
  hostPath?: string;
}

interface SecurityCheckedService {
  privileged?: boolean;
  networkMode?: string;
  pid?: string;
  volumes?: { hostPath?: string; volumeName?: string }[];
  capAdd?: string[];
  devices?: string[];
  securityOpt?: string[];
}

/**
 * Capabilities an ordinary app may add without a grant.
 *
 * `capAdd` confers the power `privileged` confers, piecemeal: `SYS_ADMIN` is treated as equivalent
 * to privileged by every container-security guide, `SYS_MODULE` loads kernel modules, and
 * `DAC_READ_SEARCH` bypasses file permission checks. An allow-list, not a deny-list, because the
 * dangerous set grows with the kernel and the set an app legitimately needs does not.
 *
 * The list is Docker's OWN default capability set, which every container already holds. Adding one
 * of these back through `cap_add` grants nothing the runtime has not already granted — refusing it
 * would fail the install of any manifest that lists one redundantly, or that drops all capabilities
 * and re-adds the few it needs, and buy no security for it.
 */
const SAFE_CAP_ADD = new Set([
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'MKNOD',
  'NET_BIND_SERVICE',
  'NET_RAW',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
]);

/** Docker accepts `CAP_SYS_ADMIN` and `SYS_ADMIN` for the same capability, so both sides normalize. */
function normalizeCapability(capability: string): string {
  return capability.trim().toUpperCase().replace(/^CAP_/, '');
}

/** Docker accepts `seccomp=unconfined` and `seccomp:unconfined` for the same option, so both sides normalize. */
function normalizeSecurityOpt(opt: string): string {
  return opt
    .trim()
    .toLowerCase()
    .replace(/\s*[:=]\s*/, '=');
}

/**
 * `securityOpt` values that switch confinement OFF, matched against `normalizeSecurityOpt`.
 *
 * `label=` is refused whole: `label=disable` turns SELinux off outright, and `label=type:spc_t` —
 * the "super privileged container" type — is no weaker. `seccomp=` is refused whole because its
 * value is either `unconfined` or a path to a profile the Hub cannot audit, and the app's own data
 * directory is a host path it can write that profile into. `apparmor=my-profile` and
 * `no-new-privileges`, which tighten rather than loosen, are unaffected.
 */
const CONFINEMENT_DISABLING_SECURITY_OPTS = [/^apparmor=unconfined$/, /^systempaths=unconfined$/, /^seccomp=/, /^label=/];

/**
 * Host devices no app may pass through without a grant.
 *
 * Deliberately narrower than the host-path reject-list. `/dev` is on that list, but passing a single
 * character device through is ordinary for a self-hosted app — a Zigbee dongle (`/dev/ttyUSB0`), a
 * GPU (`/dev/dri`, `/dev/kfd`), a capture card (`/dev/video0`) — so refusing all of them would break
 * real installs and buy nothing. The escape is a device that IS the host: the tree itself, the
 * memory and port devices, and any block device, including the aliases that reach one under another
 * name (`/dev/disk/by-id/*`, `/dev/block/*`, `/dev/mapper/*`, `/dev/root`).
 */
const DENIED_DEVICE_PATTERNS = [
  /^\/dev\/?$/,
  /^\/dev\/(sd|nvme|vd|hd|xvd|loop|dm-|md|mmcblk|nbd|zd|ram|sr|pmem|dasd)/i,
  /^\/dev\/(disk|block|mapper)(\/|$)/i,
  /^\/dev\/(mem|kmem|port|root)$/i,
];

function isDeniedDeviceHostPath(hostHalf: string): boolean {
  if (hasUnresolvableHostPathSyntax(hostHalf)) {
    return true;
  }

  const normalized = normalizeCustomAppHostPath(hostHalf);

  if (DENIED_DEVICE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Anything OUTSIDE `/dev` is an ordinary host path and is held to the ordinary
  // reject-list: `devices` must not become a second way to mount `/etc`.
  return !normalized.startsWith('/dev/') && isDeniedCustomAppHostPath(hostHalf);
}

/**
 * Returns the host-privileged features a service requests that are NOT permitted by its
 * grants. An empty array means the service stays within the app sandbox. This is the
 * authoritative check enforced at the compose-build (install) sink so that a malicious or
 * compromised marketplace manifest cannot obtain root-equivalent access on the host.
 */
export function collectServiceSecurityViolations(service: SecurityCheckedService, grants?: AppSecurityGrants): ServiceSecurityViolation[] {
  const violations: ServiceSecurityViolation[] = [];

  if (service.privileged === true && !grants?.privileged) {
    violations.push({ path: ['privileged'], message: 'CUSTOM_APP_ERROR_PRIVILEGED_NOT_ALLOWED' });
  }
  // `container:<name>` joins the namespace of an arbitrary container by name, the Hub's own
  // included, so it reaches whatever that container binds on loopback and defeats the
  // internal-infrastructure port isolation the compose builder applies. It needs the same grant the
  // host namespace needs. (`service:<name>` stays inside the app's own project and is left alone.)
  if ((service.networkMode === 'host' || service.networkMode?.startsWith('container:')) && !grants?.networkModeHost) {
    violations.push({ path: ['networkMode'], message: 'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED' });
  }
  if ((service.pid === 'host' || service.pid?.startsWith('container:')) && !grants?.pidHost) {
    violations.push({ path: ['pid'], message: 'CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED' });
  }

  /*
   * A service that is both granted `privileged` and declares it needs no separate capability,
   * device or confinement check: `privileged: true` already confers every capability, every device
   * and no confinement, so checking them again would be theatre and would need four allowlist
   * entries to say one thing.
   *
   * Scoped to the service that actually runs privileged, and to these three axes only. A grant is
   * per-field and per-path, so it must not silently widen the app's OTHER services, nor the host
   * bind reject-list below — `home-assistant` is granted `privileged`, not `/var/run/docker.sock`.
   */
  const isAuditedPrivileged = service.privileged === true && grants?.privileged === true;

  if (!isAuditedPrivileged) {
    const grantedCaps = new Set((grants?.capAdd ?? []).map(normalizeCapability));
    for (const [index, cap] of (service.capAdd ?? []).entries()) {
      const normalized = normalizeCapability(cap);

      if (SAFE_CAP_ADD.has(normalized) || grantedCaps.has(normalized)) {
        continue;
      }

      violations.push({ path: ['capAdd', index], message: 'CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED', hostPath: cap });
    }

    const grantedSecurityOpts = new Set((grants?.securityOpt ?? []).map(normalizeSecurityOpt));
    for (const [index, opt] of (service.securityOpt ?? []).entries()) {
      const normalized = normalizeSecurityOpt(opt);

      if (!CONFINEMENT_DISABLING_SECURITY_OPTS.some((pattern) => pattern.test(normalized)) || grantedSecurityOpts.has(normalized)) {
        continue;
      }

      violations.push({ path: ['securityOpt', index], message: 'CUSTOM_APP_ERROR_SECURITY_OPT_NOT_ALLOWED', hostPath: opt });
    }

    const grantedDevices = new Set((grants?.devices ?? []).map(normalizeCustomAppHostPath));
    for (const [index, device] of (service.devices ?? []).entries()) {
      // `devices` is `host:container[:perms]`, and only the HOST half escapes.
      // `?? ''` for `noUncheckedIndexedAccess`; `split` always yields at least one element.
      const hostHalf = device.split(':')[0] ?? '';

      if (grantedDevices.has(normalizeCustomAppHostPath(hostHalf))) {
        continue;
      }

      if (isDeniedDeviceHostPath(hostHalf)) {
        violations.push({ path: ['devices', index], message: 'CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED', hostPath: device });
      }
    }
  }

  const grantedPaths = new Set((grants?.hostPaths ?? []).map(normalizeCustomAppHostPath));
  for (const [index, volume] of (service.volumes ?? []).entries()) {
    // Compose's short syntax decides bind-vs-volume from the shape of the source: `/var/run/docker.sock`
    // in the volumeName slot is rendered as a HOST BIND, not a named volume. The schema's charset rule
    // is only advisory at the install sink (parse failures there warn), so a volumeName that is not a
    // plain docker volume name has to be rejected here or it would smuggle a bind past every check below.
    if (volume.volumeName !== undefined && !DOCKER_VOLUME_NAME_PATTERN.test(volume.volumeName)) {
      violations.push({ path: ['volumes', index, 'volumeName'], message: 'CUSTOM_APP_ERROR_VOLUME_NAME_INVALID', hostPath: volume.volumeName });
      continue;
    }

    // A genuine named volume is docker-managed and exposes no host path, so it cannot escape the sandbox.
    if (volume.hostPath === undefined) {
      continue;
    }
    // The benign timezone binds are cleared inside `isDeniedCustomAppHostPath`, so both this sink
    // and the schema layer agree on them; only the per-app grants are consulted here.
    if (grantedPaths.has(normalizeCustomAppHostPath(volume.hostPath))) {
      continue;
    }
    if (isDeniedCustomAppHostPath(volume.hostPath)) {
      violations.push({ path: ['volumes', index, 'hostPath'], message: 'CUSTOM_APP_ERROR_HOST_PATH_DENIED', hostPath: volume.hostPath });
    }
  }

  return violations;
}

/**
 * Minimum supported schema version
 * Apps with schema version below this will be blocked from installation/update
 */
export const MIN_SCHEMA_VERSION = 1;

/**
 * Current schema version
 * Apps below this version will show a deprecation warning
 */
export const CURRENT_SCHEMA_VERSION = 2;

const serviceSchemaV2Object = z.object({
  image: z.string('CUSTOM_APP_ERROR_IMAGE_REQUIRED'),
  name: z.string('CUSTOM_APP_ERROR_NAME_REQUIRED'),
  internalPort: z
    .union([
      z
        .number('CUSTOM_APP_ERROR_INTERNAL_PORT_INVALID')
        .min(1, 'CUSTOM_APP_ERROR_INTERNAL_PORT_MIN')
        .max(65535, 'CUSTOM_APP_ERROR_INTERNAL_PORT_MAX'),
      z.string(),
    ])
    .optional(),
  isMain: z.boolean().optional(),
  restart: z.enum(['no', 'always', 'unless-stopped', 'on-failure'], 'CUSTOM_APP_ERROR_RESTART_INVALID').optional(),
  networkMode: z.string().optional(),
  extraHosts: z.array(z.string('CUSTOM_APP_ERROR_EXTRA_HOST_INVALID')).optional(),
  ulimits: z
    .object({
      nproc: z
        .number('CUSTOM_APP_ERROR_ULIMIT_NPROC_INVALID')
        .or(z.object({ soft: z.number('CUSTOM_APP_ERROR_ULIMIT_SOFT_INVALID'), hard: z.number('CUSTOM_APP_ERROR_ULIMIT_HARD_INVALID') }))
        .optional(),
      nofile: z
        .number('CUSTOM_APP_ERROR_ULIMIT_NOFILE_INVALID')
        .or(z.object({ soft: z.number('CUSTOM_APP_ERROR_ULIMIT_SOFT_INVALID'), hard: z.number('CUSTOM_APP_ERROR_ULIMIT_HARD_INVALID') }))
        .optional(),
      core: z
        .number('CUSTOM_APP_ERROR_ULIMIT_CORE_INVALID')
        .or(z.object({ soft: z.number('CUSTOM_APP_ERROR_ULIMIT_SOFT_INVALID'), hard: z.number('CUSTOM_APP_ERROR_ULIMIT_HARD_INVALID') }))
        .optional(),
      memlock: z
        .number('CUSTOM_APP_ERROR_ULIMIT_MEMLOCK_INVALID')
        .or(z.object({ soft: z.number('CUSTOM_APP_ERROR_ULIMIT_SOFT_INVALID'), hard: z.number('CUSTOM_APP_ERROR_ULIMIT_HARD_INVALID') }))
        .optional(),
    })
    .optional(),
  addToMainNetwork: z.boolean().optional(),
  addPorts: z
    .array(
      z.object({
        containerPort: z.union([
          z
            .number('CUSTOM_APP_ERROR_CONTAINER_PORT_INVALID')
            .min(1, 'CUSTOM_APP_ERROR_CONTAINER_PORT_MIN')
            .max(65535, 'CUSTOM_APP_ERROR_CONTAINER_PORT_MAX'),
          z.string(),
        ]),
        hostPort: z.union([
          z.number('CUSTOM_APP_ERROR_HOST_PORT_INVALID').min(1, 'CUSTOM_APP_ERROR_HOST_PORT_MIN').max(65535, 'CUSTOM_APP_ERROR_HOST_PORT_MAX'),
          z.string(),
        ]),
        udp: z.boolean().optional(),
        tcp: z.boolean().optional(),
        interface: z.string().optional(),
      }),
    )
    .optional(),
  command: z
    .string()
    .optional()
    .or(z.array(z.string('CUSTOM_APP_ERROR_COMMAND_INVALID')).optional()),
  volumes: z
    .array(
      z
        .object({
          // `.min(1)` because `assertVolumeSource` only asks whether the field is present: an empty
          // string reads as "declared", passes the source check, and then makes `setVolume` throw
          // "declares neither hostPath nor volumeName" — a message that contradicts the manifest.
          hostPath: z.string('CUSTOM_APP_ERROR_HOST_PATH_REQUIRED').min(1, 'CUSTOM_APP_ERROR_HOST_PATH_REQUIRED').optional(),
          /**
           * Docker-managed named volume, mounted instead of a host bind. Compose scopes the name to
           * the app's project, so `db` becomes `<app>_<store>_db` and cannot collide across apps.
           */
          volumeName: z.string().regex(DOCKER_VOLUME_NAME_PATTERN, 'CUSTOM_APP_ERROR_VOLUME_NAME_INVALID').optional(),
          // An empty target renders as `source:` — compose rejects it, but only once the app is
          // already installing, and the error names the generated file rather than the manifest.
          containerPath: z.string('CUSTOM_APP_ERROR_CONTAINER_PATH_REQUIRED').min(1, 'CUSTOM_APP_ERROR_CONTAINER_PATH_REQUIRED'),
          readOnly: z.boolean().optional(),
          /**
           * Marks a bind mount whose contents need real POSIX ownership/permissions — database data
           * directories above all. Windows-backed host paths (drvfs/9p) silently ignore chown/chmod,
           * so `initdb` and `mysqld` abort with EPERM there. When this is set and the host filesystem
           * cannot carry ownership, the Hub mounts a named volume instead of the bind. Platforms that
           * do support ownership keep the bind mount, so existing installs never lose their data.
           */
          requiresPosixPermissions: z.boolean().optional(),
          shared: z.boolean().optional(),
          private: z.boolean().optional(),
          bind: z
            .object({
              propagation: z.enum(['rprivate', 'private', 'rshared', 'shared', 'rslave', 'slave']),
            })
            .optional(),
        })
        .superRefine(assertVolumeSource),
    )
    .optional(),
  environment: z
    .array(
      z.object({
        key: z.string('CUSTOM_APP_ERROR_ENV_KEY_REQUIRED').min(1, 'CUSTOM_APP_ERROR_ENV_KEY_MIN_LENGTH'),
        value: z.string('CUSTOM_APP_ERROR_ENV_VALUE_REQUIRED').min(1, 'CUSTOM_APP_ERROR_ENV_VALUE_MIN_LENGTH').or(z.number()).or(z.boolean()),
      }),
    )
    .optional(),
  sysctls: z.record(z.string('CUSTOM_APP_ERROR_SYSCTL_KEY_INVALID'), z.number('CUSTOM_APP_ERROR_SYSCTL_VALUE_INVALID')).optional(),
  healthCheck: z
    .object({
      test: z.string('CUSTOM_APP_ERROR_HEALTH_CHECK_TEST_REQUIRED'),
      interval: z.string().optional(),
      timeout: z.string().optional(),
      retries: z.number('CUSTOM_APP_ERROR_HEALTH_CHECK_RETRIES_INVALID').optional(),
      startInterval: z.string().optional(),
      startPeriod: z.string().optional(),
    })
    .optional(),
  dependsOn: z
    .union([
      z.array(z.string('CUSTOM_APP_ERROR_DEPENDS_ON_SERVICE_INVALID')),
      z.record(
        z.string('CUSTOM_APP_ERROR_DEPENDS_ON_SERVICE_INVALID'),
        z.object({
          condition: z.enum(
            ['service_healthy', 'service_started', 'service_completed_successfully'],
            'CUSTOM_APP_ERROR_DEPENDS_ON_CONDITION_INVALID',
          ),
        }),
      ),
    ])
    .optional(),
  capAdd: z.array(z.string('CUSTOM_APP_ERROR_CAP_ADD_INVALID')).optional(),
  deploy: z
    .object({
      resources: z.object({
        limits: z
          .object({
            cpus: z.string().optional(),
            memory: z.string().optional(),
            pids: z.number('CUSTOM_APP_ERROR_DEPLOY_PIDS_INVALID').optional(),
          })
          .optional(),
        reservations: z
          .object({
            cpus: z.string().optional(),
            memory: z.string().optional(),
            devices: z
              .object({
                capabilities: z.array(z.string('CUSTOM_APP_ERROR_DEVICE_CAPABILITY_INVALID')),
                driver: z.string().optional(),
                count: z.enum(['all'], 'CUSTOM_APP_ERROR_DEVICE_COUNT_INVALID').or(z.number('CUSTOM_APP_ERROR_DEVICE_COUNT_INVALID')).optional(),
                deviceIds: z.array(z.string('CUSTOM_APP_ERROR_DEVICE_ID_INVALID')).optional(),
              })
              .array(),
          })
          .optional(),
      }),
    })
    .optional(),
  hostname: z.string().optional(),
  devices: z.array(z.string('CUSTOM_APP_ERROR_DEVICE_INVALID')).optional(),
  entrypoint: z
    .string()
    .or(z.array(z.string('CUSTOM_APP_ERROR_ENTRYPOINT_INVALID')))
    .optional(),
  pid: z.string().optional(),
  privileged: z.boolean().optional(),
  tty: z.boolean().optional(),
  user: z.string().optional(),
  workingDir: z.string().optional(),
  shmSize: z.string().optional(),
  httpsBackend: z.boolean().optional(),
  capDrop: z.array(z.string('CUSTOM_APP_ERROR_CAP_DROP_INVALID')).optional(),
  logging: z
    .object({
      driver: z.string('CUSTOM_APP_ERROR_LOGGING_DRIVER_REQUIRED'),
      options: z
        .record(z.string('CUSTOM_APP_ERROR_LOGGING_OPTION_KEY_INVALID'), z.string('CUSTOM_APP_ERROR_LOGGING_OPTION_VALUE_INVALID'))
        .optional(),
    })
    .optional(),
  readOnly: z.boolean().optional(),
  securityOpt: z.array(z.string('CUSTOM_APP_ERROR_SECURITY_OPT_INVALID')).optional(),
  stopSignal: z.string().optional(),
  stopGracePeriod: z.string().optional(),
  stdinOpen: z.boolean().optional(),
  extraLabels: z.record(z.string('CUSTOM_APP_ERROR_LABEL_KEY_INVALID'), z.string().or(z.boolean())).optional(),
  dns: z
    .string()
    .optional()
    .or(z.array(z.string('CUSTOM_APP_ERROR_DNS_INVALID')).optional()),
  platform: z.string().optional(),
});

export const serviceSchema = serviceSchemaV2Object.superRefine((service, ctx) => {
  assertCustomAppServiceSecurity(service, ctx);
});

/**
 * Unrefined object form of the dynamic compose schema.
 *
 * Keep this separate from `dynamicComposeSchema`: Zod 4 rejects `.omit()` /
 * `.pick()` on an object schema that carries refinements ("`.omit()` cannot be
 * used on object schemas containing refinements"). Callers that need a subset
 * of the shape must derive it from this object and re-apply
 * `assertComposeOverrideSecurity` themselves — see `dynamicComposeFormSchema`.
 */
export const dynamicComposeObject = z.object({
  schemaVersion: z.literal(2),
  services: serviceSchema.array().min(1, 'CUSTOM_APP_ERROR_SERVICES_MIN_LENGTH'),
  overrides: z
    .array(
      z.object({
        architecture: z.enum(['arm64', 'amd64'], 'CUSTOM_APP_ERROR_ARCHITECTURE_INVALID').optional(),
        services: serviceSchemaV2Object.partial().array(),
      }),
    )
    .optional(),
});

const assertComposeOverrideSecurity = (compose: { overrides?: { services: unknown[] }[] }, ctx: z.RefinementCtx) => {
  for (const override of compose.overrides ?? []) {
    for (const service of override.services) {
      assertCustomAppServiceSecurity(service as Parameters<typeof assertCustomAppServiceSecurity>[0], ctx);
    }
  }
};

export const dynamicComposeSchema = dynamicComposeObject.superRefine(assertComposeOverrideSecurity);

/**
 * Shape used by the custom-app builder form, which supplies `schemaVersion`
 * itself on submit and therefore must not require it as user input.
 */
export const dynamicComposeFormSchema = dynamicComposeObject.omit({ schemaVersion: true }).superRefine(assertComposeOverrideSecurity);

export const dynamicComposeUnion = z.discriminatedUnion('schemaVersion', [dynamicComposeSchemaV1, dynamicComposeSchema]);

export type DynamicCompose = z.output<typeof dynamicComposeSchema>;
export type DependsOn = z.output<typeof serviceSchema.shape.dependsOn>;
export type ServiceInput = z.input<typeof serviceSchema>;
export type Service = z.output<typeof serviceSchema>;
