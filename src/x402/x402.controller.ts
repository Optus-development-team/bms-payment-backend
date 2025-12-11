import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Logger,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiQuery,
} from '@nestjs/swagger';
import { PayRequestDto } from './dto/pay-request.dto';
import { X402PaymentService } from './services/x402-payment.service';
import { X402FacilitatorService } from './services/x402-facilitator.service';
import { FiatAutomationService } from '../fiat/fiat-automation.service';
import {
  X402_CONFIG,
  encodeSettlementHeader,
  decodePaymentHeader,
  UnifiedAcceptOption,
  SettlementResponse,
  isFiatPaymentPayload,
  PaymentRequirements,
  FiatPaymentPayload,
} from './types';

/**
 * X402 Payment Controller
 *
 * Unified QR + crypto payments through a single /pay entrypoint.
 * - GET /api/pay           -> returns 402 with payment options when missing X-PAYMENT
 * - GET /api/pay?X-PAYMENT -> processes crypto/fiat payments
 */
@ApiTags('X402 Payments')
@Controller('api')
export class X402Controller {
  private readonly logger = new Logger(X402Controller.name);
  private readonly fiatTimeoutMs = 30_000;

  constructor(
    private readonly paymentService: X402PaymentService,
    private readonly facilitator: X402FacilitatorService,
    private readonly fiatAutomation: FiatAutomationService,
  ) {}

  @Get('pay')
  @ApiOperation({
    summary: 'Unified pay endpoint (QR + crypto)',
    description:
      'Without X-PAYMENT returns HTTP 402 with crypto + optional fiat QR options. ' +
      'With X-PAYMENT, verifies and settles the chosen method.',
  })
  @ApiHeader({
    name: 'X-PAYMENT',
    required: false,
    description: 'Base64-encoded payment payload (crypto or fiat).',
  })
  @ApiQuery({
    name: 'orderId',
    required: true,
    description: 'Business order identifier',
  })
  @ApiQuery({
    name: 'amountUsd',
    required: true,
    description: 'Amount to charge in USD for crypto path',
  })
  async pay(
    @Query() dto: PayRequestDto,
    @Headers('x-payment') xPaymentHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const resource = dto.resource ?? 'Product';
    const description = dto.description ?? 'Payment';

    const { jobId, paymentRequirements } =
      await this.paymentService.createPaymentJob(
        dto.orderId,
        dto.amountUsd,
        description,
        resource,
        dto.requiresManualConfirmation ?? true,
      );

    if (!xPaymentHeader) {
      const accepts = await this.buildAccepts(
        dto,
        resource,
        paymentRequirements,
        jobId,
      );

      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        resource,
        accepts,
        error: 'X-PAYMENT header is required',
        jobId,
      });
      return;
    }

    const paymentPayload = decodePaymentHeader(xPaymentHeader);

    if (isFiatPaymentPayload(paymentPayload)) {
      await this.handleFiatPayment(
        dto,
        paymentPayload,
        resource,
        paymentRequirements,
        jobId,
        res,
      );
      return;
    }

    await this.handleCryptoPayment(
      dto,
      xPaymentHeader,
      paymentRequirements,
      resource,
      jobId,
      res,
    );
  }

  /**
   * Health check for x402 facilitator
   */
  @Get('health')
  @ApiOperation({
    summary: 'X402 health check',
    description: 'Check if the x402 facilitator is properly configured.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health status',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        facilitatorReady: { type: 'boolean' },
        network: { type: 'string', example: 'avalanche-fuji' },
        chainId: { type: 'number', example: 43113 },
        facilitatorAddress: { type: 'string' },
      },
    },
  })
  getHealth(): {
    status: string;
    facilitatorReady: boolean;
    network: string;
    chainId: number;
    facilitatorAddress?: string;
  } {
    return {
      status: this.facilitator.isReady() ? 'ok' : 'degraded',
      facilitatorReady: this.facilitator.isReady(),
      network: X402_CONFIG.network,
      chainId: X402_CONFIG.chainId,
      facilitatorAddress: this.facilitator.getFacilitatorAddress(),
    };
  }

  private buildCryptoAccept(
    requirements: PaymentRequirements,
    resource: string,
  ): UnifiedAcceptOption {
    return {
      type: 'crypto',
      scheme: requirements.scheme,
      network: requirements.network,
      amountRequired: requirements.maxAmountRequired,
      AmountRequired: requirements.maxAmountRequired,
      resource,
      payTo: requirements.payTo,
      asset: requirements.asset,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    };
  }

  private async tryFiatAccept(
    dto: PayRequestDto,
  ): Promise<UnifiedAcceptOption | null> {
    const fiatAmount = dto.fiatAmount ?? dto.amountUsd;
    if (!fiatAmount || Number.isNaN(fiatAmount)) {
      return null;
    }

    try {
      const qrBase64 = await this.fiatAutomation.generateQrWithTimeout(
        fiatAmount,
        dto.description ?? dto.orderId,
        dto.orderId,
        this.fiatTimeoutMs,
      );

      if (!qrBase64) {
        return null;
      }

      return {
        type: 'fiat',
        currency: dto.currency ?? 'BOB',
        symbol: dto.symbol ?? 'Bs.',
        amountRequired: fiatAmount.toString(),
        AmountRequired: fiatAmount.toString(),
        base64QrSimple: qrBase64,
        Base64QRSimple: qrBase64,
        maxTimeoutSeconds: 60,
        resource: dto.resource ?? 'Product',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Fiat QR option skipped: ${message}`);
      return null;
    }
  }

  private async buildAccepts(
    dto: PayRequestDto,
    resource: string,
    paymentRequirements: PaymentRequirements,
    jobId: string,
  ): Promise<UnifiedAcceptOption[]> {
    const job = this.paymentService.getJobStatus(jobId);
    const lockedMethod = job?.paymentMethod;

    const accepts: UnifiedAcceptOption[] = [];

    if (lockedMethod !== 'fiat') {
      accepts.push(this.buildCryptoAccept(paymentRequirements, resource));
    }

    if (lockedMethod !== 'crypto') {
      const fiatAccept = await this.tryFiatAccept(dto);
      if (fiatAccept) {
        accepts.push(fiatAccept);
        if (job && fiatAccept.type === 'fiat') {
          job.fiatQrBase64 = fiatAccept.base64QrSimple;
          job.fiatAmount = Number(fiatAccept.amountRequired);
        }
      }
    }

    return accepts;
  }

  private async handleCryptoPayment(
    dto: PayRequestDto,
    xPaymentHeader: string,
    paymentRequirements: PaymentRequirements,
    resource: string,
    jobId: string,
    res: Response,
  ): Promise<void> {
    const result = await this.paymentService.processPayment(
      jobId,
      xPaymentHeader,
    );

    const settlement: SettlementResponse = {
      success: result.success,
      type: 'crypto',
      transaction: result.txHash ?? null,
      network: X402_CONFIG.network,
      chainId: X402_CONFIG.chainId,
      payer: result.payer,
      errorReason: result.error ?? null,
    };

    res.setHeader('X-PAYMENT-RESPONSE', encodeSettlementHeader(settlement));

    if (!result.success && result.status === 'failed') {
      const accepts = await this.buildAccepts(
        dto,
        resource,
        paymentRequirements,
        jobId,
      );

      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        resource,
        accepts,
        error: settlement.errorReason ?? 'Payment failed',
        jobId,
      });
      return;
    }

    res.status(HttpStatus.OK).json(settlement);
  }

  private async handleFiatPayment(
    dto: PayRequestDto,
    paymentPayload: FiatPaymentPayload,
    resource: string,
    paymentRequirements: PaymentRequirements,
    jobId: string,
    res: Response,
  ): Promise<void> {
    const job = this.paymentService.getJobStatus(jobId);

    if (job?.paymentMethod && job.paymentMethod !== 'fiat') {
      const settlement: SettlementResponse = {
        success: false,
        type: 'fiat',
        transaction: null,
        currency: paymentPayload.currency ?? dto.currency ?? 'BOB',
        errorReason: 'Payment method already locked to crypto',
      };

      res.setHeader('X-PAYMENT-RESPONSE', encodeSettlementHeader(settlement));

      const accepts = await this.buildAccepts(
        dto,
        resource,
        job.paymentRequirements ?? paymentRequirements,
        jobId,
      );

      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        resource,
        accepts,
        error: settlement.errorReason,
        jobId,
      });
      return;
    }

    const details =
      paymentPayload.payload.glosa || dto.description || dto.orderId;

    const verified = await this.fiatAutomation.verifyPaymentInline(
      {
        orderId: dto.orderId,
        details,
      },
      this.fiatTimeoutMs,
    );

    const settlement: SettlementResponse = {
      success: verified,
      type: 'fiat',
      transaction:
        paymentPayload.payload.transactionId || paymentPayload.payload.time ||
        null,
      currency: paymentPayload.currency ?? dto.currency ?? 'BOB',
      errorReason: verified ? null : 'Fiat payment could not be verified',
    };

    res.setHeader('X-PAYMENT-RESPONSE', encodeSettlementHeader(settlement));

    if (!verified) {
      if (job) {
        job.paymentMethod = 'fiat';
        job.errorMessage = settlement.errorReason ?? undefined;
      }

      const accepts = await this.buildAccepts(
        dto,
        resource,
        job?.paymentRequirements ?? paymentRequirements,
        jobId,
      );

      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        resource,
        accepts,
        error: settlement.errorReason,
        jobId,
      });
      return;
    }

    if (job) {
      job.paymentMethod = 'fiat';
      job.status = 'completed';
      job.updatedAt = new Date();
    }

    res.status(HttpStatus.OK).json(settlement);
  }

}
