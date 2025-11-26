import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetTwoFaDto {
  @ApiProperty({
    description: 'Temporary code provided by the bank to unblock login',
    example: '123456',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'code must be alphanumeric',
  })
  @MinLength(4)
  @MaxLength(12)
  code!: string;
}
