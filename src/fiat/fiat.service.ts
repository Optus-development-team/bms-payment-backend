import { Injectable, Logger } from '@nestjs/common';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { SetTwoFaDto } from './dto/set-2fa.dto';
import { JobQueueService } from './services/job-queue.service';
import { FiatAutomationService } from './fiat-automation.service';
import { TwoFaStoreService } from './services/two-fa-store.service';

@Injectable()
export class FiatService {
  private readonly logger = new Logger(FiatService.name);

  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly automationService: FiatAutomationService,
    private readonly twoFaStoreService: TwoFaStoreService,
  ) {}

  queueGenerateQr(dto: GenerateQrDto): void {
    this.jobQueueService
      .enqueueQrJob(dto.orderId, dto.details, () =>
        this.automationService.processGenerateQr(dto),
      )
      .catch((error) => {
        this.logAsyncError('QR generation job failed', error);
      });
  }

  queueVerifyPayment(dto: VerifyPaymentDto): void {
    this.jobQueueService
      .enqueue(() => this.automationService.processVerifyPayment(dto))
      .catch((error) => {
        this.logAsyncError('Payment verification job failed', error);
      });
  }

  updateTwoFactorCode(dto: SetTwoFaDto): { status: string; message: string } {
    this.twoFaStoreService.setCode(dto.code);
    this.logger.log('2FA code updated.');
    return { status: 'updated', message: 'Retry the job now' };
  }

  private logAsyncError(context: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(`${context}: ${error.message}`, error.stack);
      return;
    }

    try {
      this.logger.error(`${context}: ${JSON.stringify(error)}`);
    } catch {
      this.logger.error(`${context}: ${String(error)}`);
    }
  }
}
