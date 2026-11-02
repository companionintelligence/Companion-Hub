import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerReadFacade } from '../docker-read.facade';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const spawn = vi.mocked(child_process.spawn);

/** `docker logs` printing `text` to stderr, as the CLI does for its own errors and for a container's stderr, and exiting with `code`. */
function dockerLogsExits(code: number, text: string) {
  spawn.mockImplementation((() => {
    const cmd = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      cmd.stderr.emit('data', Buffer.from(text));
      cmd.emit('close', code);
    });
    return cmd;
  }) as never);
}

describe('DockerReadFacade.tailContainerLogs', () => {
  // Reads no state of the facade, so it needs none of what the facade is built from.
  const facade = Object.create(DockerReadFacade.prototype) as DockerReadFacade;

  beforeEach(() => {
    spawn.mockReset();
  });

  it("gives a container's own stderr", async () => {
    dockerLogsExits(0, 'exec /app/run: permission denied\n');

    await expect(facade.tailContainerLogs('app-web-1')).resolves.toBe('exec /app/run: permission denied');
  });

  it("does not pass Docker's own error off as the container's log", async () => {
    dockerLogsExits(1, 'Error response from daemon: can not get logs from container which is dead or marked for removal\n');

    await expect(facade.tailContainerLogs('app-db-1')).resolves.toBe('(failed to capture logs)');
  });
});
