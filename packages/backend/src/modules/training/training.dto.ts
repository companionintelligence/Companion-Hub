import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import {
  TRAINING_DATASET_FORMATS,
  TRAINING_DEVICES,
  TRAINING_FRAMEWORKS,
  TRAINING_JOB_ID_PATTERN,
  TRAINING_JOB_TYPES,
  TRAINING_PRIORITIES,
  TRAINING_TARGET_FORMATS,
} from './training.types';

const MAX_JOB_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);

/**
 * `POST /training/jobs` and `POST /training/pool/jobs`, checked before a handler runs so malformed
 * input is a 400 rather than a 500 from deep inside the runner.
 *
 * Unknown keys are dropped, which is the default for every DTO here. `userId` is declared for that
 * reason: the HBPE trainer reads it from the manifest file, and dropping it would quietly train
 * under the trainer's all-zero fallback id.
 */
const trainingJobManifestSchema = z.object({
  jobId: z.string().min(1).max(MAX_JOB_ID_LENGTH).regex(TRAINING_JOB_ID_PATTERN, {
    message: 'jobId may contain only letters, digits, dashes and underscores',
  }),
  appId: z.string().min(1).max(200),
  jobType: z.enum(TRAINING_JOB_TYPES),
  userId: z.string().min(1).max(100).optional(),
  model: z.object({
    backboneId: z.string().min(1).max(500),
    framework: z.enum(TRAINING_FRAMEWORKS),
    targetFormat: z.enum(TRAINING_TARGET_FORMATS),
    baseCheckpointPath: pathSchema.optional(),
  }),
  dataset: z.object({
    format: z.enum(TRAINING_DATASET_FORMATS),
    dataPath: pathSchema,
    trainDaysCount: z.number().int().positive().optional(),
    /** The share held out for validation. 1 would leave nothing to train on. */
    valFraction: z.number().min(0).lt(1),
  }),
  hyperparameters: z.object({
    batchSize: z.number().int().positive(),
    learningRate: z.number().positive(),
    /** Progress is reported as epoch / epochs, so 0 is refused here rather than divided by later. */
    epochs: z.number().int().positive(),
    weightDecay: z.number().min(0).optional(),
    loraRank: z.number().int().positive().optional(),
    loraAlpha: z.number().positive().optional(),
    patience: z.number().int().min(0).optional(),
    mixedPrecision: z.boolean(),
  }),
  resourcePolicy: z.object({
    devicePreference: z.enum(TRAINING_DEVICES),
    maxVramMb: z.number().int().positive().optional(),
    allowRemoteOffload: z.boolean(),
    priority: z.enum(TRAINING_PRIORITIES),
    timeoutSeconds: z.number().int().positive(),
  }),
});

export class TrainingJobManifestBody extends createZodDto(trainingJobManifestSchema) {}
