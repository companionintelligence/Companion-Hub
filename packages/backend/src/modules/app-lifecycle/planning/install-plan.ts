import { mergeFormFieldDefaults } from '@ci-hub/common/validation';
import type { FormField } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import type { AppFilesManager } from '../../apps/app-files-manager';
import type { DockerService } from '../../docker/docker.service';
import type { PortManagerService } from '../../network/port-manager.service';
import type { EnvUtils } from '../../env/env.utils';
import type { CheckResult, FormFieldPlanItem, ImagePlanItem, PortPlanItem } from './install-plan.types';
import type { PortRequestInput } from './port-requests';

/**
 * Runs a throwing assertion and captures the result as a non-throwing {@link CheckResult}, so a
 * plan preview can report the same guards `install` runs (`assertForInstall`,
 * `assertHostDevicesAvailable`, ...) without their `throw` aborting plan construction.
 */
export async function toCheckResult(assertion: () => Promise<unknown> | undefined): Promise<CheckResult> {
  try {
    await assertion();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Read-only per-image cache lookup for a plan preview. Never pulls. */
export async function planImages(dockerService: DockerService, images: string[]): Promise<ImagePlanItem[]> {
  return Promise.all(
    images.map(async (image) => ({
      image,
      cachedLocally: await dockerService.imageExistsLocally(image),
    })),
  );
}

/**
 * Reports each requested port's availability right now, via the same
 * `PortManagerService.isPortAvailable` check `allocateWithRetry` uses for its own preferred-port
 * attempt. Never allocates — see {@link PortPlanItem} for why `available` is a snapshot, not a
 * guarantee.
 */
export async function planPorts(portManager: PortManagerService, requests: PortRequestInput[]): Promise<PortPlanItem[]> {
  return Promise.all(
    requests.map(async (request) => {
      const protocol = request.protocol ?? 'tcp';
      const preferredHostPort = request.preferredHostPort ?? request.containerPort;
      return {
        label: request.label,
        containerPort: request.containerPort,
        protocol,
        preferredHostPort,
        available: await portManager.isPortAvailable(preferredHostPort, protocol),
      };
    }),
  );
}

/**
 * Diffs the app's declared `form_fields` — the submitted form merged with catalog defaults, via
 * the same `mergeFormFieldDefaults` call `generateEnvFile` itself starts from — against what is
 * currently persisted in `app.env`. See {@link FormFieldPlanItem} for why this covers only the
 * form-driven subset of the env `install` writes, not the full file.
 */
export async function planFormFields(
  appFilesManager: AppFilesManager,
  envUtils: EnvUtils,
  appUrn: AppUrn,
  formFields: FormField[],
  form: Record<string, unknown>,
): Promise<FormFieldPlanItem[]> {
  if (formFields.length === 0) return [];

  const merged = mergeFormFieldDefaults(form, formFields);
  const currentEnv = await appFilesManager.getAppEnv(appUrn);
  const currentMap = envUtils.envStringToMap(currentEnv.content);

  return formFields.map((field) => {
    const currentValue = currentMap.get(field.env_variable);
    const proposedValue = String(merged[field.env_variable] ?? '');
    const status: FormFieldPlanItem['status'] = currentValue === undefined ? 'added' : currentValue === proposedValue ? 'unchanged' : 'changed';

    return {
      key: field.env_variable,
      label: field.label,
      currentValue,
      proposedValue,
      status,
    };
  });
}
