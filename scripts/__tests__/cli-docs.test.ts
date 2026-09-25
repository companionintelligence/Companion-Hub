/**
 * The command surface as an operator can find it: `--help`, `man`, and `docs/CLI.md`.
 *
 * `cihub fleet` shipped seven subcommands of which `--help` listed three and the docs listed none,
 * so `backends`, `install`, `update` and `apps` were reachable only by reading the source — for the
 * one command group that acts on OTHER machines. The man page also claimed every command takes an
 * optional `[env]`, which `cihub fleet scan prod` refuses outright.
 *
 * Assertions are driven from FLEET_SUBCOMMANDS rather than a hand-written list, so a new subcommand
 * fails here until it is documented in both places.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLEET_SUBCOMMANDS } from '../lib/cli-fleet.js';
import { renderHelp, renderManPage, stripAnsi } from '../lib/cli-ui.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const cliDoc = fs.readFileSync(path.join(repoRoot, 'docs/CLI.md'), 'utf-8');

describe('fleet is discoverable', () => {
  it('names every fleet subcommand in --help and man', () => {
    for (const rendered of [stripAnsi(renderHelp()), stripAnsi(renderManPage())]) {
      for (const sub of FLEET_SUBCOMMANDS) {
        expect(rendered).toContain(`fleet ${sub}`);
      }
    }
  });

  it('says in --help that fleet acts on other machines', () => {
    expect(stripAnsi(renderHelp())).toContain('Fleet (other machines, over SSH)');
  });

  it('has a Fleet section in docs/CLI.md covering every subcommand', () => {
    expect(cliDoc).toContain('\n## Fleet\n');
    for (const sub of FLEET_SUBCOMMANDS) {
      expect(cliDoc).toContain(`cihub fleet ${sub}`);
    }
  });

  it('documents the two things that decide whether a fleet run does anything', () => {
    // The roster nothing else writes, and the account the tailnet actually grants.
    expect(cliDoc).toContain('fleet.json');
    expect(cliDoc).toContain('--write-roster');
    expect(cliDoc).toContain('FLEET_SSH_USER');
    expect(cliDoc).toContain('--execute');
  });

  it('lists cli-fleet.ts in the implementation map', () => {
    expect(cliDoc).toContain('| `cli-fleet.ts` | `fleet` |');
  });
});

describe('the [env] argument', () => {
  it('is not claimed for all commands', () => {
    // `cihub fleet scan prod` dies with "Unexpected argument 'prod'", so "all commands" was false
    // in both the man page and the docs.
    expect(stripAnsi(renderManPage())).not.toContain('All commands accept an optional [env]');
    expect(cliDoc).not.toContain('All commands accept an optional `[env]`');
  });

  it('names the commands that take one, and says fleet does not', () => {
    const man = stripAnsi(renderManPage());
    expect(man).toContain('take an optional [env]');
    expect(man).toContain('fleet refuses one');
    expect(cliDoc).toContain('cihub fleet scan prod');
  });
});

describe('exit codes', () => {
  it('tells an operator which commands report failure in their exit code', () => {
    expect(cliDoc).toContain('\n## Exit codes\n');
    for (const command of ['doctor', 'fleet backends', 'models list', 'app status', 'public-web repair', 'uninstall']) {
      expect(cliDoc).toContain(command);
    }
  });

  it('says a doctor warning is not a failure', () => {
    // The whole point of #1345: a yellow box exits 0, so a note cannot break a scripted chain.
    expect(cliDoc).toContain('A yellow box is not a failure.');
  });

  it('says register over SSH needs --code and refuses fast', () => {
    expect(cliDoc).toContain('The pairing-code prompt needs a terminal');
  });
});

/**
 * Claiming has to be findable, or it is not a fix.
 *
 * The condition it clears is invisible by construction: a registered Hub with no operator answers
 * every guarded route the same way whether the key is wrong or the Hub is empty. An operator who
 * cannot find `cihub claim` in `--help` goes back to re-issuing keys, which is what twelve nodes'
 * worth of the Hub Pool fleet did for a week.
 */
describe('claim is discoverable', () => {
  it('is listed in --help and man, alongside register', () => {
    for (const rendered of [stripAnsi(renderHelp()), stripAnsi(renderManPage())]) {
      expect(rendered).toContain('cihub claim');
    }
  });

  it('is named among the commands that take an [env]', () => {
    expect(stripAnsi(renderManPage())).toContain('register, claim,');
  });

  it('has its own section in docs/CLI.md, saying what register does NOT do', () => {
    expect(cliDoc).toContain('### `cihub claim [env] [--email <addr>]`');
    // The sentence the whole misdiagnosis turned on.
    expect(cliDoc).toContain('AUTH_ERROR_HUB_NOT_CLAIMED');
    expect(cliDoc).toContain('cihub claim --email');
  });

  it('lists cli-claim.ts in the implementation map', () => {
    expect(cliDoc).toContain('| `cli-claim.ts` | `claim` |');
  });
});

/**
 * The two distribution channels, and the command that reconciles them.
 *
 * `cihub self-update` exists because a headless appliance had no way to move its CLI at all, so an
 * operator who cannot find it in `--help` or the docs is back where they started. The skew wording
 * is pinned here too: `update` and `doctor` are where a mismatch is reported, and a doc that does
 * not say so sends people to a command that will not tell them.
 */
describe('CLI vs stack is discoverable', () => {
  it('lists self-update in --help and man', () => {
    for (const rendered of [stripAnsi(renderHelp()), stripAnsi(renderManPage())]) {
      expect(rendered).toContain('self-update');
    }
  });

  it('documents both channels and where the skew is reported', () => {
    expect(cliDoc).toContain('\n## Keeping the CLI and the stack together\n');
    expect(cliDoc).toContain('### `cihub self-update`');
    for (const entry of ['cihub doctor', 'cihub pool update', 'brew upgrade --cask companion-hub', 'scoop update companion-hub']) {
      expect(cliDoc).toContain(entry);
    }
  });

  it('says the CLI version is never read from CI_HUB_VERSION', () => {
    // The env-file value no build stamps, wrong on 10 of 16 fleet Hubs. A doc that leaves it in
    // sends the next person to the one source that was measured to be unreliable.
    expect(cliDoc).toContain('never** from `CI_HUB_VERSION`');
  });

  it('lists cli-update.ts as owning self-update in the implementation map', () => {
    expect(cliDoc).toContain('| `cli-update.ts` | `version`, `update`, `self-update`, `connect` |');
  });

  it('documents which image pool update deploys, and that it records it', () => {
    // The measured downgrade: an operator's digest in the operative env file lost to a channel tag,
    // and nothing wrote back what was deployed. Both halves have to be findable.
    expect(cliDoc).toContain('#### Which image it deploys');
    expect(cliDoc).toContain('#### It records what it deployed');
    expect(cliDoc).toContain('com.docker.compose.project.environment_file');
    expect(cliDoc).toContain('The env argument does not select a release channel');
  });
});
