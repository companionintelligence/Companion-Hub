import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { InferenceAccessGuard } from '@/modules/auth/inference-access.guard';
import { PoolProxyService } from './hub-pool-proxy.service';

/**
 * Ollama-native probe surface at the Hub's OWN root — deliberately NOT under `inference/pool`.
 *
 * `HubPoolController` already answers `GET api/version` / `GET api/tags` (full path
 * `/api/inference/pool/api/version` etc.), and that is the path every Hub-*generated* credential
 * points an app at (`InferenceEndpointService.applyPoolRouting()` → `HERMES_OPENAI_BASE_URL` /
 * `OLLAMA_HOST`, consumed by `CI-Hermes`'s `native_root()` in `ollama_native_adapter.py`). For an
 * app that bootstraps through the Hub, that path was always reachable.
 *
 * But `OLLAMA_HOST` is a pre-existing, external convention: real Ollama answers these two routes at
 * ITS OWN root (`http://<host>:11434/api/version`), and the Hub's exposed API port
 * (`CI_HUB_URL`/`API_PORT`, default 5002) is exactly the kind of address an operator, a probe
 * script, or a not-yet-pool-aware integration reaches for when told "point `OLLAMA_HOST` at the
 * Hub" — with no `/inference/pool` segment, because nothing about the Ollama-native convention
 * has one. Hit that way, the request never reaches `HubPoolController` at all: Nest's global `/api`
 * prefix (see main.ts) resolves `GET /api/version` against a root `@Controller()`, and until this
 * controller existed nothing there answered `version` or `tags` — a plain Nest "Cannot GET" 404
 * with none of the diagnostics `PoolProxyService.proxyLocalOnlyRequest` logs when every local
 * backend is genuinely exhausted (see its `NATIVE_CAPABILITY_PROBE_PATHS` warn). That is a
 * different, earlier failure than the one that warn covers, and easy to mistake for it.
 *
 * Same guard, same call as `HubPoolController`'s equivalents — this is a second front door onto
 * the identical `proxyLocalOnlyRequest`, not a new code path, and it degrades exactly the same way
 * (tries this node's own backends in order; a single-node Hub with a healthy local Ollama answers
 * here too, not just once a peer is paired).
 */
@ApiExcludeController()
@Controller()
export class HubPoolOllamaCompatController {
  constructor(private readonly proxyService: PoolProxyService) {}

  // NOTE: the route path here is `version`/`tags`, NOT `api/version`/`api/tags` — this controller
  // has no `@Controller()` prefix of its own, so the app's global prefix (`app.setGlobalPrefix('/api')`
  // in main.ts) already supplies the leading `/api`. Writing `api/version` here (as
  // `HubPoolController` correctly does under ITS `inference/pool` prefix) would instead mount at
  // `/api/api/version`, reintroducing exactly the reachability gap this controller exists to close.
  @UseGuards(InferenceAccessGuard)
  @Get('version')
  async version(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/version', 'GET', undefined, res);
  }

  @UseGuards(InferenceAccessGuard)
  @Get('tags')
  async tags(@Res() res: Response) {
    await this.proxyService.proxyLocalOnlyRequest('/api/tags', 'GET', undefined, res);
  }
}
