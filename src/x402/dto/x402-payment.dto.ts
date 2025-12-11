import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for initiating an x402 payment request
 * This creates a new payment job and returns the payment requirements
 */
export class CreateX402PaymentDto {
  @ApiProperty({
    description: 'Unique order identifier for correlation',
    example: 'ORDER-X402-001',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : ''))
  @IsString()
  @MinLength(1)
  orderId!: string;

  @ApiProperty({
    description: 'Amount to charge in USD',
    example: 10.5,
  })
  @Transform(({ value }) => {
    const num = typeof value === 'number' ? value : parseFloat(value as string);
    return isNaN(num) ? 0 : num;
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  amountUsd!: number;

  @ApiProperty({
    description: 'Description of the resource being paid for',
    example: 'Payment for QR code generation service',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : ''))
  @IsString()
  @MinLength(1)
  description!: string;

  @ApiPropertyOptional({
    description: 'Resource URL being paid for',
    example: '/api/pay',
  })
  @IsOptional()
  @IsString()
  resource?: string;

  @ApiPropertyOptional({
    description:
      'Whether manual confirmation is required after blockchain settlement',
    example: true,
    default: true,
  })
  @IsOptional()
  requiresManualConfirmation?: boolean;
}

/**
 * DTO for submitting payment via X-PAYMENT header
 */
export class SubmitX402PaymentDto {
  @ApiProperty({
    description: 'Job ID returned from the initial payment request',
    example: 'job_abc123',
  })
  @IsString()
  @MinLength(1)
  jobId!: string;
}

/**
 * DTO for manually confirming a payment
 */
export class ConfirmX402PaymentDto {
  @ApiProperty({
    description: 'Job ID of the payment to confirm',
    example: 'job_abc123',
  })
  @IsString()
  @MinLength(1)
  jobId!: string;

  @ApiPropertyOptional({
    description: 'Identifier of the person confirming (admin/agent)',
    example: 'admin@example.com',
  })
  @IsOptional()
  @IsString()
  confirmedBy?: string;

  @ApiPropertyOptional({
    description: 'Additional notes about the confirmation',
    example: 'Verified transaction on block explorer',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * DTO for querying payment status
 */
export class GetX402PaymentStatusDto {
  @ApiProperty({
    description: 'Job ID to query',
    example: 'job_abc123',
  })
  @IsString()
  @MinLength(1)
  jobId!: string;
}

/**
 * Response DTO for payment status
 */
export class X402PaymentStatusResponseDto {
  @ApiProperty({ example: 'job_abc123' })
  jobId!: string;

  @ApiProperty({ example: 'ORDER-X402-001' })
  orderId!: string;

  @ApiProperty({
    example: 'verified',
    enum: [
      'pending',
      'payment_required',
      'payment_received',
      'verifying',
      'verified',
      'settling',
      'settled',
      'completed',
      'failed',
      'expired',
    ],
  })
  status!: string;

  @ApiProperty({ example: 10.5 })
  amountUsd!: number;

  @ApiPropertyOptional({ example: '0x1234...' })
  txHash?: string;

  @ApiPropertyOptional({ example: 'https://testnet.snowtrace.io/tx/0x1234...' })
  blockExplorerUrl?: string;

  @ApiPropertyOptional({ example: '0xABC...' })
  payer?: string;

  @ApiPropertyOptional({ example: true })
  requiresManualConfirmation?: boolean;

  @ApiPropertyOptional({ example: false })
  manuallyConfirmed?: boolean;

  @ApiPropertyOptional({ example: '2024-01-15T10:30:00.000Z' })
  confirmedAt?: string;

  @ApiProperty({ example: '2024-01-15T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2024-01-15T10:05:00.000Z' })
  updatedAt!: string;

  @ApiPropertyOptional({ example: 'Invalid signature' })
  errorMessage?: string;
}
