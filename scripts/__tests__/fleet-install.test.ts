/**
 * Fleet install and update script generation.
 *
 * These build shell that runs as root on other people's machines, so the tests are about what the
 * scripts must never do as much as what they do. Every case is a failure this fleet has actually
 * seen.
 */

import { describe, expect, it } from 'vitest';
import {
  bringUpScript,
  claimHubScript,
  describeStepFailure,
  joinPoolScript,
  pullModelScript,
  shouldAdoptExistingCihub,
  updateHubScript,
} from '../lib/fleet-install.js';

describe('shouldAdoptExistingCihub', () => {
  it('adopts a present cihub when nothing better is on offer', () => {
    expect(shouldAdoptExistingCihub({ present: true, version: '0.2.55' })).toMatchObject({ adopt: true });
    expect(shouldAdoptExistingCihub({ present: true, version: '0.2.55' }, 'latest')).toMatchObject({ adopt: true });
  });

  it('replaces one that is older than what this run would install', () => {
    // A 0.2.55 from August drove a fresh install on 2026-09-18 and ran `up` against service names
    // that no longer existed. "Present" is not "usable".
    expect(shouldAdoptExistingCihub({ present: true, version: '0.2.55' }, 'v0.2.72')).toMatchObject({ adopt: false });
    expect(shouldAdoptExistingCihub({ present: true, version: '0.2.72' }, 'v0.2.72')).toMatchObject({ adopt: true });
    expect(shouldAdoptExistingCihub({ present: true, version: '0.2.80' }, 'v0.2.72')).toMatchObject({ adopt: true });
  });

  it('replaces one whose version cannot be read, rather than guessing', () => {
    expect(shouldAdoptExistingCihub({ present: true }, 'v0.2.72')).toMatchObject({ adopt: false });
    expect(shouldAdoptExistingCihub({ present: false }, 'v0.2.72')).toMatchObject({ adopt: false });
  });
});

describe('describeStepFailure', () => {
  it('prefers the line that explains the failure over the last line of compose noise', () => {
    const out = [
      'Container ci-hub Started',
      '┌─ Pairing failed ─┐',
      '  That device is already paired. Send its current device key to re-pair it.',
      '└──┘',
      'Container traefik Started',
    ].join('\n');
    const detail = describeStepFailure(out, '');
    expect(detail).toContain('Pairing failed');
    expect(detail).toContain('already paired');
    expect(detail).not.toMatch(/^Container traefik Started/);
  });

  it('falls back to the tail when nothing looks like an explanation', () => {
    expect(describeStepFailure('one\ntwo\nthree\nfour', '')).toBe('two | three | four');
  });

  it('reads stderr first, where hub-up-failed markers go', () => {
    expect(
      describeStepFailure('Container traefik Started', 'hub-up-failed: nothing answered http://127.0.0.1:5003/api/registration/phase after cihub up'),
    ).toContain('hub-up-failed');
  });
});

describe('bringUpScript', () => {
  it('passes the password through the environment, never on a command line', () => {
    // argv is visible in `ps` to every user on the box.
    const script = bringUpScript('hunter2hunter2', 'ABC123');
    expect(script).toContain("export CIHUB_POSTGRES_PASSWORD='hunter2hunter2'");
    expect(script).not.toMatch(/cihub up[^\n]*hunter2/);
  });

  it('always passes --code, because register hangs on a prompt without it', () => {
    expect(bringUpScript('pw12345678', 'ABC123')).toContain("cihub register --code 'ABC123'");
  });

  it('verifies registration state rather than trusting the command, and fails on silence', () => {
    // register exited 0 on every failure until recently; the state check is the real evidence.
    // A heal once moved API_PORT to 5003; the probe was silent and the step still said done.
    const script = bringUpScript('pw12345678', 'ABC123');
    expect(script).toContain('/api/registration/phase');
    expect(script).toContain('^API_PORT=');
    expect(script).toMatch(/\[ -n "\$phase" \] \|\| \{ echo "hub-up-failed/);
    expect(script).toContain('"registered":true');
    expect(script).not.toContain('|| true\n');
  });

  it('escapes a quote in either secret rather than breaking out of the string', () => {
    const script = bringUpScript("pass'word12", "AB'123");
    expect(script).toContain("'pass'\\''word12'");
    expect(script).toContain("'AB'\\''123'");
  });
});

describe('claimHubScript', () => {
  /**
   * The step `docs/fleet-setup.md` never listed. "install, register, install models, then pair"
   * leaves out the one thing that creates an operator, which is why this fleet ended up with twelve
   * registered Hubs that could not authenticate anybody.
   */
  it('claims for the address given, non-interactively', () => {
    const script = claimHubScript('owner@example.com');

    expect(script).toContain("cihub claim --email 'owner@example.com'");
    // No prompt fallback: `ssh -n` has no TTY, and `claim` without --email would sit on a stdin
    // that never answers.
    expect(script).toContain('--email');
  });

  it('escapes a quote in the address rather than breaking out of the string', () => {
    expect(claimHubScript("o'brien@example.com")).toContain("'o'\\''brien@example.com'");
  });

  it('stops the step on failure instead of reporting the marker anyway', () => {
    expect(claimHubScript('owner@example.com').startsWith('set -e')).toBe(true);
  });
});

describe('joinPoolScript', () => {
  it('sets the non-interactive opt-in, since ssh -n has no TTY', () => {
    // Without it every pool mutation exits 2 before doing anything.
    const script = joinPoolScript('hub-b.tail.ts.net');
    expect(script).toContain('CI_HUB_ASSUME_YES=1');
    expect(script).toContain('--yes');
  });

  it('includes a PIN only when one is supplied', () => {
    expect(joinPoolScript('10.0.0.5', '123456')).toContain("--pin '123456'");
    expect(joinPoolScript('hub-b.tail.ts.net')).not.toContain('--pin');
  });
});

describe('pullModelScript', () => {
  it('does not allocate a TTY', () => {
    // `docker exec -it` against ssh -n fails with "the input device is not a TTY".
    const script = pullModelScript('qwen3.8:27b');
    expect(script).not.toContain('-it');
    expect(script).toContain('docker exec "$c"');
  });

  it('tries a container, then a live endpoint, then a host CLI', () => {
    // The first cut only knew about a Hub-managed container and failed on every node in this fleet,
    // which runs Ollama as a host systemd service.
    const script = pullModelScript('x');
    expect(script).toContain('docker exec "$c"');
    expect(script).toContain('/api/pull');
    expect(script).toMatch(/command -v ollama/);
  });

  it('discovers where ollama actually listens instead of assuming loopback', () => {
    // core-1 binds to its tailnet address, not 0.0.0.0, so 127.0.0.1 answers nothing on a node that
    // is serving perfectly — which is exactly how this failed before.
    const script = pullModelScript('x');
    expect(script).toContain('OLLAMA_HOST=');
    expect(script).toMatch(/ss -ltn/);
  });

  it('fails with a message naming all three things it looked for', () => {
    // A silent no-op is indistinguishable from success on a fresh appliance.
    expect(pullModelScript('x')).toMatch(/no ollama on this node/);
  });

  it('escapes a quote in a model name', () => {
    expect(pullModelScript("weird'name")).toContain("'weird'\\''name'");
  });
});

describe('updateHubScript', () => {
  it('uses the toolchain-free pool update path', () => {
    // `cihub up` appends --build, which a node with no source tree and no registry token cannot do.
    const script = updateHubScript();
    expect(script).toContain('cihub pool update');
    expect(script).not.toContain('cihub up');
  });

  it('leaves the image floating unless a pin is given', () => {
    expect(updateHubScript()).not.toContain('CI_HUB_IMAGE');
  });

  it('hands a pinned image to pool update as CI_HUB_IMAGE, before the command that reads it', () => {
    // `cihub pool update` honours process.env.CI_HUB_IMAGE over its `:dev` default — this is the whole
    // delivery path for a digest pin, so the export must precede the call.
    const pin = `ghcr.io/companionintelligence/ci-hub@sha256:${'c'.repeat(64)}`;
    const script = updateHubScript(pin);
    expect(script).toContain(`export CI_HUB_IMAGE='${pin}'`);
    expect(script.indexOf('CI_HUB_IMAGE')).toBeLessThan(script.indexOf('cihub pool update'));
  });

  it('escapes a quote in the pin rather than letting it end the export', () => {
    expect(updateHubScript("repo@sha256:x'y")).toContain("'repo@sha256:x'\\''y'");
  });
});
