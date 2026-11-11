import { describe, expect, it } from 'vitest';
import { hbpeNightlyManifest } from '../examples';
import { parseTrainingJobManifest, trainingJobManifestSchema } from '../training-job.manifest';

const USER = '11111111-2222-3333-4444-555555555555';

function base(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(hbpeNightlyManifest(USER)));
}

describe('training job manifest', () => {
  it('accepts the HBPE nightly pipeline unchanged', () => {
    const parsed = parseTrainingJobManifest(base());
    expect(parsed.steps.map((s) => s.name)).toContain('lora');
    expect(parsed.steps.every((s) => s.onFailure === 'continue')).toBe(true);
  });

  it('applies defaults', () => {
    const m = base();
    (m.steps as Array<Record<string, unknown>>)[0] = { name: 'label' };
    const parsed = parseTrainingJobManifest(m);
    expect(parsed.steps[0]).toEqual({ name: 'label', onFailure: 'continue', etaSeconds: 120 });
  });

  it('rejects a writable data mount', () => {
    const m = base();
    (m.data as { mounts: Array<Record<string, unknown>> }).mounts[0].mode = 'rw';
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects trainers that ask for network access', () => {
    const m = base();
    (m.data as Record<string, unknown>).network = 'egress';
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects artifacts written inside a read-only mount', () => {
    const m = base();
    (m.artifacts as Record<string, unknown>).dir = '/data/memory/hbpe/out';
    const r = trainingJobManifestSchema.safeParse(m);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('read-only data mount');
  });

  it('rejects duplicate step names', () => {
    const m = base();
    (m.steps as Array<Record<string, unknown>>).push({ name: 'train' });
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });

  it('needs a trigger', () => {
    const m = base();
    m.trigger = {};
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects gpu-only jobs that ship only a cpu image', () => {
    const m = base();
    (m.resources as Record<string, unknown>).device = 'gpu';
    (m.resources as Record<string, unknown>).images = ['cpu'];
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });

  it('rejects malformed step names', () => {
    const m = base();
    (m.steps as Array<Record<string, unknown>>)[0] = { name: 'Label Items' };
    expect(trainingJobManifestSchema.safeParse(m).success).toBe(false);
  });
});
