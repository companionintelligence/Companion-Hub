import { extractOverlapCidrsFromError, isDockerNetworkOverlapError } from '@/modules/network/docker-network-errors';

export const ROCM_KFD_MISSING_CODE = 'rocm_kfd_missing';

export const KVM_MISSING_CODE = 'kvm_missing';

export const NETWORK_OVERLAP_CODE = 'network_overlap';

export const NETWORK_OVERLAP_USER_MESSAGE = 'App network range conflict — Hub is reassigning a new internal network. Retry install or start.';

export function createNetworkOverlapError(conflictingCidrs: string[] = []): AppLifecycleError {
  const detailParts = ['Docker reported overlapping bridge network IPv4 ranges after automatic subnet recovery attempts.'];
  if (conflictingCidrs.length > 0) {
    detailParts.push(`Conflicting ranges: ${conflictingCidrs.join(', ')}`);
  }

  return new AppLifecycleError(NETWORK_OVERLAP_USER_MESSAGE, {
    code: NETWORK_OVERLAP_CODE,
    detail: detailParts.join(' '),
  });
}

export const ROCM_KFD_MISSING_SETTINGS_PATH = '/settings?tab=ai&section=rocm';

/** Short user-facing message; frontend maps to i18n via errorCode when present. */
export const ROCM_KFD_MISSING_USER_MESSAGE = 'This app needs AMD ROCm. Set up ROCm in AI Settings, then retry.';

/** Full detail for logs and support. */
export const ROCM_KFD_MISSING_DETAIL =
  'This app requires an AMD GPU with ROCm drivers. The ROCm compute device (/dev/kfd) was not found on this machine. Verify that you have a supported AMD GPU and ROCm drivers installed before running this app.';

export class AppLifecycleError extends Error {
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly settingsPath?: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      detail?: string;
      settingsPath?: string;
    },
  ) {
    super(message);
    this.name = 'AppLifecycleError';
    this.errorCode = options?.code;
    this.errorDetail = options?.detail;
    this.settingsPath = options?.settingsPath;
  }
}

export function createRocmKfdMissingError(): AppLifecycleError {
  return new AppLifecycleError(ROCM_KFD_MISSING_USER_MESSAGE, {
    code: ROCM_KFD_MISSING_CODE,
    detail: ROCM_KFD_MISSING_DETAIL,
    settingsPath: ROCM_KFD_MISSING_SETTINGS_PATH,
  });
}

/** Short user-facing message for apps that require /dev/kvm (QEMU VMs). */
export const KVM_MISSING_USER_MESSAGE = 'This app needs hardware virtualization (KVM). It is not available on this machine.';

export const KVM_MISSING_DETAIL =
  'This app requires /dev/kvm on the host (QEMU/KVM). KVM is typically available only on Linux hosts with nested virtualization enabled — not on Docker Desktop for macOS/Windows.';

export function createKvmMissingError(): AppLifecycleError {
  return new AppLifecycleError(KVM_MISSING_USER_MESSAGE, {
    code: KVM_MISSING_CODE,
    detail: KVM_MISSING_DETAIL,
  });
}

export type AppCommandFailureResult = {
  success: false;
  message: string;
  errorCode?: string;
  errorDetail?: string;
  settingsPath?: string;
  /** True when the command stopped because the operation was cancelled (vs. failed). */
  cancelled?: boolean;
  /** Resting status a before-PONR cancel reverted to (e.g. 'stopped'); unused by install. */
  cancelledStatus?: string;
  /** A failed update put the previous version back (and running again, if it was running). */
  rolledBack?: boolean;
};

export type AppCommandResult = { success: true; message: string } | AppCommandFailureResult;

export function toAppCommandFailureResult(err: unknown): AppCommandFailureResult {
  if (err instanceof AppLifecycleError) {
    return {
      success: false,
      message: err.message,
      errorCode: err.errorCode,
      errorDetail: err.errorDetail,
      settingsPath: err.settingsPath,
    };
  }

  if (err instanceof Error) {
    return { success: false, message: err.message };
  }

  return { success: false, message: String(err) };
}

export function translateDockerNetworkOverlapError(error: unknown, conflictingCidrs: string[] = []): AppLifecycleError | null {
  if (!isDockerNetworkOverlapError(error)) {
    return null;
  }

  const fromMessage = extractOverlapCidrsFromError(error);
  const merged = [...new Set([...conflictingCidrs, ...fromMessage])];
  return createNetworkOverlapError(merged);
}

export function translateRocmKfdInstallMessage(message: string): AppLifecycleError | null {
  const normalizedMessage = message.toLowerCase();
  // Docker checks compose `devices` entries in order and fails on the first one it can't
  // attach. ROCm apps list /dev/dri before /dev/kfd (see CI-Marketplace comfyui/hunyuan3d-rocm
  // docker-compose.json), so a host missing both reports /dev/dri in the error text, not
  // /dev/kfd — match either device path, not just /dev/kfd.
  const referencesRocmDevice = normalizedMessage.includes('/dev/kfd') || normalizedMessage.includes('/dev/dri');
  const missingRocmDevice =
    normalizedMessage.includes('error gathering device information') && normalizedMessage.includes('no such file or directory');
  const blockedKfdPath = normalizedMessage.includes('file path') && normalizedMessage.includes('is not allowed');

  if (referencesRocmDevice && (missingRocmDevice || blockedKfdPath)) {
    return createRocmKfdMissingError();
  }

  if (message === ROCM_KFD_MISSING_DETAIL || message === ROCM_KFD_MISSING_USER_MESSAGE) {
    return createRocmKfdMissingError();
  }

  return null;
}

export function translateKvmInstallMessage(message: string): AppLifecycleError | null {
  const normalizedMessage = message.toLowerCase();
  const referencesKvm = normalizedMessage.includes('/dev/kvm');
  const missingDevice = normalizedMessage.includes('error gathering device information') && normalizedMessage.includes('no such file or directory');
  const blockedPath = normalizedMessage.includes('file path') && normalizedMessage.includes('is not allowed');

  if (referencesKvm && (missingDevice || blockedPath)) {
    return createKvmMissingError();
  }

  if (message === KVM_MISSING_DETAIL || message === KVM_MISSING_USER_MESSAGE) {
    return createKvmMissingError();
  }

  return null;
}
