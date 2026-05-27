import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { RegistrationModule } from '../registration/registration.module';
import { ActivityPubController } from './activitypub.controller';
import { ActivityPubStoreService } from './activitypub-store.service';
import { ActorService } from './actor.service';
import { DeliveryService } from './delivery.service';
import { FederationConfigService } from './federation-config.service';
import { InboxService } from './inbox.service';
import { NodeinfoController } from './nodeinfo.controller';
import { OutboxService } from './outbox.service';
import { SignatureService } from './signature.service';
import { WebfingerController } from './webfinger.controller';

@Module({
  imports: [AppsModule, RegistrationModule],
  controllers: [ActivityPubController, WebfingerController, NodeinfoController],
  providers: [ActivityPubStoreService, FederationConfigService, ActorService, SignatureService, DeliveryService, OutboxService, InboxService],
  exports: [OutboxService, InboxService, ActorService, FederationConfigService],
})
export class ActivityPubModule {}
