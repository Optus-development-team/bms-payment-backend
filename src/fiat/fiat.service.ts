import { Injectable, Logger } from '@nestjs/common';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { SetTwoFaDto } from './dto/set-2fa.dto';
import {
  GenerateHybridPaymentDto,
  HybridPaymentResponseDto,
  PaymentMethod,
} from './dto/generate-hybrid-payment.dto';
import { JobQueueService } from './services/job-queue.service';
import { FiatAutomationService } from './fiat-automation.service';
import { TwoFaStoreService } from './services/two-fa-store.service';
import { X402PaymentService } from '../x402/services/x402-payment.service';

@Injectable()
export class FiatService {
  private readonly logger = new Logger(FiatService.name);

  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly automationService: FiatAutomationService,
    private readonly twoFaStoreService: TwoFaStoreService,
    private readonly x402PaymentService: X402PaymentService,
  ) {}

  queueGenerateQr(dto: GenerateQrDto): void {
    this.jobQueueService
      .enqueueQrJob(
        dto.orderId,
        dto.details,
        () => this.automationService.processGenerateQr(dto),
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`QR generation job failed: ${message}`);
        throw error; // Re-throw to propagate ConflictException to controller
      });
  }

  queueVerifyPayment(dto: VerifyPaymentDto): void {
    this.jobQueueService
      .enqueue(() => this.automationService.processVerifyPayment(dto))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Payment verification job failed: ${message}`);
      });
  }

  updateTwoFactorCode(dto: SetTwoFaDto): { status: string; message: string } {
    this.twoFaStoreService.setCode(dto.code);
    this.logger.log('2FA code updated.');
    return { status: 'updated', message: 'Retry the job now' };
  }

  /**
   * Queue a hybrid payment that generates both fiat QR and x402 payment options
   */
  async queueHybridPayment(
    dto: GenerateHybridPaymentDto,
  ): Promise<HybridPaymentResponseDto> {
    const paymentMethod = dto.paymentMethod ?? PaymentMethod.HYBRID;
    const response: HybridPaymentResponseDto = {
      status: 'accepted',
      orderId: dto.orderId,
      availableMethods: [],
    };

    // Generate fiat QR if requested
    if (
      paymentMethod === PaymentMethod.FIAT_QR ||
      paymentMethod === PaymentMethod.HYBRID
    ) {
      const qrDto: GenerateQrDto = {
        orderId: dto.orderId,
        amount: dto.amount,
        details: dto.details,
      };

      this.queueGenerateQr(qrDto);
      response.fiatQrStatus = 'queued';
      response.availableMethods.push('fiat_qr');
      this.logger.log(`Fiat QR queued for order ${dto.orderId}`);
    }

    // Generate x402 payment requirements if requested
    if (
      paymentMethod === PaymentMethod.X402_CRYPTO ||
      paymentMethod === PaymentMethod.HYBRID
    ) {
      try {
        const { jobId, paymentRequirements } =
          await this.x402PaymentService.createPaymentJob(
            dto.orderId,
            dto.amount,
            dto.details,
            undefined, // resource
            dto.requiresManualConfirmation ?? true,
          );

        response.x402JobId = jobId;
        response.x402PaymentRequirements = {
          scheme: paymentRequirements.scheme,
          network: paymentRequirements.network,
          maxAmountRequired: paymentRequirements.maxAmountRequired,
          payTo: paymentRequirements.payTo,
          asset: paymentRequirements.asset,
        };
        response.availableMethods.push('x402_crypto');
        this.logger.log(
          `X402 payment job ${jobId} created for order ${dto.orderId}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to create x402 payment: ${message}`);
        // Don't fail the whole request if x402 fails
        if (paymentMethod === PaymentMethod.X402_CRYPTO) {
          throw error; // Only throw if x402 was the only method requested
        }
      }
    }

    return response;
  }
}
