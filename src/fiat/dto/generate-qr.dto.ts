import { Transform } from 'class-transformer';
import { IsNumber, IsPositive, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { isRecord, toNonEmptyString, toNumber } from './dto-helpers';

export class GenerateQrDto {
  @ApiProperty({
    description: 'Unique identifier used to correlate automation events',
    example: 'ORDER-123456',
  })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) {
      return current;
    }

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
    description: 'Amount to encode inside the bank QR',
    example: 150.75,
  })
  @Transform(({ value }) => toNumber(value) ?? Number.NaN)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  amount!: number;

  @ApiProperty({
    description: 'Glosa or memo text used later for verification',
    example: 'BM QR #INV-1001',
  })
  @Transform(({ value, obj }) => {
    const current = toNonEmptyString(value);
    if (current) {
      return current;
    }
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
}
