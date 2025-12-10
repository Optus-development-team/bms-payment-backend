import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isRecord, toNonEmptyString, toNumber } from './dto-helpers';

/**
 * Payment method options
 */
export enum PaymentMethod {
  FIAT_QR = 'fiat_qr',
  X402_CRYPTO = 'x402_crypto',
  HYBRID = 'hybrid', // Both options available
}

/**
 * DTO for initiating a hybrid payment (QR + x402)
 * Can generate both fiat QR and x402 payment requirements
 */
export class GenerateHybridPaymentDto {
  @ApiProperty({
    description: 'Unique order identifier for correlation',
    example: 'ORDER-HYBRID-001',
  })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) return current;
    if (isRecord(obj)) {
      return (
        toNonEmptyString(obj['order_id']) ??
        toNonEmptyString(obj['orderId']) ??
        ''
      );
    }
    return '';
  })
  @IsString()
  @MinLength(1)
  orderId!: string;

  @ApiProperty({
    description: 'Amount to charge',
    example: 150.75,
  })
  @Transform(({ value }) => toNumber(value) ?? Number.NaN)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  amount!: number;

  @ApiProperty({
    description: 'Glosa/memo text for the payment',
    example: 'BM QR #INV-1001',
  })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) return current;
    if (isRecord(obj)) {
      return (
        toNonEmptyString(obj['details']) ?? toNonEmptyString(obj['glosa']) ?? ''
      );
    }
    return '';
  })
  @IsString()
  @MinLength(1)
  details!: string;

  @ApiPropertyOptional({
    description: 'Preferred payment method',
    enum: PaymentMethod,
    default: PaymentMethod.HYBRID,
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Whether manual confirmation is required for x402 payments',
    example: true,
    default: true,
  })
  @IsOptional()
  requiresManualConfirmation?: boolean;
}

/**
 * Response DTO for hybrid payment generation
 */
export class HybridPaymentResponseDto {
  @ApiProperty({ example: 'accepted' })
  status!: string;

  @ApiProperty({ example: 'ORDER-HYBRID-001' })
  orderId!: string;

  @ApiPropertyOptional({
    description: 'Fiat QR job status (will receive QR via webhook)',
    example: 'queued',
  })
  fiatQrStatus?: string;

  @ApiPropertyOptional({
    description: 'X402 payment job ID',
    example: 'x402_abc123',
  })
  x402JobId?: string;

  @ApiPropertyOptional({
    description: 'X402 payment requirements (for crypto payment)',
  })
  x402PaymentRequirements?: {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
  };

  @ApiProperty({
    description: 'Available payment methods',
    example: ['fiat_qr', 'x402_crypto'],
  })
  availableMethods!: string[];
}
