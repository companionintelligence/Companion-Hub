/**
 * Installing the two agent apps against a pool endpoint.
 *
 * `hermes-agent` and `openclaw` are the only two slugs CI-Hub hands inference credentials to —
 * `app-credentials.service.ts` names them in `SUPPORTED_APP_SLUGS` and serves each a `.env` at
 * `GET /api/inference/apps/:slug/credentials.env`. That endpoint already exists and already knows
 * how to point an app at the pool rather than a single node, which is why this file is thin: the
 * work is choosing the endpoint and reporting honestly, not inventing a credential path.
 *
 * ⚠️ THE THING TO KNOW BEFORE RUNNING THIS. From `docs/fleet-setup.md`, unchanged and worth
 * repeating at every call site: *"Every installed app receives the device key in its environment.
 * Treat app installation as granting Hub operator authority."* Installing an app on fourteen nodes
 * distributes that key to fourteen more containers.
 */

import { sshCapture, type SshTarget } from './fleet-ssh.js';

export const SUPPORTED_APP_SLUGS = ['hermes-agent', 'openclaw'] as const;
export type AppSlug = (typeof SUPPORTED_APP_SLUGS)[number];

/** Where the app should send inference. */
export type AppEndpointMode =
  /** The Hub's pool proxy — routes across peers, so the app gains the whole cluster. */
  | 'pool'
  /** This node's own backend only. */
  | 'local';

export interface AppCheck {
  slug: AppSlug;
  ok: boolean;
  detail: string;
}

/**
 * Read the credentials the Hub would give an app, without installing anything.
 *
 * The useful pre-flight: it proves the Hub is up, that the slug is supported by this build, and that
 * an inference endpoint actually resolves — all three of which fail differently and all three of
 * which are invisible until an app is already installed and broken.
 */
export function checkAppCredentialsScript(slug: AppSlug, mode: AppEndpointMode): string {
  return [
    'set -e',
    `code="$(curl -s -o /tmp/cihub-app-creds -w '%{http_code}' --max-time 15 'http://127.0.0.1:5002/api/inference/apps/${slug}/credentials.env' || true)"`,
    'if [ "$code" != "200" ]; then',
    `  echo "the Hub did not serve credentials for ${slug} (HTTP $code) — is it registered and running?" >&2`,
    '  exit 1',
    'fi',
    // Report the base URL rather than the key. The key is the Hub operator credential; echoing it
    // into a fleet log would spread it further than the install itself does.
    'base="$(grep -iE \'^(HERMES_OPENAI_BASE_URL|OPENAI_API_BASE|CI_LLM_BASE_URL)=\' /tmp/cihub-app-creds | head -1 | cut -d= -f2-)"',
    'rm -f /tmp/cihub-app-creds',
    '[ -n "$base" ] || { echo "credentials came back with no inference base URL" >&2; exit 1; }',
    `echo "app-creds-ok ${slug} ${mode} $base"`,
  ].join('\n');
}

/**
 * Does this node's Hub route through a pool at all?
 *
 * Asked separately from the credential check because the two can disagree in the direction that
 * matters: the credentials bake in a base URL at install time, so an app installed before a peer was
 * paired keeps pointing at the local backend even once the pool is live.
 */
export function poolRoutingScript(): string {
  return [
    'set -e',
    's="$(curl -s --max-time 10 http://127.0.0.1:5002/api/inference/pool/identify || echo \'{}\')"',
    'echo "$s" | grep -q poolProtocol && echo "pool-routes-present" || echo "pool-routes-absent"',
  ].join('\n');
}

export async function checkAppOnNode(target: SshTarget, slug: AppSlug, mode: AppEndpointMode): Promise<AppCheck> {
  const res = await sshCapture(target, `bash <<'EOF'\n${checkAppCredentialsScript(slug, mode)}\nEOF`, 60_000);
  if (res.ok && res.out.includes('app-creds-ok')) {
    return { slug, ok: true, detail: res.out.split('\n').filter(Boolean).slice(-1)[0] ?? 'ok' };
  }
  return { slug, ok: false, detail: (res.err || res.out).split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? 'no output' };
}
