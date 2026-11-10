import type { HardwareProfile } from '../types/inference.js';

/**
 * Whether anything on this node can actually run models on the GPU.
 *
 * `runtimeAvailable` is the CONTAINER's view: `/dev/kfd` + `/dev/dri` visible to the Hub
 * process, or `docker info` listing an `nvidia` runtime. On a Linux host the Hub container is
 * started without device passthrough, so that is false on every AMD box — while Ollama, which
 * is what runs the models, sits on the host (or in its own container with the nodes
 * bind-mounted) and uses the card fine. The host probe (`/data/state/hardware/rocm.json`,
 * `source: host-dev-kfd`) records exactly that as `hostRocmKfdAvailable`.
 * Measured 2026-09-17 on an RX 7900 XTX: `runtimeAvailable=false`, `hostRocmKfdAvailable=true`,
 * tier computed as `cpu-only`, so the 27B the operator had pinned was rejected as "not
 * runnable" and every app was handed a 4B model.
 *
 * NVIDIA has the same split. A fleet node without nvidia-container-toolkit reports
 * `runtimeAvailable=false` while the host's driver runs the card for the engine that actually
 * serves models. Measured 2026-09-21 on beta-nas (RTX A1000 8 GB, driver 595, no `nvidia`
 * runtime): the host wrote `nvidia.json` and a fresh `gpu_processes.json` showing the host's
 * llama-server and vLLM holding VRAM, yet the tier was `cpu-only`. `hostNvidiaAvailable` is
 * that host proof.
 *
 * Both the hardware tier and the node status report follow this. `runtimeAvailable` itself is
 * left as the container's own view, so the router and the setup card can still say that
 * container apps have no GPU — a different statement from "the driver is broken", which the
 * status report once made of every Linux AMD box (it read `runtimeAvailable` alone).
 */
export function gpuRuntimeReady(gpu: HardwareProfile['gpu']): boolean {
  if (gpu.runtimeAvailable) return true;
  if (gpu.vendor === 'amd') return gpu.hostRocmKfdAvailable === true;
  if (gpu.vendor === 'nvidia') return gpu.hostNvidiaAvailable === true;
  return false;
}
