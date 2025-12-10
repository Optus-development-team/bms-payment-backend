import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsPositive,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
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
    description:
      'Glosa or memo text (alphanumeric + hyphens/underscores only, no spaces)',
    example: 'BM-QR-INV-1001',
  })
  @Transform(({ value, obj }) => {
    let current = toNonEmptyString(value);
    if (!current && isRecord(obj)) {
      current =
        toNonEmptyString(obj['details']) ??
        toNonEmptyString(obj['glosa']) ??
        '';
    }
    // Normalize: remove spaces, special chars except hyphen/underscore
    return (current || '')
      .trim()
      .replace(/\s+/g, '-') // spaces to hyphens
      .replace(/[^a-zA-Z0-9_-]/g, '') // remove special chars
      .toUpperCase();
  })
  @IsString()
  @MinLength(3, {
    message: 'La glosa debe tener al menos 3 caracteres',
  })
  @MaxLength(50, {
    message: 'La glosa no puede exceder 50 caracteres',
  })
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      'La glosa solo puede contener letras mayúsculas, números, guiones y guiones bajos',
  })
  details!: string;
}
