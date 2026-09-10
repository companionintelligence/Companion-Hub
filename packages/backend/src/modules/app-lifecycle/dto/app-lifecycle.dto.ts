import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { optionalCpuLimitSchema } from '@/common/validation/cpu-limit';
import { optionalMemoryLimitSchema } from '@/common/validation/memory-limit';
import isFQDN from 'validator/lib/isFQDN';

export const appFormSchema = z
  .object({
    port: z.number().min(1024).max(65535).optional(),
    exposed: z.boolean().optional(),
    exposedLocal: z.boolean().optional(),
    exposureMode: z.enum(['local', 'cloudflare', 'tailscale']).optional(),
    openPort: z.boolean().optional(),
    domain: z.string().optional(),
    isVisibleOnGuestDashboard: z.boolean().optional(),
    enableAuth: z.boolean().optional(),
    localSubdomain: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,63}$/)
      .optional(),
    publicDomain: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isFQDN(value), { message: 'Invalid public domain' })
      .optional(),
    /*
     * A custom domain the installer picked from the organization's connected
     * ones. Recorded as an INTENT (`app.custom_domain_intent`) and asked of
     * Companion Portal after the app registers — never written into the app's env, which
     * only ever carries a hostname Companion Portal confirmed it wired.
     *
     * Absent and empty are different instructions. `undefined` is "the caller
     * said nothing about this", which must leave an existing choice alone — a
     * client that predates custom domains, or one patching a single setting,
     * must not silently unbind a domain the customer is being served on. `''` is
     * "serve on the platform hostname again", which the picker sends when
     * somebody chooses that.
     *
     * The empty string carries that meaning rather than `null` because the
     * OpenAPI client the frontend is generated from cannot express a nullable
     * field: this repo's spec is 3.1, where `nullable: true` is not a keyword,
     * and no generated type in it has ever had `| null`. A sentinel the
     * toolchain can represent beats a nicer one it silently drops.
     */
    customDomain: z
      .string()
      /*
       * Checked BEFORE trimming, so whitespace-only input is rejected rather than
       * silently unbinding a live domain: trimming first turns `'   '` into the
       * empty string, which is the deliberate "go back to the platform hostname"
       * instruction. `publicDomain` above gets the same protection from `.min(1)`.
       */
      .refine((value) => value === '' || isFQDN(value.trim()), { message: 'Invalid custom domain' })
      /*
       * STORED NORMALIZED, because DNS is case-insensitive and every reader of
       * this value already is: the exclusivity check lowercases, the bind pass
       * runs it through `normalizeStoredHostname`, and the picker's options are
       * the normalized hostnames Companion Portal listed. A row left holding
       * `Comfy.Acme.Com` matches no option, so the settings dialog would show no
       * custom domain for an app that has one.
       *
       * Zod's own string checks rather than `.transform(normalizeHostname)`: a
       * transform turns the field into a pipe, and the OpenAPI generator emits `{}`
       * for one — the frontend client would type this `unknown`. The trailing dot
       * `normalizeHostname` also strips cannot survive `isFQDN` above anyway.
       */
      .trim()
      .toLowerCase()
      .optional(),
    /*
     * The person choosing `customDomain` confirmed it may be taken off whatever
     * is serving it now.
     *
     * Sent only alongside a `customDomain`, and meaningless without one. The
     * bind pass runs long after this dialog closes and cannot ask anybody
     * anything, while CI-Cloud will happily retarget a domain that is live on a
     * sibling Hub in the organization — so the answer has to travel with the
     * choice or the pass has to guess. See `app.custom_domain_takeover`.
     *
     * ⚠ ABSENT IS A NO, NEVER AN INHERIT. Unlike `customDomain` above, an
     * omitted value here is not "leave the existing answer alone": a client that
     * does not know about this field cannot have asked anyone, and carrying a
     * previous confirmation forward would let one dialog's answer authorize a
     * later dialog's choice. It is written from the form on every save that
     * carries a `customDomain`, and cleared with the intent otherwise.
     */
    customDomainTakeover: z.boolean().optional(),
    /*
     * What the client believed this app was BEING SERVED ON when it drew the
     * picker — `app.custom_domain`, or `''` for "nothing".
     *
     * The compare-and-swap half of `customDomain: ''` (R2-HUBDOMAINS-3). Giving a
     * domain up is the one instruction on this form that destroys state nobody
     * can restore from the Hub, and it was carried on every save whether or not
     * the picker had ever been shown: the dialog seeds this field from the row
     * snapshot taken when it OPENED, so an operator who opened settings on a
     * domainless app, and saved an unrelated env var after an admin bound
     * `shop.acme.com` in the Portal, released the domain they were never shown.
     * Every existing guard passed precisely because the domain genuinely was this
     * app's by then.
     *
     * So the release is conditioned on the state the operator saw rather than on
     * the state at save time. It is read ONLY by
     * `AppLifecycleService.releaseClearedCustomDomain`, and only when a binding
     * actually exists to release — it is an assertion about one moment, never a
     * setting, which is why `toStoredConfig` keeps it out of the stored snapshot.
     */
    customDomainExpected: z.string().trim().toLowerCase().optional(),
    maxBackups: z.number().min(0).max(100).optional(),
    cpuLimit: optionalCpuLimitSchema,
    memoryLimit: optionalMemoryLimitSchema,
    skipEnv: z.boolean().optional(),
    skipPull: z.boolean().optional(),
    skipRun: z.boolean().optional(),
  })
  .passthrough();

const uninstallAppBodySchema = z.object({
  deleteAllData: z.boolean().optional().default(true),
  // Required to uninstall the shared Companion Memory provider while consumer apps are still connected.
  force: z.boolean().optional().default(false),
});

const resetAppBodySchema = z
  .object({
    // Required to reset the shared Companion Memory provider while consumer apps are still connected.
    force: z.boolean().optional().default(false),
  })
  // The reset route historically took no body; tolerate a missing/empty one so existing
  // bodyless callers keep working (force then defaults to false → the guard still applies).
  .default({ force: false });

const updateAppBodySchema = z.object({
  performBackup: z.boolean(),
});

const lifecycleRequestSchema = z.object({
  requestId: z.string().uuid(),
});

const cancelOperationBodySchema = z.object({
  // Optional guard so a stale client never cancels a newer operation for the same app.
  requestId: z.string().uuid().optional(),
});

const cancelOperationResponseSchema = z.object({
  // `cancelling`: in-flight abort requested; `cancelled_queued`: was still queued; `refused`: not
  // cancellable / past point-of-no-return; `force_reset`: reserved for stuck-op recovery (Phase 4);
  // `not_found`: no active op for this app (or requestId mismatch).
  outcome: z.enum(['cancelling', 'cancelled_queued', 'refused', 'force_reset', 'not_found']),
  status: z.string().optional(),
  message: z.string().optional(),
});

export class AppFormBody extends createZodDto(appFormSchema) {}

export class UninstallAppBody extends createZodDto(uninstallAppBodySchema) {}

export class ResetAppBody extends createZodDto(resetAppBodySchema) {}

export class UpdateAppBody extends createZodDto(updateAppBodySchema) {}

export class LifecycleRequestDto extends createZodDto(lifecycleRequestSchema) {}

export class CancelOperationBody extends createZodDto(cancelOperationBodySchema) {}

export class CancelOperationResponseDto extends createZodDto(cancelOperationResponseSchema) {}

const validateConfigResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(
    z.object({
      env_variable: z.string(),
      label: z.string(),
      messageKey: z.string(),
    }),
  ),
});

export class ValidateConfigResultDto extends createZodDto(validateConfigResultSchema) {}
