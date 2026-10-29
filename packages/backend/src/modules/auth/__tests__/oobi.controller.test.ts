import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { OobiController } from '../oobi.controller';

describe('OobiController', () => {
  const controller = new OobiController();

  it('does not publish placeholder identity data when no persisted KERI log exists', () => {
    expect(() => controller.getHubOobi()).toThrow(ServiceUnavailableException);
  });

  it('does not claim to resolve an AID without verifying a persisted KERI log', () => {
    expect(() => controller.getOobiForAid('did:keri:example')).toThrow(ServiceUnavailableException);
  });
});
