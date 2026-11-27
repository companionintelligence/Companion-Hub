import { appNetworkName, createAppUrn } from '@/common/helpers/app-helpers';
import { HUB_FORWARD_AUTH_MIDDLEWARES } from '@ci-hub/common/schemas';

export type ExposureMode = 'local' | 'cloudflare' | 'tailscale';

interface TraefikLabelsArgs {
  internalPort: number | string;
  appId: string;
  exposureMode: ExposureMode;
  storeId: string;
  enableAuth?: boolean;
  cloudflareOriginHostname?: string;
  cloudflarePublicHostname?: string;
  localDomain?: string;
  tailscaleHostname?: string;
  httpsBackend?: boolean;
}

/** The app's router on the `web` entry point, which the Cloudflare tunnel connects to: `<app id>-insecure`. */
const INSECURE_ROUTER_SUFFIX = '-insecure';
/** The app's Private VPN router: `<app id>-tailscale`. */
const TAILSCALE_ROUTER_SUFFIX = '-tailscale';
/** The app's middleware that sets the forwarded public host: `<app id>-public-host`. */
const PUBLIC_HOST_MIDDLEWARE_SUFFIX = '-public-host';
/** The app's routers for a browser's fetch of its `/sw.js` (#2324): `<app id>-sw-reset` and `<app id>-sw-reset-insecure`. */
const SW_RESET_ROUTER_SUFFIX = '-sw-reset';

/**
 * What the builder adds to an app's id for its other routers and its public-host middleware. An app
 * whose id is another app's id plus one of these would get a router or middleware of the same name
 * as that app's.
 */
export const HUB_ROUTE_NAME_SUFFIXES: readonly string[] = [
  INSECURE_ROUTER_SUFFIX,
  TAILSCALE_ROUTER_SUFFIX,
  PUBLIC_HOST_MIDDLEWARE_SUFFIX,
  SW_RESET_ROUTER_SUFFIX,
  `${SW_RESET_ROUTER_SUFFIX}${INSECURE_ROUTER_SUFFIX}`,
];

/** The file-provider middleware that strips visitor-set forwarded headers from tunnel requests. */
export const EDGE_HEADERS_MIDDLEWARE = 'ci-hub-edge-headers@file';
/** The Hub's sign-in (cache header, then forward auth) under the file provider. Its `@docker` twin vanishes when the Hub's labels flap. */
export const FORWARD_AUTH_MIDDLEWARE = 'ci-hub@file';
/** See `ci-hub-sw-reset` in assets/traefik/dynamic/dynamic.yml. */
export const SW_RESET_MIDDLEWARE = 'ci-hub-sw-reset@file';
/**
 * The label on an app's containers with the paths the operator exempted from the Hub login, joined by
 * commas ({@link publicPathsLabels}). Under the Hub's reserved `ci-hub.` prefix, so no app sets it.
 */
export const PUBLIC_PATHS_LABEL = 'ci-hub.public-paths';
/** The router apps.yml holds next to an app router for the operator's paths, without the login. */
export const PUBLIC_PATHS_ROUTER_SUFFIX = '-public-paths';
/** What a browser sends when it fetches a service worker script. Nothing else sends this header. */
const SW_RESET_RULE_SUFFIX = ' && Path(`/sw.js`) && Header(`Service-Worker`, `script`)';

/**
 * The file-provider `errors` middleware that swaps Traefik's bare 502 and 504 for the Hub's
 * "<app> is starting…" page. See `ci-hub-app-starting` in assets/traefik/dynamic/dynamic.yml.
 */
export const APP_STARTING_MIDDLEWARE = 'ci-hub-app-starting@file';

/** `traefik.http.routers.<router>.<option>`. Traefik reads option names without regard to case. */
const HTTP_ROUTER_LABEL = /^traefik\.http\.routers\.([^.]+)\.(.+)$/i;

function middlewareChain(value: string | boolean | undefined): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
}

/**
 * Puts the middlewares this builder gave each of its routers at the head of that router's chain,
 * whatever chain an app's `extraLabels` set there, so a manifest can't drop the edge header strip or
 * the Hub login. Donetick, Firefly III and OnlyOffice set chains on these routers: theirs now follow
 * ours, and their forward auth under the other provider counts as ours, so it isn't run twice.
 * Runs after interpolation and compares keys without regard to case, as Traefik reads them. A chain
 * under another spelling of our key is folded into ours: Traefik would read only one of the two and
 * TraefikConfigService only ours.
 */
export function withHubMiddlewaresFirst(
  labels: Record<string, string | boolean>,
  hubLabels: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const hubChains = new Map<string, { key: string; chain: string[]; hasForwardAuth: boolean }>();
  for (const [key, value] of Object.entries(hubLabels)) {
    if (HTTP_ROUTER_LABEL.exec(key)?.[2]?.toLowerCase() === 'middlewares') {
      const chain = middlewareChain(value);
      hubChains.set(key.toLowerCase(), { key, chain, hasForwardAuth: chain.some((name) => HUB_FORWARD_AUTH_MIDDLEWARES.has(name.toLowerCase())) });
    }
  }

  const result = { ...labels };
  const chains = new Map<string, string[]>();
  for (const [key, value] of Object.entries(labels)) {
    const hub = hubChains.get(key.toLowerCase());
    if (!hub) {
      continue;
    }
    let chain = chains.get(hub.key);
    if (!chain) {
      chain = [...hub.chain];
      chains.set(hub.key, chain);
    }
    for (const name of middlewareChain(value)) {
      const lower = name.toLowerCase();
      const known = chain.some((existing) => existing.toLowerCase() === lower);
      if (!known && !(hub.hasForwardAuth && HUB_FORWARD_AUTH_MIDDLEWARES.has(lower))) {
        chain.push(name);
      }
    }
    if (key !== hub.key) {
      delete result[key];
    }
  }
  for (const [key, chain] of chains) {
    result[key] = chain.join(',');
  }
  return result;
}

/** The Hub's sign-in as the Hub container's labels define it for the Docker provider. */
const DOCKER_FORWARD_AUTH_MIDDLEWARE = 'ci-hub@docker';

/**
 * Names the Hub's sign-in under the file provider on every HTTP router in an app container's labels.
 *
 * Some manifests name `ci-hub@docker` on routers of their own. The Hub container's labels define that
 * one, and they change only when the installed compose file is rewritten: by a desktop app update or
 * `cihub compose refresh`, never by the Hub's own image update. The Hub writes `ci-hub@file` from
 * dynamic.yml on every boot, so it is the current sign-in on every install. The two differed once
 * already: `ci-hub` became a chain with the cache header first (CI-Engineering#510), and a route
 * on the old labels sent its files out without it.
 */
export function withSignInUnderFileProvider(labels: Record<string, string | boolean>): Record<string, string | boolean> {
  const result = { ...labels };
  for (const [key, value] of Object.entries(labels)) {
    if (HTTP_ROUTER_LABEL.exec(key)?.[2]?.toLowerCase() !== 'middlewares') {
      continue;
    }
    const chain = middlewareChain(value);
    if (!chain.some((name) => name.toLowerCase() === DOCKER_FORWARD_AUTH_MIDDLEWARE)) {
      continue;
    }
    const renamed: string[] = [];
    for (const name of chain) {
      const next = name.toLowerCase() === DOCKER_FORWARD_AUTH_MIDDLEWARE ? FORWARD_AUTH_MIDDLEWARE : name;
      if (!renamed.some((existing) => existing.toLowerCase() === next.toLowerCase())) {
        renamed.push(next);
      }
    }
    result[key] = renamed.join(',');
  }
  return result;
}

/**
 * Puts the Hub's middlewares at the head of every HTTP router a manifest declared itself: the edge
 * header strip on a Public web app, then the Hub login unless the operator switched it off
 * (`requiresHubLogin`).
 *
 * A manifest may route its own hosts (`${APP_DOMAIN}`, `${APP_LOCAL_DOMAIN}`, `${APP_BASE_HOST}`) to
 * its own services, and those routers carried whatever chain it gave them: none of them had to hold
 * the login, and one with a longer rule outranked the Hub's router on the same host. Any of the
 * Hub's middlewares a manifest placed further down its chain move to the head, so nothing of the
 * app's (a path rewrite, say) runs before the login sees the request.
 *
 * The routers the Hub built (`hubLabels`) are left as {@link withHubMiddlewaresFirst} ordered them:
 * the service-worker reset runs ahead of the login there on purpose. Runs after interpolation, and
 * tells routers apart without regard to case, as Traefik does.
 */
export function withHubLoginOnEveryRouter(
  labels: Record<string, string | boolean>,
  hubLabels: Record<string, string | boolean>,
  { requireLogin, publicWeb }: { requireLogin: boolean; publicWeb: boolean },
): Record<string, string | boolean> {
  const hubRouters = new Set<string>();
  for (const key of Object.keys(hubLabels)) {
    const router = HTTP_ROUTER_LABEL.exec(key)?.[1];
    if (router) hubRouters.add(router.toLowerCase());
  }
  const head = [...(publicWeb ? [EDGE_HEADERS_MIDDLEWARE] : []), ...(requireLogin ? [FORWARD_AUTH_MIDDLEWARE] : [])];
  const hubOwned = new Set([EDGE_HEADERS_MIDDLEWARE.toLowerCase(), ...HUB_FORWARD_AUTH_MIDDLEWARES]);

  // Each manifest router under the first spelling seen, with every key that sets its chain.
  const routers = new Map<string, { name: string; chainKeys: string[] }>();
  for (const key of Object.keys(labels)) {
    const [, router, option] = HTTP_ROUTER_LABEL.exec(key) ?? [];
    if (!router || !option || hubRouters.has(router.toLowerCase())) continue;
    let entry = routers.get(router.toLowerCase());
    if (!entry) {
      entry = { name: router, chainKeys: [] };
      routers.set(router.toLowerCase(), entry);
    }
    if (option.toLowerCase() === 'middlewares') entry.chainKeys.push(key);
  }

  const result = { ...labels };
  for (const { name, chainKeys } of routers.values()) {
    const own: string[] = [];
    for (const chainKey of chainKeys) {
      for (const middleware of middlewareChain(result[chainKey])) {
        const lower = middleware.toLowerCase();
        if (!hubOwned.has(lower) && !own.some((existing) => existing.toLowerCase() === lower)) own.push(middleware);
      }
      delete result[chainKey];
    }
    const chain = [...head, ...own];
    if (chain.length > 0) result[`traefik.http.routers.${name}.middlewares`] = chain.join(',');
  }
  return result;
}

/**
 * Ends every HTTP router in an app container's labels with {@link APP_STARTING_MIDDLEWARE}.
 *
 * Every router, whoever declared it. The ones this builder adds are only some of them: a manifest's
 * `extraLabels` can add middlewares to a router's chain (Donetick does), add a host to one (Kimai's
 * LAN name) or declare routers of its own, and each of those showed the same bare page while the
 * app started. So this runs on the merged labels, after the app id is interpolated into their keys:
 * run before, a manifest's `{{CI_HUB_APP_ID}}` router would get a chain of its own that then
 * overwrote this builder's.
 *
 * Last in the chain, so it only ever sees the app's own answer. Forward auth runs before it, and its
 * 401s, redirects and 5xx reach the visitor untouched: someone who is not signed in gets the login,
 * never the page. The visitor-set headers the edge middleware strips are also gone by then, and
 * Traefik copies the request's headers into its request for the page.
 *
 * Routers are told apart without regard to case, as Traefik tells them apart. A router spelled two
 * ways is one router with one chain: a second chain key, here or added here, would leave Traefik to
 * read only one of the two, which could be the one without the Hub login.
 */
export function withAppStartingPage(labels: Record<string, string | boolean>): Record<string, string | boolean> {
  // Each router under the first spelling seen, with every key that sets its chain, so an existing
  // chain is extended rather than doubled.
  const routers = new Map<string, { name: string; chainKeys: string[] }>();
  for (const key of Object.keys(labels)) {
    const match = HTTP_ROUTER_LABEL.exec(key);
    const [, router, option] = match ?? [];
    if (!router || !option) {
      continue;
    }
    let entry = routers.get(router.toLowerCase());
    if (!entry) {
      entry = { name: router, chainKeys: [] };
      routers.set(router.toLowerCase(), entry);
    }
    if (option.toLowerCase() === 'middlewares') {
      entry.chainKeys.push(key);
    }
  }

  if (routers.size === 0) {
    return labels;
  }

  const result = { ...labels };
  for (const { name, chainKeys } of routers.values()) {
    // One chain under the spelling TraefikConfigService reads for its file-provider copy.
    const key = `traefik.http.routers.${name}.middlewares`;
    const chain: string[] = [];
    for (const chainKey of chainKeys) {
      for (const middleware of middlewareChain(result[chainKey])) {
        if (!chain.some((existing) => existing.toLowerCase() === middleware.toLowerCase())) {
          chain.push(middleware);
        }
      }
      delete result[chainKey];
    }
    if (!chain.includes(APP_STARTING_MIDDLEWARE)) {
      chain.push(APP_STARTING_MIDDLEWARE);
    }
    result[key] = chain.join(',');
  }
  return result;
}

/**
 * Every `Host()` or `HostHeader()` matcher in a rule, whatever hosts it names. `HostHeader()` and
 * several hosts in one matcher are the v2 rule syntax, which a router may still ask for.
 */
const ANY_HOST_MATCHER = /\bHost(?:Header)?\(\s*(?:`[^`]*`|"(?:[^"\\]|\\.)*")(?:\s*,\s*(?:`[^`]*`|"(?:[^"\\]|\\.)*"))*\s*\)/gi;
/** The app's public address as a matcher's argument, in the text a manifest wrote: compose fills it in later. */
const PUBLIC_ADDRESS_HOST = /^(?:`\$\{(?:APP_DOMAIN|APP_BASE_HOST)\}`|"\$\{(?:APP_DOMAIN|APP_BASE_HOST)\}")$/i;
/** The hosts of a matcher {@link ANY_HOST_MATCHER} found. */
const MATCHER_HOST = /`[^`]*`|"(?:[^"\\]|\\.)*"/g;
/** `PathPrefix(`/`)`, which every path has. */
const ROOT_PATH_PREFIX = /\bPathPrefix\(\s*(?:`\/`|"\/")\s*\)/gi;

/**
 * Whether a rule asks for hosts and nothing more: `Host(`${APP_DOMAIN}`)`, the shape most Traefik
 * labels copied from elsewhere have. Such a router claims the app's whole address, and Traefik ranks
 * it by the length of its rule.
 */
function namesOnlyHosts(rule: string): boolean {
  return (
    rule
      .replace(ANY_HOST_MATCHER, '')
      .replace(ROOT_PATH_PREFIX, '')
      .replace(/[\s()|&]/g, '') === ''
  );
}

/** The names of the routers the builder makes for an app, in lower case. */
function hubRouterNames(appId: string): Set<string> {
  return new Set([appId, ...HUB_ROUTE_NAME_SUFFIXES.map((suffix) => `${appId}${suffix}`)].map((name) => name.toLowerCase()));
}

/**
 * On Public web, has a manifest's router on the app's public address (`${APP_DOMAIN}` or
 * `${APP_BASE_HOST}`) answer the tunnel too, which sends the origin host the Hub's own routers match.
 * Each such `Host()` becomes `(Host(...) || Host(<origin host>))`, so the rest of the rule binds as
 * before. The router also gets `<app id>-public-host` first in its own chain (`publicHost`).
 *
 * Left as written: the Hub's own routers (a longer rule there would outrank the reset routers) and a
 * rule that names only hosts ({@link namesOnlyHosts}). Widened, that one would take the app's whole
 * address from the Hub's route and outrank the reset router for a signed-out fetch of `/sw.js`
 * (#2324). Runs after interpolation.
 */
export function withTunnelHostOnPublicAddressRules(
  labels: Record<string, string | boolean>,
  { appId, originHost, publicHost }: { appId: string; originHost: string; publicHost: boolean },
): Record<string, string | boolean> {
  const hubRouters = hubRouterNames(appId);
  const result = { ...labels };
  const rewritten = new Map<string, string>();
  for (const [key, value] of Object.entries(labels)) {
    const [, router, option] = HTTP_ROUTER_LABEL.exec(key) ?? [];
    if (
      !router ||
      option?.toLowerCase().split('.').pop() !== 'rule' ||
      hubRouters.has(router.toLowerCase()) ||
      typeof value !== 'string' ||
      namesOnlyHosts(value)
    ) {
      continue;
    }
    const rule = value.replace(ANY_HOST_MATCHER, (matcher) =>
      (matcher.match(MATCHER_HOST) ?? []).some((host) => PUBLIC_ADDRESS_HOST.test(host)) ? `(${matcher} || Host(\`${originHost}\`))` : matcher,
    );
    if (rule !== value) {
      result[key] = rule;
      rewritten.set(router.toLowerCase(), router);
    }
  }
  if (!publicHost) {
    return result;
  }
  const middleware = `${appId}${PUBLIC_HOST_MIDDLEWARE_SUFFIX}@docker`;
  for (const [lower, router] of rewritten) {
    const chainKey =
      Object.keys(result).find((key) => {
        const [, name, option] = HTTP_ROUTER_LABEL.exec(key) ?? [];
        return name?.toLowerCase() === lower && option?.toLowerCase() === 'middlewares';
      }) ?? `traefik.http.routers.${router}.middlewares`;
    result[chainKey] = [middleware, ...middlewareChain(result[chainKey])].join(',');
  }
  return result;
}

/**
 * Turns Traefik on for a service of the app that declares routers of its own, so a listing's routes on
 * its other services (Public Pool's API, Skyvern's backend) are loaded. The caller does it on Public
 * web only. The routers already carry the login.
 *
 * Not for a service with a router that has no rule (Traefik would make one up from the container's
 * name), one that sets `traefik.enable` itself, or one with a router of a Hub name: Traefik drops a
 * router two containers define differently and takes the Hub's route of the app with it.
 */
export function withTraefikOnRoutingService(
  labels: Record<string, string | boolean>,
  { appId }: { appId: string },
): Record<string, string | boolean> {
  const hubRouters = hubRouterNames(appId);
  const hasRule = new Map<string, boolean>();
  for (const key of Object.keys(labels)) {
    if (key.toLowerCase() === 'traefik.enable') {
      return labels;
    }
    const [, router, option] = HTTP_ROUTER_LABEL.exec(key) ?? [];
    if (router && option) {
      const name = router.toLowerCase();
      if (hubRouters.has(name)) {
        return labels;
      }
      hasRule.set(name, hasRule.get(name) === true || option.toLowerCase().split('.').pop() === 'rule');
    }
  }
  return hasRule.size > 0 && [...hasRule.values()].every(Boolean) ? { ...labels, 'traefik.enable': true } : labels;
}

/**
 * Gives a service whose routers name `<app id>-public-host@docker` the main service's definition of it.
 *
 * Only the main container defined it. Traefik drops a router whose middleware is missing, so a
 * listing's routes on its other services went down while the main container restarted. Traefik keeps
 * a middleware that several containers define alike, so the main service's labels are copied as they
 * are (Donetick and Firefly III set their own value there). A service that defines it itself keeps its own.
 */
export function withPublicHostMiddlewareOfMain(
  labels: Record<string, string | boolean>,
  mainLabels: Record<string, string | boolean>,
  { appId }: { appId: string },
): Record<string, string | boolean> {
  const middleware = `${appId}${PUBLIC_HOST_MIDDLEWARE_SUFFIX}`.toLowerCase();
  const definesIt = (key: string) => key.toLowerCase().startsWith(`traefik.http.middlewares.${middleware}.`);
  const namesIt = Object.entries(labels).some(
    ([key, value]) =>
      HTTP_ROUTER_LABEL.exec(key)?.[2]?.toLowerCase() === 'middlewares' &&
      middlewareChain(value).some((name) => name.toLowerCase() === `${middleware}@docker`),
  );
  if (!namesIt || Object.keys(labels).some(definesIt)) {
    return labels;
  }
  return { ...labels, ...Object.fromEntries(Object.entries(mainLabels).filter(([key]) => definesIt(key))) };
}

/** The app id placeholders `ServiceBuilder.interpolateVariables` writes the app id into. */
const APP_ID_PLACEHOLDER = /\{\{\s*(?:CI_HUB_APP_ID|RUNTIPI_APP_ID|RUNCIHUB_APP_ID)\s*\}\}/g;

/** The router a label sets, as Traefik names it once `appId` is written in, and the option's last part. */
function routerOption(label: string, appId: string): { router: string; option: string } | undefined {
  const [, router, option] = HTTP_ROUTER_LABEL.exec(label) ?? [];
  if (!router || !option) {
    return undefined;
  }
  const lowerOption = option.toLowerCase();
  return { router: router.replace(APP_ID_PLACEHOLDER, appId).toLowerCase(), option: lowerOption.slice(lowerOption.lastIndexOf('.') + 1) };
}

/**
 * The other labels in `labels` of each router whose `middlewares` label is in `leftOut`, each with
 * that `middlewares` label. Without its chain such a router still serves, with no Hub login in front
 * of it when the chain held one, so the builder leaves the whole router out. The Hub's own labels
 * for a router of its own are not in `labels`, so its router keeps its chain.
 */
export function labelsOfRoutersLosingTheirChain(leftOut: Iterable<string>, labels: Record<string, unknown>, appId: string): Map<string, string> {
  const chainLabels = new Map<string, string>();
  for (const label of leftOut) {
    const parsed = routerOption(label, appId);
    if (parsed?.option === 'middlewares' && !chainLabels.has(parsed.router)) {
      chainLabels.set(parsed.router, label);
    }
  }
  const result = new Map<string, string>();
  if (chainLabels.size === 0) {
    return result;
  }
  for (const label of Object.keys(labels)) {
    const router = routerOption(label, appId)?.router;
    const chainLabel = router === undefined ? undefined : chainLabels.get(router);
    if (chainLabel !== undefined && chainLabel !== label) {
      result.set(label, chainLabel);
    }
  }
  return result;
}

/**
 * The operator's `publicPaths` (each one already checked against `publicPathSchema`) as a label for
 * every container of an app with the Hub login. TraefikConfigService gives every router of the app
 * with the login a twin for those paths in apps.yml: the same chain without the login, ranked one
 * above its router, a listing's routes on its other services included. On every container, so those
 * keep the paths while the main one restarts.
 *
 * Not twins in the labels: Traefik ranks a router without a priority by the length of its rule, which
 * a listing's rule has only once compose fills in `${APP_LOCAL_DOMAIN}` and the like.
 */
export function publicPathsLabels({ enableAuth, publicPaths }: { enableAuth: boolean; publicPaths?: readonly string[] }): Record<string, string> {
  const paths = (publicPaths ?? []).map((path) => path.replace(/\/+$/, '')).filter(Boolean);
  return enableAuth && paths.length > 0 ? { [PUBLIC_PATHS_LABEL]: paths.join(',') } : {};
}

export class TraefikLabelsBuilder {
  private labels: Record<string, string | boolean> = {};
  private effectiveMode: ExposureMode;

  constructor(private params: TraefikLabelsArgs) {
    // The app's own network, which the Hub connects Traefik to: no app is on a network Traefik shares
    // with other apps.
    const appNetwork = appNetworkName(createAppUrn(params.appId, params.storeId));

    this.effectiveMode = params.exposureMode || 'local';

    this.labels = {
      generated: true,
      'traefik.enable': false,
      'traefik.docker.network': appNetwork,
      [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.port`]: `${params.internalPort}`,
      ...(params.httpsBackend && {
        [`traefik.http.services.${params.appId}-${params.storeId}.loadbalancer.server.scheme`]: 'https',
      }),
    };
  }

  addCloudflareLabels() {
    if (this.effectiveMode !== 'cloudflare' || !this.params.cloudflareOriginHostname) {
      return this;
    }

    const hostRule = `Host(\`${this.params.cloudflareOriginHostname}\`)`;
    const publicHostMiddleware = `${this.params.appId}-${this.params.storeId}${PUBLIC_HOST_MIDDLEWARE_SUFFIX}`;
    // First, auth or not: drops the forwarded headers a tunnel visitor can set and no edge hop
    // replaces (X-Real-Ip and the rest), which Traefik keeps because it trusts cloudflared's
    // forwarded headers. See `ci-hub-edge-headers` in assets/traefik/dynamic/dynamic.yml.
    const middlewares: string[] = [EDGE_HEADERS_MIDDLEWARE];

    if (this.params.enableAuth) {
      // BOTH routers, not just the TLS one. The `-insecure` router below serves the same host
      // rule on the `web` entrypoint, and that is precisely the entrypoint the Cloudflare tunnel
      // connects to (see traefik.yml: "Cloudflare Tunnel connects via plain HTTP"). Attaching the
      // forward-auth middleware only to `websecure` left every request that arrived through the
      // tunnel — i.e. all remote traffic to a cloudflare-exposed app — bypassing edge auth
      // entirely, while `curl`-ing the HTTPS entrypoint from the appliance looked correctly
      // gated. An app trusting the edge alone was open to the internet (CI-Engineering#74).
      //
      // Prefer the file provider middleware — `@docker` vanishes when Hub labels flap.
      middlewares.push(FORWARD_AUTH_MIDDLEWARE);
    }

    if (this.params.cloudflarePublicHostname) {
      middlewares.push(`${publicHostMiddleware}@docker`);
    }

    Object.assign(this.labels, {
      'traefik.enable': true,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}${INSECURE_ROUTER_SUFFIX}.rule`]: hostRule,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}${INSECURE_ROUTER_SUFFIX}.entrypoints`]: 'web',
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}${INSECURE_ROUTER_SUFFIX}.service`]: `${this.params.appId}-${this.params.storeId}`,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.rule`]: hostRule,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.entrypoints`]: 'websecure',
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.service`]: `${this.params.appId}-${this.params.storeId}`,
      [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.tls.certresolver`]: 'myresolver',
    });

    if (this.params.cloudflarePublicHostname) {
      Object.assign(this.labels, {
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Host`]: this.params.cloudflarePublicHostname,
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Proto`]: 'https',
        [`traefik.http.middlewares.${publicHostMiddleware}.headers.customrequestheaders.X-Forwarded-Port`]: '443',
      });
    }

    if (middlewares.length > 0) {
      const middlewareChain = middlewares.join(',');
      Object.assign(this.labels, {
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}.middlewares`]: middlewareChain,
        [`traefik.http.routers.${this.params.appId}-${this.params.storeId}${INSECURE_ROUTER_SUFFIX}.middlewares`]: middlewareChain,
      });
    }

    if (this.params.enableAuth) {
      // A browser that holds a worker from before the sign-in fetches `/sw.js` to update it. The
      // sign-in refuses that fetch and the browser keeps the old worker, which goes on serving the
      // cached app (#2324). These routers take only that fetch on both entry points like the routers
      // above. They put the reset middleware in front of the same forward auth. Their rule is longer
      // than the host rule, so Traefik ranks them first for that one request and for nothing else.
      // The service is the app's own: a signed-in browser still gets the app's `/sw.js`.
      const swResetRouter = `${this.params.appId}-${this.params.storeId}${SW_RESET_ROUTER_SUFFIX}`;
      const swResetChain = middlewares.flatMap((name) => (name === FORWARD_AUTH_MIDDLEWARE ? [SW_RESET_MIDDLEWARE, name] : [name])).join(',');
      const swResetRule = `${hostRule}${SW_RESET_RULE_SUFFIX}`;
      Object.assign(this.labels, {
        [`traefik.http.routers.${swResetRouter}${INSECURE_ROUTER_SUFFIX}.rule`]: swResetRule,
        [`traefik.http.routers.${swResetRouter}${INSECURE_ROUTER_SUFFIX}.entrypoints`]: 'web',
        [`traefik.http.routers.${swResetRouter}${INSECURE_ROUTER_SUFFIX}.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${swResetRouter}${INSECURE_ROUTER_SUFFIX}.middlewares`]: swResetChain,
        [`traefik.http.routers.${swResetRouter}.rule`]: swResetRule,
        [`traefik.http.routers.${swResetRouter}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${swResetRouter}.service`]: `${this.params.appId}-${this.params.storeId}`,
        [`traefik.http.routers.${swResetRouter}.tls.certresolver`]: 'myresolver',
        [`traefik.http.routers.${swResetRouter}.middlewares`]: swResetChain,
      });
    }

    return this;
  }

  addTailscaleLabels() {
    if (this.effectiveMode === 'tailscale') {
      const hostname = this.params.tailscaleHostname || `${this.params.appId}.${this.params.storeId}`;
      const router = `traefik.http.routers.${this.params.appId}-${this.params.storeId}${TAILSCALE_ROUTER_SUFFIX}`;

      Object.assign(this.labels, {
        'traefik.enable': true,
        [`${router}.rule`]: `Host(\`${hostname}\`)`,
        [`${router}.entrypoints`]: 'web',
        [`${router}.service`]: `${this.params.appId}-${this.params.storeId}`,
      });
      // This router listens on `web`, which answers the LAN: any request there naming the host above
      // reached the app with no login. The same login as the Public web routes, on the same terms.
      if (this.params.enableAuth) {
        this.labels[`${router}.middlewares`] = FORWARD_AUTH_MIDDLEWARE;
      }
    }
    return this;
  }

  build() {
    return this.labels;
  }
}
