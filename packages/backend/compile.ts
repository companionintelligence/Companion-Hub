import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { replaceTscAliasPaths } from 'tsc-alias';

/*
 * Compiles the backend into dist/, which is what `nest build` and `nest start --watch` did.
 *
 *   tsx compile.ts          one build (build.ts bundles it afterwards)
 *   tsx compile.ts --watch  local dev: rebuild on change, restart the server after each clean build
 *
 * TypeScript 7 ships the `tsc` executable but not the programmatic compiler API the Nest CLI
 * loads, so the CLI refuses to start. tsc emits the same CommonJS, decorator metadata included.
 * The two things the CLI added on top happen here:
 *  - `@/…` imports become relative paths (tsc-alias). `node dist/src/main.js`, which e2e,
 *    gen:swagger and local dev all run, has nothing else to resolve them.
 *  - The Drizzle migration SQL is copied to dist/assets/migrations, as nest-cli.json's assets rule did.
 */

const watch = process.argv.includes('--watch');
const tsconfig = join(__dirname, 'tsconfig.json');
const outDir = join(__dirname, 'dist');
const tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const serverEntry = join(outDir, 'src', 'main.js');

/** One build reports "Found 3 errors. Watching for file changes." when it settles. */
const BUILD_SETTLED = /Found (\d+) errors?\. Watching for file changes\./;

function copyMigrations() {
  const from = join(__dirname, 'src/core/database/drizzle');
  const to = join(outDir, 'assets/migrations');
  mkdirSync(to, { recursive: true });
  for (const file of readdirSync(from)) {
    if (file.endsWith('.sql')) {
      copyFileSync(join(from, file), join(to, file));
    }
  }
}

function rewriteAliases() {
  return replaceTscAliasPaths({ configFile: tsconfig, outDir });
}

/** The newest write under dist/. A build that emitted nothing leaves it where it was. */
function newestOutput() {
  let newest = 0;
  for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
    }
  }
  return newest;
}

async function compileOnce() {
  // On Node 22.15+ the tsc shim execs the native compiler in place, so its exit status is tsc's.
  const result = spawnSync(process.execPath, [tscBin, '-p', tsconfig], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    // A tsc killed by a signal (the OOM killer in a busy builder, say) has no status of its own.
    if (result.signal) {
      console.error(`tsc was stopped by ${result.signal}`);
    }
    process.exit(result.status ?? 1);
  }
  await rewriteAliases();
  copyMigrations();
}

function compileAndServe() {
  let server: ChildProcess | undefined;
  let restarting = Promise.resolve();
  let closing = false;

  const stopServer = () => {
    const current = server;
    server = undefined;
    if (!current || current.exitCode !== null || current.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // Graceful first, as Nest's shutdown hooks close the database and queue; a hung one still goes.
      const force = setTimeout(() => current.kill('SIGKILL'), 10_000);
      current.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      current.kill('SIGTERM');
    });
  };

  let servedOutput = 0;
  const settle = async (clean: boolean) => {
    // tsc emits even when a build has type errors, so the aliases are rewritten after every build:
    // dist/ never holds a raw `@/…` require that the running server, or anything else, could load.
    await rewriteAliases();
    // A build with errors leaves the last good server running.
    if (!clean || closing) {
      return;
    }
    // TypeScript 7's watcher rebuilds on any write under the project, `exclude` or not, and the
    // dev server rewrites src/swagger.json each time it boots. Restarting on a build that
    // emitted nothing would boot, rewrite, rebuild and restart forever.
    const output = newestOutput();
    if (server && output === servedOutput) {
      return;
    }
    servedOutput = output;
    await stopServer();
    // Shutdown may have begun while the old server stopped; a server started now would outlive it.
    if (closing) {
      return;
    }
    // The absolute path is what `cihub up local` looks for when it clears a stale dev backend.
    server = spawn(process.execPath, [serverEntry], { stdio: 'inherit' });
  };

  copyMigrations();
  const tsc = spawn(process.execPath, [tscBin, '-p', tsconfig, '--watch', '--preserveWatchOutput'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let pending = '';
  tsc.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    const lines = (pending + chunk.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const settled = BUILD_SETTLED.exec(line);
      if (settled && !closing) {
        const clean = settled[1] === '0';
        restarting = restarting.then(() => settle(clean)).catch((error: unknown) => console.error('Restart failed:', error));
      }
    }
  });

  const shutdown = async (code: number) => {
    if (closing) {
      return;
    }
    closing = true;
    tsc.kill('SIGTERM');
    await restarting;
    await stopServer();
    process.exit(code);
  };
  tsc.on('exit', (code) => void shutdown(code ?? 1));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

rmSync(outDir, { recursive: true, force: true });

if (watch) {
  compileAndServe();
} else {
  compileOnce().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
