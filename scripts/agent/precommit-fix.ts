#!/usr/bin/env tsx
/**
 * Pre-commit fix: biome --write, then optional agent fix hints.
 * Usage: pnpm exec tsx scripts/agent/precommit-fix.ts [files...]
 * Set CURSOR_AGENT_FIX=1 to print LLM remediation instructions for remaining issues.
 */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

const files = process.argv.slice(2);
const target = files.length > 0 ? files.join(' ') : '.';

process.chdir(ROOT);

console.log('▶ biome check --write');
try {
  execSync(`pnpm exec biome check --write --no-errors-on-unmatched ${target}`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch {
  // biome may exit non-zero if unfixable issues remain
}

console.log('▶ biome ci (verify)');
let hasRemaining = false;
try {
  execSync(`pnpm exec biome ci ${target} --error-on-warnings --no-errors-on-unmatched`, {
    stdio: 'inherit',
    env: process.env,
  });
} catch {
  hasRemaining = true;
}

if (hasRemaining && process.env.CURSOR_AGENT_FIX === '1') {
  console.log('');
  console.log('=== CURSOR_AGENT_FIX=1 — remaining issues need agent remediation ===');
  console.log('Paste this into Cursor Agent (Composer 2.5 or similar):');
  console.log('');
  console.log(`Fix all remaining Biome diagnostics in: ${target || 'staged files'}`);
  console.log('Rules: docs/agent/CODING_CONVENTIONS.md — no non-null assertions, explicit mock types.');
  console.log('Run pnpm run lint:ci after fixing. Do not skip hooks.');
  process.exit(1);
}

if (hasRemaining) {
  console.error('Unfixable Biome issues remain. Set CURSOR_AGENT_FIX=1 for agent remediation hints.');
  process.exit(1);
}

console.log('✓ precommit-fix complete');
