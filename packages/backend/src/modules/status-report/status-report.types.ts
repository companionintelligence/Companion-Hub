/**
 * The shape of `CI_HUB_STATUS.md`, kept separate from both the gathering and the
 * rendering so the renderer can be tested without standing up a Hub.
 *
 * Every section is independently optional. A Hub with a dead inference backend
 * or an unreachable Docker socket must still produce a status file — one that
 * says which part could not be read. A section that is absent and a section that
 * is empty are different findings and are encoded differently: `null` means
 * "could not read this", `[]` means "read it, there is nothing here".
 */

export interface StatusConnection {
  hostname: string | null;
  deviceId: string | null;
  registered: boolean;
  organization: string | null;
  apiPort: number | null;
  /** Public hostname served through the Cloudflare tunnel, when one is provisioned. */
  publicHostname: string | null;
  tailscale: {
    connected: boolean;
    nodeFqdn: string | null;
    tailnet: string | null;
  } | null;
  /** Hub Pool identity, absent on a build or node without pooling. */
  poolNodeUuid: string | null;
}

export interface StatusBackend {
  type: string;
  running: boolean;
  healthy: boolean;
  url: string | null;
  /** Models this backend reports as loaded. A count only; the names are in {@link StatusModel}. */
  modelsLoaded: number | null;
}

export interface StatusModel {
  name: string;
  backend: string | null;
  /** Present when the engine reports one. Never guessed from the name. */
  sizeBytes: number | null;
  /**
   * On disk but refused to serve. Listing is not serving — this fleet has seen a
   * model answer `/api/tags` and then fail to load.
   */
  unservable: boolean;
}

export interface StatusWorkloadContainer {
  name: string;
  state: string;
  status: string;
  ports: Array<{ hostPort: number | null; containerPort: number; protocol: string }>;
}

export interface StatusWorkload {
  name: string;
  urn: string | null;
  /**
   * What the Hub's database believes. This is desired state, not a probe — an app
   * row can say `running` while nothing is up, which is exactly why
   * {@link StatusWorkload.containers} is reported beside it rather than instead.
   */
  desiredStatus: string | null;
  containers: StatusWorkloadContainer[];
}

export interface StatusSystem {
  platform: string | null;
  uptimeSeconds: number | null;
  cpu: { model: string | null; cores: number | null; loadPercent: number | null } | null;
  memory: { totalBytes: number; usedBytes: number; percent: number } | null;
  disk: { totalBytes: number; usedBytes: number; freeBytes: number; percent: number } | null;
  dockerVersion: string | null;
  containerCount: { running: number; stopped: number; total: number } | null;
  gpu: { vendor: string | null; model: string | null; vramMb: number | null; driverWorking: boolean } | null;
  hardwareTier: string | null;
}

export interface HubStatusReport {
  /** ISO-8601. The reader's only defence against a file left behind by a dead Hub. */
  generatedAt: string;
  hubVersion: string | null;
  connection: StatusConnection | null;
  system: StatusSystem | null;
  backends: StatusBackend[] | null;
  models: StatusModel[] | null;
  workloads: StatusWorkload[] | null;
  /**
   * Sections that could not be read, and why. Rendered into the file rather than
   * swallowed: a report that silently omits a section it failed to gather reads
   * identically to one where that section is genuinely empty.
   */
  problems: string[];
}
