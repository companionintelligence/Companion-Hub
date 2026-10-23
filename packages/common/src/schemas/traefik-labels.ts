/**
 * What an app's `extraLabels` may tell Traefik.
 *
 * Every app container sits behind the one Traefik, which reads all their labels into one routing
 * table, and nothing in a label says which app wrote it. So an app's labels could name another app's
 * router, send a router of its own to another app's service or claim another app's host. Its route
 * then reached that app's backend with no Hub login, showed in place of that app or took it offline.
 *
 * An app's Traefik labels may set `traefik.enable` and its own HTTP routers, middlewares and
 * load-balanced services, under names that start with the app's id and that no other app's longer id
 * covers:
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
  'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN',
  'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST',
]);

export interface TraefikLabelIssue {
  label: string;
  message: string;
  params: Record<string, string>;
}

/** What a caller that builds the app's compose knows about it and the Hub, for {@link collectTraefikLabelIssues}. */
export interface TraefikLabelContext {
  /** The ids of the apps the Hub knows about. */
  knownAppIds?: Iterable<string>;
  /**
   * Which of `APP_DOMAIN`, `APP_LOCAL_DOMAIN` and `APP_BASE_HOST` the Hub set in the app's env. A rule
   * may name only those: compose would expand one the Hub left unset from wherever else it finds it,
   * or to nothing.
   */
  hostVariables?: Iterable<string>;
}

/**
 * The labels in `labels` an app may not set, each with the rule it breaks.
 *
 * `appId` is the app's interpolated id, for a caller that knows it. Names may then also start with
 * the id itself, as well as with `{{CI_HUB_APP_ID}}`.
 *
 * `knownAppIds` are the ids of the apps the Hub knows about, for a caller that has them. An app's
 * id is its name and its store's slug joined by a dash. Both may hold dashes, so one app's id and a
 * dash can begin another app's id: the same app in stores `home` and `home-lab` is `app-home` and
 * `app-home-lab`. A name belongs to the app with the longest id it is, or starts with followed by a
 * dash. It is this app's own only when that app is this one. For `app-home`, the name
 * `{{CI_HUB_APP_ID}}-lab-web` is `app-home-lab`'s. The Hub's own names count the same way and win
 * over an app's id of the same length (see {@link HUB_TRAEFIK_NAMES}).
 */
export function collectTraefikLabelIssues(
  labels: Record<string, unknown> | undefined,
  appId?: string,
  context: TraefikLabelContext = {},
): TraefikLabelIssue[] {
  const ownHosts = context.hostVariables
    ? new Set([...context.hostVariables].map((name) => `\${${name}}`).filter((host) => OWN_HOSTS.has(host)))
    : OWN_HOSTS;
  const ownership: Ownership = { appId, claims: appId ? claimsOver(appId, context.knownAppIds) : [], ownHosts };
  const issues: TraefikLabelIssue[] = [];
  for (const [label, value] of Object.entries(labels ?? {})) {
    const issue = traefikLabelIssue(label, value, ownership);
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

/**
 * Router, service and middleware names the Hub's own Traefik configuration defines.
 *
 * The Hub container's labels define the router, service and middleware `ci-hub` and the router
 * `ci-os-hub` on the Docker provider (docker-compose.prod.yml and the desktop app's copy). Its files
 * define `ci-hub`, `ci-hub-edge-headers`, `ci-hub-app-starting`, `hub-public` and `hub-service` on
 * the file provider (assets/traefik/dynamic/dynamic.yml and `TraefikConfigService`), which also holds
 * a copy of every app's routers, services and middlewares. An app may not define one: a name that is
 * one of these, or starts with one followed by a dash, is the Hub's unless an app's longer id covers
 * it, and the Hub's when that id is just as long.
 */
export const HUB_TRAEFIK_NAMES: readonly string[] = [
  'ci-hub',
  'ci-os-hub',
  'ci-hub-edge-headers',
  'ci-hub-app-starting',
  'hub-public',
  'hub-service',
];

/** Who a claimed name belongs to when it is the Hub's. */
const HUB_OWNER = 'the Hub';

/** A name longer than or as long as the app's id that covers some of its names, and whose it is. */
type Claim = { name: string; owner: string };

/**
 * The app the names are checked for: its id (when the caller knows it) and the claims on names that
 * start with it: the Hub's names and the other apps' ids that are this id followed by a dash and
 * more, in lower case.
 */
type Ownership = { appId: string | undefined; claims: Claim[]; ownHosts: ReadonlySet<string> };

/**
 * The Hub's names that are `appId` or start with it and a dash, and the ids in `knownAppIds` that
 * start with it and a dash, in lower case and the longest first. A Hub name comes before an app id
 * of the same spelling.
 */
function claimsOver(appId: string, knownAppIds: Iterable<string> | undefined): Claim[] {
  const id = appId.toLowerCase();
  const prefix = `${id}-`;
  const claims = new Map<string, Claim>();
  for (const name of HUB_TRAEFIK_NAMES) {
    if (name === id || name.startsWith(prefix)) {
      claims.set(name, { name, owner: HUB_OWNER });
    }
  }
  for (const known of knownAppIds ?? []) {
    const lower = known.toLowerCase();
    if (lower.startsWith(prefix) && !claims.has(lower)) {
      claims.set(lower, { name: lower, owner: lower });
    }
  }
  return [...claims.values()].sort((a, b) => b.name.length - a.name.length);
}

function traefikLabelIssue(label: string, value: unknown, ownership: Ownership): TraefikLabelIssue | undefined {
  const lower = label.toLowerCase();
  if (!lower.startsWith('traefik.') || lower === 'traefik.enable') {
    return undefined;
  }

  const [, kind, name, option] = HTTP_OBJECT_LABEL.exec(label) ?? [];
  // TCP and UDP routers, `traefik.docker.*` and the rest: no store app sets one, and a TCP router
  // on the web entry points is matched before every HTTP router there.
  if (!kind || !name || !option) {
    return { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_LABEL_NOT_ALLOWED', params: { label } };
  }
  const nameOwner = ownerOf(name, ownership, false);
  if (nameOwner !== OWN) {
    return {
      label,
      message: 'CUSTOM_APP_ERROR_TRAEFIK_NAME_NOT_OWN',
      params: { label, name, placeholder: APP_ID_PLACEHOLDER_TEXT, ...ownerParam(nameOwner) },
    };
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
    return ruleKeepsToOwnHosts(value, ownership.ownHosts)
      ? undefined
      : { label, message: 'CUSTOM_APP_ERROR_TRAEFIK_RULE_NOT_OWN_HOST', params: { label } };
  }
  if (lastOption === 'service') {
    // A router's service, and an `errors` middleware's, which answers in the app's place.
    const target = String(value).trim();
    const targetOwner = referenceOwner(target, ownership);
    return targetOwner === OWN
      ? undefined
      : {
          label,
          message: 'CUSTOM_APP_ERROR_TRAEFIK_SERVICE_NOT_OWN',
          params: { label, target, placeholder: APP_ID_PLACEHOLDER_TEXT, ...ownerParam(targetOwner) },
        };
  }
  if (lastOption === 'middlewares') {
    for (const middleware of middlewareList(value)) {
      const middlewareOwner = HUB_MIDDLEWARES.has(middleware.toLowerCase()) ? OWN : referenceOwner(middleware, ownership);
      if (middlewareOwner !== OWN) {
        return {
          label,
          message: 'CUSTOM_APP_ERROR_TRAEFIK_MIDDLEWARE_NOT_OWN',
          params: { label, target: middleware, placeholder: APP_ID_PLACEHOLDER_TEXT, ...ownerParam(middlewareOwner) },
        };
      }
    }
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

/** A name that is the app's own. */
const OWN = Symbol('own');

/**
 * Whose a router, service or middleware name is: {@link OWN}, the id of the longer-id app it belongs
 * to or {@link HUB_OWNER}, or `undefined` when it is plainly not this app's.
 *
 * It is the app's own when it is the app's id alone or followed by a dash (a dash so
 * `{{CI_HUB_APP_ID}}x` can't become another app's id) and no claim covers it the same way (see
 * {@link collectTraefikLabelIssues}).
 */
function ownerOf(name: string, ownership: Ownership, valueSide: boolean): typeof OWN | string | undefined {
  const { appId } = ownership;
  let rest: string | undefined;
  const placeholder = APP_ID_PLACEHOLDER.exec(name);
  if (placeholder) {
    rest = name.slice(placeholder[0].length);
  } else if (valueSide && name.startsWith(APP_ID_VARIABLE)) {
    rest = name.slice(APP_ID_VARIABLE.length);
  } else if (appId && name.toLowerCase().startsWith(appId.toLowerCase())) {
    rest = name.slice(appId.length);
  }
  if (rest === undefined || (rest !== '' && !rest.startsWith('-'))) {
    return undefined;
  }
  if (appId) {
    const resolved = `${appId}${rest}`.toLowerCase();
    const claim = ownership.claims.find(({ name: claimed }) => resolved === claimed || resolved.startsWith(`${claimed}-`));
    if (claim !== undefined) {
      return claim.owner;
    }
  }
  return OWN;
}

/** Whose a reference to a service or middleware is. Only the Docker provider holds the app's own. */
function referenceOwner(reference: string, ownership: Ownership): typeof OWN | string | undefined {
  const at = reference.indexOf('@');
  const name = at === -1 ? reference : reference.slice(0, at);
  const provider = at === -1 ? 'docker' : reference.slice(at + 1).toLowerCase();
  return provider === 'docker' ? ownerOf(name, ownership, true) : undefined;
}

/** The app a refused name belongs to, when it is another app's by the longer id. */
function ownerParam(owner: typeof OWN | string | undefined): { owner?: string } {
  return typeof owner === 'string' ? { owner } : {};
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
function ruleKeepsToOwnHosts(value: unknown, ownHosts: ReadonlySet<string>): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  let withoutOwnHosts = value;
  for (const host of ownHosts) {
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
  return !namesOtherHost(rule, ownHosts) && restrictsToOwnHost(rule, ownHosts);
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

function namesOtherHost(node: RuleNode, ownHosts: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'matcher':
      return isHostPatternMatcher(node.name) || (isHostMatcher(node.name) && node.args.some((host) => !ownHosts.has(host)));
    case 'not':
      return namesOtherHost(node.operand, ownHosts);
    default:
      return node.operands.some((operand) => namesOtherHost(operand, ownHosts));
  }
}

function restrictsToOwnHost(node: RuleNode, ownHosts: ReadonlySet<string>): boolean {
  switch (node.kind) {
    case 'matcher':
      return isHostMatcher(node.name) && node.args.length > 0 && node.args.every((host) => ownHosts.has(host));
    case 'not':
      return false;
    case 'and':
      return node.operands.some((operand) => restrictsToOwnHost(operand, ownHosts));
    default:
      return node.operands.every((operand) => restrictsToOwnHost(operand, ownHosts));
  }
}
