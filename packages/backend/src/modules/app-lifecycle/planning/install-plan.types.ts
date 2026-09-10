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
  /** True when any check failed — install would reject before reaching the mutating phase. */
  blocked: boolean;
}
