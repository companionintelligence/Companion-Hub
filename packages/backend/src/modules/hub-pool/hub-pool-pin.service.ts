import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DEFAULT_POOL_PIN_MODE, MAX_POOL_PINS, removePoolPin, upsertPoolPin, type HubPoolPin, type PoolPinScope } from '@/common/helpers/hub-pool';
import { HubPoolPeerRepository } from './hub-pool-peer.repository';

/** What `POST /pins` accepts, after `ZodValidationPipe` — `mode` still optional, defaulted here rather than in the schema. */
export interface UpsertPoolPinInput {
  scope: PoolPinScope;
  model?: string;
  targetKind: 'local' | 'peer';
  targetPeerId?: string;
  mode?: 'prefer';
}

/**
 * The operator's routing pins: read, upsert, remove.
 *
 * Storage is `HubPoolPreferences` in settings.json, which is why this service is thin and why there
 * is no repository under it. That was a deliberate choice over a `hub_pool_pin` table: a pin has no
 * lifecycle of its own, the write path already exists and is already correctly typed in the
 * generated client, there is no migration to get wrong — and, decisively, an FK to `hub_pool_peer`
 * would have had to CASCADE, which would let a *remote* peer's `handleRemoteUnpair` silently delete
 * this operator's routing policy. A dangling pin here is a `filter` that matches nothing.
 *
 * Nothing on the inference hot path goes through this service: `PoolProxyService` reads the same
 * in-memory settings object directly, so pinning adds no per-request query.
 */
@Injectable()
export class HubPoolPinService {
  private readonly logger = new Logger(HubPoolPinService.name);

  constructor(
    private readonly configuration: ConfigurationService,
    private readonly peers: HubPoolPeerRepository,
  ) {}

  list(): HubPoolPin[] {
    return this.configuration.getHubPoolPreferences().poolPins;
  }

  /**
   * Add or replace the pin for `(scope, model)`.
   *
   * A peer target is checked against the peer table so a typo'd uuid is a 404 at the moment it is
   * chosen rather than a pin that silently never applies. It is deliberately NOT required to be
   * `connected`: `unreachable` is the transient state the module recovers from on its own, and
   * refusing to pin a peer that is merely mid-outage would be a worse trap than allowing it —
   * `/pool/status` reports `targetAvailable: false` for exactly this case.
   */
  async upsert(input: UpsertPoolPinInput): Promise<HubPoolPin[]> {
    if (input.targetKind === 'peer') {
      const peer = await this.peers.findById(input.targetPeerId as string);
      if (!peer) {
        throw new NotFoundException(`No paired peer with id ${input.targetPeerId}`);
      }
    }
    const pin: HubPoolPin = {
      scope: input.scope,
      ...(input.scope === 'model' ? { model: input.model } : {}),
      targetKind: input.targetKind,
      ...(input.targetKind === 'peer' ? { peerId: input.targetPeerId } : {}),
      mode: input.mode ?? DEFAULT_POOL_PIN_MODE,
    };

    const next = upsertPoolPin(this.list(), pin);
    // Checked after the upsert, not before: replacing an existing pin at the cap must keep working.
    if (next.length > MAX_POOL_PINS) {
      throw new BadRequestException(`At most ${MAX_POOL_PINS} routing pins can be stored. Remove one before adding another.`);
    }
    await this.configuration.setHubPoolPreferences({ poolPins: next });
    this.logger.log(`[HubPool] pinned ${pin.scope === 'model' ? `model "${pin.model}"` : 'all models'} to ${pin.targetKind}`);
    return this.list();
  }

  /**
   * Remove the pin for `(scope, model)`. Removing one that is not there is a success, not a 404 —
   * the operator asked for a state and that state now holds.
   *
   * The scope/model pairing is checked here rather than in the DTO because the DELETE takes query
   * parameters, and a `.refine`d schema is not a bare `ZodObject`, which is what the OpenAPI query
   * patcher walks — refining it would have emitted a route taking no parameters at all.
   */
  async remove(scope: PoolPinScope, model?: string): Promise<HubPoolPin[]> {
    if ((scope === 'model') !== (model !== undefined)) {
      throw new BadRequestException(
        scope === 'model' ? 'Removing a model pin needs ?model=<model id>' : 'The pool-wide default pin is removed with ?scope=default and no model',
      );
    }
    const current = this.list();
    const next = removePoolPin(current, scope, model);
    if (next.length !== current.length) {
      await this.configuration.setHubPoolPreferences({ poolPins: next });
    }
    return this.list();
  }
}
