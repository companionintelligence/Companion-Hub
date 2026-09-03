import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutDir = join(pluginRoot, 'dist');
const defaultOutFile = join(defaultOutDir, 'hub-plugin.mjs');

mkdirSync(defaultOutDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(pluginRoot, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: defaultOutFile,
  target: 'node22',
  sourcemap: false,
});

console.log(`Bundled CI-Hub OpenClaw plugin → ${defaultOutFile}`);

const externalOutDir = process.env.OPENCLAW_PLUGIN_OUT_DIR?.trim();
if (externalOutDir) {
  mkdirSync(externalOutDir, { recursive: true });
  const externalOutFile = join(externalOutDir, 'hub-plugin.mjs');
  copyFileSync(defaultOutFile, externalOutFile);
  console.log(`Copied CI-Hub OpenClaw plugin → ${externalOutFile}`);
}
