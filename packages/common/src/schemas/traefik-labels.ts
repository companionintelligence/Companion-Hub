/**
 * What an app's `extraLabels` may tell Traefik.
 *
 * Every app container sits behind the one Traefik, which reads all their labels into one routing
 * table, and nothing in a label says which app wrote it. So an app's labels could name another app's
 * router, send a router of its own to another app's service or claim another app's host. Its route
 * then reached that app's backend with no Hub login, showed in place of that app or took it offline.
 *
 * An app's Traefik labels may set `traefik.enable`, `traefik.docker.network` to a Hub network the app's
 * container is on, and its own HTTP routers, middlewares and load-balanced services, under names that
 * start with the app's id:
 * - a router's `service`, and an `errors` middleware's, is one of the app's own services;
 * - a `middlewares` list names the app's own middlewares or the Hub's shared ones;
 * - a router's `rule` keeps it to the app's own hosts;
 * - a service's server is the app's own container, never a `url`;
 * - no middleware calls out with `forwardAuth` or sets the request's `Host`.
 *
 * Every store app that sets Traefik labels already keeps to this.
 */

/** The app id the Hub writes into label keys and values: see `ServiceBuilder.interpolateVariables`. */
const APP_ID_PLACEHOLDER = /^\{\{\s*(?:CI_HUB_APP_ID|RUNTIPI_APP_ID|RUNCIHUB_APP_ID)\s*\}\}/;

/** How the refusals spell the app id for the person fixing the labels. */
const APP_ID_PLACEHOLDER_TEXT = '{{CI_HUB_APP_ID}}';

/** The same id from the app's `.env`, which compose expands in label values but not in keys. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
const APP_ID_VARIABLE = '${APP_ID}';

/**
 * The hosts the Hub gives this app, as compose expansions of the app's `.env`: its address, its LAN
 * name and the host of its base URL. A rule may name no other, so a literal host, which could be
 * another app's, is refused with the rest.
 */
const OWN_HOSTS = new Set([
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  '${APP_DOMAIN}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  '${APP_LOCAL_DOMAIN}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose expansion, matched literally
  '${APP_BASE_HOST}',
]);

/** The Hub's forward auth: assets/traefik/dynamic/dynamic.yml, and the Hub container's labels for the Docker provider. */
export const HUB_FORWARD_AUTH_MIDDLEWARES: ReadonlySet<string> = new Set(['ci-hub@file', 'ci-hub@docker']);

/**
 * The Hub's middlewares any app may put in a chain: forward auth under both providers, the edge
 * header strip and the starting page (assets/traefik/dynamic/dynamic.yml).
 */
const HUB_MIDDLEWARES = new Set([...HUB_FORWARD_AUTH_MIDDLEWARES, 'ci-hub-edge-headers@file', 'ci-hub-app-starting@file']);

/** `traefik.http.<routers|services|middlewares>.<name>.<option>`. Traefik reads labels without regard to case. */
const HTTP_OBJECT_LABEL = /^traefik\.http\.(routers|services|middlewares)\.([^.]+)\.(.+)$/i;

/** Every refusal {@link collectTraefikLabelIssues} gives, by its message. */
export const TRAEFIK_LABEL_REFUSALS: ReadonlySet<string> = new Set([
  'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED',
  'CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB',
  'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST',
]);

/**
 * The Hub networks the Hub puts an app's main containers on, under the names a Hub uses unless it runs
 * under another container name: see `hubAppNetworkNames` in the backend, whose names the compose
 * builder passes in.
 */
export const HUB_APP_NETWORK_NAMES: readonly string[] = ['ci-hub_network', 'ci-os-hub_network'];

export interface TraefikLabelCheckOptions {
  /** The Hub networks the service's container is on, which `traefik.docker.network` may name. */
  hubNetworks?: readonly string[];
}

export interface TraefikLabelIssue {
  label: string;
  message: string;
  params: Record<string, string>;
}

/**
 * The labels in `labels` an app may not set, each with the rule it breaks.
 *
 * `appId` is the app's interpolated id, for a caller that knows it. Names may then also start with
 * the id itself, as well as with `{{CI_HUB_APP_ID}}`.
 */
export function collectTraefikLabelIssues(
  labels: Record<string, unknown> | undefined,
  appId?: string,
  options: TraefikLabelCheckOptions = {},
): TraefikLabelIssue[] {
  const hubNetworks = options.hubNetworks ?? HUB_APP_NETWORK_NAMES;
  const issues: TraefikLabelIssue[] = [];
  for (const [label, value] of Object.entries(labels ?? {})) {
    const issue = traefikLabelIssue(label, value, appId, hubNetworks);
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

function traefikLabelIssue(label: string, value: unknown, appId: string | undefined, hubNetworks: readonly string[]): TraefikLabelIssue | undefined {
  const lower = label.toLowerCase();
  if (!lower.startsWith('traefik.') || lower === 'traefik.enable') {
    return undefined;
  }
  if (lower === 'traefik.docker.network') {
    // Which of the container's networks Traefik reaches it on. A container on more than one needs it,
    // or Traefik may pick a network it isn't on. Only a Hub network the container is on will do.
    return typeof value === 'string' && hubNetworks.includes(value)
      ? undefined
      : { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_NETWORK_NOT_HUB', params: { label, networks: hubNetworks.join(', ') } };
  }

  const [, kind, name, option] = HTTP_OBJECT_LABEL.exec(label) ?? [];
  // TCP and UDP routers, `traefik.docker.*` and the rest: no store app sets one, and a TCP router
  // on the web entry points is matched before every HTTP router there.
  if (!kind || !name || !option) {
    return { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED', params: { label } };
  }
  if (!isOwnName(name, appId, false)) {
    return { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN', params: { label, name, placeholder: APP_ID_PLACEHOLDER_TEXT } };
  }

  const kindLower = kind.toLowerCase();
  const optionLower = option.toLowerCase();
  if (kindLower === 'services') {
    // `url` sends the service anywhere, the Hub's own backend and other apps' containers included.
    const segments = optionLower.split('.');
    return segments[0] !== 'loadbalancer' || segments.includes('url')
      ? { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED', params: { label } }
      : undefined;
  }
  if (kindLower === 'middlewares' && isOutwardMiddlewareOption(optionLower)) {
    return { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED', params: { label } };
  }
  // Read by the option's last part: TraefikConfigService copies routers into the file provider that
  // way, so `routers.<name>.x.rule` is a rule there whatever Traefik's Docker provider makes of it.
  const lastOption = optionLower.slice(optionLower.lastIndexOf('.') + 1);
  if (kindLower === 'routers' && lastOption === 'rule') {
    return ruleKeepsToOwnHosts(value) ? undefined : { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST', params: { label } };
  }
  if (lastOption === 'service') {
    // A router's service, and an `errors` middleware's, which answers in the app's place.
    const target = String(value).trim();
    return isOwnReference(target, appId)
      ? undefined
      : { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN', params: { label, target, placeholder: APP_ID_PLACEHOLDER_TEXT } };
  }
  if (lastOption === 'middlewares') {
    const target = middlewareList(value).find((middleware) => !HUB_MIDDLEWARES.has(middleware.toLowerCase()) && !isOwnReference(middleware, appId));
    return target === undefined
      ? undefined
      : { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN', params: { label, target, placeholder: APP_ID_PLACEHOLDER_TEXT } };
  }
  return undefined;
}

/**
 * Middleware options an app's own middlewares may not use:
 * - `forwardAuth`: the Hub's login is the only forward auth on an app's routes;
 * - a `Host` request header: a request keeps the host the visitor asked for, which is the host the
 *   Hub's login goes by.
 */
function isOutwardMiddlewareOption(optionLower: string): boolean {
  const [type, group, header, ...rest] = optionLower.split('.');
  return type === 'forwardauth' || (type === 'headers' && group === 'customrequestheaders' && header === 'host' && rest.length === 0);
}

function middlewareList(value: unknown): string[] {
  return String(value)
    .split(',')
    .map((middleware) => middleware.trim())
    .filter(Boolean);
}

/**
 * Whether a router, service or middleware name is the app's own: its id alone or followed by a dash.
 * A dash, so `{{CI_HUB_APP_ID}}x` can't become another app's id.
 *
 * In a value, nothing after the id may be a compose expansion: compose expands it after this check,
 * so what it names can't be known here.
 */
function isOwnName(name: string, appId: string | undefined, valueSide: boolean): boolean {
  let rest: string | undefined;
  const placeholder = APP_ID_PLACEHOLDER.exec(name);
  if (placeholder) {
    rest = name.slice(placeholder[0].length);
  } else if (valueSide && name.startsWith(APP_ID_VARIABLE)) {
    rest = name.slice(APP_ID_VARIABLE.length);
  } else if (appId && name.toLowerCase().startsWith(appId.toLowerCase())) {
    rest = name.slice(appId.length);
  }
  return rest !== undefined && (rest === '' || rest.startsWith('-')) && !(valueSide && rest.includes('$'));
}

/** A reference to one of the app's own services or middlewares, on the Docker provider. */
function isOwnReference(reference: string, appId: string | undefined): boolean {
  const at = reference.indexOf('@');
  const name = at === -1 ? reference : reference.slice(0, at);
  const provider = at === -1 ? 'docker' : reference.slice(at + 1).toLowerCase();
  return provider === 'docker' && isOwnName(name, appId, true);
}

type RuleNode = { kind: 'matcher'; name: string; args: string[] } | { kind: 'not'; operand: RuleNode } | { kind: 'and' | 'or'; operands: RuleNode[] };

type RuleToken = { kind: 'punct'; value: string } | { kind: 'name'; value: string } | { kind: 'string'; value: string };

/** Deeper than any rule a person writes; it bounds the parser's recursion on a hostile one. */
const MAX_RULE_DEPTH = 32;

/**
 * Whether a router rule matches only requests for one of the app's own hosts.
 *
 * It must name a host, and only the app's: an AND with a `Host()` of its own hosts, or an OR whose
 * every branch is one. `HostRegexp()` and the SNI matchers can't be checked and are refused, and so
 * is any `$` but the own-host expansions: compose expands the rule before Traefik reads it, so
 * another expansion could change it after this check.
 */
function ruleKeepsToOwnHosts(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  let withoutOwnHosts = value;
  for (const host of OWN_HOSTS) {
    withoutOwnHosts = withoutOwnHosts.split(host).join('');
  }
  if (withoutOwnHosts.includes('$')) {
    return false;
  }

  const tokens = tokenizeRule(value);
  if (!tokens) {
    return false;
  }
  const parser = { tokens, position: 0 };
  const rule = parseOr(parser, 0);
  if (!rule || parser.position !== tokens.length) {
    return false;
  }
  return !namesOtherHost(rule) && restrictsToOwnHost(rule);
}

function tokenizeRule(rule: string): RuleToken[] | undefined {
  const tokens: RuleToken[] = [];
  let index = 0;
  while (index < rule.length) {
    const char = rule.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (rule.startsWith('&&', index) || rule.startsWith('||', index)) {
      tokens.push({ kind: 'punct', value: rule.slice(index, index + 2) });
      index += 2;
    } else if ('()!,'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
    } else if (char === '`') {
      const end = rule.indexOf('`', index + 1);
      if (end === -1) {
        return undefined;
      }
      tokens.push({ kind: 'string', value: rule.slice(index + 1, end) });
      index = end + 1;
    } else if (char === '"') {
      // A Go string literal. Its escapes are kept as written: only own-host expansions are accepted
      // as hosts, and none of them holds a backslash.
      let end = index + 1;
      while (end < rule.length && rule.charAt(end) !== '"') {
        end += rule.charAt(end) === '\\' ? 2 : 1;
      }
      if (end >= rule.length) {
        return undefined;
      }
      tokens.push({ kind: 'string', value: rule.slice(index + 1, end) });
      index = end + 1;
    } else {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rule.slice(index))?.[0];
      if (!name) {
        return undefined;
      }
      tokens.push({ kind: 'name', value: name });
      index += name.length;
    }
  }
  return tokens;
}

type RuleParser = { tokens: RuleToken[]; position: number };

function takePunct(parser: RuleParser, value: string): boolean {
  const token = parser.tokens[parser.position];
  if (token?.kind === 'punct' && token.value === value) {
    parser.position += 1;
    return true;
  }
  return false;
}

function parseOr(parser: RuleParser, depth: number): RuleNode | undefined {
  return parseChain(parser, depth, '||', 'or', parseAnd);
}

function parseAnd(parser: RuleParser, depth: number): RuleNode | undefined {
  return parseChain(parser, depth, '&&', 'and', parseUnary);
}

function parseChain(
  parser: RuleParser,
  depth: number,
  operator: string,
  kind: 'and' | 'or',
  parseOperand: (parser: RuleParser, depth: number) => RuleNode | undefined,
): RuleNode | undefined {
  const first = parseOperand(parser, depth);
  if (!first) {
    return undefined;
  }
  const operands = [first];
  while (takePunct(parser, operator)) {
    const next = parseOperand(parser, depth);
    if (!next) {
      return undefined;
    }
    operands.push(next);
  }
  return operands.length === 1 ? first : { kind, operands };
}

function parseUnary(parser: RuleParser, depth: number): RuleNode | undefined {
  if (depth > MAX_RULE_DEPTH) {
    return undefined;
  }
  if (takePunct(parser, '!')) {
    const operand = parseUnary(parser, depth + 1);
    return operand ? { kind: 'not', operand } : undefined;
  }
  if (takePunct(parser, '(')) {
    const inner = parseOr(parser, depth + 1);
    return inner && takePunct(parser, ')') ? inner : undefined;
  }

  const name = parser.tokens[parser.position];
  if (name?.kind !== 'name') {
    return undefined;
  }
  parser.position += 1;
  if (!takePunct(parser, '(')) {
    return undefined;
  }
  const args: string[] = [];
  if (!takePunct(parser, ')')) {
    do {
      const arg = parser.tokens[parser.position];
      if (arg?.kind !== 'string') {
        return undefined;
      }
      parser.position += 1;
      args.push(arg.value);
    } while (takePunct(parser, ','));
    if (!takePunct(parser, ')')) {
      return undefined;
    }
  }
  return { kind: 'matcher', name: name.value, args };
}

/** `Host`, and `HostHeader`, its other name under the v2 rule syntax a router may still ask for. */
function isHostMatcher(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'host' || lower === 'hostheader';
}

/** Matchers on a host pattern, which can't be checked against the app's own hosts. */
function isHostPatternMatcher(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'hostregexp' || lower === 'hostsni' || lower === 'hostsniregexp';
}

function namesOtherHost(node: RuleNode): boolean {
  switch (node.kind) {
    case 'matcher':
      return isHostPatternMatcher(node.name) || (isHostMatcher(node.name) && node.args.some((host) => !OWN_HOSTS.has(host)));
    case 'not':
      return namesOtherHost(node.operand);
    default:
      return node.operands.some(namesOtherHost);
  }
}

function restrictsToOwnHost(node: RuleNode): boolean {
  switch (node.kind) {
    case 'matcher':
      return isHostMatcher(node.name) && node.args.length > 0 && node.args.every((host) => OWN_HOSTS.has(host));
    case 'not':
      return false;
    case 'and':
      return node.operands.some(restrictsToOwnHost);
    default:
      return node.operands.every(restrictsToOwnHost);
  }
}
