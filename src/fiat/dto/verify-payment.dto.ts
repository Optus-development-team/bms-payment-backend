import { Transform } from 'class-transformer';
import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { isRecord, toNonEmptyString } from './dto-helpers';

export class VerifyPaymentDto {
  @ApiProperty({
    description: 'Order identifier associated with the payment',
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
    description: 'Glosa string used when the QR was generated',
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
