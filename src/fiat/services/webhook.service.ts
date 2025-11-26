import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface WebhookPayload {
  type: string;
  order_id?: string;
  data: Record<string, unknown>;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly configService: ConfigService) {}

  async sendQrGenerated(orderId: string, qrImageBase64: string): Promise<void> {
    await this.dispatch({
      type: 'QR_GENERATED',
      order_id: orderId,
      data: { qr_image_base64: qrImageBase64 },
    });
  }

  async sendVerificationResult(
    orderId: string,
    success: boolean,
  ): Promise<void> {
    await this.dispatch({
      type: 'VERIFICATION_RESULT',
      order_id: orderId,
      data: { success },
    });
  }

  async sendTwoFactorRequired(): Promise<void> {
    await this.dispatch({
      type: 'LOGIN_2FA_REQUIRED',
      data: {
        message: 'Bank is asking for Token/SMS code.',
        timestamp: new Date().toISOString(),
      },
    });
  }

  private async dispatch(payload: WebhookPayload): Promise<void> {
    const baseUrl = this.configService.get<string>('OPTUSBMS_BACKEND_URL');

    if (!baseUrl) {
      this.logger.warn(
        `OPTUSBMS_BACKEND_URL is not configured. Skipping payload ${payload.type}.`,
      );
      return;
    }

    const url = `${baseUrl.replace(/\/$/, '')}/webhook/payments/result`;

    try {
      await axios.post(url, payload, { timeout: 10000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send webhook (${payload.type}): ${message}`);
    }
  }
}
