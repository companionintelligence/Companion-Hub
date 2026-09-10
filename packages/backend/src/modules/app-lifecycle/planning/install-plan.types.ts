import type { AppUrn } from '@ci-hub/common/types';

/** Outcome of a single non-mutating guard check against an install. */
export interface CheckResult {
  ok: boolean;
  /** Human-readable failure reason. Absent when `ok` is true. */
  reason?: string;
}

/** Whether an image the install would pull is already cached locally. */
export interface ImagePlanItem {
  image: string;
  cachedLocally: boolean;
}

/**
 * One port `install` would request from `PortManagerService.allocatePorts`. `available` reports
 * whether `preferredHostPort` is free *right now* — install allocates against a live DB
 * constraint, so this cannot be a guarantee: another install between plan and apply can still take
 * it. When unavailable, install falls back to the next free port in the dynamic range, which this
 * preview does not attempt to predict (previewing it would mean reserving it).
 */
export interface PortPlanItem {
  label: string;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  preferredHostPort: number;
  available: boolean;
}

/**
 * One of the app's declared `form_fields`, comparing the value the submitted form would set
 * against what is currently persisted in `app.env` (absent on a fresh install). This is
 * deliberately NOT a full diff of the env file `install` writes: identity vars, Hub-managed
 * secrets, inference config, and Portal-derived values are resolved by `generateEnvFile` at apply
 * time, some of it side-effecting (managed API key provisioning, memory-connection state), so
 * previewing it here would mean triggering those effects before the operator has committed to
 * anything.
 */
export interface FormFieldPlanItem {
  key: string;
  label: string;
  currentValue?: string;
  proposedValue: string;
  status: 'unchanged' | 'added' | 'changed';
}

export interface InstallPlanChecks {
  config: CheckResult;
  entitlement: CheckResult;
  hostDevices: CheckResult;
  architecture: CheckResult;
}

/**
 * A read-only preview of what `POST :urn/install` would do, computed without mutating any state
 * (no files written, no ports allocated, no images pulled). Mirrors the same guard checks
 * `installApp`/`InstallAppCommand` run, so a plan that reports `blocked: false` reflects the same
 * checks the real install is about to run — not a second, independently-maintained copy of them.
 */
export interface InstallPlan {
  appUrn: AppUrn;
  checks: InstallPlanChecks;
  images: ImagePlanItem[];
  ports: PortPlanItem[];
  formFields: FormFieldPlanItem[];
  /** True when any check failed — install would reject before reaching the mutating phase. */
  blocked: boolean;
}
