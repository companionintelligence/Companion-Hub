import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remapContainerDataPath } from '../container-paths';

describe('remapContainerDataPath', () => {
  const localDataDir = '/Users/dev/ci-hub/.internal';

  it('passes through when DATA_DIR is the container root', () => {
    expect(remapContainerDataPath('/data/state/hardware/host_metrics.json', '/data')).toBe(path.resolve('/data/state/hardware/host_metrics.json'));
  });

  it('remaps /data paths to the local DATA_DIR in source dev', () => {
    expect(remapContainerDataPath('/data/state/hardware/host_metrics.json', localDataDir)).toBe(
      path.join(localDataDir, 'state/hardware/host_metrics.json'),
    );
  });

  it('leaves non-container paths unchanged', () => {
    expect(remapContainerDataPath('/tmp/probe.json', localDataDir)).toBe(path.resolve('/tmp/probe.json'));
  });

  it('does not remap paths that only share the /data prefix', () => {
    expect(remapContainerDataPath('/data-backup/state.json', localDataDir)).toBe(path.resolve('/data-backup/state.json'));
  });
});
