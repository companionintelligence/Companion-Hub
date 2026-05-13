import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const nodeExternals = builtinModules.flatMap((m) => [m, `node:${m}`]);

// Copy non-TypeScript asset files
const assetsDir = join(__dirname, 'dist/modules/app-lifecycle/data');
mkdirSync(assetsDir, { recursive: true });
copyFileSync(join(__dirname, 'src/modules/app-lifecycle/data/openclaw-ci-entrypoint.sh'), join(assetsDir, 'openclaw-ci-entrypoint.sh'));

build({
  entryPoints: ['./dist/src/main.js'],
  outfile: './dist/main.js',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  minify: false,
  bundle: true,
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
  external: [
    ...nodeExternals,
    'argon2',
    '@nestjs/typeorm',
    '@nestjs/mapped-types',
    'class-transformer',
    '@nestjs/mapped-types',
    'class-transformer/storage',
    '@nestjs/mongoose',
    '@nestjs/sequelize',
    '@mikro-orm/core',
    '@fastify/static',
    '@nestjs/microservices',
    '@nestjs/websockets',
    'cpu-features',
    'drizzle-orm',
    '@opentelemetry/api',
    'ssh2',
    'pg',
    'i18next-fs-backend',
  ],
}).catch(() => process.exit(1));
