import { z } from 'zod';
import { dynamicComposeSchemaV1 } from './utils/converters/v1.js';

const DENIED_CUSTOM_APP_HOST_PATHS = [
  '/',
  '/var/run/docker.sock',
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
 * ⚠ THE REJECT-LIST IS A STRING COMPARISON, so anything that spells a denied
 * path differently used to walk straight past it.
 *
 * `normalizeCustomAppHostPath` collapsed separators and dropped a trailing
 * slash and stopped there: it never resolved a `.` or `..` segment. So `/etc`
 * was denied while `/etc/../etc`, `/./etc` and `/var/../etc` were not — each is
 * one character away from the denied form and mounts exactly the same
 * directory. A `${...}` expansion is the same problem one layer later: the
 * string checked here is not the string docker-compose eventually resolves.
 *
 * Both are REJECTED rather than resolved. A manifest has no legitimate need for
 * a relative segment or an expansion in a host path — every real entry in the
 * allowlist above is a plain absolute path — so accepting them and normalising
 * would only mean guessing at what the author meant, on the one input where
 * guessing wrong is a host escape.
 */
/**
 * The one expansion a manifest may legitimately use.
 *
 * `${APP_DATA_DIR}` is substituted by the Hub with the app's OWN data
 * directory, which is under the app-data root and therefore never a denied
 * path. Substituting it here — rather than rejecting it — lets the reject-list
 * see the shape of the rest of the path, so `${APP_DATA_DIR}/../../etc` is still
 * caught by the dot-segment test below.
 */
const APP_DATA_DIR_EXPANSION = /\$\{?APP_DATA_DIR\}?/g;

/** A stand-in for the app's own data directory: absolute, and on no reject-list. */
const APP_DATA_DIR_PLACEHOLDER = '/app-data/__app__';

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

function isDeniedCustomAppHostPath(hostPath: string): boolean {
  // Unresolvable first: a path we cannot canonicalize is one we cannot clear.
  if (hasUnresolvableHostPathSyntax(hostPath)) {
    return true;
  }

  const normalized = normalizeCustomAppHostPath(hostPath.replace(APP_DATA_DIR_EXPANSION, APP_DATA_DIR_PLACEHOLDER));
  return DENIED_CUSTOM_APP_HOST_PATHS.some((denied) => normalized === denied || normalized.startsWith(`${denied}/`));
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
 * Host paths that are safe to bind even though they sit under a denied root: single,
 * well-known timezone files. Binding these grants no meaningful host access and many
 * apps rely on them, so they are never treated as a sandbox escape.
 */
const ALLOWED_CUSTOM_APP_HOST_PATHS = new Set(['/etc/localtime', '/etc/timezone']);

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
  falco: { hostPaths: ['/var/run/docker.sock', '/proc', '/etc', '/sys/kernel/tracing'] },
  // Agentic workspace's code-execution sandbox service needs privileged mode
  // to isolate arbitrary AI-agent-generated code, matching upstream's own
  // docker-compose.yml.
  refly: { privileged: true },
  // Host file explorer: bind-mounts Hub root so the UI can browse/edit device files.
  'filebrowser-quantum': { hostPaths: ['/'] },
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
 * ⚠ THE POINT OF BLOCKING `privileged` IS THE POWER IT CONFERS, AND `capAdd`
 * CONFERS THE SAME POWER PIECEMEAL. `SYS_ADMIN` alone is close enough to
 * privileged to be treated as equivalent by every container-security guide;
 * `SYS_MODULE` loads kernel modules; `SYS_RAWIO` reaches raw devices;
 * `SYS_PTRACE` reads other processes' memory; `DAC_READ_SEARCH` bypasses file
 * permission checks; `MKNOD` creates device nodes. Refusing `privileged: true`
 * while accepting any of these was a sandbox that could be stepped over rather
 * than climbed.
 *
 * An allow-list, not a deny-list: the set of dangerous capabilities grows with
 * the kernel, and the set an app legitimately needs does not.
 */
const SAFE_CAP_ADD = new Set(['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID', 'FOWNER', 'DAC_OVERRIDE', 'KILL']);

/**
 * `securityOpt` values that switch confinement OFF.
 *
 * Matched on the VALUE half so `apparmor=unconfined` is refused while
 * `apparmor=my-profile` is not, and so `no-new-privileges` — which tightens
 * rather than loosens — is unaffected.
 */
const CONFINEMENT_DISABLING_SECURITY_OPTS = /^(apparmor|seccomp|systempaths)\s*[:=]\s*unconfined$|^label\s*[:=]\s*disable$/i;

/**
 * Host devices no app may pass through without a grant.
 *
 * ⚠ DELIBERATELY NARROWER THAN THE HOST-PATH REJECT-LIST. `/dev` is on that
 * list, but passing through a single character device under it is an ORDINARY
 * thing for a self-hosted app to need — a Zigbee or Z-Wave dongle
 * (`/dev/ttyUSB0`, `/dev/ttyACM0`), a GPU (`/dev/dri`, `/dev/kfd`), a capture
 * card (`/dev/video0`). Refusing all of those would break real installs while
 * buying nothing: the escape is not "a device" but a device that IS the host.
 *
 * What is refused: `/dev` itself or any other denied ROOT (which passes the
 * whole tree), raw block devices (the disk the host filesystem is on, readable
 * and writable byte by byte, whatever the file permissions say), and the memory
 * and port devices.
 */
const DENIED_DEVICE_PATTERNS = [/^\/dev\/?$/, /^\/dev\/(sd|nvme|vd|hd|xvd|loop|dm-|md)/i, /^\/dev\/mapper\//i, /^\/dev\/(mem|kmem|port)$/i];

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
  if (!normalized.startsWith('/dev/')) {
    return isDeniedCustomAppHostPath(hostHalf);
  }

  return false;
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
  if (service.networkMode === 'host' && !grants?.networkModeHost) {
    violations.push({ path: ['networkMode'], message: 'CUSTOM_APP_ERROR_NETWORK_MODE_HOST_NOT_ALLOWED' });
  }
  if (service.pid === 'host' && !grants?.pidHost) {
    violations.push({ path: ['pid'], message: 'CUSTOM_APP_ERROR_PID_HOST_NOT_ALLOWED' });
  }

  /*
   * ⚠ THE AXES BELOW WERE CHECKED BY NEITHER LAYER, so the `privileged` refusal
   * above was the front door of a building with the windows open.
   *
   * ⚠ A `privileged` GRANT SUBSUMES THEM. `privileged: true` already confers
   * every capability, every device and no confinement — that is what it means —
   * so refusing an audited privileged app's `capAdd` would be theatre, and would
   * make the allowlist harder to read by requiring four entries to say one
   * thing. An app granted `privileged` has been reviewed for exactly this.
   */
  if (grants?.privileged) {
    return violations;
  }

  const grantedCaps = new Set((grants?.capAdd ?? []).map((cap) => cap.trim().toUpperCase()));
  for (const [index, cap] of (service.capAdd ?? []).entries()) {
    const normalized = cap.trim().toUpperCase().replace(/^CAP_/, '');

    if (SAFE_CAP_ADD.has(normalized) || grantedCaps.has(normalized) || grantedCaps.has(cap.trim().toUpperCase())) {
      continue;
    }

    violations.push({ path: ['capAdd', index], message: 'CUSTOM_APP_ERROR_CAP_ADD_NOT_ALLOWED', hostPath: cap });
  }

  const grantedSecurityOpts = new Set((grants?.securityOpt ?? []).map((opt) => opt.trim().toLowerCase()));
  for (const [index, opt] of (service.securityOpt ?? []).entries()) {
    if (!CONFINEMENT_DISABLING_SECURITY_OPTS.test(opt.trim())) {
      continue;
    }

    if (grantedSecurityOpts.has(opt.trim().toLowerCase())) {
      continue;
    }

    violations.push({ path: ['securityOpt', index], message: 'CUSTOM_APP_ERROR_SECURITY_OPT_NOT_ALLOWED', hostPath: opt });
  }

  const grantedDevices = new Set((grants?.devices ?? []).map(normalizeCustomAppHostPath));
  for (const [index, device] of (service.devices ?? []).entries()) {
    // `devices` is `host:container[:perms]`, and only the HOST half escapes.
    const hostHalf = device.split(':')[0] ?? '';

    if (grantedDevices.has(normalizeCustomAppHostPath(hostHalf))) {
      continue;
    }

    if (isDeniedDeviceHostPath(hostHalf)) {
      violations.push({ path: ['devices', index], message: 'CUSTOM_APP_ERROR_DEVICE_NOT_ALLOWED', hostPath: device });
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
    const normalized = normalizeCustomAppHostPath(volume.hostPath);
    if (ALLOWED_CUSTOM_APP_HOST_PATHS.has(normalized) || grantedPaths.has(normalized)) {
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
