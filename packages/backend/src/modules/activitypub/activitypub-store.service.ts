import path from 'node:path';
import { DATA_DIR } from '@/common/constants';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { Injectable } from '@nestjs/common';
import type { ActivityPubState, StoredKeyPair } from './activitypub.types';

const DEFAULT_STATE: ActivityPubState = {
  followers: [],
  following: [],
  activities: [],
  objects: [],
};

@Injectable()
export class ActivityPubStoreService {
  private readonly statePath = path.join(DATA_DIR, 'state', 'activitypub-state.json');
  private readonly keyPath = path.join(DATA_DIR, 'state', 'activitypub-keypair.json');

  constructor(private readonly filesystem: FilesystemService) {}

  async readState(): Promise<ActivityPubState> {
    return (await this.filesystem.readJsonFile<ActivityPubState>(this.statePath)) ?? structuredClone(DEFAULT_STATE);
  }

  async writeState(state: ActivityPubState): Promise<void> {
    await this.filesystem.writeJsonFile(this.statePath, state);
  }

  async updateState(mutator: (state: ActivityPubState) => ActivityPubState | undefined): Promise<ActivityPubState> {
    const state = await this.readState();
    const updated = mutator(state) ?? state;
    await this.writeState(updated);
    return updated;
  }

  async readKeyPair(): Promise<StoredKeyPair | null> {
    return await this.filesystem.readJsonFile<StoredKeyPair>(this.keyPath);
  }

  async writeKeyPair(keyPair: StoredKeyPair): Promise<void> {
    await this.filesystem.writeJsonFile(this.keyPath, keyPair);
  }
}
