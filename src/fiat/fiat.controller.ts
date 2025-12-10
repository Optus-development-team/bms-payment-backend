import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiAcceptedResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { FiatService } from './fiat.service';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { SetTwoFaDto } from './dto/set-2fa.dto';
import {
  GenerateHybridPaymentDto,
  HybridPaymentResponseDto,
  PaymentMethod,
} from './dto/generate-hybrid-payment.dto';

@ApiTags('Fiat Automation')
@Controller('v1/fiat')
export class FiatController {
  private readonly logger = new Logger(FiatController.name);

  constructor(
    private readonly fiatService: FiatService,
    private readonly configService: ConfigService,
  ) {}

  @Post('generate-qr')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue a job that generates a QR image in the bank portal.',
  })
  @ApiAcceptedResponse({
    description: 'Job accepted for background processing.',
  })
  @ApiConflictResponse({
    description: 'QR already exists for this order or glosa.',
  })
  generateQr(@Body() dto: GenerateQrDto) {
    try {
      this.fiatService.queueGenerateQr(dto);
      return { status: 'accepted', orderId: dto.orderId, details: dto.details };
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      this.logger.error(`Failed to queue QR generation: ${error}`);
      throw error;
    }
  }

  @Post('verify-payment')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue a job that verifies the latest payment using its glosa.',
  })
  @ApiAcceptedResponse({
    description: 'Verification job accepted for processing.',
  })
  verifyPayment(@Body() dto: VerifyPaymentDto) {
    this.fiatService.queueVerifyPayment(dto);
    return { status: 'accepted' };
  }

  @Post('set-2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Provide the current 2FA token to unblock automation logins.',
  })
  @ApiSecurity('internal-api-key')
  @ApiResponse({
    status: 200,
    description: '2FA token stored and ready for use.',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid internal API key.',
  })
  updateTwoFa(
    @Headers('x-internal-api-key') internalApiKey: string | undefined,
    @Body() dto: SetTwoFaDto,
  ) {
    this.validateInternalApiKey(internalApiKey);
    return this.fiatService.updateTwoFactorCode(dto);
  }

  /**
   * Generate hybrid payment (Fiat QR + X402 crypto)
   * This endpoint creates both a fiat QR code and x402 payment requirements,
   * allowing the user to choose their preferred payment method.
   */
  @Post('generate-hybrid-payment')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Generate hybrid payment options (QR + X402 crypto)',
    description:
      'Creates both a fiat QR code and x402 cryptocurrency payment requirements. ' +
      'The user can choose to pay via bank QR or crypto. ' +
      'QR image arrives via webhook; x402 payment can be completed via /v1/x402/payment/:jobId/pay.',
  })
  @ApiAcceptedResponse({
    description: 'Payment options created. QR will arrive via webhook.',
    type: HybridPaymentResponseDto,
  })
  async generateHybridPayment(
    @Body() dto: GenerateHybridPaymentDto,
  ): Promise<HybridPaymentResponseDto> {
    return this.fiatService.queueHybridPayment(dto);
  }

  private validateInternalApiKey(headerValue: string | undefined) {
    const expectedKey = this.configService.get<string>('INTERNAL_API_KEY');

    if (!expectedKey) {
      this.logger.error(
        'INTERNAL_API_KEY is not configured but required for /set-2fa.',
      );
      throw new UnauthorizedException(
        'Internal API key missing in configuration.',
      );
    }

    if (headerValue !== expectedKey) {
      throw new UnauthorizedException('Invalid internal API key.');
    }
  }
}
