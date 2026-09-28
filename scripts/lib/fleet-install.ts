/**
 * Standing a Hub up on a remote machine, and keeping a fleet of them current.
 *
 * `docs/fleet-setup.md` describes the manual path plainly: *"Adding a node repeats the whole one-node
 * path: install, register, install models, then pair."* For fourteen boxes that is fourteen sessions,
 * and it is why nobody does it.
 *
 * Six things had to be fixed before this file could exist at all — a release asset nothing built, an
 * `install.sh` pointing at a retired repo, `cihub register` exiting 0 on failure, pool mutations
 * refusing a non-TTY, `docker exec -it` against `ssh -n`, and appliance updates that never re-pulled.
 * They are fixed; this is what they were blocking.
 *
 * TWO RULES, both from watching a fleet-wide pass go wrong:
 *
 * 1. **Serialised per node, and load-gated.** A maintenance pass on this fleet caught one machine
 *    mid-inference at load 108-116 on 32 cores; its package transaction stalled rebuilding an
 *    initramfs it could never get CPU for, and the box ended up needing physical recovery. Nothing
 *    in that pass checked load first. This one does, and refuses.
 * 2. **Verify, never trust an exit code.** `cihub register` used to report success when it had not
 *    reached the Hub. Even now that it exits properly, every step here re-checks the state it
 *    claims to have produced.
 */

import { classifyGpuProbeOutput, describeGpuProbeOutcome, installGpuProbeTimerScript } from './gpu-probe-timer.js';
import { classifyStatusTimerOutput, describeStatusTimerOutcome, installStatusTimerScript } from './status-timer.js';
import { sshCapture, sshStreamFile, type SshTarget, stdinScriptCommand } from './fleet-ssh.js';
import { isTooBusyForMaintenance, readHostFacts } from './fleet-hardware.js';
import {
  assetNameForArch,
  type CihubBinarySource,
  compareCihubVersions,
  downloadReleaseAsset,
  installCihubFromStdinScript,
  parseCihubVersionOutput,
  sha256File,
} from './fleet-cihub-binary.js';
import { tailscaleCertStep } from './fleet-tailscale-cert.js';
import { gatePreflight, preflightNode } from './fleet-preflight.js';
import { classifyPairingFailure, type PairingCodeOutcome } from './fleet-pairing-codes.js';
import {
  describePairingPace,
  describeWait,
  detectPairingRateLimit,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  PairingPacer,
  PORTAL_DEVICE_CREATE_RATE_LIMIT,
  type PortalRateLimit,
  portalRateLimitOf,
  RATE_LIMIT_MARGIN_MS,
  rateLimitWaitMs,
} from './portal-rate-limit.js';

export interface InstallStep {
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
  /** True when the step decided not to act, rather than trying and failing. */
  skipped?: boolean;
}

export interface NodeInstallReport {
  node: string;
  steps: InstallStep[];
  ok: boolean;
}

const tail = (text: string, lines = 3) => text.split('\n').filter(Boolean).slice(-lines).join(' | ').slice(0, 300);

/**
 * Is a usable `cihub` already on this machine, and which one would a login shell run?
 *
 * Both questions, because on this fleet they had different answers: `/usr/local/bin/cihub` was
 * current while `~/.local/bin/cihub` was an August build, and `REMOTE_TOOL_INIT` resolves the latter
 * first. `cihub version` also prints a stray notice before the version on some builds, so the
 * version is the line that names one, not the first line.
 */
export async function detectCihub(target: SshTarget): Promise<{ present: boolean; version?: string; path?: string }> {
  const res = await sshCapture(target, 'p="$(command -v cihub || true)"; echo "path=$p"; [ -n "$p" ] && "$p" version 2>/dev/null', 20_000);
  if (!res.ok && !res.out) return { present: false };
  const pathLine = res.out.split('\n').find((line) => line.startsWith('path='));
  const found = pathLine?.slice('path='.length).trim();
  if (!found) return { present: false };
  return { present: true, path: found, version: parseCihubVersionOutput(res.out) };
}

/**
 * Whether an existing `cihub` is good enough to keep, given the one this run could install.
 *
 * Adopting is the default — the "engine already here, install nothing" behaviour — but only when
 * what is here is not older than what would replace it. Without that gate a node keeps whatever
 * happened to be on PATH: a 0.2.55 from August drove a fresh install on 2026-09-18 and ran a compose
 * command against service names that no longer exist.
 *
 * `wantedVersion` must be a version. `latest` is what the flag says before the release is looked up,
 * and treating it as comparable adopted a July 0.2.36 on 2026-09-20 with a current release in hand;
 * it is unknown here, like `undefined`, and the answer says the two were not compared so the caller
 * can put the reason on the node's line.
 */
export function shouldAdoptExistingCihub(
  existing: { present: boolean; version?: string },
  wantedVersion?: string,
): { adopt: boolean; why: string; compared: boolean } {
  if (!existing.present) return { adopt: false, why: 'no cihub on this node', compared: false };
  if (!wantedVersion || wantedVersion === 'latest')
    return { adopt: true, why: existing.version ? `already installed (${existing.version})` : 'already installed', compared: false };
  if (!existing.version) return { adopt: false, why: 'a cihub is present but its version could not be read; replacing it', compared: false };
  if (compareCihubVersions(existing.version, wantedVersion) >= 0)
    return { adopt: true, why: `already installed (${existing.version}, not older than ${wantedVersion})`, compared: true };
  return { adopt: false, why: `${existing.version} is older than ${wantedVersion}; replacing it`, compared: true };
}

/**
 * `$env_file`: the primary env file a node's Hub reads, else its compat copy. One line, so the check
 * before the mint and every check in `bringUpScript` read the same file.
 */
const ENV_FILE_LINE = 'env_file="$HOME/.local/share/companion-hub/.env.dev"; [ -f "$env_file" ] || env_file="$HOME/.local/share/companion-hub/.env"';

/**
 * Where a node's Hub reads CI_CLOUD_URL, printed as `ci-cloud-url=<value>`. Empty when unset —
 * including a node with no env file yet, which `bringUpScript` seeds with the mint origin.
 */
export function nodePortalUrlScript(): string {
  return [
    ENV_FILE_LINE,
    'url="$(grep -h \'^CI_CLOUD_URL=\' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2-)"',
    'echo "ci-cloud-url=$url"',
    'echo "ci-cloud-url-file=$env_file"',
  ].join('\n');
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Why a code minted on `mintOrigin` cannot pair a Hub that talks to `nodeUrl`, or `null` when it
 * can — or when the node's URL is unknown, which is not evidence of a mismatch.
 *
 * `cihub`'s default Portal is the dev tier while a release Hub defaults to production, so the two
 * disagree by default, and nothing downstream says so: Portal answers the redeeming call with the
 * same 410 it gives a mistyped code. Every attempt also resets the node's registration first.
 */
export function portalOriginMismatch(nodeUrl: string | undefined, mintOrigin: string): string | null {
  const node = nodeUrl ? originOf(nodeUrl) : null;
  const mint = originOf(mintOrigin);
  if (!node || !mint || node === mint) return null;
  return (
    `this Hub pairs against ${node} (its CI_CLOUD_URL), but the code would be minted on ${mint} — ` +
    `a code from one Portal is not in the other's database, so it would be refused 410 every time. ` +
    `Mint on ${node}: CI_CLOUD_URL=${node} cihub login --scope device:manage, or set CI_PORTAL_ORIGIN=${node} with CI_PORTAL_TOKEN`
  );
}

/** The mint origin as a single-quoted shell word's contents, compared with the node's CI_CLOUD_URL as an origin. */
function shellQuotedOrigin(expectedPortalOrigin: string): string {
  return (originOf(expectedPortalOrigin) ?? expectedPortalOrigin).replace(/'/g, "'\\''");
}

const readNodePortal = (variable: string) =>
  `${variable}="$(grep -h '^CI_CLOUD_URL=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's:/*$::')"`;

/**
 * Before `cihub up`: an install that already names another Portal stops here, untouched.
 *
 * `up` is about to be handed the mint origin as CI_CLOUD_URL, and that may only ever seed a node that
 * has no Portal yet — an installed Hub pointing elsewhere belongs to that Portal's organization, and
 * moving it is not something a fleet run decides. The seed never rewrites a complete install, but a
 * partial one (an env file whose compose is gone) is seeded again from scratch, and the check before
 * the mint is skipped when its SSH probe comes back empty. So the script refuses on its own evidence,
 * before `up` has restarted anything.
 */
function portalOriginCheckBeforeUpLines(expectedPortalOrigin: string): string[] {
  const expected = shellQuotedOrigin(expectedPortalOrigin);
  return [
    ENV_FILE_LINE,
    readNodePortal('pre_portal'),
    `if [ -n "$pre_portal" ] && [ "$pre_portal" != '${expected}' ]; then echo "hub-up-failed: portal-mismatch: this Hub pairs against $pre_portal, the code was minted on ${expected}; cihub up was not run, so its Portal is unchanged" >&2; exit 1; fi`,
  ];
}

/**
 * After `cihub up`: the Portal the node actually ended up with, before `register` resets anything.
 *
 * A fresh node should now hold the mint origin, seeded from CI_CLOUD_URL. When it does not, the line
 * says which of the two known writers put something else there: a `cihub` older than seeding from
 * CI_CLOUD_URL (it writes production whatever it is given), or a desktop app, whose every Hub start
 * rewrites CI_CLOUD_URL to its own build's Portal.
 */
function portalOriginCheckAfterUpLines(expectedPortalOrigin: string): string[] {
  const expected = shellQuotedOrigin(expectedPortalOrigin);
  return [
    readNodePortal('hub_portal'),
    `if [ -n "$hub_portal" ] && [ "$hub_portal" != '${expected}' ]; then`,
    '  why=""',
    '  if [ -n "$desk" ]; then why="; a companion-hub desktop app is running here, and every Hub start it makes rewrites CI_CLOUD_URL to its own Portal"',
    '  elif [ -z "$pre_portal" ]; then why="; this node\'s cihub seeded that without honouring CI_CLOUD_URL, so it predates that fix: install a newer one"; fi',
    `  echo "hub-up-failed: portal-mismatch: this Hub pairs against $hub_portal, the code was minted on ${expected}$why" >&2; exit 1`,
    'fi',
  ];
}

/**
 * Bring the Hub stack up and register it with Portal.
 *
 * The password reaches the seed through the environment because `seedApplianceInstall` prompts
 * otherwise, and there is no terminal here to answer. `cihub register --code` is non-interactive;
 * without `--code` it drops into a readline loop that would hang until the SSH budget expires.
 *
 * `expectedPortalOrigin` is the Portal the code was minted on. A fresh node is seeded against it —
 * `cihub up` gets it as CI_CLOUD_URL, which the seed writes — and a node that already names another
 * Portal is refused before `up` and again after it (see the two check functions above).
 */
export function bringUpScript(postgresPassword: string, pairingCode: string, expectedPortalOrigin?: string): string {
  return [
    'set -e',
    // Single-quoted heredoc-free assignment; the password never reaches argv, only the environment.
    `export CIHUB_POSTGRES_PASSWORD='${postgresPassword.replace(/'/g, "'\\''")}'`,
    ...(expectedPortalOrigin ? portalOriginCheckBeforeUpLines(expectedPortalOrigin) : []),
    // The seed used to write production whatever Portal the code came from, so on 2026-09-28 a fleet
    // install minting on the dev Portal could bring up no fresh node at all: each one stopped with
    // portal-mismatch right after this line. Scoped to `up` rather than exported. On an appliance only
    // the seed reads it (the appliance compose deliberately does not interpolate CI_CLOUD_URL), and
    // the seed runs only when there is no complete install, so it cannot move an existing Hub.
    expectedPortalOrigin ? `CI_CLOUD_URL='${shellQuotedOrigin(expectedPortalOrigin)}' cihub up --detached` : 'cihub up --detached',
    ENV_FILE_LINE,
    // The image the node ended up pinning, on the node's line whichever way the step ends. Read after
    // `up`, so a desktop app that rewrote the file first shows here too. On 2026-09-26 core-6 and fzzy
    // failed with "nothing answered …/registration/phase" and nothing else: the ci-hub:0.2.70 and
    // ci-hub:0.2.61 they had been seeded with sat in the env file until someone went and read it.
    'img="$(grep -h \'^CI_HUB_IMAGE=\' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2-)"; [ -n "$img" ] || img=unset',
    // A running desktop app is the other writer of that file, and whatever `up` seeded, the next Hub
    // start it makes puts its own build back: core-6's 0.2.70 app did so eight seconds after the seed.
    'desktop_note="a companion-hub desktop app is running on this node, and every Hub start it makes rewrites CI_HUB_IMAGE to its own build"',
    'desk=""; if pgrep -x companion-hub >/dev/null 2>&1; then echo "hub-up-note: $desktop_note"; desk="; $desktop_note"; fi',
    // A code minted on one Portal is not in the other's database, so every `register` against the
    // wrong one answers 410 PAIRING_CODE_INVALID after first resetting the node's registration.
    // Checked again here, after `up` wrote the file and before `register` touches anything: a `cihub`
    // too old to seed from CI_CLOUD_URL, or a desktop app, can still have written another Portal.
    ...(expectedPortalOrigin ? portalOriginCheckAfterUpLines(expectedPortalOrigin) : []),
    // The port the Hub was actually given, not the one it usually gets: a heal that moved API_PORT
    // to 5003 once left the probe below silent while the step reported success.
    'port="$(grep -h \'^API_PORT=\' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2)"; [ -n "$port" ] || port=5002',
    // Before `register`, because Portal spends the code the moment it accepts it, whatever the Hub
    // does next. On 2026-09-26 core-6 and fzzy spent theirs on 0.2.70 and 0.2.61 Hubs that could
    // never report registered. `registration/phase` is the route that answers without a check-in, and
    // a Hub without it (404) predates what this install needs. `up -d` returns before the Hub listens,
    // so an unanswered probe is retried, 60 times 3 s apart; a 404 is an answer and ends the wait.
    'probe=000; tries=0',
    'while [ "$tries" -lt 60 ]; do',
    '  probe="$(curl -s -o /dev/null -w \'%{http_code}\' --max-time 5 "http://127.0.0.1:$port/api/registration/phase" || true)"',
    '  case "$probe" in 200|404) break ;; esac',
    '  tries=$((tries + 1)); sleep 3',
    'done',
    'if [ "$probe" = 404 ]; then echo "hub-up-failed: the Hub on :$port has no /api/registration/phase, so it is older than this install needs; the pairing code was not sent (CI_HUB_IMAGE=$img$desk)" >&2; exit 1; fi',
    '[ "$probe" = 200 ] || { echo "hub-up-failed: nothing answered http://127.0.0.1:$port/api/registration/phase in 60 tries after cihub up (last HTTP status $probe); the pairing code was not sent (CI_HUB_IMAGE=$img$desk)" >&2; exit 1; }',
    // `register` now exits non-zero on failure, but the state check is what actually proves it —
    // an exit code says what the command believed, not what the Hub is.
    `cihub register --code '${pairingCode.replace(/'/g, "'\\''")}'`,
    // An empty answer is a failure, and so is an answer that does not say registered.
    'phase="$(curl -fsS --max-time 10 "http://127.0.0.1:$port/api/registration/phase" || true)"',
    '[ -n "$phase" ] || { echo "hub-up-failed: nothing answered http://127.0.0.1:$port/api/registration/phase after cihub register (CI_HUB_IMAGE=$img$desk)" >&2; exit 1; }',
    'echo "$phase"',
    'echo "$phase" | grep -q \'"registered":true\' || { echo "hub-up-failed: the Hub is up but not registered: $phase" >&2; exit 1; }',
    '[ "$port" = 5002 ] || echo "hub-up-note: the Hub listens on :$port, not :5002 — tailscale serve and pool peers expect 5002"',
    'echo "hub-up-complete (CI_HUB_IMAGE=$img$desk)"',
  ].join('\n');
}

/**
 * Give the freshly registered Hub its first operator.
 *
 * `docs/fleet-setup.md` describes the one-node path as *"install, register, install models, then
 * pair"* — and that list is missing a step, which is why this fleet ended up with twelve registered
 * Hubs that could not authenticate anybody. `register` writes the device key; the operator row was
 * only ever written by a person signing in through Portal in a browser, which is precisely what a
 * fleet install does not have. `cihub claim` is that step, headless.
 *
 * Re-runnable: a Hub that already has an operator reports it and exits 0, so a replayed install
 * does not fail here.
 */
export function claimHubScript(email: string): string {
  return ['set -e', `cihub claim --email '${email.replace(/'/g, "'\\''")}'`, 'echo "hub-claim-complete"'].join('\n');
}

/**
 * Join this node into a pool by pairing with an existing Hub.
 *
 * The PIN is minted on the RECEIVING Hub and typed on the joining one — the opposite direction from
 * every other pool command, and the single easiest thing to get backwards here.
 *
 * `CI_HUB_ASSUME_YES=1` because `ssh -n` has no TTY and every pool mutation refuses one.
 */
export function joinPoolScript(peerFqdn: string, pin?: string): string {
  const pinArg = pin ? ` --pin '${pin.replace(/'/g, "'\\''")}'` : '';
  return [
    'set -e',
    'export CI_HUB_ASSUME_YES=1',
    `cihub pool pair '${peerFqdn.replace(/'/g, "'\\''")}'${pinArg} --yes`,
    'cihub pool status',
    'echo "pool-join-attempted"',
  ].join('\n');
}

/**
 * Update the Hub image on a node. Uses the pool-update path, which needs no build toolchain.
 *
 * `image`, when given, is an exact reference (`repo@sha256:…`) and reaches `cihub pool update` as
 * `CI_HUB_IMAGE`, which that command honours over its floating default. Without it every node pulls
 * whatever `:dev` points at the moment its turn comes — on a slow fleet pass that has been two
 * different builds, which is how a fleet ends up on four images with nobody having asked for any of
 * them. The pin holds for this run only; it is not written to the node's env file.
 */
export function updateHubScript(image?: string): string {
  return [
    'set -e',
    'export CI_HUB_ASSUME_YES=1',
    ...(image ? [`export CI_HUB_IMAGE='${image.replace(/'/g, "'\\''")}'`] : []),
    'cihub pool update',
    'echo "hub-update-complete"',
  ].join('\n');
}

/**
 * Pull a model on a node.
 *
 * Tries the Hub-managed container, then a host `ollama` binary, then the HTTP API. The first version
 * only knew about the container and failed on every node in this fleet, which runs Ollama as a host
 * systemd service — a perfectly supported shape the script simply did not consider. The final
 * fallback needs no CLI at all, so it works wherever something is listening.
 */
export function pullModelScript(model: string): string {
  const safe = model.replace(/'/g, "'\\''");
  return [
    'set -e',
    // Three ways a node can serve Ollama, tried in the order that keeps the pull closest to the Hub.
    // The container-only version of this failed on every node in this fleet, which runs Ollama as a
    // host systemd service — a shape the Hub supports and this script did not.
    'c="$(docker ps --filter label=com.docker.compose.project=ci-hub --filter name=ollama --format \'{{.Names}}\' 2>/dev/null | head -1)"',
    'if [ -n "$c" ]; then',
    `  docker exec "$c" ollama pull '${safe}'`,
    'else',
    // A live listener beats a CLI. Measured: a node serving happily on :11434 whose root `ollama`
    // CLI answered "could not connect to ollama server" — the daemon binds elsewhere and the CLI
    // defaults somewhere else. Asking the port that is actually answering avoids the whole question.
    // Discover where Ollama actually listens. Measured on this fleet: a node whose service binds to
    // its tailnet address (100.x.y.z:11434) rather than 0.0.0.0, so loopback answers nothing and both
    // the CLI and a 127.0.0.1 probe report "could not connect" on a machine that is serving fine.
    // OLLAMA_HOST first, then the listening socket, then loopback.
    "  host=\"$(systemctl show ollama -p Environment 2>/dev/null | tr ' ' '\\n' | sed -n 's/^OLLAMA_HOST=//p' | head -1)\"",
    '  [ -n "$host" ] || host="$(ss -ltn 2>/dev/null | awk \'/:11434 /{print $4; exit}\')"',
    '  [ -n "$host" ] || host="127.0.0.1:11434"',
    '  case "$host" in *:*) : ;; *) host="$host:11434" ;; esac',
    '  case "$host" in 0.0.0.0:*|\\[::\\]:*|*:*) host="$(echo "$host" | sed \'s/^0\\.0\\.0\\.0:/127.0.0.1:/; s/^\\[::\\]:/127.0.0.1:/\')" ;; esac',
    '  code="$(curl -s -o /dev/null -w \'%{http_code}\' --max-time 10 "http://$host/api/version" || true)"',
    '  if [ "$code" = "200" ]; then',
    `    curl -fsS --max-time 3600 -X POST "http://$host/api/pull" -d '{"model":"${safe}","stream":false}' >/dev/null`,
    '  elif command -v ollama >/dev/null 2>&1; then',
    `    ollama pull '${safe}'`,
    '  else',
    '    echo "no ollama on this node: no Hub-managed container, nothing answering on $host, and no ollama binary" >&2; exit 1',
    '  fi',
    'fi',
    'echo "model-pull-complete"',
  ].join('\n');
}

/**
 * What a failed step should say. The last line of stdout is usually compose noise ("Container
 * traefik Started") while the line that explains the failure — a Portal 403, a `cihub register`
 * refusal, a `hub-up-failed:` marker — sits a few lines up or on stderr. Prefer those.
 *
 * Never empty when `outcome` is given. `✗ install cihub (0s) —` with nothing after the dash is what a
 * script that exited 0 before its first `echo` produced on 2026-09-20; the exit code is always
 * something to say, and an exit 0 that never printed its marker is its own diagnosis.
 */
export function describeStepFailure(out: string, err: string, outcome?: { code: number | null; marker: string }): string {
  const lines = `${err}\n${out}`
    .split('\n')
    .map((line) => line.replace(/[│┌┐└┘─]+/g, ' ').trim())
    .filter(Boolean);
  // `too many` is Portal's rate limit, relayed by the Hub. Without it the node's line kept the box
  // title, "Pairing failed", and dropped the one line saying the fix was to wait 51 seconds.
  // `temporarily unavailable` is the same limiter failing closed, for the same reason.
  const telling = lines.filter((line) =>
    /hub-up-failed|hub-up-note|failed|refused|denied|error|not registered|already|cannot|unauthori|forbidden|timed out|too many|temporarily unavailable/i.test(
      line,
    ),
  );
  const chosen = telling.length > 0 ? telling.slice(-3) : lines.slice(-3);
  const quoted = chosen.join(' | ');
  if (!outcome) return quoted.slice(0, 300);
  const output = quoted || 'nothing on stdout or stderr';
  if (outcome.code === 0) return `exited 0 without printing ${outcome.marker}: ${output}`.slice(0, 300);
  if (quoted) return quoted.slice(0, 300);
  return outcome.code === null ? 'killed before it printed anything' : `exited ${outcome.code} with nothing on stdout or stderr`;
}

/**
 * A step, plus what the node actually said. `describeStepFailure` keeps three lines of the output at
 * most, and whether a pairing code was refused or spent is decided by lines it may well drop.
 */
async function stepWithOutput(
  name: string,
  target: SshTarget,
  script: string,
  marker: string,
  timeoutMs: number,
): Promise<{ step: InstallStep; out: string; err: string }> {
  const started = Date.now();
  const heredoc = `bash <<'CIHUB_STEP_EOF'\n${script}\nCIHUB_STEP_EOF`;
  const res = await sshCapture(target, heredoc, timeoutMs);
  const ms = Date.now() - started;
  const step: InstallStep =
    res.ok && res.out.includes(marker)
      ? { name, ok: true, detail: tail(res.out, 1), ms }
      : { name, ok: false, detail: describeStepFailure(res.out, res.err, { code: res.code, marker }), ms };
  return { step, out: res.out, err: res.err };
}

async function step(name: string, target: SshTarget, script: string, marker: string, timeoutMs: number): Promise<InstallStep> {
  return (await stepWithOutput(name, target, script, marker, timeoutMs)).step;
}

export interface InstallOptions {
  postgresPassword: string;
  /** A code already in hand (one node). Either this or `mintPairingCode`. */
  pairingCode?: string;
  /**
   * Mint (or reuse) this node's Portal pairing code — called only once the node has passed every
   * gate and has a `cihub`, immediately before `register`. Minting first was how a failed download
   * left an orphan device per attempt in Portal and made a retry impossible: the name was taken and
   * the code was never kept. Whatever this returns is what `register` sends.
   */
  mintPairingCode?: () => Promise<{ code: string; detail: string }>;
  /**
   * The Portal `mintPairingCode` mints on. Set, each node's own CI_CLOUD_URL is checked against it
   * before anything is minted, and again before and after `cihub up` — see `portalOriginMismatch`.
   * A node with no install yet is seeded against it: `cihub up` gets it as CI_CLOUD_URL.
   */
  portalOrigin?: string;
  /** Called once `register` has verifiably succeeded, so a kept code can be forgotten. */
  onRegistered?: () => void;
  /**
   * `register` failed over the code itself. Return a replacement to try once more, or throw to say
   * why there is none — either way the code just sent is gone, and the caller must stop keeping it.
   *
   * Called at most once per node, and only for a failure `classifyPairingFailure` recognises: a
   * `hub up` that died before `register` leaves the code unspent and never reaches here.
   */
  replacePairingCode?: (outcome: PairingCodeOutcome) => Promise<{ code: string; detail: string } | undefined>;
  /**
   * Spaces the run's pairings and holds them while Portal says to wait — one per run, shared by
   * every node, since Portal counts pairings per network address. Absent: no spacing, though a
   * refusal for rate is still waited out and the same code sent again.
   */
  pairingPacer?: PairingPacer;
  /**
   * Said as it happens rather than with the node's report, which prints once the node is done: a
   * minute's wait with nothing on screen reads as a hang.
   */
  onProgress?: (line: string) => void;
  /** Where the `cihub` binary comes from when the node needs one. Absent: adopt or fail. */
  cihubBinary?: CihubBinarySource;
  /** Per-run cache of downloaded assets, keyed by asset name, shared across nodes. */
  binaryCache?: Map<string, { path: string; sha256: string; label: string }>;
  /**
   * CI Account address to claim each Hub for, creating its first operator.
   *
   * Optional, and skipped rather than assumed when absent: a claim writes the one row that decides
   * who this appliance belongs to, and guessing an address for fourteen machines is not a default
   * anything should hold.
   */
  claimEmail?: string;
  version?: string;
  joinPool?: string;
  poolPin?: string;
  /** Refuse to touch a node above this load-per-core. */
  loadRatio?: number;
  /**
   * Go ahead on a node whose preflight said `block`. The finding is still printed on the node's
   * line, prefixed so the log shows the override was chosen rather than missed.
   */
  force?: boolean;
  /**
   * The operation will touch the kernel, initramfs or GRUB. A Hub install does not, so the default
   * is false; a caller that will (a driver or kernel install) passes true and the boot-recovery and
   * grub-customizer findings become blocking rather than advisory.
   */
  touchesBoot?: boolean;
}

export type ResolvedBinary = { path: string; sha256: string; label: string; version?: string } | { why: string; fix: string[] };

/**
 * The file to stream to this node, for its architecture. Downloads happen at most once per asset
 * per run; a `--cihub-binary` is used for every node, whatever its architecture, because the
 * operator named it.
 */
async function resolveBinaryForNode(opts: InstallOptions, arch: string): Promise<ResolvedBinary | undefined> {
  const source = opts.cihubBinary;
  if (!source) return undefined;
  if (source.kind === 'unavailable') return { why: source.why, fix: source.fix };
  if (source.kind === 'local') {
    return { path: source.path, sha256: sha256File(source.path), label: source.version ?? 'local', version: source.version };
  }
  const assetName = assetNameForArch(arch);
  if (!assetName) return { why: `unsupported architecture: ${arch}`, fix: ['cihub ships for linux x86_64 and aarch64 only.'] };
  const cache = opts.binaryCache ?? new Map();
  const cached = cache.get(assetName);
  if (cached) return { ...cached, version: cached.label };
  try {
    const asset = await downloadReleaseAsset({ token: source.token, assetName, version: source.version });
    const entry = { path: asset.path, sha256: asset.sha256, label: asset.tag };
    cache.set(assetName, entry);
    return { ...entry, version: asset.tag };
  } catch (error) {
    return {
      why: error instanceof Error ? error.message : String(error),
      fix: ['Check GH_TOKEN can read the private repository, or pass --cihub-binary.'],
    };
  }
}

/**
 * The version this run can put on a node, or why it cannot name one.
 *
 * The version a download came back with is the release's own answer; a download that failed still
 * has the tag the source was pinned to, so a node whose copy is older than that tag is not adopted
 * but reported as needing the download that failed. `latest` is not a version — it means the source
 * was never pinned — and a `--cihub-binary` that would not run here has no version to offer.
 */
export function offeredCihubVersion(source: CihubBinarySource | undefined, binary: ResolvedBinary | undefined): { version?: string; why: string } {
  if (!source) return { why: 'no cihub binary source was given' };
  if (source.kind === 'unavailable') return { why: source.why };
  if (binary && !('why' in binary) && binary.version) return { version: binary.version, why: '' };
  if (source.kind === 'local') return { why: `${source.path} would not run here, so its version could not be read` };
  if (source.version !== 'latest') return { version: source.version, why: '' };
  return { why: binary && 'why' in binary ? binary.why : "release 'latest' was not resolved to a tag" };
}

/** A refusal whose `Retry-After` is longer than any limit of Portal's own would ask for. */
function tooLongToWait(limit: PortalRateLimit): string {
  return `Portal asked for ${limit.retryAfterSeconds}s, more than the ${describeWait(MAX_RATE_LIMIT_WAIT_MS - RATE_LIMIT_MARGIN_MS)} window its own limits run on, so the run does not wait on it`;
}

/**
 * Install a Hub on one node, end to end.
 *
 * Returns a report rather than throwing: a fourteen-node run must visit all fourteen and describe
 * every one, including the ones it deliberately declined to touch.
 */
export async function installNode(
  node: { name: string; ip: string; user?: string; oob?: string },
  opts: InstallOptions,
  sshUser?: string,
): Promise<NodeInstallReport> {
  const target: SshTarget = { host: node.ip, user: node.user ?? sshUser };
  const steps: InstallStep[] = [];

  const { facts, error } = await readHostFacts(target);
  if (!facts) {
    return { node: node.name, ok: false, steps: [{ name: 'probe', ok: false, detail: String(error).slice(0, 200) }] };
  }
  steps.push({ name: 'probe', ok: true, detail: `${facts.os}/${facts.arch}, ${facts.cpuCount ?? '?'} cores, load ${facts.load1 ?? '?'}` });

  const busy = isTooBusyForMaintenance(facts, opts.loadRatio);
  if (busy.busy) {
    steps.push({ name: 'load gate', ok: false, skipped: true, detail: busy.why ?? 'node is busy' });
    return { node: node.name, ok: false, steps };
  }

  if (facts.os !== 'linux') {
    steps.push({ name: 'platform', ok: false, skipped: true, detail: `headless install is Linux-only; this node is ${facts.os}` });
    return { node: node.name, ok: false, steps };
  }
  if (!facts.docker.usable) {
    steps.push({ name: 'docker', ok: false, detail: facts.docker.present ? 'docker present but `docker info` failed' : 'no docker engine' });
    return { node: node.name, ok: false, steps };
  }

  // The checks nothing ran before: sudo, a wedged dpkg, grub-customizer's proxies, a boot with no
  // way back, a held package lock. One round trip, decided in `fleet-preflight.ts`; `block` ends the
  // node here rather than six steps in, unless `force` was chosen.
  const preflightStarted = Date.now();
  const preflight = await preflightNode(target, node, { touchesBoot: opts.touchesBoot });
  const gate = gatePreflight(preflight, { force: opts.force });
  steps.push({ name: 'preflight', ok: gate.proceed, skipped: !gate.proceed, detail: gate.detail, ms: Date.now() - preflightStarted });
  if (!gate.proceed) return { node: node.name, ok: false, steps };

  const binary = await resolveBinaryForNode(opts, facts.arch);
  const existing = await detectCihub(target);
  const offered = offeredCihubVersion(opts.cihubBinary, binary);
  const adopt = shouldAdoptExistingCihub(existing, offered.version);
  if (adopt.adopt) {
    // Adopted without a compare is still adopted — there is nothing to replace it with — but the
    // line says so, and why, rather than reading like a version check that passed.
    const uncompared = adopt.compared ? '' : ` — version not compared: ${offered.why}`;
    steps.push({ name: 'cihub', ok: true, skipped: true, detail: `${adopt.why} at ${existing.path}${uncompared}` });
  } else if (!binary || 'why' in binary) {
    const source = opts.cihubBinary;
    const fix = binary ? binary.fix : source?.kind === 'unavailable' ? source.fix : [];
    steps.push({
      name: 'install cihub',
      ok: false,
      detail: `${binary ? binary.why : `${adopt.why}; ${offered.why}`}${fix.length ? ` — ${fix.join(' ')}` : ''}`,
    });
    return { node: node.name, ok: false, steps };
  } else {
    const started = Date.now();
    const marker = 'cihub-installed';
    // Not `step()`: its heredoc would be the script's stdin, and this script's stdin is the binary.
    const res = await sshStreamFile(target, stdinScriptCommand(installCihubFromStdinScript(binary.sha256, binary.label)), binary.path, 10 * 60_000);
    const ms = Date.now() - started;
    const s: InstallStep =
      res.ok && res.out.includes(marker)
        ? { name: 'install cihub', ok: true, detail: `${existing.present ? `${adopt.why}; ` : ''}${tail(res.out, 2)}`, ms }
        : { name: 'install cihub', ok: false, detail: describeStepFailure(res.out, res.err, { code: res.code, marker }), ms };
    steps.push(s);
    if (!s.ok) return { node: node.name, ok: false, steps };
  }

  // The Portal device, last of all the things that can be checked without one. A code is one
  // device's credential and Portal refuses a second device by the same name, so nothing above may
  // burn it, and nothing above did.
  let pairingCode = opts.pairingCode;
  if (opts.mintPairingCode && opts.portalOrigin) {
    // Before the mint, so a node that could never redeem the code does not leave a device in Portal.
    // A node with no env file yet (never brought up, or wiped) answers empty, and that is not a
    // mismatch but a fresh install: `bringUpScript` hands `cihub up` this origin as CI_CLOUD_URL, so
    // the seed writes the Portal the code is minted on. `bringUpScript` checks again before and
    // after `up`, for whatever this probe could not see.
    const url = await sshCapture(target, nodePortalUrlScript(), 20_000);
    const nodeUrl = url.out.match(/^ci-cloud-url=(.*)$/m)?.[1]?.trim();
    const mismatch = portalOriginMismatch(nodeUrl, opts.portalOrigin);
    if (mismatch) {
      steps.push({ name: 'portal origin', ok: false, detail: mismatch });
      return { node: node.name, ok: false, steps };
    }
  }
  const pacer = opts.pairingPacer ?? new PairingPacer(0);
  if (opts.mintPairingCode) {
    // A mint Portal refused for rate created no device and took no name, so asking again is safe —
    // the one mint failure that is. Everything else still ends the node here, as it always has.
    for (let retry = 0; ; retry++) {
      try {
        const minted = await opts.mintPairingCode();
        pairingCode = minted.code;
        steps.push({ name: 'portal device', ok: true, detail: minted.detail });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const limit = portalRateLimitOf(error);
        const waitMs = limit ? rateLimitWaitMs(limit) : undefined;
        if (!limit || waitMs === undefined || retry >= MAX_RATE_LIMIT_RETRIES) {
          const { windowMs, max } = PORTAL_DEVICE_CREATE_RATE_LIMIT;
          const gaveUp = limit
            ? ` — ${waitMs === undefined ? tooLongToWait(limit) : `still refused after ${retry} wait(s)`}. Portal allows ${max} new devices per ${windowMs / 60_000} minutes from one address and created none here, so rerun this node later`
            : '';
          // The next node mints from the same address, so this counts towards the run stopping.
          if (limit) pacer.gaveUp(node.name);
          steps.push({ name: 'portal device', ok: false, detail: `${message}${gaveUp}` });
          return { node: node.name, ok: false, steps };
        }
        const why = `Portal refused the mint for rate ("${limit.said}") and created no device, so it is sent again (retry ${retry + 1} of ${MAX_RATE_LIMIT_RETRIES})`;
        opts.onProgress?.(`waiting ${describeWait(waitMs)} before minting again — ${why}`);
        await pacer.pause(waitMs);
        steps.push({ name: 'portal rate limit', ok: true, skipped: true, ms: waitMs, detail: `waited ${describeWait(waitMs)}: ${why}` });
      }
    }
  }
  if (!pairingCode) {
    steps.push({ name: 'portal device', ok: false, detail: 'no pairing code and no way to mint one' });
    return { node: node.name, ok: false, steps };
  }

  /**
   * `hub up + register` with one code: waits its turn on the pacer, runs, and — when Portal refused
   * the pair for rate — waits what Portal asked and sends the SAME code again. The limiter answers
   * before Portal's handler, so the code was never looked at; a replacement would solve a problem
   * the code does not have, and `classifyPairingFailure` never sees this answer as one about it.
   *
   * The refused attempt is reported as the wait it caused, not as a failed step: a node whose retry
   * registered is an installed node, and a `✗` on its first attempt would count it failed.
   *
   * Portal's limiter failing closed — `Service temporarily unavailable`, its D1 counter unreachable —
   * is the same answer from the same place with a five-second wait, and goes round the same loop.
   */
  const redeem = async (name: string, code: string) => {
    let waitingFor: string | undefined;
    for (let retry = 0; ; retry++) {
      const why = waitingFor ?? describePairingPace(pacer.gapMs);
      const waitedMs = await pacer.waitTurn((ms) => opts.onProgress?.(`waiting ${describeWait(ms)} before pairing — ${why}`));
      if (waitedMs > 0) {
        steps.push({
          name: waitingFor ? 'pairing rate limit' : 'pairing pace',
          ok: true,
          skipped: true,
          ms: waitedMs,
          detail: `waited ${describeWait(waitedMs)}: ${why}`,
        });
      }
      // The turn is this node's until Portal's answer is known; whatever happens, it is handed on,
      // or every node after this one would wait on it for ever.
      let limit: PortalRateLimit | undefined;
      let waitMs: number | undefined;
      let up: Awaited<ReturnType<typeof stepWithOutput>> | undefined;
      try {
        // 20 minutes: this pulls the Hub image and every infra container on a cold machine.
        up = await stepWithOutput(
          name,
          target,
          bringUpScript(opts.postgresPassword, code, opts.mintPairingCode ? opts.portalOrigin : undefined),
          'hub-up-complete',
          20 * 60_000,
        );
        limit = up.step.ok ? undefined : detectPairingRateLimit(`${up.err}\n${up.out}`);
        waitMs = limit ? rateLimitWaitMs(limit) : undefined;
      } finally {
        // Held even when this node gives up: the next node shares the address, and Portal's answer is for it too.
        if (limit) pacer.notCounted(waitMs);
        else pacer.redeemed({ registered: up?.step.ok === true });
      }
      if (!limit) return up;
      const refusal = limit.limiterUnavailable
        ? `Portal's rate limiter could not reach its counter and refused the pairing before it looked at the code ("${limit.said}")`
        : `Portal refused the pairing for rate before it looked at the code ("${limit.said}")`;
      if (waitMs === undefined || retry >= MAX_RATE_LIMIT_RETRIES) {
        pacer.gaveUp(node.name);
        const stillRefused = limit.limiterUnavailable
          ? `Portal's rate limiter was still unavailable after ${retry} wait(s)`
          : `still refused for rate after ${retry} wait(s)`;
        const why = waitMs === undefined ? tooLongToWait(limit) : stillRefused;
        up.step.detail = `${up.step.detail} — ${why}. Portal refused before it looked at the code, so the code is still good: rerun this node (--nodes ${node.name}) once nothing else on this network is pairing`;
        return up;
      }
      waitingFor = `${refusal}, so the same code goes again (retry ${retry + 1} of ${MAX_RATE_LIMIT_RETRIES})`;
    }
  };

  let up = await redeem('hub up + register', pairingCode);

  // A code Portal has refused is dead for good, and a run that keeps handing the same one back can
  // never finish: on 2026-09-22 fifteen nodes failed on one 410 apiece, three runs in a row, because
  // nothing read the refusal (CI-Hub#1582). One replacement, asked for only when the failure was
  // about the code — a caller that cannot get one throws, and its reason becomes this node's line.
  if (!up.step.ok && opts.replacePairingCode) {
    const outcome = classifyPairingFailure(`${up.err}\n${up.out}\n${up.step.detail}`);
    if (outcome) {
      steps.push(up.step);
      let replacement: { code: string; detail: string } | undefined;
      let refused = '';
      try {
        replacement = await opts.replacePairingCode(outcome);
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      if (!replacement) {
        steps.push({ name: 'replacement code', ok: false, detail: refused || `${outcome.why}, and no replacement was available` });
        return { node: node.name, ok: false, steps };
      }
      steps.push({ name: 'replacement code', ok: true, detail: `${outcome.why}; ${replacement.detail}` });
      // The image and every infra container are on the node by now, so this is the register alone —
      // paced like any other, since Portal counted the refusal that led here.
      up = await redeem('hub up + register (retry)', replacement.code);
    }
  }

  steps.push(up.step);
  if (!up.step.ok) return { node: node.name, ok: false, steps };
  opts.onRegistered?.();

  // Registered is not claimed. Without this the node comes up paired, keyed, and answering 409
  // AUTH_ERROR_HUB_NOT_CLAIMED to its own operator API — the state twelve of this fleet's nodes
  // were in, misread as bad device keys for a week.
  if (opts.claimEmail) {
    steps.push(await step('claim hub', target, claimHubScript(opts.claimEmail), 'hub-claim-complete', 2 * 60_000));
  } else {
    steps.push({
      name: 'claim hub',
      ok: true,
      skipped: true,
      detail: 'no --claim-email given; this Hub has no operator until one is created',
    });
  }

  // The audit file. Best-effort by design: a node that ends up without a timer is
  // still an installed Hub, and the step says which of the three ways it fell short
  // rather than reporting a bare failure.
  // sshCapture rather than step(): the outcome is decided by markers that can appear
  // on any line, and step() reports only the last one.
  const timerStarted = Date.now();
  const timerRun = await sshCapture(target, `bash <<'CIHUB_STEP_EOF'\n${installStatusTimerScript()}\nCIHUB_STEP_EOF`, 2 * 60_000);
  const timerOutcome = classifyStatusTimerOutput(timerRun.out, timerRun.ok);
  steps.push({
    name: 'status timer',
    ok: timerOutcome !== 'failed',
    skipped: timerOutcome === 'no-user-session',
    detail: describeStatusTimerOutcome(timerOutcome),
    ms: Date.now() - timerStarted,
  });

  // Per-process GPU VRAM for the Hub container, which cannot run the vendor tool itself. Best-effort
  // like the status timer, and skipped outright on a node with neither tool — that is an Apple or
  // CPU-only node, not a failure. `cihub fleet update --gpu-probe` re-runs this same step alone.
  steps.push(await gpuProbeTimerStep(target));

  // TLS for pooling. A peer is stored under its tailnet FQDN and reached at https://<fqdn>, so a
  // `tailscale cert` on this node is a prerequisite for every pool call — and nothing provisioned one
  // until now. Measured 2026-09-10: 14 of 18 nodes had a certificate because someone ran it by hand;
  // 4 did not. Best-effort like the timer: a node whose tailnet has HTTPS off is still an installed
  // Hub, and the step says why it cannot pool yet rather than failing the install.
  steps.push(await tailscaleCertStep(target));

  if (opts.joinPool) {
    const join = await step('join pool', target, joinPoolScript(opts.joinPool, opts.poolPin), 'pool-join-attempted', 3 * 60_000);
    // A pair lands PENDING and needs approval on the receiving Hub — reported, not treated as done.
    join.detail = `${join.detail} — the receiving Hub must approve: cihub pool peers && cihub pool approve <id> --yes`;
    steps.push(join);
  }

  return { node: node.name, ok: steps.every((s) => s.ok || s.skipped), steps };
}

/**
 * Install the GPU probe timer on one node and say what it got. Shared by `fleet install` and
 * `fleet update --gpu-probe`, so the two cannot drift on what "installed" means.
 *
 * sshCapture rather than step(): the outcome is decided by markers that can appear on any line,
 * and step() reports only the last one.
 */
export async function gpuProbeTimerStep(target: SshTarget): Promise<InstallStep> {
  const started = Date.now();
  const run = await sshCapture(target, `bash <<'CIHUB_STEP_EOF'\n${installGpuProbeTimerScript()}\nCIHUB_STEP_EOF`, 2 * 60_000);
  const outcome = classifyGpuProbeOutput(run.out, run.ok);
  return {
    name: 'gpu probe timer',
    ok: outcome !== 'failed',
    skipped: outcome === 'no-tool' || outcome === 'no-user-session',
    detail: outcome === 'failed' ? `${describeGpuProbeOutcome(outcome)}: ${tail(run.err || run.out, 2)}` : describeGpuProbeOutcome(outcome),
    ms: Date.now() - started,
  };
}
