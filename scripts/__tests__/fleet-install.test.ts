/**
 * Fleet install and update script generation.
 *
 * These build shell that runs as root on other people's machines, so the tests are about what the
 * scripts must never do as much as what they do. Every case is a failure this fleet has actually
 * seen.
 */

import { describe, expect, it } from 'vitest';
import { bringUpScript, installCihubScript, joinPoolScript, pullModelScript, updateHubScript } from '../lib/fleet-install.js';

describe('installCihubScript', () => {
  const script = installCihubScript();

  it('downloads to a file and never pipes a download into a shell', () => {
    // A POSIX pipeline reports only the last command's status, so `curl | sh` executes a truncated
    // download and reports success.
    expect(script).toContain('-o "$tmp"');
    expect(script).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/);
  });

  it('refuses an empty download instead of installing it', () => {
    // This exact URL 404'd for the whole life of the old installer; a renamed error page must not
    // become /usr/local/bin/cihub.
    expect(script).toContain('[ -s "$tmp" ]');
  });

  it('resolves the asset from the architecture, and fails loudly on an unknown one', () => {
    expect(script).toContain('cihub-linux-x64');
    expect(script).toContain('cihub-linux-arm64');
    expect(script).toMatch(/unsupported architecture/);
  });

  it('pins an explicit version when asked', () => {
    expect(installCihubScript('v0.2.61')).toContain('tag="v0.2.61"');
    expect(installCihubScript()).toContain('releases/latest');
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

  it('verifies registration state rather than trusting the command', () => {
    // register exited 0 on every failure until recently; the state check is the real evidence.
    expect(bringUpScript('pw12345678', 'ABC123')).toContain('/api/registration/status');
  });

  it('escapes a quote in either secret rather than breaking out of the string', () => {
    const script = bringUpScript("pass'word12", "AB'123");
    expect(script).toContain("'pass'\\''word12'");
    expect(script).toContain("'AB'\\''123'");
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

  it('fails with a usable message when no ollama container exists', () => {
    // A fresh prod appliance has none, and a silent no-op there is indistinguishable from success.
    expect(pullModelScript('x')).toMatch(/no ollama container on this node/);
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
});
