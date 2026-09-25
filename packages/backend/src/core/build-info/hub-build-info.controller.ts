import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HubBuildInfoService } from './hub-build-info.service';
import type { HubBuildInfo } from './hub-build-info';

/**
 * `GET /api/hub/build` — which build of the Hub is running here.
 *
 * ## Why a new route rather than an existing `version` one
 *
 * Two routes already answer to the name "version" and NEITHER is the Hub's:
 *
 * - `GET /api/inference/pool/api/version` (`HubPoolController.proxyOllamaVersion`)
 * - `GET /api/version` (`HubPoolOllamaCompatController.version`)
 *
 * Both proxy straight through to this node's Ollama engine and return Ollama's version
 * (`{"version":"0.34.0"}`). They exist so an app handed `OLLAMA_HOST=<hub>` finds the Ollama-native
 * probe surface where the convention says it is — CI-Hermes' `native_root()` calls one of them.
 * Answering a Hub build there would break every such client, so the Hub's own identity lives on its
 * own path under a `hub` prefix that nothing else claims.
 *
 * ## Why it is unauthenticated
 *
 * The question is "what is deployed on this node", asked by an operator who frequently cannot log
 * in — a wedged JWT_SECRET, an unpaired Hub, or a fleet sweep across 17 appliances. Behind
 * `AuthGuard` it would be unavailable in precisely those cases, which is the whole failure being
 * fixed. The response is limited to build identity: a version, a commit, a public image reference
 * and a build time. All four are already public — the commit is in a public GitHub repo, and the
 * image reference is an anonymously pullable GHCR package that `verify-anonymous-pull` asserts on
 * every release. Nothing here describes the host, its config, or its data, and this is the same
 * posture `GET /api/health/*` already takes on this port.
 */
@Controller('hub')
export class HubBuildInfoController {
  constructor(private readonly buildInfo: HubBuildInfoService) {}

  @Get('build')
  @ApiOperation({
    summary: 'Build identity of the running Hub',
    description:
      'The release, commit, image reference and build time stamped into this image at build time, plus the ' +
      "running image digest when Docker can be reached. `declaredVersion` is the install env file's " +
      'CI_HUB_VERSION, reported for comparison only — it is not evidence of which build is running.',
  })
  @ApiResponse({ status: 200, description: 'Build identity. `source: "unstamped"` means this image carries no build stamp.' })
  async build(): Promise<HubBuildInfo> {
    return this.buildInfo.getBuildInfoWithDigest();
  }
}
