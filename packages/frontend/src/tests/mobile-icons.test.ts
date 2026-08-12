import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getLogo } from '@/lib/theme/theme';

/**
 * Guards the mobile app-icon critical path.
 *
 * Background: the Tauri iOS (`gen/apple/.../AppIcon.appiconset`) and Android
 * (`gen/android/.../res/mipmap-*`) icon sets are what actually get compiled
 * into the shipped apps. They are generated copies of the canonical CI brand
 * assets under `src-tauri/icons/`. A regression once left the whole `gen/` set
 * as the DEFAULT TAURI PLACEHOLDER (cyan/yellow "8") while `icons/` already
 * held the CI globe logo — so both simulators showed the wrong icon. These
 * tests assert, structurally:
 *   - every iOS AppIcon `Contents.json` entry maps to a real, non-empty PNG
 *     whose actual pixel dimensions equal its declared size x scale;
 *   - the Android launcher mipmaps exist for every expected density at the
 *     canonical Android pixel sizes;
 *   - every compiled `gen/` icon is byte-identical to its `icons/` source
 *     (catches the placeholder-drift / out-of-sync bug that caused this);
 *   - `tauri.conf.json` `bundle.icon` paths all exist and are non-empty;
 *   - `getLogo()` returns a path to a real in-app logo asset.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/frontend/src/tests
const srcTauri = path.resolve(here, '../../../mobile/src-tauri'); // packages/mobile/src-tauri
const frontendPublic = path.resolve(here, '../../public'); // packages/frontend/public

const iosSrcDir = path.join(srcTauri, 'icons/ios');
const iosGenDir = path.join(srcTauri, 'gen/apple/Assets.xcassets/AppIcon.appiconset');
const androidSrcDir = path.join(srcTauri, 'icons/android');
const androidGenDir = path.join(srcTauri, 'gen/android/app/src/main/res');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read a PNG, asserting it exists, is non-empty and has a valid PNG signature. */
function readPng(file: string): Buffer {
  expect(existsSync(file), `missing PNG: ${file}`).toBe(true);
  const buf = readFileSync(file);
  expect(buf.length, `empty PNG: ${file}`).toBeGreaterThan(0);
  expect(buf.subarray(0, 8).toString('hex'), `not a valid PNG (bad signature): ${file}`).toBe(PNG_SIGNATURE.toString('hex'));
  expect(buf.length, `PNG too small to contain an IHDR header: ${file}`).toBeGreaterThanOrEqual(24);
  return buf;
}

/** Actual pixel dimensions from the PNG IHDR chunk (big-endian width/height at bytes 16-23). */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function isNonEmptyFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile() && statSync(file).size > 0;
}

// ---------------------------------------------------------------------------
// iOS AppIcon set
// ---------------------------------------------------------------------------

interface IosImage {
  size: string;
  scale: string;
  filename?: string;
  idiom: string;
}

const iosContents = JSON.parse(readFileSync(path.join(iosGenDir, 'Contents.json'), 'utf8')) as {
  images: IosImage[];
};
const iosImages = iosContents.images.filter((i): i is Required<IosImage> => Boolean(i.filename));

describe('iOS AppIcon.appiconset', () => {
  it('Contents.json declares icon images', () => {
    expect(iosImages.length).toBeGreaterThan(0);
  });

  it.each(iosImages)('$filename ($idiom $size @$scale) is a real PNG sized to size x scale', ({ size, scale, filename }) => {
    const file = path.join(iosGenDir, filename);
    const buf = readPng(file);
    const { width, height } = pngDimensions(buf);

    const [wPart = 0, hPart = 0] = size.split('x').map((n) => Number.parseFloat(n));
    const scaleNum = Number.parseInt(scale, 10);
    const expectedW = Math.round(wPart * scaleNum);
    const expectedH = Math.round(hPart * scaleNum);

    expect({ width, height }, `${filename}: declared ${size}@${scale} => expected ${expectedW}x${expectedH}, got ${width}x${height}`).toEqual({
      width: expectedW,
      height: expectedH,
    });
  });
});

// ---------------------------------------------------------------------------
// Android launcher mipmaps
// ---------------------------------------------------------------------------

/** Canonical Android launcher (legacy square/round) and adaptive-foreground pixel sizes per density. */
const ANDROID_DENSITIES = [
  { dir: 'mipmap-mdpi', launcher: 48, foreground: 108 },
  { dir: 'mipmap-hdpi', launcher: 72, foreground: 162 },
  { dir: 'mipmap-xhdpi', launcher: 96, foreground: 216 },
  { dir: 'mipmap-xxhdpi', launcher: 144, foreground: 324 },
  { dir: 'mipmap-xxxhdpi', launcher: 192, foreground: 432 },
];

describe('Android launcher mipmaps', () => {
  it.each(ANDROID_DENSITIES)('$dir has launcher/round/foreground PNGs at canonical sizes', ({ dir, launcher, foreground }) => {
    const cases: Array<[string, number]> = [
      ['ic_launcher.png', launcher],
      ['ic_launcher_round.png', launcher],
      ['ic_launcher_foreground.png', foreground],
    ];
    for (const [name, expected] of cases) {
      const buf = readPng(path.join(androidGenDir, dir, name));
      const { width, height } = pngDimensions(buf);
      expect({ width, height }, `${dir}/${name}: expected ${expected}x${expected}, got ${width}x${height}`).toEqual({
        width: expected,
        height: expected,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// gen/ icons must stay byte-identical to their icons/ source
// (this is the invariant that broke: gen held placeholder art, source held CI art)
// ---------------------------------------------------------------------------

describe('generated platform icons stay in sync with icons/ source', () => {
  const iosSrcFiles = readdirSync(iosSrcDir).filter((f) => f.endsWith('.png'));

  it('there are iOS source icons to compare', () => {
    expect(iosSrcFiles.length).toBeGreaterThan(0);
  });

  it.each(iosSrcFiles)('iOS gen/%s is byte-identical to icons/ios source', (f) => {
    const src = readPng(path.join(iosSrcDir, f));
    const gen = readPng(path.join(iosGenDir, f));
    expect(gen.toString('hex'), `gen AppIcon ${f} differs from source icons/ios/${f}`).toBe(src.toString('hex'));
  });

  it.each(ANDROID_DENSITIES)('Android $dir gen mipmaps are byte-identical to icons/android source', ({ dir }) => {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const src = readPng(path.join(androidSrcDir, dir, name));
      const gen = readPng(path.join(androidGenDir, dir, name));
      expect(gen.toString('hex'), `gen ${dir}/${name} differs from source icons/android/${dir}/${name}`).toBe(src.toString('hex'));
    }
  });
});

// ---------------------------------------------------------------------------
// tauri.conf.json bundle.icon paths
// ---------------------------------------------------------------------------

const tauriConf = JSON.parse(readFileSync(path.join(srcTauri, 'tauri.conf.json'), 'utf8')) as {
  bundle: { icon: string[] };
};

describe('tauri.conf.json bundle.icon', () => {
  it('declares bundle icons', () => {
    expect(Array.isArray(tauriConf.bundle.icon)).toBe(true);
    expect(tauriConf.bundle.icon.length).toBeGreaterThan(0);
  });

  it.each(tauriConf.bundle.icon)('bundle.icon "%s" exists and is non-empty', (rel) => {
    const file = path.resolve(srcTauri, rel);
    expect(isNonEmptyFile(file), `bundle.icon points at missing/empty file: ${rel}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-app logo (getLogo)
// ---------------------------------------------------------------------------

describe('getLogo() in-app logo', () => {
  it.each([true, false])('getLogo(%s) resolves to a real public asset', (auto) => {
    const rel = getLogo(auto);
    expect(typeof rel).toBe('string');
    expect(rel.startsWith('/')).toBe(true);
    const file = path.join(frontendPublic, rel.replace(/^\//, ''));
    expect(isNonEmptyFile(file), `getLogo(${auto}) => ${rel} is missing/empty in public/`).toBe(true);
  });

  // Both possible getLogo() branches (default + christmas) must have real assets,
  // independent of the current date.
  it.each(['/hub.png', '/hub-christmas.png'])('logo asset %s exists in public/', (rel) => {
    const file = path.join(frontendPublic, rel.replace(/^\//, ''));
    expect(isNonEmptyFile(file), `logo asset missing/empty: ${rel}`).toBe(true);
  });
});
