import { z } from 'zod';

/**
 * Generic training job manifest.
 *
 * Generalizes what HBPE hand-builds today (named steps with fail-continue, per-step ETA,
 * cooperative cancel, per-subject artifacts with compatibility fingerprints, resource etiquette
 * toward chat inference, and an offline quality bar) so any app can declare a training job and
 * let Hub own the lifecycle.
 *
 * Security posture is part of the schema, not a convention: trainers get read-only data mounts and
 * no network, because the data is the user's memory and a trainer has no reason to send it anywhere.
 */

export const TRAINING_IMAGE_VARIANTS = ['cpu', 'cuda', 'rocm'] as const;
export type TrainingImageVariant = (typeof TRAINING_IMAGE_VARIANTS)[number];

const stepSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'step names are lower_snake_case'),
  /** HBPE semantics: one step's error is recorded and does not block the rest. */
  onFailure: z.enum(['continue', 'stop']).default('continue'),
  /** First-guess wall clock. The runner refines it from observed rate. */
  etaSeconds: z.number().int().positive().default(120),
});

const mountSchema = z.object({
  name: z.string().min(1),
  path: z.string().startsWith('/'),
  /** Read-only is the only mode. A trainer writes artifacts to its own directory, never to the data. */
  mode: z.literal('ro'),
});

const evalGateSchema = z.object({
  metric: z.string().min(1),
  higherIsBetter: z.boolean(),
  /** Smallest improvement over the baseline that counts. 0 means "must not regress". */
  minDelta: z.number().min(0).default(0),
  /** Absolute bar the candidate must clear regardless of baseline (HBPE: L0 top-1 >= 0.75). */
  floor: z.number().optional(),
});

export const trainingJobManifestSchema = z
  .object({
    version: z.literal(1),
    /** Reverse-DNS or app slug, e.g. `hbpe.nightly`. */
    kind: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    /** Who the artifacts belong to (HBPE: user id). One run at a time per kind and subject. */
    subject: z.string().min(1),

    steps: z.array(stepSchema).min(1),

    resources: z.object({
      device: z.enum(['cpu', 'gpu', 'any']).default('any'),
      minMemoryMb: z.number().int().positive(),
      images: z.array(z.enum(TRAINING_IMAGE_VARIANTS)).min(1),
      framework: z.enum(['pytorch', 'mlx', 'tinygrad', 'unsloth']).default('pytorch'),
    }),

    trigger: z.object({
      cron: z.string().optional(),
      onEvent: z.string().optional(),
    }),

    /**
     * Hub-level lease on inference. HBPE polls chat state and rate-limits itself per app; Hub
     * should arbitrate once so every trainer behaves the same.
     */
    yieldToInference: z.object({
      mode: z.enum(['yield', 'ignore']).default('yield'),
      maxWaitSeconds: z.number().int().min(0).default(600),
    }),

    data: z.object({
      mounts: z.array(mountSchema).min(1),
      network: z.literal('none'),
      /** Which node holds the data. Jobs move to data; data moves only if offload is allowed. */
      allowRemoteOffload: z.boolean().default(false),
    }),

    artifacts: z.object({
      dir: z.string().startsWith('/'),
      /** Same idea as HBPE's architecture and L1 vocab fingerprints. */
      compatibility: z.record(z.string(), z.string()).default({}),
      keepVersions: z.number().int().min(1).max(20).default(3),
    }),

    evalGate: evalGateSchema.optional(),
    timeoutSeconds: z.number().int().positive(),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.steps.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'name'], message: `duplicate step ${s.name}` });
      }
      seen.add(s.name);
    });
    if (!m.trigger.cron && !m.trigger.onEvent) {
      ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'a job needs a cron or an event trigger' });
    }
    if (m.resources.device === 'gpu' && m.resources.images.every((i) => i === 'cpu')) {
      ctx.addIssue({ code: 'custom', path: ['resources', 'images'], message: 'device gpu needs a cuda or rocm image' });
    }
    const mountNames = new Set<string>();
    m.data.mounts.forEach((mount, i) => {
      if (mountNames.has(mount.name)) {
        ctx.addIssue({ code: 'custom', path: ['data', 'mounts', i, 'name'], message: `duplicate mount ${mount.name}` });
      }
      mountNames.add(mount.name);
      if (m.artifacts.dir === mount.path || m.artifacts.dir.startsWith(`${mount.path}/`)) {
        ctx.addIssue({
          code: 'custom',
          path: ['artifacts', 'dir'],
          message: 'artifacts must not be written inside a read-only data mount',
        });
      }
    });
  });

export type TrainingJobManifest = z.infer<typeof trainingJobManifestSchema>;
export type TrainingEvalGate = z.infer<typeof evalGateSchema>;

export function parseTrainingJobManifest(input: unknown): TrainingJobManifest {
  return trainingJobManifestSchema.parse(input);
}
