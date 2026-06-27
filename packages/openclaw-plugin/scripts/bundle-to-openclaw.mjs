import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(pluginRoot, '../../../CI-OpenClaw/openclaw-context/plugins/ci-hub');

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(pluginRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(outDir, 'hub-plugin.mjs'),
  target: 'node22',
  sourcemap: false,
});

console.log(`Bundled CI-Hub OpenClaw plugin → ${outDir}/hub-plugin.mjs`);
