/**
 * The `cihub pool` command surface: Hub Pool peering and routing over the private VPN.
 *
 * Argument parsing and rendering live here; the HTTP calls stay in `hub-pool-cli.ts` so the
 * two can be tested apart from each other.
 */
import { existsSync } from 'node:fs';
import { parseEnvFile, upsertEnvVar } from '../env-file.js';
import { discoverComposeIdentity } from './compose-discovery.js';
import {
  approvePoolPeer,
  cancelPairingPin,
  deletePoolPin,
  fetchPoolPeers,
  fetchPoolRoutingLog,
  fetchInferencePreferences,
  fetchPoolStatus,
  formatContextCapResultLines,
  formatOllamaSlotsResultLines,
  formatPoolPeersLines,
  formatPoolProbeLines,
  formatPairingPinCancelledLines,
  formatPairingPinLines,
  formatPoolRoutingLogLines,
  formatPoolStatusLines,
  formatPromptCeilingResultLines,
  mintPairingPin,
  pairPoolPeer,
  probePoolAddress,
  rejectPoolPeer,
  resolvePoolPeerTarget,
  runPoolDiscover,
  setInferenceContextCap,
  setInferenceOllamaSlots,
  setPoolEnabledSetting,
  setPoolMaxPromptTokens,
  setPoolPeerEnabled,
  setPoolPin,
  unpairPoolPeer,
  type InferencePreferencesResponse,
  type PoolEnableAxis,
} from '../hub-pool-cli.js';
import { readRunningImageIdentity, runPoolDoctorSection } from '../pool-diagnostics-cli.js';
import { cliUpdateInstructions, gatherSkew } from './cli-version-skew.js';
import { decideImagePinWrite, HUB_IMAGE_VAR, readDeclaredHubImage, resolveComposeEnvFile, shortImageRef } from './cli-image-pin.js';
import { readHubApiKeySource, resolveHubApiBase } from '../public-web-cli.js';
import { resolveEnvFromArgs, usageAndExit } from './cli-args.js';
import { confirmDestructiveAction } from './cli-prompt.js';
import { run, runCapture } from './cli-proc.js';
import {
  buildPoolUpdateComposeArgs,
  composeFilesForPoolUpdate,
  decideGitUpdate,
  describeImageChange,
  describeImageSource,
  gatherGitUpdateFacts,
  resolvePoolUpdateImage,
} from './cli-pool-update.js';
import { BASE_COMMAND, type HubEnv } from './cli-types.js';
import { cliFail, cliOk, cliWarn, colorize, dim, printMessageBox, sanitizeForBox, STEP_ICONS } from './cli-ui.js';
import { type HubContext, resolveHubContext } from './hub-context.js';

export const POOL_SUBCOMMANDS = [
  'status',
  'doctor',
  'update',
  'peers',
  'discover',
  'probe',
  'pair',
  'approve',
  'reject',
  'unpair',
  'log',
  'enable',
  'disable',
  'peer-enable',
  'peer-disable',
  'pin',
  'unpin',
  'ceiling',
  'context-cap',
  'slots',
  // Four places in this repo and two in docs/CLI.md already tell the operator to run
  // `cihub pool pairing-pin`; until now it was not a subcommand and exited as an unknown one.
  'pairing-pin',
  'cancel-pin',
] as const;
export type PoolSubcommand = (typeof POOL_SUBCOMMANDS)[number];

/** Subcommands taking a peer reference before the optional [env], so the env parser never sees it. */
const POOL_TARGET_SUBCOMMANDS: readonly PoolSubcommand[] = [
  'probe',
  'pair',
  'approve',
  'reject',
  'unpair',
  'peer-enable',
  'peer-disable',
  'pin',
  // The token count (or `clear`) sits where a peer reference would, so `ceiling 16000 dev` reads the env.
  'ceiling',
  'context-cap',
  'slots',
];

const POOL_USAGE = `Usage: ${BASE_COMMAND} pool <${POOL_SUBCOMMANDS.join('|')}> [env]`;

/** How long `pool doctor` runs before it starts narrating. Below this, the box arrives on its own. */
const POOL_DOCTOR_PROGRESS_AFTER_MS = 3_000;

export interface ParsedPoolArgs {
  subcommand: PoolSubcommand;
  target?: string;
  displayName?: string;
  /** `pair` only: the six digits minted on the OTHER Hub, and the only way to pair by address. */
  pin?: string;
  limit?: number;
  /** Which switch `enable`/`disable` writes. `both` (the default) is the master switch, i.e. today's behaviour. */
  axis: PoolEnableAxis;
  /** `pin`/`unpin` only: which model the pin covers. Absent means the pool-wide default pin. */
  model?: string;
  /** `doctor` only: also measure non-streaming first-byte latency, which spends GPU time. */
  checkLatency: boolean;
  yes: boolean;
  env: HubEnv;
}

/**
 * Flags are stripped before `resolveEnvFromArgs`, which exits on any token it does not recognise as
 * an environment.
 */
export function parsePoolArgs(args: string[]): ParsedPoolArgs {
  let yes = false;
  let displayName: string | undefined;
  let pin: string | undefined;
  let limit: number | undefined;
  let axis: PoolEnableAxis = 'both';
  let model: string | undefined;
  let checkLatency = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--check-latency') {
      checkLatency = true;
      continue;
    }
    if (arg === '--outbound' || arg === '--inbound') {
      const next: PoolEnableAxis = arg === '--outbound' ? 'outbound' : 'inbound';
      // Naming both would have to mean "the master", which is what passing neither already means —
      // so rather than pick one silently, say so.
      if (axis !== 'both' && axis !== next) {
        usageAndExit('Pass at most one of --outbound / --inbound. Omit both to change the master switch.');
      }
      axis = next;
      continue;
    }
    if (arg === '--name' || arg === '--limit' || arg === '--pin' || arg === '--model') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) usageAndExit(`Missing value for ${arg}. ${POOL_USAGE}`);
      if (arg === '--name') displayName = next;
      else if (arg === '--pin') pin = parsePairingPin(next);
      else if (arg === '--model') model = parsePinnedModel(next);
      else limit = parsePoolLimit(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      model = parsePinnedModel(arg.slice('--model='.length));
      continue;
    }
    if (arg.startsWith('--pin=')) {
      pin = parsePairingPin(arg.slice('--pin='.length));
      continue;
    }
    if (arg.startsWith('--name=')) {
      displayName = arg.slice('--name='.length);
      continue;
    }
    if (arg.startsWith('--limit=')) {
      limit = parsePoolLimit(arg.slice('--limit='.length));
      continue;
    }
    if (arg.startsWith('--')) usageAndExit(`Unknown flag: ${arg}. ${POOL_USAGE}`);
    positional.push(arg);
  }

  const subcommand = (positional[0] || 'status') as PoolSubcommand;
  if (!POOL_SUBCOMMANDS.includes(subcommand)) {
    usageAndExit(`Unknown pool subcommand: ${subcommand}. ${POOL_USAGE}`);
  }

  if (axis !== 'both' && subcommand !== 'enable' && subcommand !== 'disable') {
    usageAndExit(`--${axis} only applies to \`${BASE_COMMAND} pool enable\` and \`${BASE_COMMAND} pool disable\`.`);
  }

  if (pin !== undefined && subcommand !== 'pair') {
    usageAndExit(`--pin only applies to \`${BASE_COMMAND} pool pair\`.`);
  }

  if (model !== undefined && subcommand !== 'pin' && subcommand !== 'unpin') {
    usageAndExit(`--model only applies to \`${BASE_COMMAND} pool pin\` and \`${BASE_COMMAND} pool unpin\`.`);
  }

  if (checkLatency && subcommand !== 'doctor') {
    usageAndExit(`--check-latency only applies to \`${BASE_COMMAND} pool doctor\`.`);
  }

  const takesTarget = POOL_TARGET_SUBCOMMANDS.includes(subcommand);
  const target = takesTarget ? positional[1] : undefined;
  return {
    subcommand,
    target,
    displayName,
    pin,
    limit,
    axis,
    model,
    checkLatency,
    yes,
    env: resolveEnvFromArgs(positional.slice(takesTarget ? 2 : 1)),
  };
}

/**
 * Bounded, never normalized: a model id is compared verbatim and case-sensitively against the
 * engine's inventory on the Hub, so lower-casing a pin here would produce one that looks right and
 * silently never matches. Matches `MAX_PINNED_MODEL_LENGTH` on the backend.
 */
function parsePinnedModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) {
    usageAndExit('--model takes a model id as the engine reports it, e.g. llama3.2:3b (1-200 characters).');
  }
  return trimmed;
}

/** Matches `MIN_POOL_MAX_PROMPT_TOKENS` / `MAX_POOL_MAX_PROMPT_TOKENS` on the backend, so a bad value fails here rather than as a 400. */
const MIN_PROMPT_CEILING = 1024;
const MAX_PROMPT_CEILING = 1_048_576;

/**
 * `clear` → `null`; a plain integer within the backend's bounds → that number; anything else →
 * `undefined`, which the caller turns into a usage error.
 *
 * Digits only, deliberately: `16k` reads naturally but means 16000 to one operator and 16384 to the
 * next, and a ceiling is exactly the number an operator will later compare against a routing-log
 * estimate. The floor catches the other likely typo, a dropped `000`.
 */
export function parsePromptCeilingArg(raw: string | undefined): number | null | undefined {
  const value = raw?.trim() ?? '';
  if (value.toLowerCase() === 'clear') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const tokens = Number(value);
  return tokens >= MIN_PROMPT_CEILING && tokens <= MAX_PROMPT_CEILING ? tokens : undefined;
}

/** Matches `MIN_INFERENCE_MAX_NUM_CTX` / `MAX_INFERENCE_MAX_NUM_CTX` on the backend (`inference-context-cap.ts`). */
const MIN_CONTEXT_CAP = 2048;
const MAX_CONTEXT_CAP = 1_048_576;

/**
 * `clear` → `null`; a plain integer within the backend's bounds → that number; anything else →
 * `undefined`, which the caller turns into a usage error. Digits only, for the reason the ceiling
 * gives: `16k` is 16000 to one operator and 16384 to the next, and this number is compared against
 * `OLLAMA_CONTEXT_LENGTH`, which is exact. The floor is the Hub's: below 2048 no agent turn fits.
 */
export function parseContextCapArg(raw: string | undefined): number | null | undefined {
  const value = raw?.trim() ?? '';
  if (value.toLowerCase() === 'clear') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const tokens = Number(value);
  return tokens >= MIN_CONTEXT_CAP && tokens <= MAX_CONTEXT_CAP ? tokens : undefined;
}

/** Matches `MIN_INFERENCE_OLLAMA_SLOTS` / `MAX_INFERENCE_OLLAMA_SLOTS` on the backend (`inference-ollama-slots.ts`), and `--ollama-parallel`'s bounds. */
const MIN_OLLAMA_SLOTS = 1;
const MAX_OLLAMA_SLOTS = 64;

/**
 * `clear` → `null`; a plain integer within the backend's bounds → that number; anything else →
 * `undefined`, which the caller turns into a usage error. The same shape as the cap's parser: this
 * number is compared against `OLLAMA_NUM_PARALLEL`, which is exact.
 */
export function parseOllamaSlotsArg(raw: string | undefined): number | null | undefined {
  const value = raw?.trim() ?? '';
  if (value.toLowerCase() === 'clear') return null;
  if (!/^\d+$/.test(value)) return undefined;
  const slots = Number(value);
  return slots >= MIN_OLLAMA_SLOTS && slots <= MAX_OLLAMA_SLOTS ? slots : undefined;
}

/** Exactly six digits, checked here so a typo is a usage error rather than a 400 from the Hub. */
function parsePairingPin(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    usageAndExit('A pairing PIN is exactly six digits, as shown by `cihub pool pairing-pin` on the other Hub.');
  }
  return trimmed;
}

/** Matches the backend's `RoutingLogQueryDto` bounds so a bad value fails here rather than as a 400. */
function parsePoolLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    usageAndExit(`--limit must be an integer between 1 and 200 (got "${raw}")`);
  }
  return value;
}

/**
 * Local sanity check mirroring the shape `normalizePeerFqdn` accepts on the backend — a scheme,
 * port, path or IP literal is rejected here so the operator gets an explanation instead of a 400.
 * The backend stays authoritative.
 */
export function isPlausiblePeerFqdn(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/i.test(value.trim().replace(/\.$/, ''));
}

/** Peer rows for a confirmation prompt: identify by FQDN, never by the uuid the operator typed a prefix of. */
function describePoolPeer(peer: { nodeFqdn: string; direction: string; status: string }): string {
  return `${sanitizeForBox(peer.nodeFqdn)} (${peer.direction}, ${peer.status})`;
}

function poolErrorExit(error: unknown, envFileName: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  /*
   * `HubUnreachableError` first, by NAME rather than by message text. The string
   * checks below were written against Node's `fetch failed` / `ECONNREFUSED`
   * wording, and this CLI ships as a bun-compiled binary whose message is
   * "Unable to connect. Is the computer able to access the url?" with
   * `code: ConnectionRefused` — matching neither. The result on a fleet node with
   * no Hub running was a raw TypeError and bundled source printed at the
   * operator. Catching at the fetch and keying on the type is runtime-agnostic;
   * the string checks stay for errors raised elsewhere.
   */
  if (
    name === 'HubUnreachableError' ||
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('Unable to connect')
  ) {
    printMessageBox('Hub unavailable', [`Could not reach Hub at ${resolveHubApiBase(envFileName)}.`, 'Start the Hub first: cihub up'], 'red');
    process.exit(1);
  }
  if (name === 'TimeoutError' || message.includes('timed out') || message.includes('operation was aborted')) {
    printMessageBox(
      'Hub Pool request timed out',
      [
        `No answer from ${resolveHubApiBase(envFileName)} in time.`,
        'Pairing contacts the peer over the tailnet, so an offline peer looks like this.',
      ],
      'red',
    );
    process.exit(1);
  }
  /*
   * Checked by translation key, not by status code, and BEFORE the generic 401/403 branch below.
   * A build with the `cihub claim` fix answers this 409 CONFLICT (see auth.guard.ts); a build that
   * predates it still answers a plain 401 — the same misdiagnosis the 409 change exists to end,
   * reachable again through the one error path that never learned about `claim`. The device key is
   * fine either way: this Hub is registered but has no operator, and re-pairing does not fix that.
   */
  if (message.includes('AUTH_ERROR_HUB_NOT_CLAIMED')) {
    printMessageBox(
      'Hub not claimed',
      ['This Hub is registered and its device key is valid, but has no operator yet.', `Create one: ${BASE_COMMAND} claim --email <addr>`],
      'red',
    );
    process.exit(1);
  }
  if (message.includes('failed (401)') || message.includes('failed (403)')) {
    printMessageBox('Not authorized', ['The Hub rejected this device key.', 'Re-pair this Hub with Companion Portal: cihub register'], 'red');
    process.exit(1);
  }
  if (message.startsWith('Hub API ')) {
    printMessageBox('Hub Pool request failed', [sanitizeForBox(message)], 'red');
    process.exit(1);
  }
  throw error;
}

export async function runPoolCommand(args: string[]) {
  const parsed = parsePoolArgs(args);
  // resolveHubContext (not getEnvFileOrExit) so a packaged install outside a checkout resolves the
  // canonical data dir instead of silently reading nothing and falling back to port 5002.
  const ctx = resolveHubContext(parsed.env);
  const { env, envFile } = ctx;

  // Deliberately BEFORE the device-key gate below. `doctor` is the command an operator reaches for
  // on a node that is not set up yet — a node with no key is one of the states it has to report on,
  // not a reason to refuse to run.
  if (parsed.subcommand === 'doctor') {
    // B4 compares the routes the Hub serves against the commands THIS build has, so the list has to
    // come from here — the doctor module cannot import it back without closing an import cycle.
    const section = await runPoolDoctorSection(envFile, {
      checkLatency: parsed.checkLatency,
      env,
      cliSubcommands: POOL_SUBCOMMANDS,
      // Only once the run is visibly slow. On a healthy node the whole preflight is over in a second
      // and five progress lines would be noise; on the node this command exists for it is minutes,
      // and silence there reads as a hang.
      onSectionDone: (line, elapsedMs) => {
        if (elapsedMs >= POOL_DOCTOR_PROGRESS_AFTER_MS) console.log(dim(`  ${line}`));
      },
    });
    // Same split `cihub doctor` makes, and for the same reason: `issueCount` alone only tinted the
    // box, so `cihub pool doctor && cihub pool pair …` walked on from a node no peer can reach. The
    // section decides which of its checks mean broken — a `fail` verdict is this node unusable as a
    // pool member, a `warn` is state the operator asked to see, and a measurement that may have been
    // served by a REMOTE peer is `unknown`, which is neither.
    printMessageBox(`Hub Pool doctor  [${env}]`, section.lines, section.failureCount > 0 ? 'red' : section.issueCount > 0 ? 'yellow' : 'cyan');
    if (section.failureCount > 0) process.exitCode = 1;
    return;
  }

  // Also before the device-key gate: the node most likely to need `pool update` — never started,
  // or stuck on an old image — has no key yet either, and pulling/redeploying needs none.
  if (parsed.subcommand === 'update') {
    await runPoolUpdateCommand(ctx, parsed.env);
    return;
  }

  const keySource = readHubApiKeySource(envFile);
  if (!keySource.key) {
    // Say what was searched, not what the Hub is. This box used to read "Hub not paired"
    // and prescribe `cihub register` after checking exactly one path — and printed that on
    // a node that was routing inference to three peers at the time, because sudo moved HOME
    // and the key was in the owning user's data dir. `cihub register --fresh` on a live pool
    // member is a destructive answer to a question we had not actually asked.
    printMessageBox(
      'No device key found',
      [
        'Every pool route needs a Portal device key. None of these files had one:',
        ...keySource.checked.map((checked) => `  ${checked}`),
        '',
        'If this Hub has never been paired:  cihub register',
        ...(process.env.SUDO_USER
          ? ['', 'You ran this under sudo, which changes HOME. The key is stored per user —', 'try again as the user that owns this Hub.']
          : []),
        '(The key from `cihub api-key create` is MCP-scoped and is not accepted here.)',
      ],
      'red',
    );
    process.exit(1);
  }

  try {
    if (parsed.subcommand === 'status') {
      const status = await fetchPoolStatus(envFile);
      printMessageBox(`Hub Pool  [${env}]`, formatPoolStatusLines(status), status.routingActive ? 'green' : status.enabled ? 'cyan' : 'yellow');
      return;
    }

    if (parsed.subcommand === 'peers') {
      printMessageBox(`Hub Pool peers  [${env}]`, formatPoolPeersLines(await fetchPoolPeers(envFile)), 'cyan');
      return;
    }

    if (parsed.subcommand === 'pairing-pin') {
      const minted = await mintPairingPin(envFile);
      // Best-effort: the name only makes the printed `pool pair` line copy-pasteable, so a Hub whose
      // status call fails still gets its digits rather than an error.
      const localNodeFqdn = await fetchPoolStatus(envFile)
        .then((status) => status.localNode.nodeFqdn)
        .catch(() => null);
      printMessageBox(`Hub Pool pairing PIN  [${env}]`, formatPairingPinLines(minted, localNodeFqdn), minted.identityError ? 'yellow' : 'green');
      return;
    }

    if (parsed.subcommand === 'cancel-pin') {
      await cancelPairingPin(envFile);
      printMessageBox(`Hub Pool pairing PIN  [${env}]`, formatPairingPinCancelledLines(), 'cyan');
      return;
    }

    if (parsed.subcommand === 'discover') {
      // Coloured on whether anything was found, not on the Admin API credential: two of the three
      // directories need none, so a credential-free Hub listing real candidates is not a warning.
      const { lines, found } = await runPoolDiscover(envFile);
      printMessageBox(`Hub Pool discovery  [${env}]`, lines, found ? 'cyan' : 'yellow');
      return;
    }

    if (parsed.subcommand === 'probe') {
      if (!parsed.target) {
        usageAndExit(`${BASE_COMMAND} pool probe <address> [env] — e.g. ${BASE_COMMAND} pool probe 192.168.1.42`);
      }
      // Deliberately NOT run through `isPlausiblePeerFqdn`: that check exists to reject the shapes
      // this command is for. The backend parses the address, and its errors name the exact problem.
      const result = await probePoolAddress(envFile, parsed.target);
      printMessageBox(`Hub Pool probe  [${env}]`, formatPoolProbeLines(result), result.pairable ? 'green' : result.isCiHub ? 'yellow' : 'red');
      return;
    }

    if (parsed.subcommand === 'log') {
      const log = await fetchPoolRoutingLog(envFile, parsed.limit);
      printMessageBox(`Hub Pool routing log  [${env}]`, formatPoolRoutingLogLines(log), log.summary.failed > 0 ? 'yellow' : 'cyan');
      return;
    }

    if (parsed.subcommand === 'enable' || parsed.subcommand === 'disable') {
      await runPoolEnableCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'pin' || parsed.subcommand === 'unpin') {
      await runPoolPinCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'ceiling') {
      await runPoolCeilingCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'context-cap') {
      await runPoolContextCapCommand(ctx, parsed);
      return;
    }

    if (parsed.subcommand === 'slots') {
      await runPoolSlotsCommand(ctx, parsed);
      return;
    }

    await runPoolPeerMutation(ctx, parsed);
  } catch (error) {
    poolErrorExit(error, envFile);
  }
}

/**
 * Pull the published image and redeploy — no build toolchain, no GitHub Packages token. See
 * cli-pool-update.ts for why this is a separate, narrow command instead of teaching `cihub up`
 * to skip `--build`.
 */
async function runPoolUpdateCommand(ctx: HubContext, requestedEnv: HubEnv): Promise<void> {
  const lines: string[] = [];

  // `resolveHubContext` forces `prod` on an appliance install whatever argument was typed, so
  // `cihub pool update dev` runs as `[prod]` and nothing said so — the banner simply disagreed with
  // the command. It still operates on the one stack this machine has (there is no other), but the
  // discarded argument is named, because it is what an operator thinks selected the channel.
  if (requestedEnv !== ctx.env) {
    lines.push(
      cliWarn(
        `ignoring '${requestedEnv}': this is an appliance install with a single ${ctx.env} stack. ` +
          `The env argument does not select a channel here — CI_HUB_IMAGE in ${ctx.envFile} does.`,
      ),
    );
  }

  const gitFacts = gatherGitUpdateFacts(ctx.cwd);
  const gitDecision = decideGitUpdate(gitFacts);
  if (gitDecision.action === 'pull') {
    run('git', ['-C', ctx.cwd, 'fetch', 'origin', 'dev']);
    run('git', ['-C', ctx.cwd, 'merge', '--ff-only', 'origin/dev']);
    const sha = runCapture('git', ['-C', ctx.cwd, 'rev-parse', '--short', 'HEAD']).stdout;
    lines.push(cliOk(`git checkout fast-forwarded to dev (${sha})`));
  } else {
    lines.push(cliWarn(`git checkout left untouched — ${gitDecision.reason}`));
  }

  // Read WHICH build is running before anything is pulled, so the end of this command can say
  // whether the image actually moved. A floating tag makes a no-op pull indistinguishable from a
  // real update on liveness alone — see describeImageChange.
  const imageBefore = readRunningImageIdentity();

  const { files, overlayApplied } = composeFilesForPoolUpdate(ctx.cwd, ctx.composeFiles);

  // Read the running stack before assuming this checkout's shape. Costs one `docker inspect` and is
  // the difference between updating the Hub that exists and failing on a project-name mismatch.
  // It has to happen BEFORE the image is resolved: the env file it names is where the node's own
  // pin lives, and that pin is the second source `resolvePoolUpdateImage` consults.
  const identity = discoverComposeIdentity();
  const pinTarget = resolveComposeEnvFile(identity, ctx.envFile);
  const declaredImage = readDeclaredHubImage(pinTarget.path);
  const { image, source } = resolvePoolUpdateImage({ env: ctx.env, processValue: process.env.CI_HUB_IMAGE, envFileValue: declaredImage });
  lines.push(cliOk(`will pull ${shortImageRef(image)} — ${describeImageSource(source, pinTarget.path)}`));
  if (!overlayApplied) {
    lines.push(cliWarn(`no pull-image overlay in ${ctx.cwd} — pulling directly, since the seeded compose caches a mutable tag`));
  }
  if (source === 'channel-default' && ctx.appliance) {
    // The appliance path forces `prod` whatever env was typed (see resolveHubContext), so this tag
    // is a guess about a channel nobody selected. Say so rather than deploying it quietly.
    lines.push(
      cliWarn(`${ctx.envFile} pins nothing, so this falls back to the '${ctx.env}' tag — set CI_HUB_IMAGE if that is not the channel you want`),
    );
  }

  if (identity && (identity.project !== 'ci-hub' || identity.configFiles.length)) {
    console.log(
      colorize(
        `  using the running stack: container ${identity.container}, project ${identity.project ?? '(none)'}` +
          `${identity.configFiles.length ? `, ${identity.configFiles.length} compose file(s)` : ''}`,
        'dim',
      ),
    );
  }
  const { pullArgs, upArgs } = buildPoolUpdateComposeArgs(ctx.envFile, files, identity);
  printMessageBox(`Hub Pool update  [${ctx.env}]`, [...lines, '', 'Pulling the published image, then redeploying...'], 'cyan');
  // CI_HUB_IMAGE is exported even without the overlay. On an appliance the seeded compose carries
  // `image: ${CI_HUB_IMAGE:-…:latest}` with `pull_policy: if_not_present`, so a mutable tag like
  // `:dev` is fetched once and then never again — an "update" that silently redeploys the cached
  // image it already had. Naming the image explicitly, plus the pull below, is what makes the
  // command mean what it says on a node that has no checkout.
  const envOverrides = { CI_HUB_IMAGE: image };
  if (!overlayApplied) {
    // `docker compose pull` honours pull_policy; `docker pull` does not, so it is the only way to
    // refresh a mutable tag through a compose file this command cannot edit.
    run('docker', ['pull', image], {}, ctx.cwd);
  }
  run('docker', pullArgs, envOverrides, ctx.cwd);
  run('docker', upArgs, envOverrides, ctx.cwd);

  // The env file may not carry API_PORT at all on an appliance install (the compose service
  // `environment:` block sets it) — read it off the container that just started, same precedence
  // `pool doctor`'s A1 uses, rather than assuming 5002.
  const base = `http://127.0.0.1:${readRunningImageIdentity()?.config.apiPort ?? 5002}`;
  let healthy = false;
  for (let attempt = 0; attempt < 10 && !healthy; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      healthy = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {
      // Not up yet — a redeploy can take a few seconds before the port answers.
    }
  }
  if (!healthy) {
    lines.push('', cliFail(`${base}/api/health did not answer after redeploy — check: ${BASE_COMMAND} logs ${ctx.env}`));
    // Deliberately no pin write here: see decideImagePinWrite. A pin naming a build that did not
    // come up would make the next restart fail the same way.
    lines.push(cliWarn(`left ${resolveComposeEnvFile(identity, ctx.envFile).path} alone — the pin still names the build that was serving`));
    printMessageBox(`Hub Pool update  [${ctx.env}]`, lines, 'red');
    return;
  }
  lines.push('', cliOk(`${base}/api/health answered — Hub is up`));

  // Liveness is not the same as "the update landed". A pull that fetched nothing and an `up` that
  // recreated nothing answer health exactly like a real update does.
  const imageAfter = readRunningImageIdentity();
  const moved = describeImageChange(imageBefore, imageAfter);
  lines.push(moved.warn ? cliWarn(moved.line) : cliOk(moved.line));

  try {
    const identify = await fetch(`${base}/api/inference/pool/identify`, { signal: AbortSignal.timeout(3000) });
    const body = identify.ok ? ((await identify.json()) as { poolProtocol?: number }) : null;
    lines.push(
      typeof body?.poolProtocol === 'number'
        ? cliOk(`pool protocol ${body.poolProtocol}`)
        : cliWarn('answered identify but reported no poolProtocol — this build predates Hub Pool'),
    );
  } catch {
    // identify is a bonus signal on top of health, not a requirement for a successful update.
  }

  // Record what was deployed, in the env file compose actually reads.
  //
  // Without this the image lives only in this command's environment. On 2026-09-21 fifteen fleet
  // appliances were rolled onto a new `:dev` digest while their env files went on naming an older
  // one, untouched since the previous day — so every one of those nodes was one restart away from
  // silently reverting to the build it had just been moved off.
  const pinDecision = decideImagePinWrite({
    envFile: pinTarget.path,
    envFileExists: existsSync(pinTarget.path),
    declaredImage,
    deployedImage: image,
    healthy,
  });
  if (pinDecision.action === 'write') {
    try {
      upsertEnvVar(pinDecision.envFile, HUB_IMAGE_VAR, pinDecision.image);
      lines.push(cliOk(`recorded ${HUB_IMAGE_VAR}=${shortImageRef(pinDecision.image)} in ${pinDecision.envFile} — ${pinDecision.reason}`));
    } catch (error) {
      lines.push(cliWarn(`could not record ${HUB_IMAGE_VAR} in ${pinDecision.envFile}: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else {
    lines.push(colorize(`  ${pinDecision.reason}`, 'dim'));
  }

  // The stack just moved. THIS CLI did not: it ships on the desktop/release-asset channel, and a
  // `pool update` has never touched it. So this is the exact moment a skew is created, and the one
  // place an operator is certain to be looking when it happens. Reported, never acted on — replacing
  // the binary mid-command is `cihub self-update`, explicitly.
  const skew = gatherSkew();
  const skewLine =
    skew.report.severity === 'fail'
      ? cliFail(skew.report.headline)
      : skew.report.severity === 'warn'
        ? cliWarn(skew.report.headline)
        : cliOk(skew.report.headline);
  lines.push('', skewLine);
  if (skew.report.severity !== 'ok') {
    lines.push(colorize(`  fix: ${cliUpdateInstructions(skew.channel, skew.stack?.version ?? undefined)[0]}`, 'dim'));
  }

  const boxColor = skew.report.severity === 'fail' ? 'red' : moved.warn || skew.report.severity === 'warn' ? 'yellow' : 'green';
  printMessageBox(`Hub Pool update  [${ctx.env}]`, lines, boxColor);
}

/** What each axis is called, which env var overrides it, and how `/status` reports its state. */
const POOL_AXES: Record<
  PoolEnableAxis,
  { label: string; envVar: string; describe: (s: Awaited<ReturnType<typeof fetchPoolStatus>>) => { disabledBy: 'env' | 'setting' | null } }
> = {
  both: { label: 'Hub Pool', envVar: 'HUB_POOL_USER_DISABLED', describe: (s) => ({ disabledBy: s.disabledBy }) },
  outbound: { label: 'Hub Pool outbound (sending work to peers)', envVar: 'HUB_POOL_OUTBOUND_DISABLED', describe: (s) => s.directions.outbound },
  inbound: { label: 'Hub Pool inbound (serving work for peers)', envVar: 'HUB_POOL_INBOUND_DISABLED', describe: (s) => s.directions.inbound },
};

async function runPoolEnableCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const enable = parsed.subcommand === 'enable';
  const axis = POOL_AXES[parsed.axis];
  const status = await fetchPoolStatus(ctx.envFile);
  const confirmed = await confirmDestructiveAction(
    `${enable ? 'Enabling' : 'Disabling'} ${axis.label}`,
    parsed.yes,
    `${enable ? 'Enable' : 'Disable'} ${axis.label} on this node? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the Hub Pool setting untouched.'], 'yellow');
    return;
  }

  const settings = await setPoolEnabledSetting(ctx.envFile, enable, parsed.axis);
  const lines = [
    `Stored setting  poolEnabled=${settings.poolEnabled} · outbound=${settings.poolOutboundEnabled} · inbound=${settings.poolInboundEnabled}`,
  ];

  // The env flag wins by design, so a `pool enable` under it must not read as success. Checked per
  // axis, and the master is checked first: with HUB_POOL_USER_DISABLED set, enabling one direction
  // changes nothing either, and naming the directional variable would send the operator to the
  // wrong line of the wrong file.
  const blockedBy = status.disabledBy === 'env' ? POOL_AXES.both : axis.describe(status).disabledBy === 'env' ? axis : null;
  if (blockedBy) {
    const envFileHasFlag = parseEnvFile(ctx.envFile)[blockedBy.envVar] === 'true';
    lines.push(
      '',
      `${STEP_ICONS.fail} ${blockedBy === axis ? axis.label : 'Pooling'} is still off — this changed nothing in effect.`,
      `${blockedBy.envVar}=true${envFileHasFlag ? ` in ${ctx.envFile}` : " in this Hub's environment"} forces it off,`,
      'and the .env override always wins over the stored setting.',
      '',
      `Remove that line, then: ${BASE_COMMAND} restart ${ctx.env}`,
    );
    printMessageBox(enable ? `${axis.label} setting saved (override in force)` : `${axis.label} disabled`, lines, 'yellow');
    return;
  }

  if (enable && status.peerCounts.connected === 0) {
    lines.push('', 'No connected peers yet, so inference still resolves locally.', `Find candidates with: ${BASE_COMMAND} pool discover`);
  }
  if (!enable) {
    lines.push(
      '',
      parsed.axis === 'both'
        ? 'Existing pairings are kept. Peers will mark this node unreachable until it is re-enabled.'
        : parsed.axis === 'outbound'
          ? 'Existing pairings are kept, and peers may still send work here. Requests this node cannot serve now fail locally instead of being sent out.'
          : 'Existing pairings are kept, and this node keeps using its peers. They see it as healthy but not taking work, so they route elsewhere.',
    );
  }
  printMessageBox(enable ? `${axis.label} enabled` : `${axis.label} disabled`, lines, enable ? 'green' : 'yellow');
}

/**
 * `cihub pool pin <node-fqdn|local> [--model M]` / `cihub pool unpin [--model M]`.
 *
 * A pin is a preference, not a rule — the Hub only ever moves the pinned node to the front of a
 * candidate list it already built — so neither verb can take inference down and neither is treated
 * as destructive. What they CAN do is quietly stop applying, which is why both print where the pin
 * ended up and point at `pool status`, the one place `targetAvailable` is reported.
 */
async function runPoolPinCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  const scope = parsed.model === undefined ? 'default' : 'model';
  const covers = parsed.model === undefined ? 'every model' : `model "${sanitizeForBox(parsed.model)}"`;

  if (parsed.subcommand === 'unpin') {
    const { pins } = await deletePoolPin(envFile, scope, parsed.model);
    printMessageBox(
      `Pin removed  [${env}]`,
      [
        `Routing for ${covers} is back to the ranker (least-loaded, with the local head start).`,
        ...(pins.length > 0 ? ['', `${pins.length} other pin(s) remain — see: ${BASE_COMMAND} pool status`] : []),
      ],
      'yellow',
    );
    return;
  }

  if (!parsed.target) {
    usageAndExit(`Usage: ${BASE_COMMAND} pool pin <node-fqdn|local> [--model <model id>] [env] [--yes]`);
  }

  // `local` is a literal, checked BEFORE the FQDN shape test — `isPlausiblePeerFqdn` requires a dot,
  // so "local" would otherwise be read as a malformed peer name and rejected. There is no peer row
  // for this node, which is exactly why a pin cannot be a column on one.
  const toLocal = parsed.target.trim().toLowerCase() === 'local';
  if (!toLocal && !isPlausiblePeerFqdn(parsed.target)) {
    printMessageBox(
      'Not a node name',
      [
        `"${sanitizeForBox(parsed.target)}" is neither \`local\` nor a tailnet hostname.`,
        '',
        `Pin to this Hub:  ${BASE_COMMAND} pool pin local`,
        `Pin to a peer:    ${BASE_COMMAND} pool pin <node-fqdn>   (see: ${BASE_COMMAND} pool peers)`,
      ],
      'red',
    );
    process.exit(2);
  }

  let peer: { id: string; nodeFqdn: string; status: string } | undefined;
  if (!toLocal) {
    const peers = await fetchPoolPeers(envFile);
    const resolved = resolvePoolPeerTarget(peers, parsed.target);
    if ('error' in resolved) {
      printMessageBox('Peer not found', [resolved.error], 'red');
      process.exit(2);
    }
    peer = resolved.peer;
  }

  const label = toLocal ? 'this Hub' : sanitizeForBox(peer?.nodeFqdn ?? '');
  const confirmed = await confirmDestructiveAction(
    `Pinning ${covers} to ${label}`,
    parsed.yes,
    `Prefer ${label} for ${covers}? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left routing untouched.'], 'yellow');
    return;
  }

  await setPoolPin(
    envFile,
    toLocal
      ? { scope, ...(parsed.model === undefined ? {} : { model: parsed.model }), targetKind: 'local' }
      : { scope, ...(parsed.model === undefined ? {} : { model: parsed.model }), targetKind: 'peer', targetPeerId: peer?.id as string },
  );

  printMessageBox(
    `Pinned  [${env}]`,
    [
      `${covers} → ${label}`,
      '',
      'This is a preference, not a rule: when the pinned node cannot serve a request it is ranked',
      'normally and the request still goes somewhere. Nothing restarts — the next pooled request',
      'already uses it.',
      '',
      ...(peer && peer.status !== 'connected'
        ? [`${STEP_ICONS.fail} That peer is ${sanitizeForBox(peer.status)} right now, so the pin does nothing until it recovers.`, '']
        : []),
      `Check it took effect: ${BASE_COMMAND} pool status`,
    ],
    'green',
  );
}

/**
 * `cihub pool ceiling <tokens>|clear` — the largest estimated prompt this node should serve for the
 * pool while another node can take it.
 *
 * Confirmed like a pin and for the same reason: a state change, never a destructive one, because a
 * ceiling only ever moves work and a request with nowhere else to go is still served here. Status is
 * read AFTER the write, so the box reports the ceiling in force rather than the one requested: under
 * `HUB_POOL_MAX_PROMPT_TOKENS` the PATCH succeeds and changes nothing. A Hub too old to store the
 * field answers 200 too, and is told apart by the key missing from the settings it returns.
 */
async function runPoolCeilingCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  const requested = parsePromptCeilingArg(parsed.target);
  if (requested === undefined) {
    usageAndExit(
      `Usage: ${BASE_COMMAND} pool ceiling <tokens>|clear [env] [--yes] — tokens is a whole number from ${MIN_PROMPT_CEILING} to ${MAX_PROMPT_CEILING}, e.g. 16000`,
    );
  }

  const describe = requested === null ? 'Clear the prompt ceiling' : `Set the prompt ceiling to ~${requested} tokens`;
  const confirmed = await confirmDestructiveAction(`${describe} on this node`, parsed.yes, `${describe} on this node? [y/N]: `, 'a state change');
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the prompt ceiling untouched.'], 'yellow');
    return;
  }

  const settings = await setPoolMaxPromptTokens(envFile, requested);
  // Best-effort: without status the box cannot see an .env override, but the write itself succeeded.
  const status = await fetchPoolStatus(envFile).catch(() => null);
  const result = formatPromptCeilingResultLines(requested, settings, status);
  printMessageBox(`${result.title}  [${env}]`, result.lines, result.tone);
}

/**
 * `cihub pool context-cap <tokens>|clear` — the largest `num_ctx` this node's Hub hands its apps, to
 * be set to the context the engine runs (`OLLAMA_CONTEXT_LENGTH`) so no app asks for a window that
 * reloads the model. See `docs/hub-pool.md` → Context caps for the 25 GB → 44 GB reload behind it.
 *
 * Confirmed like the ceiling — a state change, and one that restarts the AI apps whose env it
 * changes. Preferences are read BEFORE the write, because the write route needs the stored backend
 * and because a cap that already reads as requested is not worth an app sweep; and read AFTER it, so
 * the box reports the cap in force rather than the one requested. A Hub whose preferences carry no
 * `maxNumCtx` predates the cap and is told so without a write: its schema would strip the field and
 * answer 200 having stored nothing.
 */
async function runPoolContextCapCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  const requested = parseContextCapArg(parsed.target);
  if (requested === undefined) {
    usageAndExit(
      `Usage: ${BASE_COMMAND} pool context-cap <tokens>|clear [env] [--yes] — tokens is a whole number from ${MIN_CONTEXT_CAP} to ${MAX_CONTEXT_CAP}, e.g. 16384 (the node's OLLAMA_CONTEXT_LENGTH)`,
    );
  }

  const describe = requested === null ? 'Clear the context cap' : `Cap the context handout at ${requested} tokens`;
  const confirmed = await confirmDestructiveAction(
    `${describe} on this node`,
    parsed.yes,
    `${describe} on this node (AI apps whose env changes will restart)? [y/N]: `,
    'a state change',
  );
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the context cap untouched.'], 'yellow');
    return;
  }

  const before = await fetchInferencePreferences(envFile);
  const supported = 'maxNumCtx' in before;
  const alreadyInForce = supported && (before.maxNumCtx ?? null) === requested;
  const written = supported && !alreadyInForce;
  let after: InferencePreferencesResponse | null = null;
  if (written) {
    // An absent preference resolves to Ollama on the Hub already, so sending it back changes nothing.
    const patched = await setInferenceContextCap(envFile, before.preferredBackend ?? 'ollama', requested);
    // Best-effort: the PATCH already answered with the stored preferences; a read-back that fails
    // falls back to that answer rather than reporting a write that did happen as unknown.
    after = await fetchInferencePreferences(envFile).catch(() => patched);
  }
  const result = formatContextCapResultLines(requested, before, after, written);
  printMessageBox(`${result.title}  [${env}]`, result.lines, result.tone);
  if (result.tone === 'red') process.exitCode = 1;
}

/**
 * `cihub pool slots <n>|clear` — how many requests this node's Ollama runs at once, to be set to the
 * daemon's `OLLAMA_NUM_PARALLEL` so slot-aware placement (`poolSlotAwareness`) can tell a full
 * engine from a half-empty one. See `docs/hub-pool.md` → Slot-aware placement for the B5 numbers.
 *
 * Confirmed like the cap — a state change. Unlike the cap it restarts nothing: the count changes what
 * this node advertises and how the pool ranks it, not any app's env. Read before and after the write
 * for the cap's reasons: the write route needs the stored backend, a count already in force is not
 * worth a write, and the box reports the count in force rather than the one requested. A Hub whose
 * preferences carry no `ollamaSlots` predates the setting and is told so without a write.
 */
async function runPoolSlotsCommand(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  const requested = parseOllamaSlotsArg(parsed.target);
  if (requested === undefined) {
    usageAndExit(
      `Usage: ${BASE_COMMAND} pool slots <n>|clear [env] [--yes] — n is a whole number from ${MIN_OLLAMA_SLOTS} to ${MAX_OLLAMA_SLOTS}, e.g. 4 (the node's OLLAMA_NUM_PARALLEL)`,
    );
  }

  const describe =
    requested === null ? 'Clear the Ollama slot count' : `State that Ollama runs ${requested} request${requested === 1 ? '' : 's'} at once`;
  const confirmed = await confirmDestructiveAction(`${describe} on this node`, parsed.yes, `${describe} on this node? [y/N]: `, 'a state change');
  if (!confirmed) {
    printMessageBox('Cancelled', ['Left the slot count untouched.'], 'yellow');
    return;
  }

  const before = await fetchInferencePreferences(envFile);
  const supported = 'ollamaSlots' in before;
  const alreadyInForce = supported && (before.ollamaSlots ?? null) === requested;
  const written = supported && !alreadyInForce;
  let after: InferencePreferencesResponse | null = null;
  if (written) {
    const patched = await setInferenceOllamaSlots(envFile, before.preferredBackend ?? 'ollama', requested);
    after = await fetchInferencePreferences(envFile).catch(() => patched);
  }
  const result = formatOllamaSlotsResultLines(requested, before, after, written);
  printMessageBox(`${result.title}  [${env}]`, result.lines, result.tone);
  if (result.tone === 'red') process.exitCode = 1;
}

async function runPoolPeerMutation(ctx: HubContext, parsed: ParsedPoolArgs) {
  const { env, envFile } = ctx;
  if (!parsed.target) {
    usageAndExit(
      parsed.subcommand === 'pair'
        ? `Usage: ${BASE_COMMAND} pool pair <node-fqdn|address> [env] [--pin <digits>] [--name <label>] [--yes]`
        : `Usage: ${BASE_COMMAND} pool ${parsed.subcommand} <id|node-fqdn> [env] [--yes]`,
    );
  }

  if (parsed.subcommand === 'pair') {
    // Two shapes, told apart by whether the target looks like a MagicDNS name. An address needs a
    // PIN, because the far Hub only discloses its tailnet name — the name the row is keyed on — to a
    // request carrying one; `/identify` reports no name to anybody.
    const byName = isPlausiblePeerFqdn(parsed.target);
    if (!byName && parsed.pin === undefined) {
      printMessageBox(
        'Pairing by address needs a PIN',
        [
          `"${sanitizeForBox(parsed.target)}" is not a MagicDNS name, so it is being read as an address.`,
          '',
          'An address can reach the other Hub but cannot name it: /identify is unauthenticated and',
          'reports no MagicDNS name. The name comes back in the answer to a PIN-authenticated',
          'pairing request, so pairing by address needs the PIN from that Hub:',
          '',
          '  on that Hub:  cihub pool pairing-pin',
          `  then here:    ${BASE_COMMAND} pool pair ${sanitizeForBox(parsed.target)} --pin <digits>`,
          '',
          'Or pass the bare tailnet hostname instead: e.g. hub-b.example-tailnet.ts.net',
        ],
        'red',
      );
      process.exit(2);
    }
    const confirmed = await confirmDestructiveAction(
      `Pairing with ${sanitizeForBox(parsed.target)}`,
      parsed.yes,
      `Send a pairing request to ${sanitizeForBox(parsed.target)}? [y/N]: `,
      'a state change',
    );
    if (!confirmed) {
      printMessageBox('Pairing cancelled', ['No pairing request was sent.'], 'yellow');
      return;
    }
    const peer = await pairPoolPeer(envFile, byName ? { nodeFqdn: parsed.target } : { address: parsed.target }, parsed.displayName, parsed.pin);
    printMessageBox(
      `Pairing requested  [${env}]`,
      [
        `Peer   ${sanitizeForBox(peer.nodeFqdn)}`,
        `Id     ${sanitizeForBox(peer.id)}`,
        `Status ${peer.status}`,
        '',
        'Nothing is pooled until the other Hub approves. The request appears there as an',
        `inbound pending peer — on that Hub run \`${BASE_COMMAND} pool peers\` then`,
        `\`${BASE_COMMAND} pool approve <id>\`, or approve it in Settings → Network → Hub Pool.`,
      ],
      'green',
    );
    return;
  }

  const peers = await fetchPoolPeers(envFile);
  const resolved = resolvePoolPeerTarget(peers, parsed.target);
  if ('error' in resolved) {
    printMessageBox('Peer not found', [resolved.error], 'red');
    process.exit(2);
  }
  const peer = resolved.peer;

  const prompts: Record<
    'approve' | 'reject' | 'unpair' | 'peer-enable' | 'peer-disable',
    { label: string; question: string; noun: string; done: string; lines: string[] }
  > = {
    approve: {
      label: `Approving ${describePoolPeer(peer)}`,
      question: `Approve pairing with ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'a state change',
      done: 'Peer approved',
      lines: ['This node now issues the peer a token and starts offering it as a routing candidate.'],
    },
    reject: {
      label: `Rejecting ${describePoolPeer(peer)}`,
      question: `Reject the pairing request from ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'destructive',
      done: 'Peer rejected',
      lines: ['The request row was deleted and the other Hub was notified.'],
    },
    unpair: {
      label: `Unpairing ${describePoolPeer(peer)}`,
      question: `Unpair ${sanitizeForBox(peer.nodeFqdn)} and revoke both tokens? [y/N]: `,
      noun: 'destructive',
      done: 'Peer unpaired',
      lines: [
        'Both halves of the pairing are gone; re-pairing needs a fresh approval.',
        'A peer that was merely offline recovers on its own — unpairing is not the fix for that.',
      ],
    },
    'peer-enable': {
      label: `Enabling ${describePoolPeer(peer)}`,
      question: `Put ${sanitizeForBox(peer.nodeFqdn)} back in the pool? [y/N]: `,
      noun: 'a state change',
      done: 'Peer enabled',
      lines: ['Work flows both ways with this peer again, from the next request and the next health poll.'],
    },
    'peer-disable': {
      label: `Disabling ${describePoolPeer(peer)}`,
      question: `Stop exchanging work with ${sanitizeForBox(peer.nodeFqdn)}? [y/N]: `,
      noun: 'a state change',
      done: 'Peer disabled',
      lines: [
        'No work moves in either direction with this peer while it is off.',
        'This is NOT a revocation: the pairing and both tokens are kept, so re-enabling is instant',
        `and needs no approval from the other side. To revoke, use \`${BASE_COMMAND} pool unpair <id>\`.`,
      ],
    },
  };
  const plan = prompts[parsed.subcommand as 'approve' | 'reject' | 'unpair' | 'peer-enable' | 'peer-disable'];

  if (!(await confirmDestructiveAction(plan.label, parsed.yes, plan.question, plan.noun))) {
    printMessageBox('Cancelled', ['Left the pairing untouched.'], 'yellow');
    return;
  }

  if (parsed.subcommand === 'approve') await approvePoolPeer(envFile, peer.id);
  else if (parsed.subcommand === 'reject') await rejectPoolPeer(envFile, peer.id);
  else if (parsed.subcommand === 'peer-enable') await setPoolPeerEnabled(envFile, peer.id, true);
  else if (parsed.subcommand === 'peer-disable') await setPoolPeerEnabled(envFile, peer.id, false);
  else await unpairPoolPeer(envFile, peer.id);

  printMessageBox(
    `${plan.done}  [${env}]`,
    [`Peer  ${sanitizeForBox(peer.nodeFqdn)}`, ...plan.lines],
    parsed.subcommand === 'approve' || parsed.subcommand === 'peer-enable' ? 'green' : 'yellow',
  );
}
