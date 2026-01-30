import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/main.ts'],
  outdir: './dist',
  format: 'esm',
  platform: 'node',
  sourcemap: true,
  minify: false,
  bundle: true,
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
  ],
});
