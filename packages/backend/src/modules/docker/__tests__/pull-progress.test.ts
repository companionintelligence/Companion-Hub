import { describe, expect, it } from 'vitest';
import { type DockerPullLayerSnapshot, imageSizeKnown, isDownloadPhase, shortLayerId, summarizePullLayers } from '../pull-progress';

const MB = 1024 * 1024;

/** ZeroNote 1.0.12's three layers with data, as Docker announces them before any has started. */
const announced = (): Map<string, DockerPullLayerSnapshot> =>
  new Map([
    ['6a0ac1617861', { current: 0, total: 0, status: 'Pulling fs layer' }],
    ['82736a35d0e7', { current: 0, total: 0, status: 'Pulling fs layer' }],
    ['612c0c1df4c5', { current: 0, total: 0, status: 'Pulling fs layer' }],
  ]);

const MANIFEST = new Map([
  ['6a0ac1617861', 3_864_189],
  ['82736a35d0e7', 1_870_921],
  ['612c0c1df4c5', 20_248_489],
]);
const FULL = 3_864_189 + 1_870_921 + 20_248_489;

const known = (layers: Map<string, DockerPullLayerSnapshot>, expected?: ReadonlyMap<string, number>, downloadStarted = true) =>
  imageSizeKnown({ layerIds: new Set(layers.keys()), layers, expected, downloadStarted, complete: false });

describe('summarizePullLayers', () => {
  it('counts the whole download from the first update when the manifest gave the layer sizes', () => {
    const layers = announced();
    layers.set('6a0ac1617861', { current: MB, total: 3_864_189, status: 'Downloading' });

    const summary = summarizePullLayers(layers, MANIFEST);

    expect(summary.totalBytes).toBe(FULL);
    expect(summary.completedBytes).toBe(MB);
  });

  it('without the manifest, counts only the layers that have reported a size', () => {
    const layers = announced();
    layers.set('6a0ac1617861', { current: 3 * MB, total: 3_864_189, status: 'Downloading' });

    // This is the "3.0 MB / 3.7 MB" the page used to show for a 26 MB download.
    expect(summarizePullLayers(layers).totalBytes).toBe(3_864_189);
  });

  it('leaves a layer already on disk out of the total, even when the manifest lists it', () => {
    const layers = announced();
    layers.set('82736a35d0e7', { current: 0, total: 0, status: 'Already exists' });

    expect(summarizePullLayers(layers, MANIFEST).totalBytes).toBe(3_864_189 + 20_248_489);
  });

  it('keeps a size Docker reported over the manifest one', () => {
    const layers = new Map([['6a0ac1617861', { current: 0, total: 4_000_000, status: 'Downloading' }]]);

    expect(summarizePullLayers(layers, MANIFEST).totalBytes).toBe(4_000_000);
  });
});

describe('imageSizeKnown', () => {
  it('is not known while a started download still has layers waiting with no size', () => {
    const layers = announced();
    layers.set('6a0ac1617861', { current: MB, total: 3_864_189, status: 'Downloading' });

    expect(known(layers)).toBe(false);
  });

  it('is known once every layer has reported a size or finished', () => {
    const layers = announced();
    layers.set('6a0ac1617861', { current: MB, total: 3_864_189, status: 'Downloading' });
    layers.set('82736a35d0e7', { current: 0, total: 0, status: 'Download complete' });
    layers.set('612c0c1df4c5', { current: 0, total: 20_248_489, status: 'Downloading' });

    expect(known(layers)).toBe(true);
  });

  it('is known as soon as the manifest sizes and every layer it names have arrived, before any download starts', () => {
    expect(known(announced(), MANIFEST, false)).toBe(true);
  });

  it('is not known from the manifest while Docker has announced only some of its layers', () => {
    const layers = new Map([['6a0ac1617861', { current: 0, total: 0, status: 'Pulling fs layer' }]]);

    expect(known(layers, MANIFEST, false)).toBe(false);
  });

  // Classic Docker prints "Already exists" in a layer's place while it is still announcing the others.
  it('does not take an early "Already exists" as the start of the download', () => {
    expect(isDownloadPhase('Already exists')).toBe(false);
    const layers = new Map([['6a0ac1617861', { current: 0, total: 0, status: 'Already exists' }]]);

    expect(known(layers, undefined, isDownloadPhase('Already exists'))).toBe(false);
  });

  it('is known for a finished image whatever its layers said', () => {
    expect(imageSizeKnown({ layerIds: new Set(), layers: new Map(), expected: undefined, downloadStarted: false, complete: true })).toBe(true);
  });
});

describe('shortLayerId', () => {
  it("is the first 12 hex digits of the digest, the id Docker's events use", () => {
    expect(shortLayerId('sha256:612c0c1df4c5aa0b8c1f2e3d4c5b6a7980112233445566778899aabbccddeeff')).toBe('612c0c1df4c5');
  });
});
