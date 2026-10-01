import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleLocalRequires, checkBundle } from './scripts/bundle-requires';

const nodeExternals = builtinModules.flatMap((m) => [m, `node:${m}`]);

/*
 * Packages left out of the bundle on purpose (esbuild also treats every subpath of an entry as
 * external). The runtime image has no node_modules beyond what the Dockerfile's runner stage
 * `npm install`s, so each entry here is either in that install or optional: loaded inside a
 * try/catch or by a code path the Hub never takes, and absent at runtime. A package that is neither
 * crashes the Hub when it is loaded. checkBundle() below holds the bundle to this list.
 */
const packageExternals = [
  // Installed by the runner stage's `npm install` in the Dockerfile (argon2 is a native addon).
  'argon2',
  'class-transformer',
  'drizzle-orm',
  '@opentelemetry/api',
  'ssh2',
  'pg',
  'i18next-fs-backend',
  // Optional and absent at runtime. class-transformer 0.5.1 has no root `storage` entry (only
  // `cjs/storage`); @nestjs/mapped-types asks for it only in the catch after `cjs/storage` fails.
  'class-transformer/storage',
  // Nest's loaders for adapters and ORMs the Hub does not use (FastifyLoader is only chosen on the
  // Fastify adapter; the Hub runs Express), and ssh2's optional native speed-up.
  '@nestjs/typeorm',
  '@nestjs/mongoose',
  '@nestjs/sequelize',
  '@mikro-orm/core',
  '@fastify/static',
  '@nestjs/microservices',
  '@nestjs/websockets',
  'cpu-features',
  // Swagger UI's static assets. @nestjs/swagger asks swagger-ui-dist for the folder they live in
  // only when SwaggerModule.setup() serves the UI, and main.ts skips that under
  // NODE_ENV=production, which the runtime image sets, so production never makes this lookup.
  // Bundled, `absolute-path.js` would answer with the bundle's own directory, and a non-production
  // run of the image would serve /app (main.js, package.json, assets) under /api/docs instead of
  // the UI. Left external, the lookup fails with "Cannot find module", which main.ts catches and
  // logs, so that run boots without the Swagger UI.
  'swagger-ui-dist',
];

/*
 * Runtime lookups that are neither builtins nor externals, and that the image cannot satisfy. Each
 * sits behind a guard or on a path the Hub does not take; all but @mastra/observability were also in
 * the last bundle that booted on the fleet before NestJS 12. Add to this only with the same kind of
 * reason.
 */
const knownMissingAtRuntime: Record<string, string> = {
  'osx-temperature-sensor': "systeminformation's optional macOS sensor, required inside try/catch on darwin only",
  'macos-temperature-sensor': "systeminformation's optional macOS sensor, required inside try/catch on darwin only",
  // `require('process/')` and `require('string_decoder/')` name the npm shims (the trailing slash
  // rules out the builtin), which the image does not install. readable-stream@3 asks for
  // string_decoder/ only for a stream created with an `encoding`. readable-stream@4 is loaded only
  // when isomorphic-git's Node HTTP client is handed a streaming request body, and its fetch, push
  // and ref listing all send arrays, which it buffers instead.
  'process/': "readable-stream@4, reached only by a streaming isomorphic-git request body, which isomorphic-git's own commands never send",
  'string_decoder/': 'readable-stream@3 for an `encoding` stream only; readable-stream@4 as for process/',
  // Arrived with Sentry 11 (#1714). Its Mastra integration looks for @mastra/observability through
  // `createRequire(<cwd or @mastra/core's file>)` only when a Mastra instance is constructed, which
  // the Hub never does, and catches the miss with a warning.
  '@mastra/observability':
    "@sentry/server-utils' Mastra integration, reached only when a Mastra instance is constructed (the Hub has none), inside try/catch",
};

// Copy non-TypeScript asset files
const assetsDir = join(__dirname, 'dist/modules/app-lifecycle/data');
mkdirSync(assetsDir, { recursive: true });
try {
  copyFileSync(join(__dirname, 'src/modules/app-lifecycle/data/openclaw-ci-entrypoint.sh'), join(assetsDir, 'openclaw-ci-entrypoint.sh'));
} catch (err) {
  console.error('[Build Error] Failed to bundle OpenClaw fallback entrypoint:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const outfile = './dist/main.js';

/**
 * Fails the build when the bundle would load a module the runtime image does not have. Nothing in
 * CI boots this bundle, so without this check a missing module surfaces only when a Hub crash-loops
 * on the new image (NestJS 12 shipped exactly that).
 */
function verifyBundle() {
  const { unexpected, unusedAllowlist } = checkBundle(readFileSync(outfile, 'utf8'), packageExternals, knownMissingAtRuntime);
  for (const specifier of unusedAllowlist) {
    console.warn(`[bundle] "${specifier}" is allowlisted in build.ts but the bundle no longer loads it; the entry can go.`);
  }
  if (unexpected.length === 0) {
    return;
  }
  console.error(
    [
      `[Build Error] ${outfile} loads ${unexpected.length} module(s) at runtime that the Hub image does not install:`,
      ...unexpected.map(({ specifier, via, line }) => `  ${via}("${specifier}")  at ${outfile}:${line}`),
      '',
      'Each one would crash the Hub (or the feature using it) with "Cannot find module" / "package is missing".',
      'A `requireN(...)` caller, or a `createRequire(...)` called in place, is a package-local createRequire',
      'that esbuild could not see through: check bundleLocalRequires in scripts/bundle-requires.ts.',
      'Otherwise make the module bundleable, or, if it is genuinely optional, add it to packageExternals',
      'or knownMissingAtRuntime in build.ts with the reason it is safe.',
    ].join('\n'),
  );
  process.exit(1);
}

build({
  entryPoints: ['./dist/src/main.js'],
  outfile,
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  minify: false,
  bundle: true,
  plugins: [bundleLocalRequires],
  banner: {
    js: [
      `import { createRequire as __createRequire } from 'module';`,
      `import { fileURLToPath as __fileURLToPath } from 'url';`,
      `import { dirname as __dirnameFn } from 'path';`,
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameFn(__filename);',
    ].join('\n'),
  },
  external: [...nodeExternals, ...packageExternals],
}).then(
  verifyBundle,
  // esbuild has already printed its errors.
  () => process.exit(1),
);
