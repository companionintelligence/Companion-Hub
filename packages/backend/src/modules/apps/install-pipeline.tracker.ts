import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';

/** Tracks which app install currently holds the global Docker install pipeline mutex. */
@Injectable()
export class InstallPipelineTracker {
  private activeUrn: AppUrn | null = null;

  setActive(urn: AppUrn | null) {
    this.activeUrn = urn;
  }

  getActive(): AppUrn | null {
    return this.activeUrn;
  }
}
