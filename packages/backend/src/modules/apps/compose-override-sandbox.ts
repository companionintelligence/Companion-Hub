import { HUB_ENV_KEYS_INHERITED_BY_APPS, hubAppNetworkNames } from '@/common/constants';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { appIdOf } from '@/modules/apps/app-id.helpers';
import { securityGrantsFor } from '@/modules/apps/security-grants';
import {
  type AppSecurityGrants,
  collectServiceSecurityViolations,
  collectTraefikLabelIssues,
  HUB_OWNED_APP_ENV_VARS,
  isReservedHubLabel,
} from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import * as yaml from 'yaml';

/**
 * The Compose override an app's user config can carry, held to the app sandbox.
 *
 * The builder checks the settings an app declares through its own schema, and that schema can only
 * say what the builder knows about. A raw override is whatever Compose accepts, so it is parsed the
 * way Compose parses it and judged on the result: every key that isn't known to be harmless is
 * refused, and a value that can't be read counts against the override.
 */

/** A setting in an override that the sandbox refuses. */
interface ComposeOverrideViolation {
  /** Where in the override: `services.web.cap_add.0`, or `appEnv.<name>` for the env file. */
  path: string;
  /** The rule it broke. A `CUSTOM_APP_ERROR_*` key when the builder has the same rule. */
  rule: string;
  /** The value, when it helps to see it. */
  detail?: string;
}

const UNREADABLE = 'COMPOSE_OVERRIDE_UNREADABLE';
const SETTING_NOT_ALLOWED = 'COMPOSE_OVERRIDE_SETTING_NOT_ALLOWED';
const TAG_NOT_ALLOWED = 'COMPOSE_OVERRIDE_TAG_NOT_ALLOWED';
const VARIABLE_NOT_ALLOWED = 'COMPOSE_OVERRIDE_VARIABLE_NOT_ALLOWED';
const NETWORK_NOT_ALLOWED = 'COMPOSE_OVERRIDE_NETWORK_NOT_ALLOWED';
const VOLUME_DEFINITION_NOT_ALLOWED = 'COMPOSE_OVERRIDE_VOLUME_DEFINITION_NOT_ALLOWED';
const IPC_NOT_ALLOWED = 'COMPOSE_OVERRIDE_IPC_NOT_ALLOWED';
const VOLUME_TYPE_NOT_ALLOWED = 'COMPOSE_OVERRIDE_VOLUME_TYPE_NOT_ALLOWED';
const VOLUMES_FROM_NOT_ALLOWED = 'COMPOSE_OVERRIDE_VOLUMES_FROM_NOT_ALLOWED';
const ENV_NAME_RESERVED = 'COMPOSE_OVERRIDE_ENV_NAME_RESERVED';

/**
 * The Compose keys an override may set on a service: what the builder renders for an app, plus limits
 * and connection settings that stay inside the container.
 *
 * An allow-list, as with capabilities: a key added by a later Compose release is refused until someone
 * has read what it does. Keys named `x-*` are Compose's extension fields and do nothing on their own.
 * The sandbox settings are in the list because they have their own checks below.
 */
const ALLOWED_SERVICE_KEYS = new Set([
  'attach',
  'cap_add',
  'cap_drop',
  'command',
  'cpu_count',
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpu_shares',
  'cpus',
  'cpuset',
  'depends_on',
  'deploy',
  'devices',
  'dns',
  'dns_opt',
  'dns_search',
  'domainname',
  'entrypoint',
  'environment',
  'expose',
  'extra_hosts',
  'gpus',
  'group_add',
  'healthcheck',
  'hostname',
  'image',
  'init',
  'ipc',
  'labels',
  'links',
  'logging',
  'mac_address',
  'mem_limit',
  'mem_reservation',
  'mem_swappiness',
  'memswap_limit',
  'network_mode',
  'networks',
  'pid',
  'pids_limit',
  'platform',
  'ports',
  'privileged',
  'profiles',
  'pull_policy',
  'pull_refresh_after',
  'read_only',
  'restart',
  'runtime',
  'scale',
  'security_opt',
  'shm_size',
  'stdin_open',
  'stop_grace_period',
  'stop_signal',
  'sysctls',
  'tmpfs',
  'tty',
  'ulimits',
  'user',
  'volumes',
  'volumes_from',
  'working_dir',
]);

const ALLOWED_TOP_LEVEL_KEYS = new Set(['services', 'volumes', 'networks', 'version']);

/** Service settings whose builder rule compares literal text, so a `$` here can't be cleared. */
const LITERAL_ONLY_SERVICE_KEYS = ['pid', 'ipc', 'security_opt'] as const;

/** `ipc` values that stay within the app. Everything else shares memory outside it. */
const ALLOWED_IPC_MODE = /^(none|private|shareable|service:\S+)$/;

/** `!override` and these keys only: replacing a list here can't take away anything the Hub set. */
const OVERRIDE_TAG_KEYS = new Set(['ports', 'environment']);

/** Every `$NAME` and `${NAME` reference in a string, nested ones included. `$$` is a literal dollar. */
const VARIABLE_REFERENCE = /\$(?:\$|\{?([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * A line of the env file that sets a variable. Compose reads `NAME=`, `NAME:` and `export NAME=`, and
 * skips any Unicode space around the name. JavaScript's `\s` covers all of those but U+0085.
 */
const ENV_FILE_ASSIGNMENT = /^[\s\u0085]*(?:export\s+)?([^\s\u0085=:#]+)[\s\u0085]*[=:]/;

/** Line breaks the two parsers don't read the same way, so an override holding one can't be judged here. */
const LINE_BREAK_COMPOSE_READS_DIFFERENTLY = /\r(?!\n)|[\u0085\u2028\u2029]/;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compose takes a string where it wants a boolean. A string it would read as false stays false, anything else counts as true. */
function readPrivileged(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === false) {
    return false;
  }
  return !(typeof value === 'string' && /^(false|no|off|n)$/i.test(value.trim()));
}

function optionalString(value: unknown, path: string, violations: ComposeOverrideViolation[]): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  violations.push({ path, rule: UNREADABLE });
  return undefined;
}

/** A setting Compose reads as a list, or nothing. Anything else counts against the override. */
function listEntries(value: unknown, path: string, violations: ComposeOverrideViolation[]): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    violations.push({ path, rule: UNREADABLE });
    return [];
  }
  return value;
}

function stringList(value: unknown, path: string, violations: ComposeOverrideViolation[]): string[] {
  return listEntries(value, path, violations).flatMap((entry, index) => {
    if (typeof entry === 'string') {
      return [entry];
    }
    violations.push({ path: `${path}.${index}`, rule: UNREADABLE });
    return [];
  });
}

/** `devices` is short syntax strings, or Compose's long form with a `source`: the only part that names the host. */
function deviceList(value: unknown, path: string, violations: ComposeOverrideViolation[]): string[] {
  return listEntries(value, path, violations).flatMap((entry, index) => {
    if (typeof entry === 'string') {
      return [entry];
    }
    if (isMapping(entry) && typeof entry.source === 'string') {
      return [entry.source];
    }
    violations.push({ path: `${path}.${index}`, rule: UNREADABLE });
    return [];
  });
}

/**
 * Sorts a short-syntax volume into the builder's two kinds. A `$` before the first colon leaves the
 * source unknown until Compose expands it, so it goes to the builder's host-path check, which refuses it.
 */
function shortVolume(entry: string, path: string, violations: ComposeOverrideViolation[]): { hostPath?: string; volumeName?: string } {
  const parts = entry.split(':');
  const source = parts[0] ?? '';
  if (parts.length === 1) {
    // No colon is an anonymous volume at that path inside the container.
    return entry.includes('$') ? { hostPath: entry } : {};
  }
  // More than three parts is no form Compose reads, and a single letter before the colon is a Windows drive it reads differently.
  if (parts.length > 3 || /^[A-Za-z]$/.test(source)) {
    violations.push({ path, rule: UNREADABLE, detail: entry });
    return {};
  }
  return /^[A-Za-z0-9_.-]+$/.test(source) && !source.startsWith('.') ? { volumeName: source } : { hostPath: source };
}

function volumeList(value: unknown, path: string, violations: ComposeOverrideViolation[]): { hostPath?: string; volumeName?: string }[] {
  return listEntries(value, path, violations).map((entry, index) => {
    const entryPath = `${path}.${index}`;
    if (typeof entry === 'string') {
      return shortVolume(entry, entryPath, violations);
    }
    if (!isMapping(entry)) {
      violations.push({ path: entryPath, rule: UNREADABLE });
      return {};
    }
    const { type, source } = entry;
    if (type !== 'bind' && type !== 'volume' && type !== 'tmpfs') {
      violations.push({ path: `${entryPath}.type`, rule: VOLUME_TYPE_NOT_ALLOWED, detail: typeof type === 'string' ? type : undefined });
      return {};
    }
    if (type === 'tmpfs' || source === undefined || source === null) {
      if (type === 'bind') {
        violations.push({ path: `${entryPath}.source`, rule: UNREADABLE });
      }
      return {};
    }
    if (typeof source !== 'string') {
      violations.push({ path: `${entryPath}.source`, rule: UNREADABLE });
      return {};
    }
    return type === 'bind' ? { hostPath: source } : { volumeName: source };
  });
}

function checkVolumesFrom(value: unknown, path: string, violations: ComposeOverrideViolation[]): void {
  for (const [index, entry] of stringList(value, path, violations).entries()) {
    if (/^container:/i.test(entry) || entry.includes('$')) {
      violations.push({ path: `${path}.${index}`, rule: VOLUMES_FROM_NOT_ALLOWED, detail: entry });
    }
  }
}

/** A service joins the app's own network, `default` or a network this override declares itself, with no per-network options. */
function checkServiceNetworks(value: unknown, path: string, allowedNetworks: ReadonlySet<string>, violations: ComposeOverrideViolation[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, name] of value.entries()) {
      if (typeof name !== 'string' || !allowedNetworks.has(name)) {
        violations.push({ path: `${path}.${index}`, rule: NETWORK_NOT_ALLOWED, detail: typeof name === 'string' ? name : undefined });
      }
    }
    return;
  }
  if (!isMapping(value)) {
    violations.push({ path, rule: UNREADABLE });
    return;
  }
  for (const [name, options] of Object.entries(value)) {
    if (!allowedNetworks.has(name)) {
      violations.push({ path: `${path}.${name}`, rule: NETWORK_NOT_ALLOWED, detail: name });
    } else if (options !== null && !(isMapping(options) && Object.keys(options).length === 0)) {
      violations.push({ path: `${path}.${name}`, rule: NETWORK_NOT_ALLOWED, detail: name });
    }
  }
}

interface ServiceCheckContext {
  grants: AppSecurityGrants | undefined;
  allowedNetworks: ReadonlySet<string>;
  hubNetworks: readonly string[];
  appId: string;
  knownAppIds: Iterable<string> | undefined;
  hubEnvironment: ReadonlySet<string>;
}

function checkLabels(value: unknown, path: string, context: ServiceCheckContext, violations: ComposeOverrideViolation[]): void {
  if (value === undefined || value === null) {
    return;
  }
  const labels: Record<string, unknown> = {};
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string') {
        violations.push({ path: `${path}.${index}`, rule: UNREADABLE });
        continue;
      }
      const [key = ''] = entry.split('=');
      if (key.includes('$')) {
        violations.push({ path: `${path}.${index}`, rule: VARIABLE_NOT_ALLOWED, detail: key });
        continue;
      }
      labels[key] = entry.slice(key.length + 1);
    }
  } else if (isMapping(value)) {
    Object.assign(labels, value);
  } else {
    violations.push({ path, rule: UNREADABLE });
    return;
  }

  for (const key of Object.keys(labels)) {
    if (isReservedHubLabel(key)) {
      violations.push({ path: `${path}.${key}`, rule: 'CUSTOM_APP_ERROR_LABEL_RESERVED', detail: key });
    }
  }
  for (const issue of collectTraefikLabelIssues(labels, context.appId, { knownAppIds: context.knownAppIds, hubNetworks: context.hubNetworks })) {
    violations.push({ path: `${path}.${issue.label}`, rule: issue.message });
  }
}

/** Variables the Hub's process defines aren't the app's to use. */
function collectHubVariableReferences(
  value: unknown,
  path: string,
  hubEnvironment: ReadonlySet<string>,
  violations: ComposeOverrideViolation[],
): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(VARIABLE_REFERENCE)) {
      const name = match[1];
      if (name && hubEnvironment.has(name)) {
        violations.push({ path, rule: VARIABLE_NOT_ALLOWED, detail: name });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectHubVariableReferences(entry, `${path}.${index}`, hubEnvironment, violations);
    });
    return;
  }
  if (isMapping(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collectHubVariableReferences(entry, `${path}.${key}`, hubEnvironment, violations);
    }
  }
}

/** An `environment` entry that names a variable and gives it no value counts as using that variable. */
function checkInheritedEnvironment(value: unknown, path: string, hubEnvironment: ReadonlySet<string>, violations: ComposeOverrideViolation[]): void {
  let names: string[] = [];
  if (Array.isArray(value)) {
    names = value.filter((entry): entry is string => typeof entry === 'string' && !entry.includes('='));
  } else if (isMapping(value)) {
    names = Object.keys(value).filter((name) => value[name] === null || value[name] === undefined);
  }
  for (const name of names) {
    if (hubEnvironment.has(name)) {
      violations.push({ path: `${path}.${name}`, rule: VARIABLE_NOT_ALLOWED, detail: name });
    }
  }
}

/** An env file can't set the names the Hub's own checks rely on, or use a variable that isn't the app's. */
function checkEnvFile(appEnv: string, hubEnvironment: ReadonlySet<string>, violations: ComposeOverrideViolation[]): void {
  for (const line of appEnv.split('\n')) {
    const name = ENV_FILE_ASSIGNMENT.exec(line)?.[1];
    if (!name) {
      continue;
    }
    if (HUB_OWNED_APP_ENV_VARS.has(name)) {
      violations.push({ path: `appEnv.${name}`, rule: ENV_NAME_RESERVED });
    }
    collectHubVariableReferences(line, `appEnv.${name}`, hubEnvironment, violations);
  }
}

/** The builder's field names, spelled as the Compose keys someone writes in an override. */
const COMPOSE_SPELLING: Record<string, string> = {
  capAdd: 'cap_add',
  networkMode: 'network_mode',
  securityOpt: 'security_opt',
};

function checkService(name: string, service: Record<string, unknown>, context: ServiceCheckContext, violations: ComposeOverrideViolation[]): void {
  const servicePath = `services.${name}`;

  for (const key of Object.keys(service)) {
    if (!ALLOWED_SERVICE_KEYS.has(key) && !key.startsWith('x-')) {
      violations.push({ path: `${servicePath}.${key}`, rule: SETTING_NOT_ALLOWED });
    }
  }

  for (const key of LITERAL_ONLY_SERVICE_KEYS) {
    const value = service[key];
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => typeof entry === 'string' && entry.includes('$'))) {
      violations.push({ path: `${servicePath}.${key}`, rule: VARIABLE_NOT_ALLOWED });
    }
  }

  const ipc = optionalString(service.ipc, `${servicePath}.ipc`, violations);
  if (ipc && !ipc.includes('$') && !ALLOWED_IPC_MODE.test(ipc)) {
    violations.push({ path: `${servicePath}.ipc`, rule: IPC_NOT_ALLOWED, detail: ipc });
  }

  const securityViolations = collectServiceSecurityViolations(
    {
      privileged: readPrivileged(service.privileged),
      networkMode: optionalString(service.network_mode, `${servicePath}.network_mode`, violations),
      pid: optionalString(service.pid, `${servicePath}.pid`, violations),
      capAdd: stringList(service.cap_add, `${servicePath}.cap_add`, violations),
      securityOpt: stringList(service.security_opt, `${servicePath}.security_opt`, violations),
      devices: deviceList(service.devices, `${servicePath}.devices`, violations),
      volumes: volumeList(service.volumes, `${servicePath}.volumes`, violations),
    },
    context.grants,
  );
  for (const violation of securityViolations) {
    const [head = '', ...rest] = violation.path;
    violations.push({
      path: [servicePath, COMPOSE_SPELLING[String(head)] ?? head, ...rest.filter((part) => part !== 'hostPath' && part !== 'volumeName')].join('.'),
      rule: violation.message,
      detail: violation.hostPath,
    });
  }

  checkVolumesFrom(service.volumes_from, `${servicePath}.volumes_from`, violations);
  checkServiceNetworks(service.networks, `${servicePath}.networks`, context.allowedNetworks, violations);
  checkLabels(service.labels, `${servicePath}.labels`, context, violations);
  checkInheritedEnvironment(service.environment, `${servicePath}.environment`, context.hubEnvironment, violations);
  collectHubVariableReferences(service, servicePath, context.hubEnvironment, violations);
}

function collectTagViolations(node: unknown, path: (string | number)[], violations: ComposeOverrideViolation[]): void {
  if (yaml.isNode(node) && node.tag) {
    const isOverrideOnAllowedKey =
      node.tag === '!override' && path.length === 3 && path[0] === 'services' && typeof path[2] === 'string' && OVERRIDE_TAG_KEYS.has(path[2]);
    if (!isOverrideOnAllowedKey) {
      violations.push({ path: path.join('.'), rule: TAG_NOT_ALLOWED, detail: node.tag });
    }
  }
  if (yaml.isMap(node)) {
    for (const pair of node.items) {
      if (yaml.isNode(pair.key) && pair.key.tag) {
        violations.push({ path: path.join('.'), rule: TAG_NOT_ALLOWED, detail: pair.key.tag });
      }
      collectTagViolations(pair.value, [...path, yaml.isScalar(pair.key) ? String(pair.key.value) : '?'], violations);
    }
  } else if (yaml.isSeq(node)) {
    node.items.forEach((item, index) => {
      collectTagViolations(item, [...path, index], violations);
    });
  }
}

function checkTopLevelDefinitions(
  value: unknown,
  section: 'volumes' | 'networks',
  rule: string,
  declared: Set<string>,
  violations: ComposeOverrideViolation[],
  reserved: readonly string[] = [],
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!isMapping(value)) {
    violations.push({ path: section, rule: UNREADABLE });
    return;
  }
  for (const [name, definition] of Object.entries(value)) {
    if (!reserved.includes(name) && (definition === null || (isMapping(definition) && Object.keys(definition).length === 0))) {
      declared.add(name);
    } else {
      violations.push({ path: `${section}.${name}`, rule });
    }
  }
}

function parseOverride(composeYaml: string, violations: ComposeOverrideViolation[]): unknown {
  if (LINE_BREAK_COMPOSE_READS_DIFFERENTLY.test(composeYaml)) {
    violations.push({ path: 'override', rule: UNREADABLE, detail: 'a line break other than LF or CRLF' });
    return undefined;
  }
  // Compose follows `<<` merge keys, so the result has to have them applied too.
  const doc = yaml.parseDocument(composeYaml, { merge: true, stringKeys: true, uniqueKeys: true, version: '1.2' });
  const firstError = doc.errors[0];
  if (firstError) {
    violations.push({ path: 'override', rule: UNREADABLE, detail: firstError.message.split('\n')[0] });
    return undefined;
  }
  if (doc.directives?.yaml.explicit) {
    violations.push({ path: 'override', rule: UNREADABLE, detail: 'YAML directive' });
    return undefined;
  }
  const warning = doc.warnings.find((entry) => entry.code !== 'TAG_RESOLVE_FAILED');
  if (warning) {
    violations.push({ path: 'override', rule: UNREADABLE, detail: warning.message.split('\n')[0] });
    return undefined;
  }
  collectTagViolations(doc.contents, [], violations);
  try {
    return doc.toJS();
  } catch (error) {
    violations.push({ path: 'override', rule: UNREADABLE, detail: error instanceof Error ? error.message.split('\n')[0] : undefined });
    return undefined;
  }
}

/**
 * Every setting in this override and env file that the app sandbox refuses for this app, or nothing.
 * An override that can't be read as YAML is refused rather than passed through.
 */
export function collectComposeOverrideViolations(
  composeYaml: string,
  appEnv: string,
  options: { appUrn: AppUrn; knownAppIds?: Iterable<string>; hubEnvironment?: Iterable<string> },
): ComposeOverrideViolation[] {
  const { appUrn, knownAppIds } = options;
  const violations: ComposeOverrideViolation[] = [];

  // Every app is handed these anyway, so they aren't the Hub's alone.
  const hubEnvironment = new Set(
    [...(options.hubEnvironment ?? Object.keys(process.env))].filter((name) => !HUB_ENV_KEYS_INHERITED_BY_APPS.has(name)),
  );

  checkEnvFile(appEnv, hubEnvironment, violations);

  const parsed = parseOverride(composeYaml, violations);
  if (parsed === undefined || parsed === null) {
    return violations;
  }
  if (!isMapping(parsed)) {
    violations.push({ path: 'override', rule: UNREADABLE });
    return violations;
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key) && !key.startsWith('x-')) {
      violations.push({ path: key, rule: SETTING_NOT_ALLOWED });
    }
  }

  const { appName, appStoreId } = extractAppUrn(appUrn);
  const allowedNetworks = new Set(['default', `${appName}_${appStoreId}_network`]);
  checkTopLevelDefinitions(parsed.volumes, 'volumes', VOLUME_DEFINITION_NOT_ALLOWED, new Set(), violations);
  // An empty declaration merges onto the generated entry of the same name, so it isn't a network of the override's own.
  const hubNetworks = hubAppNetworkNames();
  checkTopLevelDefinitions(parsed.networks, 'networks', NETWORK_NOT_ALLOWED, allowedNetworks, violations, hubNetworks);

  const services = parsed.services;
  if (services === undefined || services === null) {
    return violations;
  }
  if (!isMapping(services)) {
    violations.push({ path: 'services', rule: UNREADABLE });
    return violations;
  }

  const context: ServiceCheckContext = {
    grants: securityGrantsFor(appUrn),
    allowedNetworks,
    hubNetworks,
    appId: appIdOf(appName, appStoreId),
    knownAppIds,
    hubEnvironment,
  };
  for (const [name, service] of Object.entries(services)) {
    if (service === null) {
      continue;
    }
    if (!isMapping(service)) {
      violations.push({ path: `services.${name}`, rule: UNREADABLE });
      continue;
    }
    checkService(name, service, context, violations);
  }
  return violations;
}

/** The same shape as the builder's refusal: each setting and the rule it broke. */
export function describeComposeOverrideViolations(violations: ComposeOverrideViolation[]): string {
  return violations.map((v) => `${v.path}${v.detail ? ` (${v.detail})` : ''} [${v.rule}]`).join(', ');
}
