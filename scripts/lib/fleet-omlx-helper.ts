/**
 * oMLX's Prefill Accelerator helper, on a Linux node with NVIDIA GPUs.
 *
 * oMLX 0.8.0 lets a Mac that serves a large model hand the first layers of each long prompt to a
 * machine with NVIDIA GPUs, while the Mac runs the rest, decodes, and keeps the KV cache. The NVIDIA
 * half is `omlx-cuda-helper` (github.com/jundot/omlx, `apps/omlx-cuda-helper`, Apache-2.0), shipped
 * as the `jundot/omlx-cuda-helper` image. It has no UI and no settings of its own: the Mac finds it
 * over mDNS and pairs with it by a six-digit code the helper prints in its log.
 *
 * It is not an engine the Hub routes to. It serves no OpenAI API and the pool cannot send it a
 * request, so a plain `fleet backends` never plans it; `--backends omlx-helper` does.
 *
 * The script runs upstream's command with a pinned tag and a label:
 *   docker run -d --name omlx-helper --restart unless-stopped --gpus all --network host \
 *     -v omlx-helper:/data jundot/omlx-cuda-helper
 * Host networking is what lets the Mac's Cluster tab find the helper. It also means the helper
 * listens on :8850–8852 on every interface, and its pairing exchange is plain HTTP, so upstream says
 * to run it only on a network you trust.
 */

import type { HostFacts } from './fleet-hardware.js';

export const OMLX_HELPER_IMAGE = 'jundot/omlx-cuda-helper';

/**
 * The helper release a fresh install gets. The Mac checks the helper per model family, not per oMLX
 * version, and names the side to update when they disagree: when that is the helper, bump this or
 * pass `--omlx-helper-version`. 0.1.3 is the build published with oMLX 0.8.0rc1 (2026-11-12).
 */
export const OMLX_HELPER_PINNED_VERSION = '0.1.3';

export const OMLX_HELPER_CONTAINER = 'omlx-helper';
/** Holds the helper's identity and pairing keys. A new volume is a new device to every Mac. */
export const OMLX_HELPER_VOLUME = 'omlx-helper';
/** Discovery and pairing. The control channel is 8851 and prefill data 8852. */
export const OMLX_HELPER_HTTP_PORT = 8850;
/** Marks a container this CLI created, so a re-run may replace it and never someone else's. */
export const OMLX_HELPER_LABEL_KEY = 'ci-hub.fleet-backend';
/** The owner the hardware probe records for :8850 when the helper answers there. */
export const OMLX_HELPER_OWNER = 'omlx-cuda-helper';

/** Driver 580 ships CUDA 13, which the image is built on. */
export const OMLX_HELPER_MIN_DRIVER_MAJOR = 580;
/** The image's kernels need bf16 tensor cores: Ampere (8.0) or newer, GB10 included. */
export const OMLX_HELPER_MIN_COMPUTE_CAPABILITY = 8.0;

/** An exact release, optionally pre-release-tagged. Never a range, never `latest`. */
const RELEASE_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export class OmlxHelperVersionError extends Error {}

/**
 * The tag a run installs: the pin, or an explicit override. `latest` is refused for the reason
 * `resolveOllamaVersion` refuses it: two nodes installed a week apart would run different helpers.
 */
export function resolveOmlxHelperVersion(override?: string): string {
  if (override === undefined) return OMLX_HELPER_PINNED_VERSION;
  const trimmed = override.trim().replace(/^v/i, '');
  if (trimmed === 'latest' || trimmed === '') {
    throw new OmlxHelperVersionError(
      `--omlx-helper-version needs an exact release such as ${OMLX_HELPER_PINNED_VERSION}; '${override}' would give each node whatever was current the day it ran.`,
    );
  }
  if (!RELEASE_SHAPE.test(trimmed)) {
    throw new OmlxHelperVersionError(
      `--omlx-helper-version must look like x.y.z (got '${override}'). The pinned default is ${OMLX_HELPER_PINNED_VERSION}.`,
    );
  }
  return trimmed;
}

export type OmlxHelperGate = { ok: true; gpu: string } | { ok: false; why: string };

/** The driver's major version, from `580.95.05`. Undefined when it does not start with a number. */
function driverMajor(version: string | undefined): number | undefined {
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  return Number.isFinite(major) && major > 0 ? major : undefined;
}

/**
 * Can this machine run the helper image? Each refusal names the fact that decided it.
 *
 * The driver and the compute capability are checked here because the container does not check them
 * at start: `serve` only runs nvidia-smi, and MLX's CUDA kernels load when a Mac first sends a model.
 * A node that fails either would install, answer, pair, and then fail the first long prompt.
 */
export function omlxHelperGate(facts: HostFacts): OmlxHelperGate {
  if (facts.os === 'darwin') {
    return { ok: false, why: 'a Mac helps another Mac through oMLX’s own Cluster tab; this helper is the NVIDIA path' };
  }
  if (facts.os !== 'linux') return { ok: false, why: `the helper image runs on Linux; upstream has not tested ${facts.os}` };
  const nvidia = facts.gpus.find((g) => g.vendor === 'nvidia');
  if (!nvidia) return { ok: false, why: 'requires an NVIDIA GPU; none detected' };
  if (!nvidia.driverWorking) {
    return { ok: false, why: `an NVIDIA card is present but its driver is not answering (${nvidia.driverNote ?? 'nvidia-smi failed'})` };
  }
  const major = driverMajor(nvidia.driverVersion);
  if (major === undefined) {
    return {
      ok: false,
      why: `could not read the NVIDIA driver version, and the helper's CUDA 13 image needs ${OMLX_HELPER_MIN_DRIVER_MAJOR} or newer`,
    };
  }
  if (major < OMLX_HELPER_MIN_DRIVER_MAJOR) {
    return {
      ok: false,
      why: `NVIDIA driver ${nvidia.driverVersion} is older than ${OMLX_HELPER_MIN_DRIVER_MAJOR}, which the helper's CUDA 13 image needs`,
    };
  }
  const cc = Number(nvidia.computeCapability);
  if (nvidia.computeCapability && Number.isFinite(cc) && cc < OMLX_HELPER_MIN_COMPUTE_CAPABILITY) {
    return {
      ok: false,
      why: `${nvidia.name ?? 'the NVIDIA card'} is compute capability ${nvidia.computeCapability}; the helper's kernels need Ampere (8.0) or newer`,
    };
  }
  if (!facts.docker.present) return { ok: false, why: 'the helper ships as a Docker image, and Docker is not installed' };
  if (!facts.docker.usable) {
    return { ok: false, why: 'Docker is installed but this account cannot use it (`docker info` failed), and the helper is started as this account' };
  }
  if (facts.nvidiaContainerHook === false) {
    return {
      ok: false,
      why: '`docker run --gpus` needs the NVIDIA Container Toolkit, and nvidia-container-runtime-hook is not on PATH',
    };
  }
  const cards = [nvidia.name ?? 'NVIDIA GPU', `driver ${nvidia.driverVersion}`];
  if (nvidia.computeCapability) cards.push(`compute ${nvidia.computeCapability}`);
  return { ok: true, gpu: cards.join(', ') };
}

/**
 * The install, run as the SSH account (Docker access is the gate, not root).
 *
 * Every exit is a marker line, and `exit 0` after each: the classifier reads markers, never the
 * status, so "refused" (a fact about the node) and "failed" (something broke) stay apart. A stopped
 * container this CLI labelled is replaced, keeping the volume, so a re-run after a failure works; a
 * container it did not create is never touched. A running one is adopted as it is, as `backends`
 * adopts a running Ollama: moving it to a new pin is a deliberate `docker rm -f` first.
 */
export function omlxHelperInstallScript(version: string): string {
  const image = `${OMLX_HELPER_IMAGE}:${version}`;
  const label = `${OMLX_HELPER_LABEL_KEY}=${OMLX_HELPER_CONTAINER}`;
  return String.raw`set -u
cihub_image='${image}'
cihub_name='${OMLX_HELPER_CONTAINER}'
cihub_identity() { curl -s --max-time 2 http://127.0.0.1:${OMLX_HELPER_HTTP_PORT}/api/cluster/node_id 2>/dev/null || true; }
cihub_is_helper() { printf '%s' "$1" | grep -q '"backends": *\[ *"cuda"'; }
cihub_field() { printf '%s' "$2" | sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1; }
cihub_report() {
  printf 'omlx-helper-version: %s\n' "$(cihub_field version "$1")"
  printf 'omlx-helper-name: %s\n' "$(cihub_field friendly_name "$1")"
  printf 'omlx-helper-chip: %s\n' "$(cihub_field chip "$1")"
}
command -v curl >/dev/null 2>&1 || { echo 'omlx-helper-refused: curl is not installed, and without it the install cannot tell whether the helper answers'; exit 0; }
docker info >/dev/null 2>&1 || { echo "omlx-helper-failed: docker info failed for $(id -un): the daemon is down, or this account may not use it"; exit 0; }
cihub_state="$(docker inspect -f '{{.State.Status}}' "$cihub_name" 2>/dev/null || true)"
cihub_owner="$(docker inspect -f '{{index .Config.Labels "${OMLX_HELPER_LABEL_KEY}"}}' "$cihub_name" 2>/dev/null || true)"
if [ "$cihub_state" = running ]; then
  cihub_body="$(cihub_identity)"
  if cihub_is_helper "$cihub_body"; then
    cihub_report "$cihub_body"
    echo "omlx-helper-adopted: container $cihub_name is already running; nothing pulled or restarted"
  else
    echo "omlx-helper-refused: container $cihub_name is running, but :${OMLX_HELPER_HTTP_PORT} does not answer as the helper; docker logs $cihub_name has its output"
  fi
  exit 0
fi
if [ -n "$cihub_state" ]; then
  if [ "$cihub_owner" != '${OMLX_HELPER_CONTAINER}' ]; then
    echo "omlx-helper-refused: a container named $cihub_name exists ($cihub_state) that this CLI did not create; start it with docker start $cihub_name, or remove it with docker rm $cihub_name and run this again"
    exit 0
  fi
  docker rm "$cihub_name" >/dev/null 2>&1 || { echo "omlx-helper-failed: could not remove the stopped $cihub_name container this CLI created"; exit 0; }
  echo "omlx-helper-note: replaced the stopped $cihub_name container this CLI created ($cihub_state); the ${OMLX_HELPER_VOLUME} volume and its pairings are kept"
fi
cihub_body="$(cihub_identity)"
if cihub_is_helper "$cihub_body"; then
  cihub_report "$cihub_body"
  echo 'omlx-helper-adopted: the helper already answers on :${OMLX_HELPER_HTTP_PORT} outside Docker; nothing pulled or started'
  exit 0
fi
if (echo > /dev/tcp/127.0.0.1/${OMLX_HELPER_HTTP_PORT}) >/dev/null 2>&1; then
  echo 'omlx-helper-refused: something that is not the helper listens on :${OMLX_HELPER_HTTP_PORT}, which the helper needs'
  exit 0
fi
cihub_hook=''
for cihub_b in nvidia-container-runtime-hook nvidia-container-toolkit; do
  command -v "$cihub_b" >/dev/null 2>&1 && { cihub_hook="$cihub_b"; break; }
done
[ -n "$cihub_hook" ] || { echo 'omlx-helper-refused: docker run --gpus needs the NVIDIA Container Toolkit, and nvidia-container-runtime-hook is not on PATH'; exit 0; }
cihub_out="$(docker pull -q "$cihub_image" 2>&1)" || { echo "omlx-helper-failed: docker pull $cihub_image failed: $(printf '%s' "$cihub_out" | tail -1)"; exit 0; }
cihub_out="$(docker run -d --name "$cihub_name" --label '${label}' --restart unless-stopped --gpus all --network host -v '${OMLX_HELPER_VOLUME}:/data' "$cihub_image" 2>&1)" || { echo "omlx-helper-failed: docker run failed: $(printf '%s' "$cihub_out" | tail -1)"; exit 0; }
cihub_i=0
while [ "$cihub_i" -lt 45 ]; do
  cihub_body="$(cihub_identity)"
  if cihub_is_helper "$cihub_body"; then
    cihub_report "$cihub_body"
    echo 'omlx-helper-install-complete'
    exit 0
  fi
  [ "$(docker inspect -f '{{.RestartCount}}' "$cihub_name" 2>/dev/null || echo 0)" = 0 ] || break
  [ "$(docker inspect -f '{{.State.Status}}' "$cihub_name" 2>/dev/null || true)" = running ] || break
  cihub_i=$((cihub_i + 1))
  sleep 2
done
docker logs --tail 8 "$cihub_name" 2>&1 | sed 's/^/omlx-helper-log: /'
docker stop "$cihub_name" >/dev/null 2>&1 || true
echo "omlx-helper-failed: the helper did not answer on :${OMLX_HELPER_HTTP_PORT} within 90 s; the container is stopped so it does not restart in a loop, and docker logs $cihub_name has its output"`;
}

export interface OmlxHelperIdentity {
  version?: string;
  name?: string;
  chip?: string;
}

export type OmlxHelperApplyResult =
  | { outcome: 'installed' | 'adopted'; why: string; identity: OmlxHelperIdentity }
  | { outcome: 'refused'; why: string }
  | { outcome: 'failed'; why: string; detail?: string }
  | { outcome: 'incomplete' };

/** What the operator does next, on the Mac. The code expires ten minutes after Pair is pressed. */
export function describeOmlxHelperPairing(name?: string): string {
  const on = name ? ` on ${name}` : '';
  return `pair it from the Mac (oMLX 0.8.0 or later, Distributed Inference on): Cluster tab → Pair${on}, then type the code \`docker logs ${OMLX_HELPER_CONTAINER}\` prints on this node`;
}

function describeIdentity(identity: OmlxHelperIdentity): string {
  const parts = [identity.version ? `${OMLX_HELPER_OWNER} ${identity.version}` : OMLX_HELPER_OWNER];
  if (identity.chip) parts.push(identity.chip);
  return parts.join(' on ');
}

/** Reads the install script's markers. A run that printed none is `incomplete`, left to the caller's SSH diagnosis. */
export function classifyOmlxHelperOutput(out: string, err: string): OmlxHelperApplyResult {
  const lines = `${out}\n${err}`.split('\n').map((line) => line.trim());
  const value = (prefix: string) =>
    lines
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() || undefined;
  const identity: OmlxHelperIdentity = {
    version: value('omlx-helper-version:'),
    name: value('omlx-helper-name:'),
    chip: value('omlx-helper-chip:'),
  };
  const note = value('omlx-helper-note:');
  const failed = value('omlx-helper-failed:');
  if (failed) {
    const logs = lines.filter((line) => line.startsWith('omlx-helper-log:')).map((line) => line.slice('omlx-helper-log:'.length).trim());
    const detail = logs.join(' | ').slice(0, 400) || undefined;
    return { outcome: 'failed', why: describeFailure(failed, logs), ...(detail ? { detail } : {}) };
  }
  const refused = value('omlx-helper-refused:');
  if (refused) return { outcome: 'refused', why: refused };
  const adopted = value('omlx-helper-adopted:');
  if (adopted) {
    return { outcome: 'adopted', why: `${describeIdentity(identity)}: ${adopted}; ${describeOmlxHelperPairing(identity.name)}`, identity };
  }
  if (lines.includes('omlx-helper-install-complete')) {
    const started = `started ${describeIdentity(identity)} on the host network (:8850–8852)`;
    return {
      outcome: 'installed',
      why: [note, started, describeOmlxHelperPairing(identity.name)].filter(Boolean).join('; '),
      identity,
    };
  }
  return { outcome: 'incomplete' };
}

/** The three failures with a known cause get that cause named; the rest keep the script's sentence. */
function describeFailure(failed: string, logs: readonly string[]): string {
  const text = [failed, ...logs].join('\n');
  if (/could not select device driver/i.test(text)) {
    return `Docker cannot hand the GPU to a container (${failed}); install the NVIDIA Container Toolkit and restart Docker`;
  }
  if (/no NVIDIA GPU found/i.test(text)) return `the helper found no NVIDIA GPU inside its container; ${failed}`;
  if (/driver version is insufficient|forward compatibility/i.test(text)) {
    return `the NVIDIA driver is too old for the helper's CUDA 13 image (${OMLX_HELPER_MIN_DRIVER_MAJOR} or newer); ${failed}`;
  }
  return failed;
}
