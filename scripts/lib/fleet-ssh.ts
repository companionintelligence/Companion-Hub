/**
 * The one way this CLI runs a command on another machine.
 *
 * CI-Hub has never had an SSH transport — the only `ssh` invocation in the repo before this file was
 * an e2e test helper. Every `cihub fleet` subcommand goes through `sshCapture` here, so the flags,
 * the timeout behaviour and the failure vocabulary are decided once.
 *
 * That matters because the alternative is already visible next door: the CI-Engineering fleet
 * harness grew FOUR different flag sets (`StrictHostKeyChecking=no` in two places, `accept-new` in
 * two others; `BatchMode=yes` in some and absent from the dashboard's own spawner; ConnectTimeout of
 * 8, 10, 12 and 30 seconds), and its two usable helpers are trapped unexported inside a 215 KB file.
 * A fleet tool whose hosts fail differently depending on which function reached them cannot report
 * honestly.
 *
 * TAILSCALE SSH ONLY. There is no key management here, no `-i`, no agent forwarding, no password
 * path. Authentication is tailnet identity, which means access is an ACL decision an operator can
 * see and audit rather than a key someone once copied. It also makes a specific failure legible:
 * a node whose tailnet ACL grants no SSH answers its inference port perfectly while being
 * completely unadministrable, and that state has gone unnoticed on this fleet for an unknown period
 * on two machines. `classifySshFailure` names it rather than reporting a generic timeout.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';

/** Default connect budget. Deliberately short: an unreachable host should fail fast, not hang a sweep. */
export const SSH_CONNECT_TIMEOUT_S = 8;

/** Default total budget for one remote command. */
export const SSH_COMMAND_TIMEOUT_MS = 20_000;

/**
 * The flags every remote call uses.
 *
 * `BatchMode=yes` is the load-bearing one: without it, a host missing from `known_hosts` or with an
 * expired credential drops into an interactive prompt and the sweep hangs on a TTY nobody is
 * watching. `accept-new` rather than `no` because pinning a host key on first sight is worth having
 * — `no` disables the check permanently and silently, which is a different and worse trade.
 */
export const SSH_FLAGS: readonly string[] = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
  '-o',
  'ServerAliveInterval=15',
];

/**
 * Prelude prepended to every remote command.
 *
 * A non-interactive SSH session does not source a login shell, so a node with Node installed via
 * nvm, asdf or bun has none of them on PATH — `command -v node` simply fails on a machine that
 * plainly has Node. Ported from the CI-Engineering harness, where this exact prelude is what makes
 * remote tooling discoverable at all.
 *
 * Every line is failure-tolerant: a node with no nvm must not have its command aborted by the
 * attempt to source one.
 */
export const REMOTE_TOOL_INIT = [
  '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1',
  '[ -s "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1',
  '[ -s "$HOME/.bun/env" ] && . "$HOME/.bun/env" >/dev/null 2>&1',
  'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
].join('; ');

export interface SshResult {
  ok: boolean;
  out: string;
  err: string;
  /** Process exit code, or null when the command was killed by our own timeout. */
  code: number | null;
  /** Wall-clock duration, so a caller can distinguish "refused instantly" from "hung to the budget". */
  ms: number;
}

/**
 * Why an SSH attempt failed, in the operator's vocabulary rather than OpenSSH's.
 *
 * The distinction that earns this function: `acl-denied` and `unreachable` both surface as a
 * non-zero exit with no output, and they mean opposite things. The first is an account-level
 * decision that no amount of retrying or rebooting will change; the second is a machine that is off
 * or off-network. Reporting both as "failed" is what let two nodes sit unadministrable and unnoticed.
 */
export type SshFailure =
  | 'ok'
  /** The tailnet grants you SSH here, but not as the user we asked for. Fixable from this side. */
  | 'acl-wrong-user'
  /** The tailnet grants you no SSH to this node at all. Not fixable from this side. */
  | 'acl-denied'
  | 'auth-refused'
  | 'unreachable'
  | 'timeout'
  | 'host-key'
  | 'command-failed'
  | 'no-ssh-binary';

export function classifySshFailure(result: SshResult): SshFailure {
  if (result.ok) return 'ok';
  const text = `${result.err}\n${result.out}`.toLowerCase();
  // Tailscale's two refusals, which look alike and mean opposite things. `as user "x"` is the ACL
  // saying "not that account" — the operator fixes it by passing --user and the node is perfectly
  // administrable. `to this node` is the ACL saying "not you, here" — no flag helps, and that is the
  // state two machines on this fleet sat in unnoticed. Reporting both as one failure would tell an
  // operator to go change an ACL when all they needed was a username.
  if (text.includes('tailnet policy does not permit')) {
    return /as user\s+"/.test(text) ? 'acl-wrong-user' : 'acl-denied';
  }
  if (text.includes('permission denied')) return 'auth-refused';
  if (text.includes('host key verification failed')) return 'host-key';
  if (text.includes('could not resolve hostname') || text.includes('no route to host') || text.includes('network is unreachable')) {
    return 'unreachable';
  }
  if (text.includes('connection refused') || text.includes('connection timed out') || text.includes('operation timed out')) {
    return 'unreachable';
  }
  if (result.code === null) return 'timeout';
  if (text.includes('enoent')) return 'no-ssh-binary';
  return 'command-failed';
}

/** One line an operator can act on, for each failure kind. */
export function describeSshFailure(kind: SshFailure, target: string): string {
  switch (kind) {
    case 'ok':
      return '';
    case 'acl-wrong-user':
      return `${target}: the tailnet permits SSH here, but not as the user we tried. Pass --user (or set FLEET_SSH_USER) with an account the ACL grants.`;
    case 'acl-denied':
      return `${target}: the tailnet ACL grants no SSH to this node at all. It may still serve inference perfectly — this is an account-level grant, not a machine fault, and no flag here can change it.`;
    case 'auth-refused':
      return `${target}: SSH refused the credential. Check the account exists on the node and that tailnet SSH is enabled for it.`;
    case 'host-key':
      return `${target}: host key changed since it was first seen. Verify the machine before removing the old key.`;
    case 'unreachable':
      return `${target}: no route. The node is off, off-network, or not in this tailnet.`;
    case 'timeout':
      return `${target}: accepted the connection but did not finish in the budget. Often a node under heavy load rather than a broken one.`;
    case 'no-ssh-binary':
      return 'no ssh binary on PATH — install OpenSSH.';
    case 'command-failed':
      return `${target}: connected, but the remote command exited non-zero.`;
  }
}

export interface SshTarget {
  /** Address to dial. A tailnet MagicDNS name or an IP; both work. */
  host: string;
  /** Remote user. Tailscale SSH maps this to a tailnet identity. */
  user?: string;
}

export function sshDestination(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/**
 * Run one command on one node and capture its output.
 *
 * Never throws for a remote failure — a fleet sweep must be able to visit twenty hosts and report on
 * all twenty, so every outcome including "no ssh binary" comes back as a value. The only way this
 * rejects is if the caller's own promise machinery breaks.
 *
 * The timeout kills with SIGTERM and returns `code: null`, which is what `classifySshFailure` reads
 * to tell a slow node from a refused one.
 */
export function sshCapture(target: SshTarget, command: string, timeoutMs: number = SSH_COMMAND_TIMEOUT_MS): Promise<SshResult> {
  const dest = sshDestination(target);
  // `-n` redirects stdin from /dev/null. Without it a command that reads stdin will consume the
  // parent's, which in a fan-out silently starves every sibling call.
  const args = ['-n', ...SSH_FLAGS, dest, `${REMOTE_TOOL_INIT}; ${command}`];
  const startedAt = Date.now();

  return new Promise<SshResult>((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code, ms: Date.now() - startedAt });
    };

    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      err += `\nTimed out after ${timeoutMs}ms`;
      proc.kill('SIGTERM');
      finish(null);
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    // A missing `ssh` binary arrives here, not as a non-zero exit.
    proc.on('error', (error) => {
      err += `\n${String(error)}`;
      finish(null);
    });
    proc.on('close', (code) => finish(code));
  });
}

/**
 * The remote command for a script that must read the SSH session's stdin — what `sshStreamFile` needs.
 *
 * Not a heredoc, which is how every other remote step carries its script: a heredoc IS that bash's
 * stdin, so a `cat` inside it reads the rest of its own script and the bytes ssh is feeding never
 * reach anything. That is the exit 0, silent, marker-less `install cihub` a node reported on
 * 2026-09-20. The script goes in argv instead, and stdin stays what ssh made it.
 */
export function stdinScriptCommand(script: string): string {
  return `bash -c '${script.replace(/'/g, "'\\''")}'`;
}

/**
 * Run one command on one node with a local file on its stdin.
 *
 * The one thing `sshCapture` cannot do, by design (`-n`). This exists for exactly one caller: putting
 * the `cihub` binary on a node. The release lives in a private GitHub repository, so a node cannot
 * `curl` it; the operator's machine can, and already has it. Streaming the bytes down the SSH
 * session the install already holds needs no token on the node and no second transport.
 *
 * `command` must leave stdin to the script — build it with `stdinScriptCommand`, not a heredoc.
 *
 * Same contract as `sshCapture`: never throws for a remote failure, `code: null` on timeout.
 */
export function sshStreamFile(target: SshTarget, command: string, localPath: string, timeoutMs: number = SSH_COMMAND_TIMEOUT_MS): Promise<SshResult> {
  const dest = sshDestination(target);
  const args = [...SSH_FLAGS, dest, `${REMOTE_TOOL_INIT}; ${command}`];
  const startedAt = Date.now();

  return new Promise<SshResult>((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code, ms: Date.now() - startedAt });
    };

    let source: ReturnType<typeof createReadStream>;
    try {
      source = createReadStream(localPath);
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error), code: null, ms: 0 });
      return;
    }

    const proc = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      err += `\nTimed out after ${timeoutMs}ms`;
      proc.kill('SIGTERM');
      finish(null);
    }, timeoutMs);

    source.on('error', (error) => {
      err += `\n${String(error)}`;
      proc.kill('SIGTERM');
      finish(null);
    });
    // EPIPE when the remote side exits early (a refused `install`, say): the failure is already in
    // stderr and the exit code; the pipe error itself is noise.
    proc.stdin?.on('error', () => undefined);
    source.pipe(proc.stdin as NodeJS.WritableStream);

    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('error', (error) => {
      err += `\n${String(error)}`;
      finish(null);
    });
    proc.on('close', (code) => finish(code));
  });
}

/**
 * Run the same command across many nodes, bounded.
 *
 * `limit` defaults low on purpose. This is not politeness: provisioning work on these machines
 * routinely pulls tens of gigabytes, and a node cold-loading weights stops answering its own HTTP
 * port for minutes. Fanning out wide has produced exactly that — nodes that were mid-work being
 * reported absent by the tool that gave them the work.
 */
export async function sshFanOut<T extends SshTarget>(
  targets: readonly T[],
  command: string,
  opts: { timeoutMs?: number; limit?: number } = {},
): Promise<Map<T, SshResult>> {
  const limit = Math.max(1, opts.limit ?? 4);
  const results = new Map<T, SshResult>();
  const queue = [...targets];

  const worker = async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      results.set(target, await sshCapture(target, command, opts.timeoutMs));
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
  return results;
}
