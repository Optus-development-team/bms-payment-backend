import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  X402PaymentJob,
  X402WebhookPayload,
  X402WebhookEventType,
  X402_CONFIG,
} from '../types';

/**
 * X402 Webhook Service
 *
 * Sends webhook notifications to the backend agents system
 * about x402 payment events.
 */
@Injectable()
export class X402WebhookService {
  private readonly logger = new Logger(X402WebhookService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Send webhook when payment requirements are generated
   */
  async sendPaymentRequired(job: X402PaymentJob): Promise<void> {
    await this.dispatch('X402_PAYMENT_REQUIRED', job, {
      paymentRequirements: job.paymentRequirements,
      amountUsd: job.amountUsd,
    });
  }

  /**
   * Send webhook when payment is received
   */
  async sendPaymentReceived(job: X402PaymentJob): Promise<void> {
    await this.dispatch('X402_PAYMENT_RECEIVED', job, {
      payer: job.paymentPayload?.payload?.authorization?.from,
    });
  }

  /**
   * Send webhook when payment is verified
   */
  async sendPaymentVerified(job: X402PaymentJob): Promise<void> {
    await this.dispatch('X402_PAYMENT_VERIFIED', job, {
      verifyResponse: job.verifyResponse,
      payer: job.verifyResponse?.payer,
    });
  }

  /**
   * Send webhook when payment is settled on blockchain
   */
  async sendPaymentSettled(job: X402PaymentJob): Promise<void> {
    const txHash = job.settleResponse?.transaction;
    await this.dispatch('X402_PAYMENT_SETTLED', job, {
      settleResponse: job.settleResponse,
      txHash,
      blockExplorerUrl: txHash
        ? `${X402_CONFIG.blockExplorer}/tx/${txHash}`
        : undefined,
      payer: job.settleResponse?.payer,
      amountUsd: job.amountUsd,
    });
  }

  /**
   * Send webhook when payment is manually confirmed
   */
  async sendPaymentConfirmed(job: X402PaymentJob): Promise<void> {
    const txHash = job.settleResponse?.transaction;
    await this.dispatch('X402_PAYMENT_CONFIRMED', job, {
      txHash,
      blockExplorerUrl: txHash
        ? `${X402_CONFIG.blockExplorer}/tx/${txHash}`
        : undefined,
      payer: job.settleResponse?.payer,
      amountUsd: job.amountUsd,
      confirmedAt: job.confirmedAt?.toISOString(),
      confirmedBy: job.confirmedBy,
    });
  }

  /**
   * Send webhook when payment fails
   */
  async sendPaymentFailed(job: X402PaymentJob): Promise<void> {
    await this.dispatch('X402_PAYMENT_FAILED', job, {
      error: job.errorMessage,
      verifyResponse: job.verifyResponse,
      settleResponse: job.settleResponse,
    });
  }

  /**
   * Send webhook when payment expires
   */
  async sendPaymentExpired(job: X402PaymentJob): Promise<void> {
    await this.dispatch('X402_PAYMENT_EXPIRED', job, {
      amountUsd: job.amountUsd,
      expiresAt: job.expiresAt.toISOString(),
    });
  }

  /**
   * Dispatch webhook to configured URL
   */
  private async dispatch(
    type: X402WebhookEventType,
    job: X402PaymentJob,
    additionalData: Record<string, unknown> = {},
  ): Promise<void> {
    const baseUrl = this.configService.get<string>('OPTUSBMS_BACKEND_URL');

    if (!baseUrl) {
      this.logger.warn(
        `OPTUSBMS_BACKEND_URL not configured. Skipping ${type} webhook for job ${job.jobId}`,
      );
      return;
    }

    const url = `${baseUrl.replace(/\/$/, '')}/webhook/x402/result`;

    const payload: X402WebhookPayload = {
      type,
      orderId: job.orderId,
      jobId: job.jobId,
      data: {
        status: job.status,
        timestamp: new Date().toISOString(),
        ...additionalData,
      },
    };

    try {
      await axios.post(url, payload, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Source': 'bms-payment-backend',
          'X-Webhook-Event': type,
        },
      });
      this.logger.debug(`Sent ${type} webhook for job ${job.jobId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to send ${type} webhook for job ${job.jobId}: ${message}`,
      );
    }
  }
}
