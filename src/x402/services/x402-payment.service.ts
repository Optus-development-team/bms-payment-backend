/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  X402_CONFIG,
  PaymentRequirements,
  PaymentPayload,
  X402PaymentJob,
  X402PaymentStatus,
  usdToAtomic,
  decodePaymentHeader,
  isFiatPaymentPayload,
} from '../types';
import { X402FacilitatorService } from './x402-facilitator.service';
import { X402WebhookService } from './x402-webhook.service';
import { X402JobQueueService } from './x402-job-queue.service';

/**
 * X402 Payment Service
 *
 * Manages the complete x402 payment flow:
 * 1. Create payment job and generate payment requirements
 * 2. Process incoming payments (verify -> settle)
 * 3. Support manual confirmation workflow
 * 4. Notify external systems via webhooks
 */
@Injectable()
export class X402PaymentService {
  private readonly logger = new Logger(X402PaymentService.name);

  /** In-memory store for payment jobs (use Redis in production) */
  private readonly jobs = new Map<string, X402PaymentJob>();

  /** Index by orderId for quick lookup */
  private readonly jobsByOrderId = new Map<string, string>();

  /** Payment timeout in milliseconds (default 5 minutes) */
  private readonly paymentTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly facilitator: X402FacilitatorService,
    private readonly webhook: X402WebhookService,
    private readonly jobQueue: X402JobQueueService,
  ) {
    this.paymentTimeoutMs =
      (this.configService.get<number>('X402_PAYMENT_TIMEOUT_SECONDS') ||
        X402_CONFIG.maxTimeoutSeconds) * 1000;
  }

  /**
   * Create a new payment job and return payment requirements
   *
   * @param orderId - Business order identifier
   * @param amountUsd - Amount to charge in USD
   * @param description - Description of the resource
   * @param resource - Resource URL (optional)
   * @param requiresManualConfirmation - Whether to wait for manual confirmation
   */
  async createPaymentJob(
    orderId: string,
    amountUsd: number,
    description: string,
    resource?: string,
    requiresManualConfirmation = true,
  ): Promise<{
    jobId: string;
    paymentRequirements: PaymentRequirements;
  }> {
    // Check if order already has a pending job
    const existingJobId = this.jobsByOrderId.get(orderId);
    if (existingJobId) {
      const existingJob = this.jobs.get(existingJobId);
      if (
        existingJob &&
        existingJob.status !== 'failed' &&
        existingJob.status !== 'expired' &&
        existingJob.status !== 'completed'
      ) {
        this.logger.log(
          `Returning existing payment job ${existingJobId} for order ${orderId}`,
        );
        return {
          jobId: existingJobId,
          paymentRequirements: existingJob.paymentRequirements!,
        };
      }
    }

    const jobId = `x402_${randomUUID()}`;
    const amountAtomic = usdToAtomic(amountUsd);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.paymentTimeoutMs);

    // Get payTo address from config
    const payTo = this.configService.get<string>('X402_PAY_TO_ADDRESS');
    if (!payTo) {
      throw new Error('X402_PAY_TO_ADDRESS not configured');
    }

    // Build payment requirements
    const resourceUrl =
      resource ||
      this.configService.get<string>('X402_DEFAULT_RESOURCE') ||
      '/api/pay';

    const paymentRequirements: PaymentRequirements = {
      type: 'crypto',
      scheme: X402_CONFIG.scheme,
      network: X402_CONFIG.network,
      maxAmountRequired: amountAtomic,
      resource: resourceUrl,
      description,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: Math.floor(this.paymentTimeoutMs / 1000),
      asset: X402_CONFIG.usdc.address,
      extra: {
        name: X402_CONFIG.usdc.name,
        version: X402_CONFIG.usdc.version,
      },
    };

    // Create job
    const job: X402PaymentJob = {
      jobId,
      orderId,
      amountUsd,
      amountAtomic,
      resource: resourceUrl,
      description,
      status: 'payment_required',
      paymentRequirements,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      requiresManualConfirmation,
    };

    this.jobs.set(jobId, job);
    this.jobsByOrderId.set(orderId, jobId);

    this.logger.log(
      `Created payment job ${jobId} for order ${orderId}: $${amountUsd} USD (${amountAtomic} atomic)`,
    );

    // Send webhook notification
    await this.webhook.sendPaymentRequired(job);

    // Schedule expiration check
    this.scheduleExpirationCheck(jobId);

    return { jobId, paymentRequirements };
  }

  /**
   * Process an incoming payment from X-PAYMENT header
   *
   * @param jobId - The payment job ID
   * @param xPaymentHeader - Base64-encoded payment payload from X-PAYMENT header
   */
  async processPayment(
    jobId: string,
    xPaymentHeader: string,
  ): Promise<{
    success: boolean;
    status: X402PaymentStatus;
    txHash?: string;
    blockExplorerUrl?: string;
    error?: string;
    requiresManualConfirmation?: boolean;
    payer?: string;
  }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        status: 'failed',
        error: 'Payment job not found',
      };
    }

    // Check if job is expired
    if (new Date() > job.expiresAt) {
      this.updateJobStatus(jobId, 'expired', 'Payment window expired');
      return {
        success: false,
        status: 'expired',
        error: 'Payment window expired',
      };
    }

    // Check if already processed
    if (
      job.status === 'completed' ||
      job.status === 'settled' ||
      job.status === 'verified'
    ) {
      return {
        success: true,
        status: job.status,
        txHash: job.settleResponse?.transaction,
        blockExplorerUrl: job.settleResponse?.transaction
          ? this.facilitator.getBlockExplorerUrl(job.settleResponse.transaction)
          : undefined,
        requiresManualConfirmation: job.requiresManualConfirmation,
        payer: job.settleResponse?.payer,
      };
    }

    if (job.paymentMethod && job.paymentMethod !== 'crypto') {
      return {
        success: false,
        status: 'failed',
        error: 'Payment method already locked to fiat for this order',
      };
    }

    // Decode payment payload
    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = decodePaymentHeader(xPaymentHeader);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateJobStatus(
        jobId,
        'failed',
        `Invalid payment payload: ${message}`,
      );
      return {
        success: false,
        status: 'failed',
        error: `Invalid payment payload: ${message}`,
      };
    }

    if (isFiatPaymentPayload(paymentPayload)) {
      this.updateJobStatus(
        jobId,
        'failed',
        'Fiat payload not supported on crypto processor',
      );
      return {
        success: false,
        status: 'failed',
        error: 'Fiat payload not supported on crypto processor',
      };
    }

    job.paymentPayload = paymentPayload;
    job.paymentMethod = 'crypto';
    this.updateJobStatus(jobId, 'payment_received');

    // Queue the verification and settlement job
    return await this.jobQueue.enqueue(() =>
      this.verifyAndSettle(jobId, paymentPayload),
    );
  }

  /**
   * Verify and settle a payment
   * This runs in the job queue to ensure sequential processing
   */
  private async verifyAndSettle(
    jobId: string,
    paymentPayload: PaymentPayload,
  ): Promise<{
    success: boolean;
    status: X402PaymentStatus;
    txHash?: string;
    blockExplorerUrl?: string;
    error?: string;
    requiresManualConfirmation?: boolean;
    payer?: string;
  }> {
    const job = this.jobs.get(jobId);
    if (!job || !job.paymentRequirements) {
      return {
        success: false,
        status: 'failed',
        error: 'Payment job not found',
      };
    }

    // Step 1: Verify
    this.updateJobStatus(jobId, 'verifying');
    const verifyResult = await this.facilitator.verify(
      paymentPayload,
      job.paymentRequirements,
    );
    job.verifyResponse = verifyResult;

    if (!verifyResult.isValid) {
      this.updateJobStatus(
        jobId,
        'failed',
        verifyResult.invalidReason || 'Verification failed',
      );
      await this.webhook.sendPaymentFailed(job);
      return {
        success: false,
        status: 'failed',
        error: verifyResult.invalidReason || 'Verification failed',
      };
    }

    this.updateJobStatus(jobId, 'verified');
    await this.webhook.sendPaymentVerified(job);

    // Step 2: Settle
    this.updateJobStatus(jobId, 'settling');
    const settleResult = await this.facilitator.settle(
      paymentPayload,
      job.paymentRequirements,
    );
    job.settleResponse = settleResult;

    if (!settleResult.success) {
      this.updateJobStatus(
        jobId,
        'failed',
        settleResult.errorReason || 'Settlement failed',
      );
      await this.webhook.sendPaymentFailed(job);
      return {
        success: false,
        status: 'failed',
        error: settleResult.errorReason || 'Settlement failed',
      };
    }

    this.updateJobStatus(jobId, 'settled');
    await this.webhook.sendPaymentSettled(job);

    const blockExplorerUrl = this.facilitator.getBlockExplorerUrl(
      settleResult.transaction,
    );

    // If manual confirmation is required, don't complete yet
    if (job.requiresManualConfirmation) {
      this.logger.log(
        `Payment ${jobId} settled, awaiting manual confirmation. TX: ${settleResult.transaction}`,
      );
      return {
        success: true,
        status: 'settled',
        txHash: settleResult.transaction,
        blockExplorerUrl,
        requiresManualConfirmation: true,
        payer: settleResult.payer,
      };
    }

    // Auto-complete if no manual confirmation required
    this.updateJobStatus(jobId, 'completed');
    await this.webhook.sendPaymentConfirmed(job);

    return {
      success: true,
      status: 'completed',
      txHash: settleResult.transaction,
      blockExplorerUrl,
      requiresManualConfirmation: false,
      payer: settleResult.payer,
    };
  }

  /**
   * Manually confirm a payment
   * Called by admin/agent after verifying the transaction
   */
  async confirmPayment(
    jobId: string,
    confirmedBy?: string,
  ): Promise<{
    success: boolean;
    status: X402PaymentStatus;
    error?: string;
  }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        success: false,
        status: 'failed',
        error: 'Payment job not found',
      };
    }

    if (job.status !== 'settled') {
      return {
        success: false,
        status: job.status,
        error: `Cannot confirm payment in status: ${job.status}. Expected: settled`,
      };
    }

    job.manuallyConfirmed = true;
    job.confirmedAt = new Date();
    job.confirmedBy = confirmedBy;
    this.updateJobStatus(jobId, 'completed');

    this.logger.log(
      `Payment ${jobId} manually confirmed by ${confirmedBy || 'unknown'}`,
    );

    await this.webhook.sendPaymentConfirmed(job);

    return {
      success: true,
      status: 'completed',
    };
  }

  /**
   * Get payment job status
   */
  getJobStatus(jobId: string): X402PaymentJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get payment job by order ID
   */
  getJobByOrderId(orderId: string): X402PaymentJob | undefined {
    const jobId = this.jobsByOrderId.get(orderId);
    if (jobId) {
      return this.jobs.get(jobId);
    }
    return undefined;
  }

  /**
   * Get all jobs (for admin purposes)
   */
  getAllJobs(): X402PaymentJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get jobs by status
   */
  getJobsByStatus(status: X402PaymentStatus): X402PaymentJob[] {
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === status,
    );
  }

  /**
   * Update job status
   */
  private updateJobStatus(
    jobId: string,
    status: X402PaymentStatus,
    errorMessage?: string,
  ): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = status;
      job.updatedAt = new Date();
      if (errorMessage) {
        job.errorMessage = errorMessage;
      }
      this.logger.debug(`Job ${jobId} status updated to: ${status}`);
    }
  }

  /**
   * Schedule expiration check for a job
   */
  private scheduleExpirationCheck(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const timeUntilExpiration = job.expiresAt.getTime() - Date.now();
    if (timeUntilExpiration <= 0) return;

    setTimeout(() => {
      const currentJob = this.jobs.get(jobId);
      if (currentJob && currentJob.status === 'payment_required') {
        this.updateJobStatus(jobId, 'expired', 'Payment window expired');
        this.webhook.sendPaymentExpired(currentJob).catch((err) => {
          this.logger.error(`Failed to send expiration webhook: ${err}`);
        });
        this.logger.log(`Payment job ${jobId} expired`);
      }
    }, timeUntilExpiration);
  }

  /**
   * Clean up expired jobs (call periodically)
   */
  cleanupExpiredJobs(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      // Clean up jobs that expired more than 1 hour ago
      if (
        job.expiresAt.getTime() < now - 3600000 &&
        (job.status === 'expired' || job.status === 'failed')
      ) {
        this.jobs.delete(jobId);
        this.jobsByOrderId.delete(job.orderId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} expired payment jobs`);
    }

    return cleaned;
  }
}
