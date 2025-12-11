import { Module } from '@nestjs/common';
import { FiatController } from './fiat.controller';
import { FiatService } from './fiat.service';
import { JobQueueService } from './services/job-queue.service';
import { FiatAutomationService } from './fiat-automation.service';
import { FiatBrowserService } from './services/fiat-browser.service';
import { WebhookService } from './services/webhook.service';
import { TwoFaStoreService } from './services/two-fa-store.service';

@Module({
  controllers: [FiatController],
  providers: [
    FiatService,
    JobQueueService,
    FiatAutomationService,
    FiatBrowserService,
    WebhookService,
    TwoFaStoreService,
  ],
  exports: [FiatAutomationService, JobQueueService],
})
export class FiatModule {}
