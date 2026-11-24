import { describe, expect, it } from 'vitest';
import {
  NETWORK_OVERLAP_CODE,
  NETWORK_OVERLAP_USER_MESSAGE,
  KVM_MISSING_CODE,
  ROCM_KFD_MISSING_CODE,
  createNetworkOverlapError,
  translateDockerNetworkOverlapError,
  translateKvmInstallMessage,
  translateRocmKfdInstallMessage,
} from '../app-lifecycle-errors';

describe('app-lifecycle-errors network overlap', () => {
  it('creates a structured network overlap error', () => {
    const error = createNetworkOverlapError(['10.128.10.0/24']);

    expect(error.errorCode).toBe(NETWORK_OVERLAP_CODE);
    expect(error.message).toBe(NETWORK_OVERLAP_USER_MESSAGE);
    expect(error.errorDetail).toContain('10.128.10.0/24');
  });

  it('translates Docker overlap daemon errors', () => {
    const translated = translateDockerNetworkOverlapError(new Error('networks have overlapping IPv4 for 10.128.10.0/24'));

    expect(translated?.errorCode).toBe(NETWORK_OVERLAP_CODE);
    expect(translated?.errorDetail).toContain('10.128.10.0/24');
  });
});

describe('translateKvmInstallMessage', () => {
  it('translates a Kata failure that names KVM', () => {
    const translated = translateKvmInstallMessage('kata-runtime: Could not access KVM kernel module: No such file or directory');

    expect(translated?.errorCode).toBe(KVM_MISSING_CODE);
  });

  it.each([
    ['a Kata runtime registered with a binary that is not installed', 'fork/exec /var/lib/docker/runtimes/kata: no such file or directory'],
    ['a missing file of an app with kata in its name', 'bind source path does not exist: /data/apps/kata-test/config: no such file or directory'],
  ])('leaves %s alone', (_case, message) => {
    expect(translateKvmInstallMessage(message)).toBeNull();
  });
});

describe('translateRocmKfdInstallMessage', () => {
  it('translates a missing-device error that references /dev/kfd', () => {
    const translated = translateRocmKfdInstallMessage(
      'Error response from daemon: error gathering device information while adding custom device "/dev/kfd": no such file or directory',
    );

    expect(translated?.errorCode).toBe(ROCM_KFD_MISSING_CODE);
  });

  // Reproduces production Sentry issue dfe2be44b8084d35b76c6d1d282c043d: Docker checks compose
  // `devices` entries in order and fails on the first one it can't attach. ComfyUI/hunyuan3d-rocm
  // list /dev/dri before /dev/kfd, so a host missing both devices reports /dev/dri in the error
  // text — this must still translate to the friendly ROCm guidance, not fall through unclassified.
  it('translates a missing-device error that references /dev/dri instead of /dev/kfd', () => {
    const translated = translateRocmKfdInstallMessage(
      'Error response from daemon: error gathering device information while adding custom device "/dev/dri": no such file or directory',
    );

    expect(translated?.errorCode).toBe(ROCM_KFD_MISSING_CODE);
    expect(translated?.message).toContain('Set up ROCm in AI Settings');
  });

  it('does not translate unrelated device errors', () => {
    const translated = translateRocmKfdInstallMessage(
      'Error response from daemon: error gathering device information while adding custom device "/dev/sda": no such file or directory',
    );

    expect(translated).toBeNull();
  });
});
