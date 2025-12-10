import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiBody,
  ApiParam,
  ApiSecurity,
} from '@nestjs/swagger';
import {
  CreateX402PaymentDto,
  ConfirmX402PaymentDto,
  X402PaymentStatusResponseDto,
} from './dto';
import { X402PaymentService } from './services/x402-payment.service';
import { X402FacilitatorService } from './services/x402-facilitator.service';
import {
  X402_CONFIG,
  PaymentRequiredResponse,
  encodeSettlementHeader,
} from './types';

/**
 * X402 Payment Controller
 *
 * Implements the HTTP 402 Payment Required flow:
 * - POST /v1/x402/payment - Create payment request (returns 402)
 * - POST /v1/x402/payment/:jobId/pay - Submit payment with X-PAYMENT header
 * - POST /v1/x402/payment/:jobId/confirm - Manual confirmation
 * - GET /v1/x402/payment/:jobId/status - Get payment status
 */
@ApiTags('X402 Payments')
@Controller('v1/x402')
export class X402Controller {
  private readonly logger = new Logger(X402Controller.name);

  constructor(
    private readonly paymentService: X402PaymentService,
    private readonly facilitator: X402FacilitatorService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Create a new payment request
   * Returns HTTP 402 Payment Required with payment requirements
   */
  @Post('payment')
  @HttpCode(HttpStatus.PAYMENT_REQUIRED)
  @ApiOperation({
    summary: 'Create x402 payment request',
    description:
      'Creates a new payment job and returns HTTP 402 with payment requirements. ' +
      'The client should sign the payment and submit via /pay endpoint.',
  })
  @ApiBody({ type: CreateX402PaymentDto })
  @ApiResponse({
    status: 402,
    description: 'Payment Required - Returns payment requirements',
    schema: {
      type: 'object',
      properties: {
        x402Version: { type: 'number', example: 1 },
        accepts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scheme: { type: 'string', example: 'exact' },
              network: { type: 'string', example: 'avalanche-fuji' },
              maxAmountRequired: { type: 'string', example: '10500000' },
              resource: { type: 'string', example: '/v1/x402/payment' },
              description: { type: 'string' },
              mimeType: { type: 'string', example: 'application/json' },
              payTo: { type: 'string', example: '0x...' },
              maxTimeoutSeconds: { type: 'number', example: 300 },
              asset: {
                type: 'string',
                example: '0x5425890298aed601595a70AB815c96711a31Bc65',
              },
            },
          },
        },
        jobId: { type: 'string', example: 'x402_abc123' },
      },
    },
  })
  async createPayment(
    @Body() dto: CreateX402PaymentDto,
    @Res() res: Response,
  ): Promise<void> {
    const { jobId, paymentRequirements } =
      await this.paymentService.createPaymentJob(
        dto.orderId,
        dto.amountUsd,
        dto.description,
        dto.resource,
        dto.requiresManualConfirmation ?? true,
      );

    const response: PaymentRequiredResponse & { jobId: string } = {
      x402Version: X402_CONFIG.x402Version,
      accepts: [paymentRequirements],
      jobId,
    };

    res.status(HttpStatus.PAYMENT_REQUIRED).json(response);
  }

  /**
   * Submit payment with X-PAYMENT header
   */
  @Post('payment/:jobId/pay')
  @ApiOperation({
    summary: 'Submit x402 payment',
    description:
      'Submit a signed payment payload via the X-PAYMENT header. ' +
      'The payment will be verified and settled on the blockchain.',
  })
  @ApiParam({ name: 'jobId', description: 'Payment job ID' })
  @ApiHeader({
    name: 'X-PAYMENT',
    description: 'Base64-encoded payment payload',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Payment successful',
    headers: {
      'X-PAYMENT-RESPONSE': {
        description: 'Base64-encoded settlement response',
        schema: { type: 'string' },
      },
    },
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        status: { type: 'string' },
        txHash: { type: 'string' },
        blockExplorerUrl: { type: 'string' },
        requiresManualConfirmation: { type: 'boolean' },
      },
    },
  })
  @ApiResponse({
    status: 402,
    description: 'Payment verification failed',
  })
  async submitPayment(
    @Param('jobId') jobId: string,
    @Headers('x-payment') xPaymentHeader: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!xPaymentHeader) {
      const job = this.paymentService.getJobStatus(jobId);
      if (!job || !job.paymentRequirements) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: 'Payment job not found',
        });
        return;
      }

      // Return 402 with payment requirements
      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        accepts: [job.paymentRequirements],
        error: 'X-PAYMENT header is required',
      });
      return;
    }

    const result = await this.paymentService.processPayment(
      jobId,
      xPaymentHeader,
    );

    if (!result.success && result.status === 'failed') {
      const job = this.paymentService.getJobStatus(jobId);
      res.status(HttpStatus.PAYMENT_REQUIRED).json({
        x402Version: X402_CONFIG.x402Version,
        accepts: job?.paymentRequirements ? [job.paymentRequirements] : [],
        error: result.error,
      });
      return;
    }

    // Set X-PAYMENT-RESPONSE header if settlement was successful
    if (result.txHash) {
      const settlementHeader = encodeSettlementHeader({
        success: true,
        txHash: result.txHash,
        networkId: X402_CONFIG.network,
        chainId: X402_CONFIG.chainId,
        payer: undefined, // Will be populated from settle response
      });
      res.setHeader('X-PAYMENT-RESPONSE', settlementHeader);
    }

    res.status(HttpStatus.OK).json({
      success: result.success,
      status: result.status,
      txHash: result.txHash,
      blockExplorerUrl: result.blockExplorerUrl,
      requiresManualConfirmation: result.requiresManualConfirmation,
    });
  }

  /**
   * Manually confirm a settled payment
   */
  @Post('payment/:jobId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually confirm x402 payment',
    description:
      'Manually confirm a payment that has been settled on the blockchain. ' +
      'This is used when requiresManualConfirmation is true.',
  })
  @ApiParam({ name: 'jobId', description: 'Payment job ID' })
  @ApiSecurity('internal-api-key')
  @ApiBody({ type: ConfirmX402PaymentDto })
  @ApiResponse({
    status: 200,
    description: 'Payment confirmed',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        status: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - Invalid API key',
  })
  async confirmPayment(
    @Param('jobId') jobId: string,
    @Body() dto: ConfirmX402PaymentDto,
    @Headers('x-internal-api-key') apiKey: string | undefined,
  ): Promise<{ success: boolean; status: string; error?: string }> {
    this.validateInternalApiKey(apiKey);

    const result = await this.paymentService.confirmPayment(
      jobId,
      dto.confirmedBy,
    );

    return {
      success: result.success,
      status: result.status,
      error: result.error,
    };
  }

  /**
   * Get payment job status
   */
  @Get('payment/:jobId/status')
  @ApiOperation({
    summary: 'Get x402 payment status',
    description: 'Get the current status of a payment job.',
  })
  @ApiParam({ name: 'jobId', description: 'Payment job ID' })
  @ApiResponse({
    status: 200,
    description: 'Payment status',
    type: X402PaymentStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Payment job not found',
  })
  getPaymentStatus(@Param('jobId') jobId: string, @Res() res: Response): void {
    const job = this.paymentService.getJobStatus(jobId);

    if (!job) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: 'Payment job not found',
      });
      return;
    }

    const txHash = job.settleResponse?.transaction;

    const response: X402PaymentStatusResponseDto = {
      jobId: job.jobId,
      orderId: job.orderId,
      status: job.status,
      amountUsd: job.amountUsd,
      txHash,
      blockExplorerUrl: txHash
        ? this.facilitator.getBlockExplorerUrl(txHash)
        : undefined,
      payer: job.settleResponse?.payer,
      requiresManualConfirmation: job.requiresManualConfirmation,
      manuallyConfirmed: job.manuallyConfirmed,
      confirmedAt: job.confirmedAt?.toISOString(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      errorMessage: job.errorMessage,
    };

    res.status(HttpStatus.OK).json(response);
  }

  /**
   * Get payment by order ID
   */
  @Get('order/:orderId/status')
  @ApiOperation({
    summary: 'Get x402 payment status by order ID',
    description: 'Get the payment status for a specific order.',
  })
  @ApiParam({ name: 'orderId', description: 'Order ID' })
  @ApiResponse({
    status: 200,
    description: 'Payment status',
    type: X402PaymentStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Payment not found for order',
  })
  getPaymentByOrderId(
    @Param('orderId') orderId: string,
    @Res() res: Response,
  ): void {
    const job = this.paymentService.getJobByOrderId(orderId);

    if (!job) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: 'Payment not found for order',
      });
      return;
    }

    const txHash = job.settleResponse?.transaction;

    const response: X402PaymentStatusResponseDto = {
      jobId: job.jobId,
      orderId: job.orderId,
      status: job.status,
      amountUsd: job.amountUsd,
      txHash,
      blockExplorerUrl: txHash
        ? this.facilitator.getBlockExplorerUrl(txHash)
        : undefined,
      payer: job.settleResponse?.payer,
      requiresManualConfirmation: job.requiresManualConfirmation,
      manuallyConfirmed: job.manuallyConfirmed,
      confirmedAt: job.confirmedAt?.toISOString(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      errorMessage: job.errorMessage,
    };

    res.status(HttpStatus.OK).json(response);
  }

  /**
   * Get supported payment kinds
   */
  @Get('supported')
  @ApiOperation({
    summary: 'Get supported x402 payment kinds',
    description: 'Returns the supported payment schemes and networks.',
  })
  @ApiResponse({
    status: 200,
    description: 'Supported payment kinds',
    schema: {
      type: 'object',
      properties: {
        kinds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              x402Version: { type: 'number', example: 1 },
              scheme: { type: 'string', example: 'exact' },
              network: { type: 'string', example: 'avalanche-fuji' },
            },
          },
        },
      },
    },
  })
  getSupported(): {
    kinds: Array<{ x402Version: number; scheme: string; network: string }>;
  } {
    return this.facilitator.getSupported();
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

  /**
   * Validate internal API key
   */
  private validateInternalApiKey(headerValue: string | undefined): void {
    const expectedKey = this.configService.get<string>('INTERNAL_API_KEY');

    if (!expectedKey) {
      this.logger.error('INTERNAL_API_KEY not configured');
      throw new UnauthorizedException('Internal API key not configured');
    }

    if (headerValue !== expectedKey) {
      throw new UnauthorizedException('Invalid internal API key');
    }
  }
}
