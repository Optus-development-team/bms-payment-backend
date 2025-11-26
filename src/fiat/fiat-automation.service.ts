import { Injectable, Logger } from '@nestjs/common';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { FiatBrowserService } from './services/fiat-browser.service';
import { WebhookService } from './services/webhook.service';
import { TwoFactorRequiredError } from './errors/two-factor-required.error';

@Injectable()
export class FiatAutomationService {
  private readonly logger = new Logger(FiatAutomationService.name);

  constructor(
    private readonly browserService: FiatBrowserService,
    private readonly webhookService: WebhookService,
  ) {}

  async processGenerateQr(dto: GenerateQrDto): Promise<void> {
    try {
      const qrBase64 = await this.browserService.generateQr(
        dto.amount,
        dto.details,
      );
      await this.webhookService.sendQrGenerated(dto.orderId, qrBase64);
    } catch (error) {
      await this.handleAutomationError(error);
      throw error;
    }
  }

  async processVerifyPayment(dto: VerifyPaymentDto): Promise<void> {
    try {
      const success = await this.browserService.verifyPayment(dto.details);
      await this.webhookService.sendVerificationResult(dto.orderId, success);
    } catch (error) {
      await this.handleAutomationError(error);
      throw error;
    }
  }

  private async handleAutomationError(error: unknown): Promise<void> {
    if (error instanceof TwoFactorRequiredError) {
      await this.webhookService.sendTwoFactorRequired();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Fiat automation failed: ${message}`);
  }
}
