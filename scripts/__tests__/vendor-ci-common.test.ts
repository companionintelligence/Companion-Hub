/**
 * `scripts/vendor-ci-common.mjs` copies CI Common files into the Hub. CI Common is private, and its files
 * carry a notice that says so and asks not to be distributed. The Hub is PolyForm Noncommercial, so its
 * copies carry the Hub's notice instead.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCiCommonNotice, relicense } from '../vendor-ci-common.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const CI_COMMON_LINES = [
  'Copyright (c) Lifescope Inc. All rights reserved.',
  'Private & Confidential — Property of Lifescope Inc. Do not distribute.',
];
const HUB_LINE = 'Copyright (c) Lifescope Inc. Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md.';

describe('vendor-ci-common license notice', () => {
  it.each([
    ['a Rust file', '// '],
    ['a TOML file', '# '],
    ['an HTML comment', '  '],
  ])("swaps CI Common's notice for the Hub's in %s", (_kind, prefix) => {
    const source = `${CI_COMMON_LINES.map((line) => prefix + line).join('\n')}\n\nconst body = 1;\n`;

    expect(relicense(Buffer.from(source)).toString('utf8')).toBe(`${prefix}${HUB_LINE}\n\nconst body = 1;\n`);
  });

  it("gives a Cargo manifest the Hub's license", () => {
    const manifest = `# ${CI_COMMON_LINES[0]}\n# ${CI_COMMON_LINES[1]}\n\n[package]\nname = "tauri-plugin-ci-auth"\nlicense = "UNLICENSED"\npublish = false\n`;

    const copy = relicense(Buffer.from(manifest)).toString('utf8');

    expect(copy).toContain('license = "PolyForm-Noncommercial-1.0.0"');
    expect(hasCiCommonNotice(Buffer.from(copy))).toBe(false);
  });

  it('leaves a file without the notice exactly as it is, binary files included', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    const css = Buffer.from(':root { --radius: 9px; }\n');

    expect(relicense(png)).toBe(png);
    expect(relicense(css)).toBe(css);
  });

  it('finds no CI Common notice in any vendored copy, and --check passes', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages/frontend/ci-common.vendor.json'), 'utf8')) as { files: { dest: string }[] };

    const withCiCommonNotice = manifest.files.map((entry) => entry.dest).filter((dest) => hasCiCommonNotice(readFileSync(resolve(repoRoot, dest))));

    expect(withCiCommonNotice).toEqual([]);
    expect(() => execFileSync(process.execPath, [resolve(repoRoot, 'scripts/vendor-ci-common.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
