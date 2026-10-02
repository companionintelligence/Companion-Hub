import { describe, expect, it, vi } from 'vitest';
import { type IntegrationRunnerIo, runIntegrationTests } from '../integration-runner';

const RUN = { composeFile: '/repo/db.compose.yml', projectName: 'test-backend-1', vitestArgs: ['-t', 'update'], env: { PATH: '/usr/bin' } };
const COMPOSE = ['compose', '-p', 'test-backend-1', '-f', '/repo/db.compose.yml'];
const DOWN = ['docker', [...COMPOSE, 'down', '-v']];

/** Docker and vitest as the run sees them; `fail` makes the matching command reject. */
function fakeIo(fail: { up?: boolean; vitest?: boolean; down?: boolean } = {}) {
  const commands: [string, string[]][] = [];
  const io: IntegrationRunnerIo = {
    run: vi.fn(async (command: string, args: string[]) => {
      commands.push([command, args]);
      const failing = (args.includes('up') && fail.up) || (args[0] === 'vitest' && fail.vitest) || (args.includes('down') && fail.down);
      if (failing) throw new Error('Command failed with code 1');
    }),
    output: vi.fn(async (_command: string, args: string[]) => (args.includes('db') ? '0.0.0.0:32768' : '[::]:32769')),
    log: vi.fn(),
    error: vi.fn(),
  };
  return { io, commands };
}

describe('runIntegrationTests', () => {
  it('runs the suite against the published ports, then removes the containers', async () => {
    const { io, commands } = fakeIo();

    expect(await runIntegrationTests(RUN, io)).toBe(0);
    expect(commands).toEqual([
      ['docker', [...COMPOSE, 'up', '-d', '--wait']],
      ['npx', ['vitest', '--watch=false', '--config', './vitest.integration.config.mts', '-t', 'update']],
      DOWN,
    ]);
    expect(io.run).toHaveBeenCalledWith(
      'npx',
      expect.any(Array),
      expect.objectContaining({ PATH: '/usr/bin', POSTGRES_PORT: '32768', RABBITMQ_PORT: '32769', POSTGRES_HOST: 'localhost' }),
    );
  });

  it('removes the containers after a failing suite, and fails', async () => {
    const { io, commands } = fakeIo({ vitest: true });

    expect(await runIntegrationTests(RUN, io)).toBe(1);
    expect(commands.at(-1)).toEqual(DOWN);
    expect(io.error).toHaveBeenCalledWith('Test run failed:', expect.any(Error));
  });

  it('removes what Compose managed to create when the containers never came up', async () => {
    const { io, commands } = fakeIo({ up: true });

    expect(await runIntegrationTests(RUN, io)).toBe(1);
    expect(commands.map(([, args]) => args.at(-1))).toEqual(['--wait', '-v']);
  });

  it('fails and says how to remove the containers by hand when the removal fails', async () => {
    const { io } = fakeIo({ down: true });

    expect(await runIntegrationTests(RUN, io)).toBe(1);
    expect(io.error).toHaveBeenCalledWith(
      'Could not remove the test containers. Remove them with: docker compose -p test-backend-1 -f /repo/db.compose.yml down -v',
      expect.any(Error),
    );
  });
});
