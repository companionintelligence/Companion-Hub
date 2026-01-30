import * as esbuild from 'esbuild';

async function build() {
  await esbuild.build({
    entryPoints: ['./src/main.ts'],
    outdir: './dist',
    format: 'esm',
    platform: 'node',
    sourcemap: true,
    minify: false,
    bundle: true,
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    external: [
      'argon2',
      'class-transformer',
      '@nestjs/typeorm',
      '@nestjs/mongoose',
      '@nestjs/sequelize',
      '@mikro-orm/core',
      '@fastify/static',
      '@nestjs/microservices',
      '@nestjs/websockets',
      'cpu-features',
      'ssh2',
    ],
  });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
