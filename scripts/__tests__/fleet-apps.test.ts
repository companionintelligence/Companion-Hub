/**
 * Agent-app credential checks.
 *
 * This is a read-only pre-flight rather than an installer, and the tests exist to keep it that way:
 * the repo's own warning is that *"every installed app receives the device key in its environment —
 * treat app installation as granting Hub operator authority"*, so a fleet command that installed
 * blind would distribute that key to fourteen more machines.
 */

import { describe, expect, it } from 'vitest';
import { checkAppCredentialsScript, poolRoutingScript, SUPPORTED_APP_SLUGS } from '../lib/fleet-apps.js';

describe('checkAppCredentialsScript', () => {
  it('reads credentials and installs nothing', () => {
    const script = checkAppCredentialsScript('hermes-agent', 'pool');
    expect(script).toContain('/api/inference/apps/hermes-agent/credentials.env');
    for (const dangerous of ['docker run', 'docker compose', 'apt-get', 'install ']) {
      expect(script).not.toContain(dangerous);
    }
  });

  it('reports the base URL and never the API key', () => {
    // The key is the Hub operator credential; echoing it into a fleet log spreads it further than
    // the install would.
    const script = checkAppCredentialsScript('openclaw', 'pool');
    expect(script).toMatch(/BASE_URL\|OPENAI_API_BASE\|CI_LLM_BASE_URL/);
    expect(script).not.toMatch(/API_KEY[^=]*\$/);
    expect(script).toContain('rm -f /tmp/cihub-app-creds');
  });

  it('does not double-print the status code', () => {
    // `curl -w '%{http_code}'` always prints a code, including 000 on a refused connection, so a
    // `|| echo 000` fallback yielded "HTTP 000000" in the error message.
    const script = checkAppCredentialsScript('openclaw', 'pool');
    expect(script).not.toContain('|| echo 000');
  });

  it('fails with a diagnosis rather than a bare status', () => {
    expect(checkAppCredentialsScript('openclaw', 'local')).toMatch(/is it registered and running/);
  });

  it('treats a missing base URL as a failure, not a pass', () => {
    // A 200 whose body carries no endpoint would otherwise read as success and leave an app pointed
    // at nothing.
    expect(checkAppCredentialsScript('hermes-agent', 'pool')).toMatch(/no inference base URL/);
  });
});

describe('poolRoutingScript', () => {
  it('distinguishes present from absent rather than guessing', () => {
    const script = poolRoutingScript();
    expect(script).toContain('pool-routes-present');
    expect(script).toContain('pool-routes-absent');
  });
});

describe('supported slugs', () => {
  it('matches the two the Hub actually serves credentials to', () => {
    // app-credentials.service.ts names exactly these in SUPPORTED_APP_SLUGS.
    expect([...SUPPORTED_APP_SLUGS]).toEqual(['hermes-agent', 'openclaw']);
  });
});
