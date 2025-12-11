import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { isRecord, toNonEmptyString, toNumber } from '../../fiat/dto/dto-helpers';

export class PayRequestDto {
  @ApiProperty({ description: 'Business order identifier', example: 'ORDER-123' })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) return current;
    if (isRecord(obj)) {
      return (
        toNonEmptyString(obj['order_id']) ||
        toNonEmptyString(obj['orderId']) ||
        ''
      );
    }
    return '';
  })
  @IsString()
  @MinLength(1)
  orderId!: string;

  @ApiProperty({ description: 'Amount to charge in USD for crypto payments' })
  @Transform(({ value, obj }) => {
    const current = toNumber(value);
    if (!Number.isNaN(current ?? Number.NaN)) return current as number;
    if (isRecord(obj)) {
      return toNumber(obj['amount']) ?? toNumber(obj['amount_usd']);
    }
    return Number.NaN;
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  amountUsd!: number;

  @ApiPropertyOptional({ description: 'Description or glosa for the payment' })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) return current;
    if (isRecord(obj)) {
      return (
        toNonEmptyString(obj['description']) ||
        toNonEmptyString(obj['details']) ||
        toNonEmptyString(obj['glosa']) ||
        ''
      );
    }
    return '';
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Resource being paid for', example: 'Product' })
  @Transform(({ value }) => toNonEmptyString(value) || 'Product')
  @IsOptional()
  @IsString()
  resource?: string;

  @ApiPropertyOptional({
    description: 'Fiat amount (BOB) to use when offering QR payments',
    example: 1500,
  })
  @Transform(({ value }) => toNumber(value) ?? Number.NaN)
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  fiatAmount?: number;

  @ApiPropertyOptional({ description: 'Fiat currency code', example: 'BOB' })
  @Transform(({ value }) => toNonEmptyString(value) || 'BOB')
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Fiat currency symbol', example: 'Bs.' })
  @Transform(({ value }) => toNonEmptyString(value) || 'Bs.')
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Require manual confirmation for crypto payments', example: true })
  @Transform(({ value }) => value === true || value === 'true')
  @IsOptional()
  @IsBoolean()
  requiresManualConfirmation?: boolean;
}
