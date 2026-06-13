import path from 'node:path';
import { describe, expect, it } from 'vitest';

const { DEFAULT_OUTDIR, artifactFilename, detectHostRustTarget, parseArgs, resolveOutputPath, resolveStandaloneTarget } =
  require('../build-standalone-cli.cjs') as {
    DEFAULT_OUTDIR: string;
    artifactFilename: (target: { platformKey: string; archKey: string; extension: string }) => string;
    detectHostRustTarget: () => string;
    parseArgs: (args: string[]) => { target?: string; outdir: string; outfile?: string; help?: boolean };
    resolveOutputPath: (
      target: {
        platformKey: string;
        archKey: string;
        extension: string;
      },
      outdir?: string,
    ) => string;
    resolveStandaloneTarget: (target?: string) => {
      bunTarget: string;
      rustTarget: string;
      platformKey: string;
      archKey: string;
      extension: string;
    };
  };

describe('build-standalone-cli target mapping', () => {
  it('maps Linux x64 rust targets to a stable artifact name and baseline Bun target', () => {
    const target = resolveStandaloneTarget('x86_64-unknown-linux-gnu');
    expect(target.bunTarget).toBe('bun-linux-x64-baseline');
    expect(artifactFilename(target)).toBe('cihub-linux-x64');
  });

  it('keeps artifact names stable when a direct Bun target is supplied', () => {
    const target = resolveStandaloneTarget('bun-windows-x64-modern');
    expect(target.rustTarget).toBe('x86_64-pc-windows-msvc');
    expect(artifactFilename(target)).toBe('cihub-windows-x64.exe');
  });

  it('builds output paths under dist/cli by default', () => {
    const target = resolveStandaloneTarget('aarch64-apple-darwin');
    expect(resolveOutputPath(target, DEFAULT_OUTDIR)).toBe(path.join(DEFAULT_OUTDIR, 'cihub-macos-arm64'));
  });

  it('detects a supported host target on this machine', () => {
    const hostTarget = detectHostRustTarget();
    expect(resolveStandaloneTarget(hostTarget).rustTarget).toBe(hostTarget);
  });

  it('accepts an explicit outfile path', () => {
    const parsed = parseArgs(['--target', 'x86_64-unknown-linux-gnu', '--outfile', 'packages/desktop/src-tauri/resources/cihub']);
    expect(parsed.target).toBe('x86_64-unknown-linux-gnu');
    expect(parsed.outfile).toBe(path.resolve(process.cwd(), 'packages/desktop/src-tauri/resources/cihub'));
  });

  it('rejects a missing outfile value passed as a separate argument', () => {
    expect(() => parseArgs(['--outfile'])).toThrow('--outfile requires a path value');
  });

  it('rejects an empty outfile value passed with equals syntax', () => {
    expect(() => parseArgs(['--outfile='])).toThrow('--outfile requires a path value');
  });
});
